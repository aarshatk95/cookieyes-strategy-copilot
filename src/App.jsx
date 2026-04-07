import { useState, useCallback } from 'react'

// ─── Claude API helper ────────────────────────────────────────────────────────

function extractJSON(text) {
  // Strip markdown code fences if present
  const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const match = stripped.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON object found in response')
  return JSON.parse(match[0])
}

async function callClaude({ apiKey, system, user }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }

  const tools = [{ type: 'web_search_20250305', name: 'web_search' }]

  let messages = [{ role: 'user', content: user }]
  const MAX_TURNS = 15

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system,
      messages,
      tools,
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error?.message || `HTTP ${res.status}: ${res.statusText}`)
    }

    const data = await res.json()
    const textBlocks = (data.content || []).filter(c => c.type === 'text')

    if (data.stop_reason === 'end_turn') {
      return textBlocks.map(b => b.text).join('\n')
    }

    if (data.stop_reason === 'tool_use') {
      // Add assistant turn
      messages = [...messages, { role: 'assistant', content: data.content }]

      // Provide tool results (web_search results come back from Anthropic's servers)
      const toolResults = (data.content || [])
        .filter(c => c.type === 'tool_use')
        .map(tu => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: tu.type === 'web_search_20250305' || tu.name === 'web_search'
            ? (tu.content || 'Search executed.')
            : JSON.stringify(tu.input || {}),
        }))

      messages = [...messages, { role: 'user', content: toolResults }]
    } else {
      // max_tokens or other stop — return whatever text we have
      return textBlocks.map(b => b.text).join('\n')
    }
  }

  throw new Error('Maximum tool-use turns reached. Try again.')
}

// ─── Ahrefs API helper ────────────────────────────────────────────────────────

// Maps a friendly competitor name to its root domain for Ahrefs queries
function toDomain(name) {
  const map = {
    cookieyes: 'cookieyes.com',
    cookiebot: 'cookiebot.com',
    onetrust: 'onetrust.com',
    complianz: 'complianz.io',
    osano: 'osano.com',
  }
  return map[name.toLowerCase()] || `${name.toLowerCase().replace(/\s+/g, '')}.com`
}

async function fetchAhrefsData({ ahrefsKey, product, competitors }) {
  const headers = {
    'Authorization': `Bearer ${ahrefsKey}`,
    'Accept': 'application/json',
  }

  const targets = [product, ...competitors].filter(Boolean)
  const results = {}

  await Promise.all(targets.map(async name => {
    const domain = toDomain(name)
    try {
      // Site metrics — organic traffic & domain rating
      const metricsRes = await fetch(
        `/api/ahrefs/v3/site-explorer/metrics?target=${domain}&mode=domain`,
        { headers }
      )
      const metricsJson = metricsRes.ok ? await metricsRes.json() : null

      // Top 50 organic keywords
      const kwRes = await fetch(
        `/api/ahrefs/v3/site-explorer/organic-keywords?target=${domain}&mode=domain&limit=50&order_by=traffic%3Adesc`,
        { headers }
      )
      const kwJson = kwRes.ok ? await kwRes.json() : null

      // Referring domains count
      const rdRes = await fetch(
        `/api/ahrefs/v3/site-explorer/refdomains?target=${domain}&mode=domain&limit=1`,
        { headers }
      )
      const rdJson = rdRes.ok ? await rdRes.json() : null

      results[name] = {
        domain,
        metrics: metricsJson?.metrics || null,
        top_keywords: kwJson?.keywords || [],
        referring_domains: rdJson?.refdomains_count || null,
      }
    } catch {
      results[name] = { domain, error: 'fetch failed' }
    }
  }))

  // Compute keyword gap: keywords competitors rank for that product doesn't
  const productKeywords = new Set(
    (results[product]?.top_keywords || []).map(k => k.keyword?.toLowerCase())
  )
  const gaps = []
  competitors.forEach(comp => {
    ;(results[comp]?.top_keywords || []).forEach(k => {
      if (!productKeywords.has(k.keyword?.toLowerCase())) {
        gaps.push({
          keyword: k.keyword,
          competitor: comp,
          competitor_position: k.position,
          monthly_volume: k.volume,
          difficulty: k.difficulty,
        })
      }
    })
  })

  // Sort by volume descending, top 20
  gaps.sort((a, b) => (b.monthly_volume || 0) - (a.monthly_volume || 0))

  return { sites: results, keyword_gaps: gaps.slice(0, 20) }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildTab1Prompts(product, industry, competitors) {
  return {
    system: `You are a senior competitive intelligence analyst specialising in B2B SaaS.
You have live web search. You search extensively — multiple queries per competitor.
You quote real people. You name real sources. You find things the company does not know yet.
You never make up data. If you cannot find something, say not found.
Return only valid JSON. No markdown. Start with {`,
    user: `Do a deep competitive intelligence sweep for ${product} (${industry}).
Competitors to research: ${competitors.join(', ')}

For EACH competitor run these searches:
1. "${competitors[0]} new features 2026" — what did they just ship?
2. "${competitors[0]} pricing 2026" — any pricing changes?
3. "${competitors[0]} G2 reviews 2026" — what are real users saying RIGHT NOW?
4. "${competitors[0]} vs ${product}" — how do buyers compare them?
5. "${product} reviews" — what do real ${product} customers say?

Repeat for each competitor. Also search:
- "GDPR consent tool news 2026"
- "cookie consent platform update 2026"

Look specifically in these G2 complaints collected from real Cookiebot reviews:
- Pricing per domain is confusing and expensive for multi-domain setups
- Confusing relationship between Cookiebot and Usercentrics — multiple UIs
- Support response times are 3-5 business days
- Scan frequency tied to pricing even for stable sites
- Cannot change account email address
Use these as starting signals but find additional complaints and evidence via web search.

Return ONLY this JSON — be specific, use real quotes, name real sources:
{
  "competitor_intelligence": [
    {
      "competitor": "<name>",
      "what_changed_recently": "<specific feature or pricing change with date if found>",
      "feature_gaps_they_have": [
        "<specific feature they offer with detail>",
        "<another specific feature>"
      ],
      "feature_gaps_we_have": [
        "<specific ${product} advantage with evidence>",
        "<another advantage>"
      ],
      "top_user_complaint": "<exact quote from a real G2 or Reddit review — use quotation marks>",
      "second_complaint": "<another real complaint quote>",
      "buyer_profile": "<who actually buys this tool based on G2 reviewer job titles>",
      "recommended_action": "<one specific, actionable ${product} response to this competitor>",
      "urgency": "high|medium|low",
      "source": "<specific URL or platform where you found this>"
    }
  ],
  "market_signals": [
    "<important trend or announcement in the cookie consent space in 2026>",
    "<another market signal>"
  ],
  "summary": "<3 sentences — the most important competitive finding and what ${product} should do about it>"
}`,
  }
}

function buildTab2Prompts(product, competitors) {
  return {
    system: `You are a buyer intelligence analyst who reads thousands of online conversations.
You find what buyers actually say — not marketing copy, not company claims.
Real words from real people in real communities.
You never paraphrase. You quote directly. You name the exact source.
Return only valid JSON. No markdown. Start with {`,
    user: `Find the raw, unfiltered voice of buyers evaluating cookie consent tools.

Search ALL of these — do not skip any:
Reddit searches:
- site:reddit.com "cookie consent tool" 2026
- site:reddit.com "Cookiebot" complaint OR problem OR expensive
- site:reddit.com "OneTrust" frustrating OR difficult OR price
- site:reddit.com "GDPR plugin" recommendation
- site:reddit.com r/webdev "cookie banner" 2026
- site:reddit.com r/gdpr "consent management" 2026
- site:reddit.com r/marketing "cookie consent"

Review searches:
- "${competitors[0]} reviews" site:g2.com
- "${competitors[1]} reviews" site:g2.com
- "${product} reviews" site:g2.com
- "cookie consent plugin" site:wordpress.org reviews

Community searches:
- "cookie consent" site:community.cookielaw.org
- "GDPR compliance tool" recommendation 2026
- "best cookie consent" site:dev.to OR site:hashnode.com

For each finding note: exact quote, platform, date if visible, job title of reviewer if shown.

Return ONLY this JSON:
{
  "top_pain_points": [
    {
      "pain": "<the pain in plain language — one clear sentence>",
      "frequency": "very common|common|occasional",
      "buyer_quote": "<exact words copied from the post or review — keep it verbatim>",
      "reviewer_context": "<job title or company size if shown>",
      "source": "<exact platform and subreddit or URL>"
    }
  ],
  "what_buyers_wish_existed": [
    {
      "wish": "<specific capability or feature they are asking for>",
      "evidence": "<exact quote showing this wish>",
      "source": "<where>"
    }
  ],
  "competitor_complaints": [
    {
      "competitor": "<name>",
      "complaint": "<specific complaint in buyer language>",
      "frequency": "very common|common|occasional",
      "exact_quote": "<verbatim from review or post>",
      "cookieyes_opportunity": "<how ${product} specifically wins here — be concrete>"
    }
  ],
  "buyer_language": [
    {
      "phrase": "<exact phrase buyers use repeatedly>",
      "context": "<what they mean when they say this>",
      "use_in_copy": "<how ${product} should use this phrase>"
    }
  ],
  "emerging_concerns_2026": [
    "<new regulation, technology, or event that is changing what buyers need right now>"
  ]
}`,
  }
}

function buildTab3Prompts(product, competitors, ahrefsData = null) {
  const ahrefsSection = ahrefsData
    ? `LIVE AHREFS DATA — treat this as your primary SEO source:
${JSON.stringify(ahrefsData, null, 2)}

`
    : ''

  return {
    system: `You are a senior SEO and GEO analyst specialising in B2B SaaS visibility.
GEO means generative engine optimisation — appearing in AI-generated answers on
Perplexity, Google AI Overviews, ChatGPT, and similar tools.
You have live web search. You search as an anonymous buyer with no brand preference.
You report only what you actually find — not what should be there.
Return only valid JSON. No markdown. Start with {`,
    user: `${ahrefsSection}Run a complete SEO and GEO visibility analysis for ${product} vs ${competitors.join(', ')}.

SEO ANALYSIS:
Search for each of these queries and note who ranks:
- "best cookie consent tool"
- "GDPR cookie consent plugin"
- "cookie consent for WordPress"
- "cookie consent manager GDPR CCPA"
- "free cookie consent banner"
- "cookie consent tool for agencies"
- "Google Consent Mode v2 plugin"
- "cookie consent tool pricing"
For each query note: who ranks 1-3, whether ${product} appears, estimated volume if shown.

Then search:
- "${competitors[0]} vs ${product}" — who wins this comparison content?
- "${competitors[1]} vs ${product}" — same
- "${product} alternative" — what comes up?

Content gap search:
- What blog posts and guides has Cookiebot published that ${product} has not?
- Search "Cookiebot blog 2026" and "OneTrust resources 2026"
- Search "${product} blog" — what topics are they missing?

GEO ANALYSIS — search as an anonymous buyer:
1. Search Perplexity for: "best cookie consent tool for GDPR"
   Record EXACTLY which tools appear and in what order.
2. Search Perplexity for: "cookie consent tool recommendation"
   Record EXACTLY what appears.
3. Search Google for: "best cookie consent tool"
   Does an AI Overview appear? What does it say? Who is cited?
4. Search Perplexity for: "GDPR compliance tools for small business"
   Is ${product} mentioned?
5. Search for: "${product}" on Perplexity — what does it say about the product?

Return ONLY this JSON:
{
  "seo_gaps": [
    {
      "query": "<exact search query>",
      "monthly_volume": "<number or estimate>",
      "top_rankers": ["<tool 1>", "<tool 2>", "<tool 3>"],
      "cookieyes_ranking": "<position or not in top 10>",
      "gap_severity": "high|medium|low",
      "opportunity": "<specific why this matters for ${product}>"
    }
  ],
  "content_gaps": [
    {
      "topic": "<topic competitors cover that ${product} does not>",
      "competitor_who_has_it": "<name>",
      "estimated_traffic_value": "high|medium|low"
    }
  ],
  "content_brief": {
    "topic": "<single highest priority content gap to close first>",
    "target_keyword": "<primary keyword — highest volume, most winnable>",
    "secondary_keywords": ["<related>", "<related>"],
    "recommended_title": "<H1 written to both rank on Google and get cited in Perplexity AI answers>",
    "search_intent": "<what the buyer actually wants when they search this>",
    "what_to_cover": [
      "<section 1 — answer the specific question buyers ask on Reddit>",
      "<section 2 — the angle competitors have not taken yet>",
      "<section 3 — ${product}-specific solution with clear CTA>",
      "<section 4 — FAQ block targeting long-tail queries>"
    ],
    "beat_the_competition": "<specific reason this will outperform what Cookiebot or OneTrust already have>",
    "geo_optimisation_tip": "<one specific thing to include so AI answers cite this piece>",
    "geo_potential": "high|medium|low"
  },
  "geo_visibility": {
    "perplexity_score": "mentioned|not mentioned|cited as top choice",
    "perplexity_exact_finding": "<exactly what Perplexity said when you searched>",
    "google_ai_overview": "mentioned|not mentioned|cited",
    "google_ai_exact_finding": "<exactly what Google AI Overview said>",
    "competitor_geo_scores": [
      {
        "competitor": "<name>",
        "perplexity": "mentioned|not mentioned|cited as top choice",
        "google_ai": "mentioned|not mentioned|cited",
        "geo_advantage": "<why they appear and ${product} does not>"
      }
    ]
  },
  "geo_opportunity": "<the single most impactful action ${product} can take to start appearing in AI search answers>",
  "quick_seo_win": "<one specific keyword or content action that could show results within 30 days>"
}`,
  }
}

function buildTab4Prompts(product, tab1Output, tab2Output, tab3Output) {
  return {
    system: `You are the Chief Strategy Officer advising the ${product} leadership team.
You have just received three fresh intelligence reports.
Your job is to synthesise them into decisions — not observations.
Every recommendation must be specific enough to put on a roadmap tomorrow.
Every recommendation must cite real evidence from the intelligence reports.
You also search for any breaking news that affects the recommendation.
Return only valid JSON. No markdown. Start with {`,
    user: `You have three live intelligence reports. Read them carefully before responding.

COMPETITOR INTELLIGENCE REPORT:
${tab1Output || 'Run Tab 1 first for best results. Proceed with web search knowledge.'}

BUYER SIGNALS REPORT:
${tab2Output || 'Run Tab 2 first for best results. Proceed with web search knowledge.'}

SEO AND GEO REPORT:
${tab3Output || 'Run Tab 3 first for best results. Proceed with web search knowledge.'}

Before generating recommendations, search for:
- "GDPR enforcement action 2026" — any new fines or rulings?
- "cookie consent regulation 2026 update" — any new laws?
- "${product} news 2026" — anything happening with the product?
- "cookie consent market 2026" — any industry shifts?

Now generate the strategy. Rules:
- Each recommendation must cite a specific finding from the reports above
- Product recommendation must be specific enough for a sprint ticket
- Marketing recommendation must include the exact content to create
- SEO/GEO recommendation must name the exact keyword or platform to target
- The opportunity buyer must be real — based on evidence, not assumption
- The Slack message must be ready to post verbatim

Return ONLY this JSON:
{
  "intelligence_summary": "<2 sentences — the single most important finding across all three reports and its direct implication for ${product}>",
  "breaking_context": "<any 2026 regulatory or market news found that changes the recommendation>",
  "recommendations": [
    {
      "type": "product",
      "title": "<5-7 word action title — verb first>",
      "what": "<specific enough for a sprint ticket — name the feature, the user flow, the success metric>",
      "why_now": "<the specific competitive or buyer evidence that makes this urgent>",
      "evidence": "<direct quote or finding from the intelligence reports>",
      "urgency": "high|medium|low",
      "effort": "low|medium|high",
      "impact": "low|medium|high"
    },
    {
      "type": "marketing",
      "title": "<5-7 word action title>",
      "what": "<exact content piece to create — title, format, target keyword, primary argument>",
      "why_now": "<specific buyer signal or GEO gap that makes this urgent>",
      "evidence": "<direct quote or finding from the intelligence reports>",
      "urgency": "high|medium|low",
      "content_brief_summary": "<one sentence: write [exact title] targeting [exact keyword] — it closes [specific gap] and has [high/medium/low] GEO potential>",
      "ready_to_brief": true
    },
    {
      "type": "seo_geo",
      "title": "<5-7 word action title>",
      "what": "<specific SEO or GEO action — exact keyword to target or exact AI platform to optimise for>",
      "why_now": "<specific gap found in the SEO/GEO report>",
      "evidence": "<direct finding from Tab 3>",
      "urgency": "high|medium|low"
    }
  ],
  "quick_win": "<one specific action the team can take TODAY with no engineering — a tweet, a G2 response, a Perplexity answer, a LinkedIn post>",
  "slack_message": "STRATEGY REPORT — ${new Date().toLocaleDateString()}\n\nTop finding: <one sentence from intelligence summary>\nTop recommendation: <title of highest urgency recommendation>\nEvidence: <one specific data point>\nQuick win: <the quick win above>",
  "opportunity_buyer": {
    "name": "<realistic full name>",
    "role": "<specific job title and company type>",
    "company_size": "<employee range>",
    "pain": "<their specific pain in their own words — based on evidence found>",
    "trigger": "<the specific event that makes them start searching today>",
    "anxiety_2026": "<what specifically is worrying them right now based on research>",
    "where_they_search": "<exact platforms and queries they use to find solutions>"
  }
}`,
  }
}

function buildCopyValidationPrompts(buyer, intelligenceSummary, contentType, copyText) {
  return {
    system: `You are ${buyer.name}, ${buyer.role}.
You are a real person evaluating this copy. You are not helpful. You are not generous.
You are skeptical, busy, and have seen a hundred tools like this.
Your pain: ${buyer.pain}
What triggered your search today: ${buyer.trigger}
What is keeping you up at night in 2026: ${buyer.anxiety_2026}
Where you look for answers: ${buyer.where_they_search || 'Google, Reddit, Perplexity, G2'}
You will score this copy honestly. You will read it exactly as you would in real life.
Search the web for what people like you are currently saying about tools like this.
Return only valid JSON. Start with {`,
    user: `Before scoring, search for:
- What are ${buyer.role} professionals saying about cookie consent tools in 2026?
- What does "${copyText.slice(0, 50)}" signal to a buyer in this market?

Strategic context from our intelligence: ${intelligenceSummary}

Now read this ${contentType} as ${buyer.name}:
"""
${copyText}
"""

Read it once. React honestly. Then score it.

Return ONLY this JSON:
{
  "overall_score": <1-10>,
  "relevance_score": <1-10>,
  "clarity_score": <1-10>,
  "trust_score": <1-10>,
  "urgency_score": <1-10>,
  "verdict": "Would click|Would not click|Saves for later|Forwards to team|Deletes immediately",
  "first_reaction": "<the first thought that crosses your mind in 3 words>",
  "inner_monologue": "<5 sentences first person stream of consciousness. Reference specific words and phrases from the copy. Connect directly to your pain and anxiety. Be brutally honest. This is what you actually think, not what you would say politely.>",
  "strategy_alignment_gap": "<the specific mismatch between what this copy assumes about you and what you actually care about based on the intelligence>",
  "what_worked": [
    "<specific word, phrase or claim that landed — and exactly why>",
    "<another specific thing that worked>"
  ],
  "what_didnt": [
    "<specific word, phrase or claim that failed — and exactly why>",
    "<another specific failure>"
  ],
  "the_one_thing_missing": "<the single most important thing this copy does not say that would make you stop and read it properly>",
  "rewrite": "<rewrite the entire copy for this content type — make it speak directly to this buyer's exact situation in 2026. Use their language. Address their specific anxiety. Make it impossible to ignore.>"
}`,
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ApiKeyBanner({ apiKey, onChange }) {
  if (apiKey) return null
  return (
    <div className="api-banner">
      <span>No API key found. Enter your Anthropic API key to continue:</span>
      <input
        type="password"
        placeholder="sk-ant-..."
        onChange={e => onChange(e.target.value)}
        className="api-key-input"
      />
    </div>
  )
}

function RunButton({ onClick, loading, label = 'Run Analysis', disabled }) {
  return (
    <button className="run-btn" onClick={onClick} disabled={loading || disabled}>
      {loading ? <><span className="spinner" /> Analysing…</> : label}
    </button>
  )
}

function ErrorBox({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="error-box">
      <strong>Error:</strong> {error}
      {onRetry && <button className="retry-btn" onClick={onRetry}>Retry</button>}
    </div>
  )
}

function Badge({ urgency }) {
  const cls = urgency === 'high' ? 'badge-high' : urgency === 'medium' ? 'badge-medium' : 'badge-low'
  return <span className={`badge ${cls}`}>{urgency}</span>
}

// ─── Tab 1 Result ─────────────────────────────────────────────────────────────

function Tab1Result({ data }) {
  if (!data) return null
  return (
    <div className="result-section">
      <div className="summary-box">{data.summary}</div>
      {(data.market_signals || []).length > 0 && (
        <div className="market-signals-box">
          <strong>Market Signals 2026</strong>
          <ul>{data.market_signals.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      <div className="cards-grid">
        {(data.competitor_intelligence || []).map((c, i) => (
          <div key={i} className="card">
            <div className="card-header">
              <h3>{c.competitor}</h3>
              {c.urgency && <Badge urgency={c.urgency} />}
            </div>
            <div className="card-body">
              <div className="field">
                <label>Recent change</label>
                <p>{c.what_changed_recently}</p>
              </div>
              <div className="field">
                <label>They have, we don't</label>
                <ul>{(c.feature_gaps_they_have || []).map((g, j) => <li key={j}>{g}</li>)}</ul>
              </div>
              <div className="field">
                <label>We have, they lack</label>
                <ul>{(c.feature_gaps_we_have || []).map((g, j) => <li key={j}>{g}</li>)}</ul>
              </div>
              <div className="field quote-field">
                <label>Top complaint</label>
                <blockquote>"{c.top_user_complaint}"</blockquote>
              </div>
              {c.second_complaint && (
                <div className="field quote-field">
                  <label>Second complaint</label>
                  <blockquote>"{c.second_complaint}"</blockquote>
                </div>
              )}
              {c.buyer_profile && (
                <div className="field">
                  <label>Who buys this</label>
                  <p>{c.buyer_profile}</p>
                </div>
              )}
              <div className="field action-field">
                <label>Recommended action</label>
                <p>{c.recommended_action}</p>
              </div>
              <div className="field source-field">
                <label>Source</label>
                <p>{c.source}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tab 2 Result ─────────────────────────────────────────────────────────────

function Tab2Result({ data }) {
  if (!data) return null
  return (
    <div className="result-section">
      <section>
        <h3 className="section-title">Top Buyer Pain Points</h3>
        {(data.top_pain_points || []).map((p, i) => (
          <div key={i} className="pain-card">
            <div className="pain-header">
              <span className="pain-label">{p.pain}</span>
              <span className={`freq-badge freq-${p.frequency?.replace(' ', '-')}`}>{p.frequency}</span>
            </div>
            <blockquote>"{p.buyer_quote}"</blockquote>
            <div className="pain-meta">
              {p.reviewer_context && <span className="reviewer-context">{p.reviewer_context}</span>}
              <span className="source-tag">{p.source}</span>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="section-title">What Buyers Wish Existed</h3>
        {(data.what_buyers_wish_existed || []).map((w, i) => {
          const wish = typeof w === 'string' ? { wish: w } : w
          return (
            <div key={i} className="complaint-card">
              <strong>{wish.wish}</strong>
              {wish.evidence && <blockquote>"{wish.evidence}"</blockquote>}
              {wish.source && <div className="source-tag">{wish.source}</div>}
            </div>
          )
        })}
      </section>

      <section>
        <h3 className="section-title">Competitor Complaint Patterns</h3>
        {(data.competitor_complaints || []).map((c, i) => (
          <div key={i} className="complaint-card">
            <div className="complaint-header">
              <strong>{c.competitor}</strong>
              {c.frequency && <span className={`freq-badge freq-${c.frequency?.replace(' ', '-')}`}>{c.frequency}</span>}
            </div>
            <p className="complaint-text">{c.complaint}</p>
            {c.exact_quote && <blockquote>"{c.exact_quote}"</blockquote>}
            <div className="opportunity-tag">Opportunity → {c.cookieyes_opportunity}</div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="section-title">Buyer Language to Adopt</h3>
        <div className="language-cards">
          {(data.buyer_language || []).map((item, i) => {
            const entry = typeof item === 'string' ? { phrase: item } : item
            return (
              <div key={i} className="language-card">
                <span className="chip">"{entry.phrase}"</span>
                {entry.context && <p className="lang-context">{entry.context}</p>}
                {entry.use_in_copy && <p className="lang-use">Use in copy: {entry.use_in_copy}</p>}
              </div>
            )
          })}
        </div>
      </section>

      {(data.emerging_concerns_2026 || []).length > 0 && (
        <section>
          <h3 className="section-title">Emerging Concerns 2026</h3>
          <ul className="wish-list">
            {data.emerging_concerns_2026.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </section>
      )}
    </div>
  )
}

// ─── Tab 3 Result ─────────────────────────────────────────────────────────────

function Tab3Result({ data }) {
  if (!data) return null
  return (
    <div className="result-section">
      <section>
        <h3 className="section-title">SEO Keyword Gaps</h3>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Query</th>
                <th>Volume</th>
                <th>Top Rankers</th>
                <th>CookieYes</th>
                <th>Severity</th>
                <th>Opportunity</th>
              </tr>
            </thead>
            <tbody>
              {(data.seo_gaps || []).map((g, i) => (
                <tr key={i}>
                  <td><strong>{g.query}</strong></td>
                  <td>{g.monthly_volume}</td>
                  <td>{Array.isArray(g.top_rankers) ? g.top_rankers.join(', ') : g.top_rankers || g.competitor_ranking}</td>
                  <td className="not-ranking">{g.cookieyes_ranking}</td>
                  <td>{g.gap_severity && <Badge urgency={g.gap_severity} />}</td>
                  <td>{g.opportunity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section>
          <h3 className="section-title">Content Gaps</h3>
          {(data.content_gaps || []).map((g, i) => {
            const gap = typeof g === 'string' ? { topic: g } : g
            return (
              <div key={i} className="content-gap-row">
                <span>{gap.topic}</span>
                {gap.competitor_who_has_it && <span className="geo-tag">{gap.competitor_who_has_it}</span>}
                {gap.estimated_traffic_value && <span className={`geo-potential-badge geo-${gap.estimated_traffic_value}`}>{gap.estimated_traffic_value}</span>}
              </div>
            )
          })}
          <div className="quick-win-box" style={{ marginTop: '12px' }}>
            <strong>Quick SEO Win:</strong> {data.quick_seo_win}
          </div>
        </section>

        <section>
          <h3 className="section-title">GEO Visibility</h3>
          <div className="geo-scores">
            <div className={`geo-item ${data.geo_visibility?.perplexity_score?.includes('not') ? 'geo-bad' : 'geo-good'}`}>
              <span>Perplexity</span>
              <strong>{data.geo_visibility?.perplexity_score}</strong>
            </div>
            <div className={`geo-item ${data.geo_visibility?.google_ai_overview?.includes('not') ? 'geo-bad' : 'geo-good'}`}>
              <span>Google AI Overview</span>
              <strong>{data.geo_visibility?.google_ai_overview}</strong>
            </div>
          </div>
          {data.geo_visibility?.perplexity_exact_finding && (
            <div className="geo-finding-box">
              <label>Perplexity said:</label>
              <p>"{data.geo_visibility.perplexity_exact_finding}"</p>
            </div>
          )}
          {data.geo_visibility?.google_ai_exact_finding && (
            <div className="geo-finding-box">
              <label>Google AI said:</label>
              <p>"{data.geo_visibility.google_ai_exact_finding}"</p>
            </div>
          )}
          {(data.geo_visibility?.competitor_geo_scores || []).map((c, i) => (
            <div key={i} className="competitor-geo-row">
              <span>{c.competitor}</span>
              <span className="geo-tag">Perplexity: {c.perplexity}</span>
              <span className="geo-tag">Google AI: {c.google_ai}</span>
              {c.geo_advantage && <span className="geo-advantage">{c.geo_advantage}</span>}
            </div>
          ))}
          <div className="opportunity-tag" style={{ marginTop: '12px' }}>
            {data.geo_opportunity}
          </div>
        </section>
      </div>

      {data.content_brief && (
        <section>
          <h3 className="section-title">Priority Content Brief</h3>
          <div className="content-brief-card">
            <div className="brief-row">
              <label>Topic</label><span>{data.content_brief.topic}</span>
            </div>
            <div className="brief-row">
              <label>Target keyword</label><span>{data.content_brief.target_keyword}</span>
            </div>
            {(data.content_brief.secondary_keywords || []).length > 0 && (
              <div className="brief-row">
                <label>Secondary keywords</label>
                <span>{data.content_brief.secondary_keywords.join(', ')}</span>
              </div>
            )}
            <div className="brief-row">
              <label>Recommended title</label><span>{data.content_brief.recommended_title}</span>
            </div>
            {data.content_brief.search_intent && (
              <div className="brief-row">
                <label>Search intent</label><span>{data.content_brief.search_intent}</span>
              </div>
            )}
            <div className="brief-row">
              <label>GEO potential</label>
              <span className={`geo-potential-badge geo-${data.content_brief.geo_potential}`}>
                {data.content_brief.geo_potential}
              </span>
            </div>
            <div className="brief-sections">
              <label>What to cover</label>
              <ol>{(data.content_brief.what_to_cover || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
            </div>
            <div className="brief-row">
              <label>Beat the competition</label><span>{data.content_brief.beat_the_competition}</span>
            </div>
            {data.content_brief.geo_optimisation_tip && (
              <div className="brief-row geo-tip-row">
                <label>GEO tip</label><span>{data.content_brief.geo_optimisation_tip}</span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Tab 4 Result ─────────────────────────────────────────────────────────────

function Tab4Result({ data }) {
  if (!data) return null
  const typeLabel = { product: 'Product', marketing: 'Marketing', seo_geo: 'SEO / GEO' }
  const [slackCopied, setSlackCopied] = useState(false)

  function copySlack() {
    navigator.clipboard.writeText(data.slack_message || '')
    setSlackCopied(true)
    setTimeout(() => setSlackCopied(false), 2000)
  }

  return (
    <div className="result-section">
      <div className="intel-summary-box">
        <strong>Intelligence Summary</strong>
        <p>{data.intelligence_summary}</p>
      </div>

      {data.breaking_context && (
        <div className="breaking-context-box">
          <strong>Breaking Context 2026</strong>
          <p>{data.breaking_context}</p>
        </div>
      )}

      <h3 className="section-title">Three Recommendations</h3>
      {(data.recommendations || []).map((r, i) => (
        <div key={i} className="recommendation-card">
          <div className="rec-header">
            <span className="rec-type">{typeLabel[r.type] || r.type}</span>
            <Badge urgency={r.urgency} />
            {r.effort && <span className="effort-tag">Effort: {r.effort}</span>}
            {r.impact && <span className="impact-tag">Impact: {r.impact}</span>}
          </div>
          <h4>{r.title}</h4>
          <p className="rec-what">{r.what}</p>
          {r.why_now && (
            <div className="rec-why-now">
              <label>Why now</label>
              <p>{r.why_now}</p>
            </div>
          )}
          <div className="rec-evidence">
            <label>Evidence</label>
            <p>{r.evidence}</p>
          </div>
          {r.content_brief_summary && (
            <div className="content-brief-summary">
              <label>Content Brief</label>
              <p>{r.content_brief_summary}</p>
            </div>
          )}
        </div>
      ))}

      <div className="quick-win-box">
        <strong>Quick Win Today</strong>
        <p>{data.quick_win}</p>
      </div>

      {data.slack_message && (
        <div className="slack-message-box">
          <div className="slack-header">
            <strong>#product-intelligence</strong>
            <button className="copy-btn" onClick={copySlack}>
              {slackCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <pre className="slack-pre">{data.slack_message}</pre>
        </div>
      )}

      {data.opportunity_buyer && (
        <div className="buyer-card">
          <h3 className="section-title">Opportunity Buyer</h3>
          <div className="buyer-grid">
            <div><label>Name</label><p>{data.opportunity_buyer.name}</p></div>
            <div><label>Role</label><p>{data.opportunity_buyer.role}</p></div>
            {data.opportunity_buyer.company_size && (
              <div><label>Company size</label><p>{data.opportunity_buyer.company_size}</p></div>
            )}
            <div><label>Trigger</label><p>{data.opportunity_buyer.trigger}</p></div>
            <div className="buyer-full"><label>Pain</label><p>{data.opportunity_buyer.pain}</p></div>
            <div className="buyer-full"><label>2026 Anxiety</label><p>{data.opportunity_buyer.anxiety_2026}</p></div>
            {data.opportunity_buyer.where_they_search && (
              <div className="buyer-full"><label>Where they search</label><p>{data.opportunity_buyer.where_they_search}</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Copy Validation Result ───────────────────────────────────────────────────

function ScoreDot({ score }) {
  const color = score >= 8 ? '#22c55e' : score >= 6 ? '#f59e0b' : '#ef4444'
  return (
    <div className="score-dot-wrap">
      <svg width="56" height="56" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r="24" fill="none" stroke="#e5e7eb" strokeWidth="5" />
        <circle
          cx="28" cy="28" r="24" fill="none"
          stroke={color} strokeWidth="5"
          strokeDasharray={`${(score / 10) * 150.8} 150.8`}
          strokeLinecap="round"
          transform="rotate(-90 28 28)"
        />
        <text x="28" y="34" textAnchor="middle" fontSize="15" fontWeight="700" fill={color}>{score}</text>
      </svg>
    </div>
  )
}

function CopyValidationResult({ data }) {
  if (!data) return null
  const verdictClass = data.verdict?.toLowerCase().includes('not') || data.verdict?.toLowerCase().includes('delete')
    ? 'verdict-bad' : 'verdict-good'

  return (
    <div className="result-section">
      {data.first_reaction && (
        <div className="first-reaction-box">
          <label>First reaction</label>
          <strong>"{data.first_reaction}"</strong>
        </div>
      )}

      <div className="scores-row">
        {[
          { label: 'Overall', val: data.overall_score },
          { label: 'Relevance', val: data.relevance_score },
          { label: 'Clarity', val: data.clarity_score },
          { label: 'Trust', val: data.trust_score },
          { label: 'Urgency', val: data.urgency_score },
        ].map(s => (
          <div key={s.label} className="score-item">
            <ScoreDot score={s.val} />
            <span>{s.label}</span>
          </div>
        ))}
      </div>

      <div className={`verdict-box ${verdictClass}`}>
        <strong>Verdict:</strong> {data.verdict}
      </div>

      <div className="inner-monologue-box">
        <label>Inner Monologue</label>
        <p>{data.inner_monologue}</p>
      </div>

      <div className="two-col">
        <div>
          <h4 className="worked-label">What Worked</h4>
          <ul>{(data.what_worked || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
        <div>
          <h4 className="didnt-label">What Didn't</h4>
          <ul>{(data.what_didnt || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      </div>

      <div className="alignment-gap-box">
        <label>Strategy Alignment Gap</label>
        <p>{data.strategy_alignment_gap}</p>
      </div>

      {data.the_one_thing_missing && (
        <div className="one-thing-box">
          <label>The One Thing Missing</label>
          <p>{data.the_one_thing_missing}</p>
        </div>
      )}

      <div className="rewrite-box">
        <label>Rewrite</label>
        <p>"{data.rewrite}"</p>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_ANTHROPIC_API_KEY || '')
  const [ahrefsKey, setAhrefsKey] = useState(import.meta.env.VITE_AHREFS_API_KEY || '')
  const [product, setProduct] = useState('CookieYes')
  const [industry, setIndustry] = useState('cookie consent / GDPR compliance SaaS')
  const [competitors, setCompetitors] = useState(['Cookiebot', 'OneTrust', 'Complianz', 'Osano'])
  const [activeTab, setActiveTab] = useState(0)

  // Per-tab state
  const [tab1Raw, setTab1Raw] = useState('')
  const [tab2Raw, setTab2Raw] = useState('')
  const [tab3Raw, setTab3Raw] = useState('')
  const [tab4Raw, setTab4Raw] = useState('')

  const [tab1Data, setTab1Data] = useState(null)
  const [tab2Data, setTab2Data] = useState(null)
  const [tab3Data, setTab3Data] = useState(null)
  const [tab4Data, setTab4Data] = useState(null)

  const [loading, setLoading] = useState({ 1: false, 2: false, 3: false, 4: false, cv: false })
  const [errors, setErrors] = useState({})

  // Copy validation
  const [copyText, setCopyText] = useState('')
  const [contentType, setContentType] = useState('landing page headline')
  const [cvData, setCvData] = useState(null)

  const setLoad = (tab, val) => setLoading(prev => ({ ...prev, [tab]: val }))
  const setErr = (tab, msg) => setErrors(prev => ({ ...prev, [tab]: msg }))

  const runTab1 = useCallback(async () => {
    if (!apiKey) return setErr(1, 'API key required')
    setLoad(1, true); setErr(1, null)
    try {
      const { system, user } = buildTab1Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user })
      setTab1Raw(raw)
      setTab1Data(extractJSON(raw))
    } catch (e) {
      setErr(1, e.message)
    } finally {
      setLoad(1, false)
    }
  }, [apiKey, product, industry, competitors])

  const runTab2 = useCallback(async () => {
    if (!apiKey) return setErr(2, 'API key required')
    setLoad(2, true); setErr(2, null)
    try {
      const { system, user } = buildTab2Prompts(product, competitors)
      const raw = await callClaude({ apiKey, system, user })
      setTab2Raw(raw)
      setTab2Data(extractJSON(raw))
    } catch (e) {
      setErr(2, e.message)
    } finally {
      setLoad(2, false)
    }
  }, [apiKey, product, competitors])

  const runTab3 = useCallback(async () => {
    if (!apiKey) return setErr(3, 'API key required')
    setLoad(3, true); setErr(3, null)
    try {
      let ahrefsData = null
      if (ahrefsKey) {
        try {
          ahrefsData = await fetchAhrefsData({ ahrefsKey, product, competitors })
        } catch (e) {
          // Ahrefs failed — continue with web search only
          console.warn('Ahrefs fetch failed, falling back to web search:', e.message)
        }
      }
      const { system, user } = buildTab3Prompts(product, competitors, ahrefsData)
      const raw = await callClaude({ apiKey, system, user })
      setTab3Raw(raw)
      setTab3Data(extractJSON(raw))
    } catch (e) {
      setErr(3, e.message)
    } finally {
      setLoad(3, false)
    }
  }, [apiKey, ahrefsKey, product, competitors])

  const runTab4 = useCallback(async () => {
    if (!apiKey) return setErr(4, 'API key required')
    setLoad(4, true); setErr(4, null)
    try {
      const { system, user } = buildTab4Prompts(product, tab1Raw, tab2Raw, tab3Raw)
      const raw = await callClaude({ apiKey, system, user })
      setTab4Raw(raw)
      setTab4Data(extractJSON(raw))
    } catch (e) {
      setErr(4, e.message)
    } finally {
      setLoad(4, false)
    }
  }, [apiKey, product, tab1Raw, tab2Raw, tab3Raw])

  const runCopyValidation = useCallback(async () => {
    if (!apiKey) return setErr('cv', 'API key required')
    if (!tab4Data?.opportunity_buyer) return setErr('cv', 'Run Tab 4 first to identify the opportunity buyer')
    if (!copyText.trim()) return setErr('cv', 'Paste copy text above')
    setLoad('cv', true); setErr('cv', null)
    try {
      const { system, user } = buildCopyValidationPrompts(
        tab4Data.opportunity_buyer,
        tab4Data.intelligence_summary,
        contentType,
        copyText,
      )
      const raw = await callClaude({ apiKey, system, user })
      setCvData(extractJSON(raw))
    } catch (e) {
      setErr('cv', e.message)
    } finally {
      setLoad('cv', false)
    }
  }, [apiKey, tab4Data, contentType, copyText])

  const runAll = useCallback(async () => {
    if (!apiKey) return setErr('all', 'API key required')
    setErr('all', null)
    try {
      // Tabs 1, 2, 3 run in parallel
      setLoad(1, true); setErr(1, null)
      setLoad(2, true); setErr(2, null)
      setLoad(3, true); setErr(3, null)

      const [r1, r2, r3] = await Promise.all([
        // Tab 1
        (async () => {
          const { system, user } = buildTab1Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user })
          setTab1Raw(raw); setTab1Data(extractJSON(raw)); setLoad(1, false)
          return raw
        })(),
        // Tab 2
        (async () => {
          const { system, user } = buildTab2Prompts(product, competitors)
          const raw = await callClaude({ apiKey, system, user })
          setTab2Raw(raw); setTab2Data(extractJSON(raw)); setLoad(2, false)
          return raw
        })(),
        // Tab 3
        (async () => {
          let ahrefsData3 = null
          if (ahrefsKey) {
            try { ahrefsData3 = await fetchAhrefsData({ ahrefsKey, product, competitors }) } catch {}
          }
          const { system, user } = buildTab3Prompts(product, competitors, ahrefsData3)
          const raw = await callClaude({ apiKey, system, user })
          setTab3Raw(raw); setTab3Data(extractJSON(raw)); setLoad(3, false)
          return raw
        })(),
      ])

      // Tab 4 runs after all three complete
      setActiveTab(3); setLoad(4, true); setErr(4, null)
      const { system: s4, user: u4 } = buildTab4Prompts(product, r1, r2, r3)
      const r4 = await callClaude({ apiKey, system: s4, user: u4 })
      setTab4Raw(r4); setTab4Data(extractJSON(r4)); setLoad(4, false)
    } catch (e) {
      setLoad(1, false); setLoad(2, false); setLoad(3, false); setLoad(4, false)
      setErr('all', e.message)
    }
  }, [apiKey, ahrefsKey, product, industry, competitors])

  const isRunningAll = loading[1] || loading[2] || loading[3] || loading[4]

  const tabs = [
    { label: 'Competitor Intelligence', num: 1 },
    { label: 'Dark Funnel Signals', num: 2 },
    { label: 'SEO & GEO', num: 3 },
    { label: 'What to Build Next', num: 4 },
  ]

  const competitorCount = [0, 1, 2, 3]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo-row">
            <span className="logo-mark">CY</span>
            <div>
              <h1>Strategy Copilot</h1>
              <p className="header-sub">AI-powered product intelligence for CookieYes · Powered by Claude</p>
            </div>
            <div className="run-all-wrap">
              {errors.all && <span className="run-all-error">{errors.all}</span>}
              <button
                className="run-all-btn"
                onClick={runAll}
                disabled={isRunningAll}
              >
                {isRunningAll
                  ? <><span className="spinner spinner-dark" /> Running all tabs…</>
                  : '⚡ Run Full Analysis'}
              </button>
            </div>
          </div>
        </div>
      </header>

      <ApiKeyBanner apiKey={apiKey} onChange={setApiKey} />
      {!ahrefsKey && (
        <div className="api-banner ahrefs-banner">
          <span>Add your Ahrefs API key for real keyword gap data in Tab 3 (optional):</span>
          <input
            type="password"
            placeholder="Ahrefs API key…"
            onChange={e => setAhrefsKey(e.target.value)}
            className="api-key-input"
          />
        </div>
      )}

      <div className="config-bar">
        <div className="config-inner">
          <div className="config-field">
            <label>Product</label>
            <input value={product} onChange={e => setProduct(e.target.value)} />
          </div>
          <div className="config-field config-wide">
            <label>Industry</label>
            <input value={industry} onChange={e => setIndustry(e.target.value)} />
          </div>
          {competitorCount.map(i => (
            <div key={i} className="config-field">
              <label>Competitor {i + 1}</label>
              <input
                value={competitors[i] || ''}
                placeholder="Optional"
                onChange={e => {
                  const next = [...competitors]
                  next[i] = e.target.value
                  setCompetitors(next)
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {isRunningAll && (
        <div className="run-all-progress">
          {[
            { n: 1, label: 'Competitor Intelligence' },
            { n: 2, label: 'Dark Funnel Signals' },
            { n: 3, label: 'SEO & GEO' },
            { n: 4, label: 'What to Build Next' },
          ].map(s => {
            const done = (s.n === 1 && tab1Data) || (s.n === 2 && tab2Data) || (s.n === 3 && tab3Data) || (s.n === 4 && tab4Data)
            const running = loading[s.n]
            return (
              <div key={s.n} className={`progress-step ${done ? 'step-done' : running ? 'step-running' : 'step-pending'}`}>
                <span className="step-icon">{done ? '✓' : running ? <span className="spinner spinner-sm" /> : s.n}</span>
                {s.label}
              </div>
            )
          })}
        </div>
      )}

      <div className="tabs-nav">
        {tabs.map((t, i) => (
          <button
            key={i}
            className={`tab-btn ${activeTab === i ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            <span className={`tab-num ${[tab1Data, tab2Data, tab3Data, tab4Data][i] ? 'tab-num-done' : ''}`}>
              {[tab1Data, tab2Data, tab3Data, tab4Data][i] ? '✓' : t.num}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      <main className="main-content">
        {/* ── Tab 1 ── */}
        {activeTab === 0 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>Competitor Intelligence</h2>
                <p className="tab-desc">
                  Claude searches competitor feature pages, pricing, G2 reviews, and 2026 news live.
                </p>
              </div>
              <RunButton onClick={runTab1} loading={loading[1]} />
            </div>
            <ErrorBox error={errors[1]} onRetry={runTab1} />
            {!tab1Data && !loading[1] && !errors[1] && (
              <div className="empty-state">Click <strong>Run Analysis</strong> to search live competitor data.</div>
            )}
            {loading[1] && <div className="loading-state"><span className="spinner" /> Searching competitor pages, G2 reviews, and 2026 announcements…</div>}
            <Tab1Result data={tab1Data} />
          </div>
        )}

        {/* ── Tab 2 ── */}
        {activeTab === 1 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>Dark Funnel Signals</h2>
                <p className="tab-desc">
                  Claude searches Reddit, G2, WordPress reviews, and community forums for real buyer language.
                </p>
              </div>
              <RunButton onClick={runTab2} loading={loading[2]} />
            </div>
            <ErrorBox error={errors[2]} onRetry={runTab2} />
            {!tab2Data && !loading[2] && !errors[2] && (
              <div className="empty-state">Click <strong>Run Analysis</strong> to surface live buyer signals.</div>
            )}
            {loading[2] && <div className="loading-state"><span className="spinner" /> Scanning Reddit, G2, and WordPress for buyer signals…</div>}
            <Tab2Result data={tab2Data} />
          </div>
        )}

        {/* ── Tab 3 ── */}
        {activeTab === 2 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>SEO & GEO Comparison</h2>
                <p className="tab-desc">
                  Keyword gaps via Ahrefs MCP + AI search visibility in Perplexity and Google AI Overviews.
                </p>
              </div>
              <RunButton onClick={runTab3} loading={loading[3]} />
            </div>
            <ErrorBox error={errors[3]} onRetry={runTab3} />
            {!tab3Data && !loading[3] && !errors[3] && (
              <div className="empty-state">Click <strong>Run Analysis</strong> to check SEO gaps and GEO visibility.</div>
            )}
            {loading[3] && <div className="loading-state"><span className="spinner" /> Querying Ahrefs for keyword gaps and checking AI search visibility…</div>}
            <Tab3Result data={tab3Data} />
          </div>
        )}

        {/* ── Tab 4 ── */}
        {activeTab === 3 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>What to Build Next</h2>
                <p className="tab-desc">
                  Cross-references all three intelligence layers. Posts summary to Slack automatically.
                </p>
              </div>
              <RunButton
                onClick={runTab4}
                loading={loading[4]}
                label="Generate Strategy Report"
              />
            </div>
            {(!tab1Data || !tab2Data || !tab3Data) && (
              <div className="prereq-warning">
                <strong>Tip:</strong> Run Tabs 1–3 first for the richest recommendations. Tab 4 will still work with available data.
              </div>
            )}
            <ErrorBox error={errors[4]} onRetry={runTab4} />
            {!tab4Data && !loading[4] && !errors[4] && (
              <div className="empty-state">Click <strong>Generate Strategy Report</strong> to synthesise all intelligence layers.</div>
            )}
            {loading[4] && <div className="loading-state"><span className="spinner" /> Cross-referencing all layers, validating with live data, posting to Slack…</div>}
            <Tab4Result data={tab4Data} />

            {/* Copy Validation */}
            {tab4Data && (
              <div className="copy-validation-section">
                <div className="cv-divider">
                  <span>Copy Validation</span>
                </div>
                <p className="tab-desc">
                  Test whether your current copy speaks to <strong>{tab4Data.opportunity_buyer?.name}</strong> ({tab4Data.opportunity_buyer?.role}).
                </p>
                <div className="cv-inputs">
                  <div className="config-field">
                    <label>Content type</label>
                    <select value={contentType} onChange={e => setContentType(e.target.value)}>
                      <option>landing page headline</option>
                      <option>Google ad</option>
                      <option>email subject line</option>
                      <option>homepage hero copy</option>
                      <option>product description</option>
                      <option>blog intro</option>
                    </select>
                  </div>
                </div>
                <textarea
                  className="copy-textarea"
                  placeholder="Paste your copy here…"
                  value={copyText}
                  onChange={e => setCopyText(e.target.value)}
                  rows={5}
                />
                <RunButton
                  onClick={runCopyValidation}
                  loading={loading.cv}
                  label="Validate Copy"
                  disabled={!copyText.trim()}
                />
                <ErrorBox error={errors.cv} onRetry={runCopyValidation} />
                {loading.cv && <div className="loading-state"><span className="spinner" /> Simulating buyer reaction…</div>}
                <CopyValidationResult data={cvData} />
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
