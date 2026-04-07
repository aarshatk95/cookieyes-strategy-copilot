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
    system: `You are a competitive intelligence analyst for a B2B SaaS company.
You have live web search. Search extensively before responding.
Be specific. Reference actual feature names, pricing numbers, and real review quotes.
Return only valid JSON. Start with {`,
    user: `Analyse competitors for ${product} (${industry}).
Competitors: ${competitors.join(', ')}

For each competitor search their feature page, pricing page,
G2 reviews from last 6 months, and any 2026 news or launches.
Also search for ${product} on the same sources.

Return ONLY:
{
  "competitor_intelligence": [
    {
      "competitor": "<name>",
      "what_changed_recently": "<specific recent change>",
      "feature_gaps_they_have": ["<they offer, we do not>"],
      "feature_gaps_we_have": ["<we offer, they lack>"],
      "top_user_complaint": "<real G2 quote>",
      "recommended_action": "<one specific ${product} action>",
      "source": "<where found>"
    }
  ],
  "summary": "<2 sentence competitive picture>"
}`,
  }
}

function buildTab2Prompts(product, competitors) {
  return {
    system: `You are a buyer intelligence analyst. You find what buyers actually say in communities and reviews.
Quote real language. Name specific sources. Return only valid JSON. Start with {`,
    user: `Find live buyer signals for ${product} and similar tools.

Search: Reddit r/gdpr, r/webdev, r/privacy, r/marketing, r/sysadmin — posts from last 60 days.
Search: G2 one and two star reviews for ${competitors.join(', ')}.
Search: WordPress.org reviews for cookie consent plugins.
Search: Any forums or communities discussing GDPR tools.

Return ONLY:
{
  "top_pain_points": [
    {
      "pain": "<specific pain in plain language>",
      "frequency": "very common|common|occasional",
      "buyer_quote": "<exact words from real post or review>",
      "source": "<Reddit r/xxx or G2 or WordPress>"
    }
  ],
  "what_buyers_wish_existed": ["<specific unmet need>"],
  "competitor_complaints": [
    {
      "competitor": "<name>",
      "complaint": "<specific complaint>",
      "cookieyes_opportunity": "<how ${product} wins here>"
    }
  ],
  "buyer_language": ["<phrase buyers use ${product} should adopt>"]
}`,
  }
}

function buildTab3Prompts(product, competitors, ahrefsData = null) {
  const ahrefsSection = ahrefsData
    ? `LIVE AHREFS DATA (use this as your primary SEO source — it is real, current data):
${JSON.stringify(ahrefsData, null, 2)}

`
    : ''

  return {
    system: `You are an SEO and GEO visibility analyst for a B2B SaaS company.
You have real Ahrefs data provided directly in the prompt and live web search for GEO.
GEO means generative engine optimisation: visibility in AI search results like Perplexity, Google AI Overviews, and ChatGPT answers.
When Ahrefs data is provided, use it as the authoritative SEO source. Return only valid JSON. Start with {`,
    user: `${ahrefsSection}Compare SEO and GEO visibility for ${product} vs ${competitors.join(', ')}.

SEO ANALYSIS:
1. Search for keyword gaps — high-volume queries where ${competitors.join(', ')} rank in top 10 but ${product} does not. Include estimated search volume.
2. Compare estimated organic traffic for ${product} vs each competitor for the cookie consent keyword cluster.
3. Identify content gaps: topic clusters competitors cover where ${product} has no published content.
4. Compare referring domain counts if available.

GEO ANALYSIS via web search:
1. Search Perplexity: "best cookie consent tool for GDPR" — which tools are cited in the AI answer?
2. Search Google for the same query and check AI Overview — which tools appear?
3. Search: "GDPR compliance guide cookie consent" on Perplexity — is ${product} mentioned?
4. Search for ${product} mentions in AI-generated compliance tool recommendations.

Return ONLY:
{
  "seo_gaps": [
    {
      "query": "<keyword>",
      "monthly_volume": "<number or estimate>",
      "competitor_ranking": "<competitor and position>",
      "cookieyes_ranking": "<position or not ranking>",
      "opportunity": "<why this matters>"
    }
  ],
  "content_gaps": ["<topic cluster ${product} is missing>"],
  "content_brief": {
    "topic": "<highest priority gap topic>",
    "target_keyword": "<keyword with highest volume>",
    "recommended_title": "<H1 that ranks and appears in AI answers>",
    "what_to_cover": [
      "<section 1 — answer the buyer question found on Reddit>",
      "<section 2 — fill gap competitors have not addressed well>",
      "<section 3 — ${product}-specific solution angle>"
    ],
    "beat_the_competition": "<how to cover this better than what Cookiebot or OneTrust have already written>",
    "geo_potential": "high|medium|low"
  },
  "geo_visibility": {
    "perplexity_score": "mentioned|not mentioned|cited as top choice",
    "google_ai_overview": "mentioned|not mentioned|cited",
    "competitor_geo_scores": [
      { "competitor": "<name>", "perplexity": "<score>", "google_ai": "<score>" }
    ]
  },
  "geo_opportunity": "<specific action to improve AI visibility>",
  "quick_seo_win": "<highest value keyword gap to target first>"
}`,
  }
}

function buildTab4Prompts(product, tab1Output, tab2Output, tab3Output) {
  return {
    system: `You are the strategic advisor to ${product} product and marketing teams.
You have four intelligence reports, Ahrefs MCP, and Slack MCP.
Your job is to synthesise everything into three specific, evidence-backed recommendations and post to Slack automatically.
Return only valid JSON. Start with {`,
    user: `COMPETITOR INTELLIGENCE: ${tab1Output || 'Not yet run — synthesise from your knowledge.'}

BUYER SIGNALS: ${tab2Output || 'Not yet run — synthesise from your knowledge.'}

SEO AND GEO REPORT: ${tab3Output || 'Not yet run — synthesise from your knowledge.'}

Step 1: Search for any new privacy regulations or GDPR enforcement actions announced in 2026.
Step 2: Generate three recommendations using all available intelligence as evidence.
Step 3: Post to Slack #product-intelligence:
"STRATEGY REPORT — ${new Date().toLocaleDateString()}
Top finding: [one sentence]
Top recommendation: [one sentence]
Evidence: [one sentence]"

Return ONLY:
{
  "intelligence_summary": "<2 sentences — the most important cross-layer finding>",
  "recommendations": [
    {
      "type": "product",
      "title": "<5-7 word action>",
      "what": "<specific enough for a roadmap>",
      "evidence": "<competitor gap + buyer quote + data>",
      "urgency": "high|medium|low"
    },
    {
      "type": "marketing",
      "title": "<5-7 word action>",
      "what": "<specific content or messaging change>",
      "evidence": "<buyer language + keyword gap + content brief>",
      "urgency": "high|medium|low",
      "content_brief_summary": "<one sentence: write [title] targeting [keyword] — closes [gap] and has [high/medium/low] potential to appear in AI search answers>",
      "ready_to_brief": true
    },
    {
      "type": "seo_geo",
      "title": "<5-7 word action>",
      "what": "<specific SEO or GEO action>",
      "evidence": "<data + GEO visibility gap>",
      "urgency": "high|medium|low"
    }
  ],
  "quick_win": "<one action this week, no engineering needed>",
  "opportunity_buyer": {
    "name": "<realistic name>",
    "role": "<title and company type>",
    "pain": "<their specific pain>",
    "trigger": "<what makes them act>",
    "anxiety_2026": "<what worries them right now>"
  }
}`,
  }
}

function buildCopyValidationPrompts(buyer, intelligenceSummary, contentType, copyText) {
  return {
    system: `You are simulating ${buyer.name} (${buyer.role}).
Pain: ${buyer.pain}
Trigger: ${buyer.trigger}
Current anxiety: ${buyer.anxiety_2026}
This buyer was identified as the strategic opportunity across four intelligence layers.
Test whether current copy will reach them. Return only valid JSON. Start with {`,
    user: `Strategic context: ${intelligenceSummary}

Evaluate this ${contentType} as ${buyer.name}:
"""
${copyText}
"""

Return ONLY:
{
  "overall_score": <1-10>,
  "relevance_score": <1-10>,
  "clarity_score": <1-10>,
  "trust_score": <1-10>,
  "urgency_score": <1-10>,
  "verdict": "Would click|Would not click|Saves for later|Forwards to team|Deletes immediately",
  "inner_monologue": "<4 sentences first person. Reference specific lines. Connect to the strategic intelligence.>",
  "strategy_alignment_gap": "<what copy assumes vs what all four intelligence layers found about this buyer>",
  "what_worked": ["<specific>", "<specific>"],
  "what_didnt": ["<specific>", "<specific>"],
  "rewrite": "<rewrite the key line for the opportunity buyer>"
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
      <div className="cards-grid">
        {(data.competitor_intelligence || []).map((c, i) => (
          <div key={i} className="card">
            <div className="card-header">
              <h3>{c.competitor}</h3>
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
            <div className="source-tag">{p.source}</div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="section-title">What Buyers Wish Existed</h3>
        <ul className="wish-list">
          {(data.what_buyers_wish_existed || []).map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      </section>

      <section>
        <h3 className="section-title">Competitor Complaint Patterns</h3>
        {(data.competitor_complaints || []).map((c, i) => (
          <div key={i} className="complaint-card">
            <strong>{c.competitor}</strong>
            <p className="complaint-text">{c.complaint}</p>
            <div className="opportunity-tag">Opportunity → {c.cookieyes_opportunity}</div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="section-title">Buyer Language to Adopt</h3>
        <div className="language-chips">
          {(data.buyer_language || []).map((phrase, i) => (
            <span key={i} className="chip">"{phrase}"</span>
          ))}
        </div>
      </section>
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
                <th>Monthly Volume</th>
                <th>Competitor Ranking</th>
                <th>CookieYes</th>
                <th>Opportunity</th>
              </tr>
            </thead>
            <tbody>
              {(data.seo_gaps || []).map((g, i) => (
                <tr key={i}>
                  <td><strong>{g.query}</strong></td>
                  <td>{g.monthly_volume}</td>
                  <td>{g.competitor_ranking}</td>
                  <td className="not-ranking">{g.cookieyes_ranking}</td>
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
          <ul className="gap-list">
            {(data.content_gaps || []).map((g, i) => <li key={i}>{g}</li>)}
          </ul>
          <div className="quick-win-box">
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
          {(data.geo_visibility?.competitor_geo_scores || []).map((c, i) => (
            <div key={i} className="competitor-geo-row">
              <span>{c.competitor}</span>
              <span className="geo-tag">Perplexity: {c.perplexity}</span>
              <span className="geo-tag">Google AI: {c.google_ai}</span>
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
            <div className="brief-row">
              <label>Recommended title</label><span>{data.content_brief.recommended_title}</span>
            </div>
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
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Tab 4 Result ─────────────────────────────────────────────────────────────

function Tab4Result({ data }) {
  if (!data) return null
  const typeIcon = { product: '🛠', marketing: '📣', seo_geo: '🔍' }
  const typeLabel = { product: 'Product', marketing: 'Marketing', seo_geo: 'SEO / GEO' }

  return (
    <div className="result-section">
      <div className="intel-summary-box">
        <strong>Intelligence Summary</strong>
        <p>{data.intelligence_summary}</p>
      </div>

      <h3 className="section-title">Three Recommendations</h3>
      {(data.recommendations || []).map((r, i) => (
        <div key={i} className="recommendation-card">
          <div className="rec-header">
            <span className="rec-type">{typeLabel[r.type] || r.type}</span>
            <Badge urgency={r.urgency} />
          </div>
          <h4>{r.title}</h4>
          <p className="rec-what">{r.what}</p>
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
        <strong>Quick Win This Week</strong>
        <p>{data.quick_win}</p>
      </div>

      {data.opportunity_buyer && (
        <div className="buyer-card">
          <h3 className="section-title">Opportunity Buyer</h3>
          <div className="buyer-grid">
            <div><label>Name</label><p>{data.opportunity_buyer.name}</p></div>
            <div><label>Role</label><p>{data.opportunity_buyer.role}</p></div>
            <div><label>Pain</label><p>{data.opportunity_buyer.pain}</p></div>
            <div><label>Trigger</label><p>{data.opportunity_buyer.trigger}</p></div>
            <div className="buyer-full"><label>2026 Anxiety</label><p>{data.opportunity_buyer.anxiety_2026}</p></div>
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

      <div className="rewrite-box">
        <label>Suggested Rewrite</label>
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

      <div className="tabs-nav">
        {tabs.map((t, i) => (
          <button
            key={i}
            className={`tab-btn ${activeTab === i ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(i)}
          >
            <span className="tab-num">{t.num}</span>
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
