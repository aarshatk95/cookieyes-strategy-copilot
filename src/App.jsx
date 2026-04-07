import { useState, useCallback } from 'react'

// ─── Claude API helper ────────────────────────────────────────────────────────

function stripLineComments(s) {
  let result = ''
  let inStr = false, esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (esc) { result += ch; esc = false; continue }
    if (inStr) {
      if (ch === '\\') { result += ch; esc = true; continue }
      if (ch === '"') inStr = false
      result += ch
      continue
    }
    if (ch === '"') { inStr = true; result += ch; continue }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    result += ch
  }
  return result
}

// Escape unescaped double-quotes that appear inside JSON string values.
// Walks char-by-char; when inside a string, any `"` not preceded by `\` that
// is NOT followed (after whitespace) by `,` `}` `]` `:` is treated as an
// embedded literal quote and gets escaped to `\"`.
function fixUnescapedQuotes(s) {
  let result = ''
  let i = 0
  const len = s.length
  while (i < len) {
    const ch = s[i]
    if (ch !== '"') { result += ch; i++; continue }
    // Opening quote of a string
    result += '"'
    i++
    while (i < len) {
      const c = s[i]
      if (c === '\\') {
        result += c; i++
        if (i < len) { result += s[i]; i++ }
        continue
      }
      if (c === '"') {
        // Peek past whitespace to decide if this is the real closing quote
        let j = i + 1
        while (j < len && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++
        const next = s[j]
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          result += '"'; i++; break   // real closing quote
        } else {
          result += '\\"'; i++        // embedded quote — escape it
        }
        continue
      }
      result += c; i++
    }
  }
  return result
}

function extractJSON(text) {
  const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const match = stripped.match(/\{[\s\S]*/)
  if (!match) throw new Error('No JSON object found in response')

  let raw = match[0]

  // Try clean parse first
  try { return JSON.parse(raw) } catch {}

  // Stage 1: strip // line comments Claude occasionally injects outside strings
  let repaired = stripLineComments(raw)

  // Stage 2: replace curly-quote variants (do this early so later stages see straight quotes)
  repaired = repaired.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")

  // Stage 3: escape literal control characters inside JSON strings
  // (Claude sometimes writes multi-line strings without \n escaping)
  repaired = repaired.replace(/"(?:[^"\\]|\\.)*"/g, m =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
  )

  // Stage 4: remove trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1')

  try { return JSON.parse(repaired) } catch {}

  // Stage 5: fix unescaped double-quotes inside string values
  // ("Expected ',' or '}' after property value" error)
  const quotesFixed = fixUnescapedQuotes(repaired)

  // Re-apply trailing-comma cleanup after quote fix
  const quotesFixedClean = quotesFixed.replace(/,(\s*[}\]])/g, '$1')

  try { return JSON.parse(quotesFixedClean) } catch {}

  // Stage 6: close truncated JSON (hit max_tokens mid-response)
  const stack = []
  let inStr = false, esc = false
  for (const ch of quotesFixedClean) {
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop()
  }
  // Strip trailing incomplete token, then close open brackets
  const truncated = quotesFixedClean.replace(/,?\s*"[^"]*$/, '').replace(/,?\s*[\w"]+[^}\]]*$/, '')
  const closed = truncated + stack.reverse().join('')

  try { return JSON.parse(closed) } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Try running again — Claude occasionally produces a small formatting error.`)
  }
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

// Derive a root domain for Ahrefs from a product/competitor label (e.g. "Acme Corp" → acmecorp.com).
// Users can paste a real domain (e.g. acme.com) as the name when the heuristic is wrong.
function toDomain(name) {
  if (!name || typeof name !== 'string') return ''
  const t = name.trim().toLowerCase()
  if (!t) return ''
  if (/\./.test(t) && !/\s/.test(t)) {
    return t.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '')
  }
  return `${t.replace(/[^a-z0-9]/g, '')}.com`
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
  const compList = competitors.filter(Boolean)
  return {
    system: `You are a senior competitive intelligence analyst specialising in B2B SaaS.
You have live web search. Search extensively — multiple queries per competitor.
You quote real people. You name real sources. You find things the company does not know yet.
You never fabricate data. If you cannot find something, say not found.
Return only valid JSON. No markdown. Start with {`,
    user: `Run a deep competitive intelligence sweep for ${product} in the ${industry} space.
Competitors to analyse: ${compList.join(', ')}

For EACH competitor run ALL of these searches:
1. "{competitor} new features 2026"
2. "{competitor} pricing 2026"
3. "{competitor} reviews" on G2 and Capterra
4. "{competitor} complaints OR problems OR alternatives 2026"
5. "{competitor} vs ${product}" — how do buyers compare them?
Repeat for every competitor listed.

Also search:
- "${product} reviews" on G2 and Capterra
- "${product} complaints OR problems 2026"
- "${product} vs {each competitor}"
- "${industry} market news 2026"
- "${industry} platform update 2026"
- "best ${industry} tool 2026"

For every finding record: exact verbatim quote, exact source, date if visible.

Return ONLY this JSON:
{
  "competitor_intelligence": [
    {
      "competitor": "<name>",
      "what_changed_recently": "<specific feature, pricing, or messaging change — include date if found>",
      "feature_gaps_they_have": [
        "<specific feature they offer that ${product} lacks — be concrete>"
      ],
      "feature_gaps_we_have": [
        "<specific ${product} advantage over this competitor — backed by evidence>"
      ],
      "what_buyers_love": [
        {
          "feature": "<specific feature buyers praise>",
          "why_they_love_it": "<what they say about it>",
          "exact_quote": "<verbatim positive review quote>",
          "implication_for_product": "<does ${product} have this? if not, should it build it?>"
        }
      ],
      "what_buyers_hate": [
        {
          "complaint": "<specific complaint>",
          "exact_quote": "<verbatim negative review quote>",
          "product_opportunity": "<how ${product} wins here specifically>"
        }
      ],
      "top_user_complaint": "<verbatim quote from a real G2, Capterra, or Reddit review>",
      "second_complaint": "<another verbatim complaint from a different source>",
      "buyer_profile": "<who actually buys this based on G2 reviewer job titles and company sizes>",
      "recommended_action": {
        "build": "<specific feature to build or improve>",
        "counter": "<specific angle to counter competitor weakness>",
        "urgency": "high|medium|low"
      },
      "source": "<exact platform and URL>"
    }
  ],
  "market_signals": [
    "<important trend or announcement in ${industry} in 2026 — with source>",
    "<another market signal with source>"
  ],
  "feature_benchmark": {
    "must_have_features": ["<feature every competitor has that buyers expect as table stakes>"],
    "battleground_features": ["<feature where competitors are actively competing>"],
    "whitespace_features": ["<feature NO competitor has well that buyers keep asking for>"]
  },
  "summary": "<3 sentences — the most important competitive finding and what ${product} should do about it immediately>"
}`,
  }
}

function buildTab2Prompts(product, industry, competitors) {
  const compList = competitors.filter(Boolean)
  return {
    system: `You are a buyer intelligence analyst who reads thousands of online conversations.
You find what buyers actually say — not marketing copy, not company claims.
Real words from real people in real communities.
You never paraphrase. You quote directly. You name the exact source.
Return only valid JSON. No markdown. Start with {`,
    user: `Find the raw unfiltered voice of buyers evaluating ${product} and similar tools in ${industry}.

Run ALL of these searches — do not skip any:

Community searches:
- site:reddit.com "${industry}" tool recommendation 2026
- site:reddit.com "${product}" complaint OR problem OR expensive OR alternative
- site:reddit.com "${compList[0]}" frustrating OR difficult OR pricing OR cancel
- site:reddit.com "${compList[1] || compList[0]}" problem OR bad OR alternative
- "${industry} software" recommendation forum 2026
- "${product} vs ${compList[0]}" community discussion

Review searches:
- "${product}" site:g2.com — especially 1 and 2 star reviews
- "${compList[0]}" site:g2.com — 1 and 2 star reviews only
- "${compList[1] || compList[0]}" site:g2.com complaints
- "${industry} software" site:capterra.com reviews
- "${product}" site:trustpilot.com OR site:getapp.com

Blog and community searches:
- "${industry} tool" site:dev.to OR site:hashnode.com 2026
- "best ${industry} software" community discussion 2026
- "${product} alternative" 2026
- "${industry}" slack community OR discord discussion tool

For each finding record: exact verbatim quote, platform name, subreddit or URL, date if visible, reviewer job title if shown.

Return ONLY this JSON:
{
  "top_pain_points": [
    {
      "pain": "<the pain in one clear plain-language sentence>",
      "frequency": "very common|common|occasional",
      "buyer_quote": "<verbatim quote — never paraphrase>",
      "reviewer_context": "<job title or company size if visible>",
      "source": "<exact platform and URL or subreddit>"
    }
  ],
  "what_buyers_wish_existed": [
    {
      "wish": "<specific capability or feature they are asking for>",
      "evidence": "<exact quote showing this wish>",
      "source": "<where found>"
    }
  ],
  "competitor_complaints": [
    {
      "competitor": "<name>",
      "complaint": "<specific complaint in buyer language>",
      "frequency": "very common|common|occasional",
      "exact_quote": "<verbatim from review or post>",
      "opportunity": "<how ${product} specifically wins here — be concrete>"
    }
  ],
  "buyer_language": [
    {
      "phrase": "<exact phrase buyers use repeatedly>",
      "context": "<what they mean when they say this>",
      "use_in_copy": "<how ${product} should use this phrase in messaging>"
    }
  ],
  "emerging_concerns_2026": [
    "<new regulation, technology, or market event changing what buyers in ${industry} need right now — with source>"
  ]
}`,
  }
}

function buildTab3Prompts(product, industry, competitors, ahrefsData = null) {
  const compList = competitors.filter(Boolean)
  const ahrefsSection = ahrefsData
    ? `LIVE AHREFS DATA — treat this as your primary SEO source:
${JSON.stringify(ahrefsData, null, 2)}

`
    : ''

  return {
    system: `You are a senior SEO and GEO analyst specialising in B2B SaaS visibility.
GEO means generative engine optimisation — appearing in AI-generated answers on
Perplexity, Google AI Overviews, ChatGPT, Bing Copilot, and Gemini.
You search as an anonymous buyer with no brand preference.
You report only what you actually find — never what should be there.
Every GEO finding must be verbatim — quote exactly what the AI answer said.
Return only valid JSON. No markdown. Start with {`,
    user: `${ahrefsSection}Run a complete SEO and GEO visibility analysis for ${product} vs ${compList.join(', ')} in ${industry}.

SEO ANALYSIS:
First identify the 6-8 most important search queries a buyer in ${industry} would use to find a tool like ${product}. Generate these yourself based on the product and industry — do not use hardcoded or generic queries.

For each query search and note: who ranks 1-3, whether ${product} appears, estimated monthly volume if shown.

Also search:
- "${product} vs ${compList[0]}" — who owns comparison content?
- "${product} vs ${compList[1] || compList[0]}" — same
- "${product} alternative" — what comes up?
- "${product} pricing" — does ${product} rank for its own pricing queries?
- "${compList[0]} blog 2026" — what content are they producing?
- "${product} blog OR resources 2026" — what is ${product} publishing?
- "${industry} guide 2026" — who owns educational content in this space?

GEO ANALYSIS:
Generate the 3 most natural questions a buyer would ask an AI tool to find ${product}. Then search each on multiple platforms:

1. Search Perplexity with buyer question 1.
   Record EXACTLY which tools appear, in what order, and what is said verbatim.

2. Search Perplexity with buyer question 2.
   Record EXACTLY what appears.

3. Search Perplexity for: "${product} alternative"
   What does it recommend?

4. Search Google for buyer question 1.
   Does an AI Overview appear? Who is cited? Quote it exactly.

5. Search for what ChatGPT recommends in this product category.
   Search: "ChatGPT recommendation ${industry} tool 2026"

6. Search "${product}" directly on Perplexity.
   What does it say about the product? Positive, neutral, or absent?

7. Search Bing for buyer question 1.
   Does Copilot surface anyone?

8. Search "${compList[0]} vs ${product}" on Perplexity.
   Who wins the comparison?

For every GEO search: report exactly what you found verbatim.
Do not report what should be there — only what actually is.

Return ONLY this JSON:
{
  "buyer_queries_identified": [
    "<query 1 a real buyer would search — generated from the industry>",
    "<query 2>",
    "<query 3>"
  ],
  "seo_gaps": [
    {
      "query": "<exact search query>",
      "monthly_volume": "<number or estimate>",
      "top_rankers": ["<tool 1>", "<tool 2>", "<tool 3>"],
      "product_ranking": "<position or not in top 10>",
      "gap_severity": "high|medium|low",
      "opportunity": "<specific reason this matters for ${product}>"
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
    "secondary_keywords": ["<related keyword>", "<related keyword>"],
    "recommended_title": "<H1 written to both rank on Google AND get cited in AI answers>",
    "search_intent": "<what the buyer actually wants when they search this>",
    "what_to_cover": [
      "<section 1 — answer the specific question buyers ask in communities>",
      "<section 2 — angle competitors have not taken yet>",
      "<section 3 — ${product}-specific solution with clear CTA>",
      "<section 4 — FAQ block targeting long-tail and voice queries>"
    ],
    "beat_the_competition": "<specific reason this will outperform existing competitor content>",
    "geo_optimisation_tip": "<one specific thing to include so AI answers cite this piece>",
    "geo_potential": "high|medium|low"
  },
  "geo_searches_run": [
    {
      "query": "<exact query searched>",
      "platform": "Perplexity|Google AI Overview|Bing Copilot|ChatGPT|Gemini",
      "product_mentioned": true,
      "product_position": "cited as top|mentioned|not mentioned",
      "who_appeared": ["<tool 1>", "<tool 2>", "<tool 3>"],
      "exact_finding": "<verbatim what the AI answer said>"
    }
  ],
  "geo_visibility": {
    "overall_geo_score": "<X out of 5 AI platforms where ${product} appears>",
    "perplexity_score": "mentioned|not mentioned|cited as top choice",
    "perplexity_exact_finding": "<verbatim what Perplexity said>",
    "google_ai_overview": "mentioned|not mentioned|cited",
    "google_ai_exact_finding": "<verbatim what Google AI said>",
    "chatgpt_score": "mentioned|not mentioned|cited as top choice",
    "bing_copilot_score": "mentioned|not mentioned|cited",
    "gemini_score": "mentioned|not mentioned|cited",
    "competitor_geo_scores": [
      {
        "competitor": "<name>",
        "perplexity": "mentioned|not mentioned|cited as top choice",
        "google_ai": "mentioned|not mentioned|cited",
        "chatgpt": "mentioned|not mentioned|cited",
        "overall": "<X out of 5 platforms>",
        "geo_advantage": "<why they appear and ${product} does not>"
      }
    ]
  },
  "geo_opportunity": "<the single most impactful action ${product} can take to start appearing in AI answers>",
  "quick_seo_win": "<one specific keyword or content action showing results within 30 days>"
}`,
  }
}

function buildTab4Prompts(product, industry, tab1Output, tab2Output, tab3Output, tab5Output) {
  return {
    system: `You are the Chief Strategy Officer advising the ${product} leadership team.
You have four fresh intelligence reports about the ${industry} market.
Your job is to synthesise them into decisions — not observations.
Every recommendation must be specific enough to act on tomorrow.
Every recommendation must cite real evidence from the reports.
You also search for breaking news that changes the picture.
Return only valid JSON. No markdown. Start with {`,
    user: `You have four live intelligence reports. Read every word before responding.

COMPETITOR INTELLIGENCE REPORT:
${tab1Output || `Run Tab 1 first for best results. Search the web for current knowledge of the ${industry} market.`}

BUYER SIGNALS REPORT:
${tab2Output || `Run Tab 2 first for best results. Search the web for current buyer signals in ${industry}.`}

SEO AND GEO REPORT:
${tab3Output || `Run Tab 3 first for best results. Search the web for ${product} SEO and GEO visibility.`}

ICP DISCOVERY REPORT:
${tab5Output || `Run ICP Discovery first for best results. Search the web for who actually buys in ${industry}.`}

Before generating recommendations also search:
- "${industry} regulation OR compliance news 2026"
- "${industry} market trends 2026"
- "${product} news 2026"
- "best ${industry} tool 2026" — who is winning right now?

Rules — non-negotiable:
- Product recommendation: specific enough for a sprint ticket. Name the feature, user flow, success metric. Cross-reference with ICP Discovery — build for the highest-priority ICP first.
- Marketing recommendation: name the exact content piece. Title, format, target keyword, primary argument. Tie messaging to the ICP's exact pain language from the ICP Discovery report.
- SEO/GEO recommendation: name the exact keyword or platform to target.
- ICP recommendation: use the ICP Discovery report to name the highest-value segment to pursue and the one action to win them.
- Every recommendation cites a specific finding from the reports.
- Opportunity buyer must come directly from the ICP Discovery report's recommended_icp_priority — use their name, title, pain, and trigger verbatim.
- Slack message must be ready to copy and post verbatim right now.

Return ONLY this JSON:
{
  "intelligence_summary": "<2 sentences — the most important cross-layer finding and its direct implication for ${product}>",
  "breaking_context": "<any 2026 news found that changes the recommendation — with source>",
  "recommendations": [
    {
      "type": "product",
      "title": "<5-7 word action title — start with a verb>",
      "what": "<specific enough for a sprint ticket — name the feature, user flow, and success metric>",
      "why_now": "<the specific competitive or buyer evidence making this urgent>",
      "evidence": "<direct quote or finding from the reports above>",
      "urgency": "high|medium|low",
      "effort": "low|medium|high",
      "impact": "low|medium|high"
    },
    {
      "type": "marketing",
      "title": "<5-7 word action title>",
      "what": "<exact content piece — title, format, target keyword, primary argument>",
      "why_now": "<specific buyer signal or GEO gap making this urgent>",
      "evidence": "<direct quote or finding from the reports above>",
      "urgency": "high|medium|low",
      "content_brief_summary": "<one sentence: write [exact title] targeting [exact keyword] — closes [specific gap] and has [high/medium/low] GEO potential>",
      "ready_to_brief": true
    },
    {
      "type": "seo_geo",
      "title": "<5-7 word action title>",
      "what": "<specific action — exact keyword to target or exact AI platform to optimise for>",
      "why_now": "<specific gap from the SEO/GEO report>",
      "evidence": "<direct finding from the intelligence>",
      "urgency": "high|medium|low"
    },
    {
      "type": "icp",
      "title": "<5-7 word action title — start with a verb>",
      "segment": "<the highest-priority ICP segment from the ICP Discovery report>",
      "what": "<the one specific thing to do this week to win this segment — name the feature, content, or outreach action>",
      "why_now": "<specific evidence from the ICP Discovery report making this the top priority>",
      "evidence": "<direct quote or finding from the ICP Discovery report>",
      "urgency": "high|medium|low",
      "effort": "low|medium|high"
    }
  ],
  "quick_win": "<one specific action the team can take TODAY — no engineering required>",
  "slack_message": "STRATEGY REPORT — ${new Date().toLocaleDateString()}\n\nProduct: ${product}\nTop finding: <one sentence>\nTop recommendation: <title of highest urgency recommendation>\nEvidence: <one specific data point>\nQuick win: <the quick win>",
  "opportunity_buyer": {
    "name": "<use the rank-1 ICP name from the ICP Discovery report if available, else a realistic full name>",
    "role": "<use the rank-1 ICP title and company type from the ICP Discovery report>",
    "company_size": "<employee range from the ICP Discovery report>",
    "pain": "<use their exact pain_in_their_words from the ICP Discovery report — verbatim>",
    "trigger": "<use their trigger from the ICP Discovery report>",
    "anxiety_2026": "<what is specifically worrying them right now — from ICP Discovery or live research>",
    "where_they_search": "<use what_they_search from the ICP Discovery report>"
  }
}`,
  }
}

function buildCopyValidationPrompts(buyer, intelligenceSummary, contentType, copyText) {
  return {
    system: `You are ${buyer.name}, ${buyer.role} at a ${buyer.company_size || 'mid-size'} company.
You are a real person evaluating this copy. You are not helpful. You are not generous.
You are skeptical, busy, and have seen many tools claiming to solve your problem.
Your pain right now: ${buyer.pain}
What triggered your search today: ${buyer.trigger}
What is keeping you up at night: ${buyer.anxiety_2026}
Where you find answers: ${buyer.where_they_search || 'Google, Reddit, Perplexity, G2'}
Score this copy honestly as you would in real life.
Return only valid JSON. No markdown. Start with {`,
    user: `Before scoring search for:
- What are ${buyer.role} professionals saying about tools like this in 2026?
- What does this type of copy typically signal to a skeptical buyer?

Strategic context: ${intelligenceSummary}

Read this ${contentType} as ${buyer.name}:
"""
${copyText}
"""

Read it once. React as you would in real life. Then score it.

Return ONLY this JSON:
{
  "overall_score": <1-10>,
  "relevance_score": <1-10>,
  "clarity_score": <1-10>,
  "trust_score": <1-10>,
  "urgency_score": <1-10>,
  "verdict": "Would click|Would not click|Saves for later|Forwards to team|Deletes immediately",
  "first_reaction": "<first thought in 3 words — raw and honest>",
  "inner_monologue": "<5 sentences first person. Reference specific words from the copy. Connect to your real pain and anxiety. Brutally honest — what you actually think, not what you would say politely.>",
  "strategy_alignment_gap": "<specific mismatch between what this copy assumes about you and what you actually care about right now>",
  "what_worked": [
    "<specific word or phrase that landed and exactly why>",
    "<another specific thing that worked>"
  ],
  "what_didnt": [
    "<specific word or phrase that failed and exactly why>",
    "<another specific failure>"
  ],
  "the_one_thing_missing": "<the single most important thing this copy does not say that would make you stop>",
  "rewrite": "<rewrite the full copy in this buyer's exact language. Address their specific 2026 anxiety. Make it impossible to ignore.>"
}`,
  }
}

function buildTab5Prompts(product, industry, competitors) {
  const compList = competitors.filter(Boolean)
  return {
    system: `You are a senior ICP research analyst specialising in B2B SaaS.
You discover who actually buys products by researching real public data.
Not who companies claim to target. Who is actually purchasing and reviewing.
You search extensively before drawing any conclusions.
Every ICP must be backed by specific evidence.
You find multiple distinct buyer types — minimum 4.
Return only valid JSON. No markdown. Start with {`,
    user: `Discover and deeply research all real buyer profiles for ${product} and its competitors in ${industry}.
Competitors: ${compList.join(', ')}

Do not use assumed buyer profiles. Research everything from scratch.

STEP 1 — WHO ACTUALLY BUYS ${product}?
- "${product} reviews" on G2 — what job titles are reviewing?
- "${product} case study" OR "${product} customer story" — who is featured?
- "${product}" on LinkedIn — what roles mention using it?
- "${product} testimonial" — who is quoted, what is their role?
- "${product}" on Reddit — who mentions using it and why?
- "${product} review" on Capterra or GetApp

STEP 2 — WHO ACTUALLY BUYS EACH COMPETITOR?
For each competitor run identical searches.
Note: primary buyer type, company size, why they chose it.
Which buyer types appear for competitors but NOT for ${product}?

STEP 3 — FIND UNDERSERVED SEGMENTS
- "${industry} tool for [specific role]" — where answers are weak or absent
- "${industry} software" on Reddit asking for recommendations with no clear winner
- "${industry} tool" small business OR startup OR enterprise OR agency 2026
- "${industry} tool" freelancer OR consultant 2026
- "${industry} tool" non-profit OR government OR education 2026
- "best ${industry} tool for [role]" — where existing answers disappoint

STEP 4 — VALIDATE EACH ICP
For each ICP found, confirm:
- Evidence they are actively searching for solutions
- Evidence they have budget and authority to buy
- Evidence no competitor is winning them decisively
- Their exact language describing their problem

Return ONLY this JSON — minimum 4 distinct ICPs:
{
  "research_summary": "<3 sentences on sources searched, patterns found, confidence level>",
  "product_icps": [
    {
      "icp_id": 1,
      "name": "<realistic full name>",
      "title": "<specific job title — not generic>",
      "seniority": "C-suite|VP|Director|Manager|Individual Contributor",
      "company_type": "<specific type e.g. B2B SaaS startup, enterprise retailer>",
      "company_size": "<employee range>",
      "industry_vertical": "<specific vertical>",
      "geography": "<primary geography based on evidence>",
      "pain_in_their_words": "<verbatim or very close paraphrase from real review or post>",
      "trigger": "<specific event that makes them start searching today>",
      "what_they_search": "<exact queries they type>",
      "why_they_choose_product": "<evidence-based reason for choosing ${product}>",
      "what_they_compare": ["<competitor 1>", "<competitor 2>"],
      "objections": ["<objection before buying>", "<another objection>"],
      "evidence": "<specific source — G2 job title, Reddit post, case study URL>",
      "confidence": "high|medium|low",
      "estimated_segment_size": "large|medium|small"
    }
  ],
  "competitor_icps": [
    {
      "competitor": "<name>",
      "primary_buyer": {
        "title": "<job title>",
        "company_type": "<type>",
        "company_size": "<size>",
        "why_they_choose_this": "<evidence-based reason>",
        "evidence": "<source>"
      },
      "secondary_buyers": [
        { "title": "<job title>", "company_type": "<type>", "evidence": "<source>" }
      ],
      "buyers_we_could_steal": "<which of their buyers ${product} could win and exactly what it would take>"
    }
  ],
  "icp_gaps": [
    {
      "segment": "<buyer type with intent but not buying ${product}>",
      "size": "large|medium|small",
      "currently_buying": "<which competitor or no one>",
      "why_not_buying_product": "<specific barrier — missing feature, messaging, pricing, awareness>",
      "what_would_make_them_switch": "<one specific thing ${product} could do>",
      "evidence": "<where you found this>"
    }
  ],
  "whitespace_segments": [
    {
      "name": "<realistic name>",
      "title": "<specific job title>",
      "company_type": "<company type>",
      "company_size": "<employee range>",
      "why_unserved": "<specific reason no competitor wins them decisively>",
      "search_signal": "<evidence they are searching — Reddit post, forum thread, search trend>",
      "pain": "<their exact pain in their own words>",
      "what_they_need": "<specific product or content capability to win them>",
      "estimated_size": "large|medium|small",
      "urgency": "high|medium|low"
    }
  ],
  "icp_comparison_matrix": [
    {
      "segment": "<buyer type>",
      "product_fit": "strong|present|weak|absent",
      "competitor_fits": [
        { "competitor": "<name>", "fit": "strong|present|weak|absent" }
      ]
    }
  ],
  "trending_2026": [
    {
      "trend": "<what is shifting in this buyer category right now>",
      "impact_on_icp": "<how this changes who buys and why>",
      "new_buyer_emerging": "<any new buyer type this trend creates>",
      "evidence": "<source and date>"
    }
  ],
  "recommended_icp_priority": [
    {
      "rank": 1,
      "icp": "<name from product_icps or whitespace_segments>",
      "why_prioritise": "<specific business reason — size, growth, competitive gap>",
      "first_action": "<one concrete thing ${product} should do this week to win this ICP>"
    }
  ]
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
      {data.feature_benchmark && (
        <div className="feature-benchmark">
          {[
            { key: 'must_have_features', label: 'Table Stakes', cls: 'bench-must' },
            { key: 'battleground_features', label: 'Battleground', cls: 'bench-battle' },
            { key: 'whitespace_features', label: 'Whitespace Opportunity', cls: 'bench-white' },
          ].map(({ key, label, cls }) => (data.feature_benchmark[key] || []).length > 0 && (
            <div key={key} className={`bench-col ${cls}`}>
              <strong>{label}</strong>
              <ul>{data.feature_benchmark[key].map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          ))}
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
              {(c.what_buyers_love || []).length > 0 && (
                <div className="field">
                  <label>What buyers love</label>
                  {c.what_buyers_love.map((l, j) => (
                    <div key={j} className="love-item">
                      <strong>{l.feature}</strong>
                      {l.exact_quote && <blockquote className="love-quote">"{l.exact_quote}"</blockquote>}
                      {l.implication_for_product && <p className="implication">{l.implication_for_product}</p>}
                    </div>
                  ))}
                </div>
              )}
              {(c.what_buyers_hate || []).length > 0 && (
                <div className="field">
                  <label>What buyers hate</label>
                  {c.what_buyers_hate.map((h, j) => (
                    <div key={j} className="hate-item">
                      <p>{h.complaint}</p>
                      {h.exact_quote && <blockquote>"{h.exact_quote}"</blockquote>}
                      {h.product_opportunity && <div className="opportunity-tag">{h.product_opportunity}</div>}
                    </div>
                  ))}
                </div>
              )}
              {(c.table_stakes_features || []).length > 0 && (
                <div className="field">
                  <label>Table stakes</label>
                  <ul>{c.table_stakes_features.map((f, j) => <li key={j}>{f}</li>)}</ul>
                </div>
              )}
              {(c.differentiator_features || []).length > 0 && (
                <div className="field">
                  <label>Differentiators</label>
                  <ul>{c.differentiator_features.map((f, j) => <li key={j}>{f}</li>)}</ul>
                </div>
              )}
              {c.buyer_profile && (
                <div className="field">
                  <label>Who buys this</label>
                  <p>{c.buyer_profile}</p>
                </div>
              )}
              {c.recommended_action && (
                <div className="field action-field">
                  <label>Recommended action</label>
                  {typeof c.recommended_action === 'string'
                    ? <p>{c.recommended_action}</p>
                    : <>
                        {c.recommended_action.build && <p><strong>Build:</strong> {c.recommended_action.build}</p>}
                        {c.recommended_action.counter && <p><strong>Counter:</strong> {c.recommended_action.counter}</p>}
                      </>
                  }
                </div>
              )}
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
            <div className="opportunity-tag">Opportunity → {c.opportunity}</div>
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

function Tab3Result({ data, productLabel }) {
  if (!data) return null
  const rankingCol = productLabel?.trim() || 'Your product'
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
                <th>{rankingCol}</th>
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
                  <td className="not-ranking">{g.product_ranking}</td>
                  <td>{g.gap_severity && <Badge urgency={g.gap_severity} />}</td>
                  <td>{g.opportunity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(data.geo_searches_run || []).length > 0 && (
        <section>
          <h3 className="section-title">GEO Searches Run</h3>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr><th>Query</th><th>Platform</th><th>Product</th><th>Who Appeared</th><th>Exact Finding</th></tr>
              </thead>
              <tbody>
                {data.geo_searches_run.map((s, i) => (
                  <tr key={i}>
                    <td><strong>{s.query}</strong></td>
                    <td>{s.platform}</td>
                    <td className={s.product_mentioned ? '' : 'not-ranking'}>{s.product_position}</td>
                    <td>{(s.who_appeared || []).join(', ')}</td>
                    <td style={{ maxWidth: '260px', fontSize: '12px' }}>{s.exact_finding}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
          {data.overall_geo_score && (
            <div className="overall-geo-score">
              <strong>Overall GEO Score</strong>
              <span>{data.overall_geo_score}</span>
            </div>
          )}
          {[
            { key: 'perplexity_score', label: 'Perplexity', finding: data.geo_visibility?.perplexity_exact_finding },
            { key: 'google_ai_overview', label: 'Google AI', finding: data.geo_visibility?.google_ai_exact_finding },
            { key: 'chatgpt_score', label: 'ChatGPT', finding: null },
            { key: 'bing_copilot_score', label: 'Bing Copilot', finding: null },
          ].filter(p => data.geo_visibility?.[p.key]).map(p => (
            <div key={p.key} className={`geo-item ${data.geo_visibility[p.key]?.includes('not') ? 'geo-bad' : 'geo-good'}`}>
              <span>{p.label}</span>
              <strong>{data.geo_visibility[p.key]}</strong>
            </div>
          ))}
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
              {c.chatgpt && <span className="geo-tag">ChatGPT: {c.chatgpt}</span>}
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

// ─── Tab 5 Result ─────────────────────────────────────────────────────────────

function Tab5Result({ data }) {
  if (!data) return null
  const fitColor = { strong: '#22c55e', present: '#f59e0b', weak: '#ef4444', absent: '#6b7280' }
  return (
    <div className="result-section">
      {data.research_summary && (
        <div className="summary-box">{data.research_summary}</div>
      )}

      {(data.recommended_icp_priority || []).length > 0 && (
        <section>
          <h3 className="section-title">ICP Priority Ranking</h3>
          {data.recommended_icp_priority.map((r, i) => (
            <div key={i} className="recommendation-card">
              <div className="rec-header">
                <span className="rec-type">#{r.rank}</span>
              </div>
              <h4>{r.icp}</h4>
              <p className="rec-what">{r.why_prioritise}</p>
              <div className="rec-evidence">
                <label>First action this week</label>
                <p>{r.first_action}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      {(data.product_icps || []).length > 0 && (
        <section>
          <h3 className="section-title">Confirmed Buyer Profiles</h3>
          <div className="cards-grid">
            {data.product_icps.map((icp, i) => (
              <div key={i} className="card">
                <div className="card-header">
                  <h3>{icp.name}</h3>
                  {icp.confidence && <span className={`badge ${icp.confidence === 'high' ? 'badge-high' : icp.confidence === 'medium' ? 'badge-medium' : 'badge-low'}`}>{icp.confidence}</span>}
                </div>
                <div className="card-body">
                  <div className="field"><label>Title</label><p>{icp.title}</p></div>
                  <div className="field"><label>Company</label><p>{icp.company_type} · {icp.company_size}</p></div>
                  {icp.industry_vertical && <div className="field"><label>Vertical</label><p>{icp.industry_vertical}</p></div>}
                  {icp.geography && <div className="field"><label>Geography</label><p>{icp.geography}</p></div>}
                  {icp.pain_in_their_words && (
                    <div className="field">
                      <label>Pain in their words</label>
                      <blockquote>"{icp.pain_in_their_words}"</blockquote>
                    </div>
                  )}
                  {icp.trigger && <div className="field"><label>Trigger</label><p>{icp.trigger}</p></div>}
                  {icp.what_they_search && <div className="field"><label>What they search</label><p>{icp.what_they_search}</p></div>}
                  {(icp.objections || []).length > 0 && (
                    <div className="field">
                      <label>Objections</label>
                      <ul>{icp.objections.map((o, j) => <li key={j}>{o}</li>)}</ul>
                    </div>
                  )}
                  {icp.evidence && <div className="field source-field"><label>Evidence</label><p>{icp.evidence}</p></div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(data.whitespace_segments || []).length > 0 && (
        <section>
          <h3 className="section-title">Whitespace Segments (Unserved)</h3>
          <div className="cards-grid">
            {data.whitespace_segments.map((s, i) => (
              <div key={i} className="card">
                <div className="card-header">
                  <h3>{s.name}</h3>
                  {s.urgency && <span className={`badge ${s.urgency === 'high' ? 'badge-high' : s.urgency === 'medium' ? 'badge-medium' : 'badge-low'}`}>{s.urgency}</span>}
                </div>
                <div className="card-body">
                  <div className="field"><label>Title</label><p>{s.title}</p></div>
                  <div className="field"><label>Company</label><p>{s.company_type} · {s.company_size}</p></div>
                  {s.pain && <div className="field"><label>Pain</label><blockquote>"{s.pain}"</blockquote></div>}
                  {s.why_unserved && <div className="field"><label>Why unserved</label><p>{s.why_unserved}</p></div>}
                  {s.what_they_need && <div className="field"><label>What they need</label><p>{s.what_they_need}</p></div>}
                  {s.search_signal && <div className="field source-field"><label>Search signal</label><p>{s.search_signal}</p></div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {(data.icp_gaps || []).length > 0 && (
        <section>
          <h3 className="section-title">ICP Gaps — Buyers Not Choosing Us</h3>
          {data.icp_gaps.map((g, i) => (
            <div key={i} className="complaint-card">
              <div className="complaint-header">
                <strong>{g.segment}</strong>
                {g.size && <span className={`freq-badge freq-${g.size}`}>{g.size}</span>}
              </div>
              <p className="complaint-text">Currently buying: {g.currently_buying}</p>
              <p>{g.why_not_buying_product}</p>
              <div className="opportunity-tag">To win them: {g.what_would_make_them_switch}</div>
              {g.evidence && <div className="source-tag" style={{ marginTop: '6px' }}>{g.evidence}</div>}
            </div>
          ))}
        </section>
      )}

      {(data.competitor_icps || []).length > 0 && (
        <section>
          <h3 className="section-title">Competitor Buyer Profiles</h3>
          {data.competitor_icps.map((c, i) => (
            <div key={i} className="complaint-card">
              <strong>{c.competitor}</strong>
              {c.primary_buyer && (
                <div style={{ marginTop: '8px' }}>
                  <p><strong>Primary:</strong> {c.primary_buyer.title} · {c.primary_buyer.company_type} · {c.primary_buyer.company_size}</p>
                  {c.primary_buyer.why_they_choose_this && <p style={{ color: 'var(--text-2)', fontSize: '13px' }}>{c.primary_buyer.why_they_choose_this}</p>}
                </div>
              )}
              {c.buyers_we_could_steal && (
                <div className="opportunity-tag" style={{ marginTop: '8px' }}>Steal: {c.buyers_we_could_steal}</div>
              )}
            </div>
          ))}
        </section>
      )}

      {(data.icp_comparison_matrix || []).length > 0 && (
        <section>
          <h3 className="section-title">ICP Fit Matrix</h3>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Our Fit</th>
                  {(data.icp_comparison_matrix[0]?.competitor_fits || []).map((cf, i) => (
                    <th key={i}>{cf.competitor}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.icp_comparison_matrix.map((row, i) => (
                  <tr key={i}>
                    <td><strong>{row.segment}</strong></td>
                    <td style={{ color: fitColor[row.product_fit] || 'inherit', fontWeight: 600 }}>{row.product_fit}</td>
                    {(row.competitor_fits || []).map((cf, j) => (
                      <td key={j} style={{ color: fitColor[cf.fit] || 'inherit' }}>{cf.fit}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(data.trending_2026 || []).length > 0 && (
        <section>
          <h3 className="section-title">Trending ICP Shifts 2026</h3>
          <div className="market-signals-box">
            <ul>
              {data.trending_2026.map((t, i) => (
                <li key={i}>
                  <strong>{t.trend}</strong>
                  {t.impact_on_icp && <span> — {t.impact_on_icp}</span>}
                  {t.new_buyer_emerging && <span> · New buyer: {t.new_buyer_emerging}</span>}
                  {t.evidence && <span className="source-tag" style={{ marginLeft: '6px' }}>{t.evidence}</span>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_ANTHROPIC_API_KEY || '')
  const [ahrefsKey, setAhrefsKey] = useState(import.meta.env.VITE_AHREFS_API_KEY || '')
  const [product, setProduct] = useState('')
  const [industry, setIndustry] = useState('')
  const [competitors, setCompetitors] = useState(['', '', '', ''])
  const [activeTab, setActiveTab] = useState(0)

  // Per-tab state
  const [tab1Raw, setTab1Raw] = useState('')
  const [tab2Raw, setTab2Raw] = useState('')
  const [tab3Raw, setTab3Raw] = useState('')
  const [tab4Raw, setTab4Raw] = useState('')
  const [tab5Raw, setTab5Raw] = useState('')

  const [tab1Data, setTab1Data] = useState(null)
  const [tab2Data, setTab2Data] = useState(null)
  const [tab3Data, setTab3Data] = useState(null)
  const [tab4Data, setTab4Data] = useState(null)
  const [tab5Data, setTab5Data] = useState(null)

  const [loading, setLoading] = useState({ 1: false, 2: false, 3: false, 4: false, 5: false, cv: false })
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
      const { system, user } = buildTab2Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user })
      setTab2Raw(raw)
      setTab2Data(extractJSON(raw))
    } catch (e) {
      setErr(2, e.message)
    } finally {
      setLoad(2, false)
    }
  }, [apiKey, product, industry, competitors])

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
      const { system, user } = buildTab3Prompts(product, industry, competitors, ahrefsData)
      const raw = await callClaude({ apiKey, system, user })
      setTab3Raw(raw)
      setTab3Data(extractJSON(raw))
    } catch (e) {
      setErr(3, e.message)
    } finally {
      setLoad(3, false)
    }
  }, [apiKey, ahrefsKey, product, industry, competitors])

  const runTab4 = useCallback(async () => {
    if (!apiKey) return setErr(4, 'API key required')
    setLoad(4, true); setErr(4, null)
    try {
      const { system, user } = buildTab4Prompts(product, industry, tab1Raw, tab2Raw, tab3Raw, tab5Raw)
      const raw = await callClaude({ apiKey, system, user })
      setTab4Raw(raw)
      setTab4Data(extractJSON(raw))
    } catch (e) {
      setErr(4, e.message)
    } finally {
      setLoad(4, false)
    }
  }, [apiKey, product, industry, tab1Raw, tab2Raw, tab3Raw, tab5Raw])

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

  const runTab5 = useCallback(async () => {
    if (!apiKey) return setErr(5, 'API key required')
    setLoad(5, true); setErr(5, null)
    try {
      const { system, user } = buildTab5Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user })
      setTab5Raw(raw)
      setTab5Data(extractJSON(raw))
    } catch (e) {
      setErr(5, e.message)
    } finally {
      setLoad(5, false)
    }
  }, [apiKey, product, industry, competitors])

  const runAll = useCallback(async () => {
    if (!apiKey) return setErr('all', 'API key required')
    setErr('all', null)
    try {
      // Tabs 1, 2, 3, and ICP (5) run in parallel
      setLoad(1, true); setErr(1, null)
      setLoad(2, true); setErr(2, null)
      setLoad(3, true); setErr(3, null)
      setLoad(5, true); setErr(5, null)

      const [r1, r2, r3, r5] = await Promise.all([
        // Tab 1
        (async () => {
          const { system, user } = buildTab1Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user })
          setTab1Raw(raw); setTab1Data(extractJSON(raw)); setLoad(1, false)
          return raw
        })(),
        // Tab 2
        (async () => {
          const { system, user } = buildTab2Prompts(product, industry, competitors)
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
          const { system, user } = buildTab3Prompts(product, industry, competitors, ahrefsData3)
          const raw = await callClaude({ apiKey, system, user })
          setTab3Raw(raw); setTab3Data(extractJSON(raw)); setLoad(3, false)
          return raw
        })(),
        // Tab 5 — ICP Discovery
        (async () => {
          const { system, user } = buildTab5Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user })
          setTab5Raw(raw); setTab5Data(extractJSON(raw)); setLoad(5, false)
          return raw
        })(),
      ])

      // Tab 4 (What to Build Next) runs after all four complete
      setActiveTab(4); setLoad(4, true); setErr(4, null)
      const { system: s4, user: u4 } = buildTab4Prompts(product, industry, r1, r2, r3, r5)
      const r4 = await callClaude({ apiKey, system: s4, user: u4 })
      setTab4Raw(r4); setTab4Data(extractJSON(r4)); setLoad(4, false)
    } catch (e) {
      setLoad(1, false); setLoad(2, false); setLoad(3, false); setLoad(4, false); setLoad(5, false)
      setErr('all', e.message)
    }
  }, [apiKey, ahrefsKey, product, industry, competitors])

  const isRunningAll = loading[1] || loading[2] || loading[3] || loading[4] || loading[5]

  const tabs = [
    { label: 'Competitor Intelligence', num: 1 },
    { label: 'Dark Funnel Signals', num: 2 },
    { label: 'SEO & GEO', num: 3 },
    { label: 'ICP Discovery', num: 4 },
    { label: 'What to Build Next', num: 5 },
  ]

  const competitorCount = [0, 1, 2, 3]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo-row">
            <span className="logo-mark">SC</span>
            <div>
              <h1>Strategy Copilot</h1>
              <p className="header-sub">AI-powered competitive & product intelligence · Powered by Claude</p>
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
            <input
              value={product}
              onChange={e => setProduct(e.target.value)}
              placeholder="Your product name (use real domain for Ahrefs if needed)"
            />
          </div>
          <div className="config-field config-wide">
            <label>Industry</label>
            <input
              value={industry}
              onChange={e => setIndustry(e.target.value)}
              placeholder="e.g. B2B analytics, HR tech, compliance SaaS"
            />
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
            { n: 5, label: 'ICP Discovery' },
            { n: 4, label: 'What to Build Next' },
          ].map(s => {
            const done = (s.n === 1 && tab1Data) || (s.n === 2 && tab2Data) || (s.n === 3 && tab3Data) || (s.n === 4 && tab4Data) || (s.n === 5 && tab5Data)
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
            <span className={`tab-num ${[tab1Data, tab2Data, tab3Data, tab5Data, tab4Data][i] ? 'tab-num-done' : ''}`}>
              {[tab1Data, tab2Data, tab3Data, tab5Data, tab4Data][i] ? '✓' : t.num}
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
            <Tab3Result data={tab3Data} productLabel={product} />
          </div>
        )}

        {/* ── ICP Discovery (was Tab 5, now shown 4th) ── */}
        {activeTab === 3 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>ICP Discovery</h2>
                <p className="tab-desc">
                  Claude researches who actually buys — confirmed profiles, whitespace segments, competitor buyers, and priority ranking.
                </p>
              </div>
              <RunButton onClick={runTab5} loading={loading[5]} />
            </div>
            <ErrorBox error={errors[5]} onRetry={runTab5} />
            {!tab5Data && !loading[5] && !errors[5] && (
              <div className="empty-state">Click <strong>Run Analysis</strong> to discover real buyer profiles from live research.</div>
            )}
            {loading[5] && <div className="loading-state"><span className="spinner" /> Researching G2 reviewers, Reddit posts, case studies, and competitor buyers…</div>}
            <Tab5Result data={tab5Data} />
          </div>
        )}
        {/* ── What to Build Next (was Tab 4, now shown 5th) ── */}
        {activeTab === 4 && (
          <div>
            <div className="tab-header">
              <div>
                <h2>What to Build Next</h2>
                <p className="tab-desc">
                  Cross-references all four intelligence layers including ICP Discovery. Posts summary to Slack automatically.
                </p>
              </div>
              <RunButton
                onClick={runTab4}
                loading={loading[4]}
                label="Generate Strategy Report"
              />
            </div>
            {(!tab1Data || !tab2Data || !tab3Data || !tab5Data) && (
              <div className="prereq-warning">
                <strong>Tip:</strong> Run Tabs 1–4 first for the richest recommendations. This tab will still work with available data.
              </div>
            )}
            <ErrorBox error={errors[4]} onRetry={runTab4} />
            {!tab4Data && !loading[4] && !errors[4] && (
              <div className="empty-state">Click <strong>Generate Strategy Report</strong> to synthesise all intelligence layers.</div>
            )}
            {loading[4] && <div className="loading-state"><span className="spinner" /> Cross-referencing all layers including ICP Discovery, validating with live data…</div>}
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
