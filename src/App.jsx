import { useState, useCallback } from 'react'
import { jsPDF } from 'jspdf'

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

// Escape raw newlines / tabs / other control chars inside JSON string values.
// Regex-based repair cannot see across line breaks ([^"\\] stops at \n), so we walk
// like stripLineComments — fixes a common cause of "Expected ',' or '}'…" parse errors.
function escapeControlCharsInJsonStrings(s) {
  let result = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (esc) {
      result += ch
      esc = false
      continue
    }
    if (inStr) {
      if (ch === '\\') {
        result += ch
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = false
        result += ch
        continue
      }
      if (ch === '\n') { result += '\\n'; continue }
      if (ch === '\r') { result += '\\r'; continue }
      if (ch === '\t') { result += '\\t'; continue }
      if (ch === '\f') { result += '\\f'; continue }
      const code = ch.charCodeAt(0)
      if (code < 32) {
        result += `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      result += ch
      continue
    }
    if (ch === '"') {
      inStr = true
      result += ch
      continue
    }
    result += ch
  }
  return result
}

// Take the first complete top-level `{ ... }` only. Models often append prose after
// valid JSON → "Unexpected non-whitespace character after JSON". String-aware `{}` depth only.
function sliceFirstJsonObject(s) {
  const start = s.indexOf('{')
  if (start < 0) return s
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

function parseJsonLenient(s) {
  return JSON.parse(sliceFirstJsonObject(s.trim()))
}

// Claude web_search embeds citation markers like <cite index="1-2,3-4"> in prose.
// They sometimes leak into JSON strings and show up raw in the UI — strip them.
function stripAnthropicWebSearchCiteTags(s) {
  if (typeof s !== 'string') return s
  return s.replace(/<\/?cite\b[^>]*>/gi, '')
}

function stripCitationsFromParsedJson(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return stripAnthropicWebSearchCiteTags(value)
  if (Array.isArray(value)) return value.map(stripCitationsFromParsedJson)
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = stripCitationsFromParsedJson(value[k])
    return out
  }
  return value
}

function extractJSON(text) {
  const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  const match = stripped.match(/\{[\s\S]*/)
  if (!match) throw new Error('No JSON object found in response')

  let raw = match[0]

  const parseAndSanitize = (jsonStr) => stripCitationsFromParsedJson(parseJsonLenient(jsonStr))

  // Try clean parse first
  try { return parseAndSanitize(raw) } catch {}

  // Stage 1: strip // line comments Claude occasionally injects outside strings
  let repaired = stripLineComments(raw)

  // Stage 2: replace curly-quote variants (do this early so later stages see straight quotes)
  repaired = repaired.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")

  // Stage 3: escape literal control characters inside JSON strings (incl. multi-line values)
  repaired = escapeControlCharsInJsonStrings(repaired)

  // Stage 4: remove trailing commas before } or ]
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1')

  try { return parseAndSanitize(repaired) } catch {}

  // Stage 5: fix unescaped double-quotes inside string values
  // ("Expected ',' or '}' after property value" error)
  const quotesFixed = fixUnescapedQuotes(repaired)

  // Re-apply trailing-comma cleanup after quote fix
  const quotesFixedClean = quotesFixed.replace(/,(\s*[}\]])/g, '$1')

  try { return parseAndSanitize(quotesFixedClean) } catch {}

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

  try { return parseAndSanitize(closed) } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}. Try running again — Claude occasionally produces a small formatting error.`)
  }
}

const CLAUDE_MAX_TOKENS_FULL = 20000
const CLAUDE_MAX_TOKENS_ECONOMY = 10000
const CLAUDE_TOOL_TURNS_FULL = 10
const CLAUDE_TOOL_TURNS_ECONOMY = 6

const ECONOMY_SYSTEM_SUFFIX = `
ECONOMY MODE: Use web search efficiently (fewer redundant queries). Obey this tab's OUTPUT RULES exactly. No prose outside the JSON object.`

async function callClaude({ apiKey, system, user, economy = false }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }

  const tools = [{ type: 'web_search_20250305', name: 'web_search' }]

  let messages = [{ role: 'user', content: user }]
  const maxTurns = economy ? CLAUDE_TOOL_TURNS_ECONOMY : CLAUDE_TOOL_TURNS_FULL
  const maxTokens = economy ? CLAUDE_MAX_TOKENS_ECONOMY : CLAUDE_MAX_TOKENS_FULL
  const systemFinal = economy ? `${system}${ECONOMY_SYSTEM_SUFFIX}` : system

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemFinal,
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

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildTab1Prompts(product, industry, competitors) {
  const compList = competitors.filter(Boolean).slice(0, 2)
  return {
    system: `
You surface reality. You do not generate it.
Your job: search the live web right now and extract what actually exists —
real G2 reviews, real Reddit threads, real pricing pages, real announcements.
Not what competitors claim. What buyers actually say about them.

Rules with no exceptions:
- Every finding traces to a URL or verbatim quote from this session.
- No URL, no finding. Cut it.
- No paraphrasing. No extrapolating. No training data.
- "Not found" is a valid and honest answer. Invented data is not.
- One real signal presented cleanly beats ten invented observations.
- CRITICAL: Always output a complete, valid JSON object. If running low on space, use null for optional fields — never stop mid-object.

Return only valid JSON. No markdown. Start with {
`,
    user: `
Surface real competitive intelligence for ${product} in ${industry}.
Competitors to research: ${compList.join(', ') || '(none listed)'}
Analyse the first 2 competitors only.

Search now — extract only what you actually find:
1. "${compList[0] || 'competitor'} pricing OR features 2026" — what changed and when?
2. "${compList[0] || 'competitor'}" site:g2.com — copy 2-3 verbatim 1-star and 2-star review excerpts
3. "${compList[1] || compList[0] || 'competitor'} vs ${product}" site:reddit.com OR site:g2.com — what do real buyers say?
4. "${product}" site:g2.com OR site:capterra.com — what do customers love and hate? Verbatim.
5. "best ${industry} tool 2026" — who appears in top results? Which reviewers recommend whom?
6. "${compList[0] || 'competitor'} alternative 2026" — who is buyers' next choice after them?

For every finding: record the exact source URL and a verbatim quote (up to 25 words).
If you cannot find a real source — omit that field. Do not fill gaps with inference.

OUTPUT RULES:
- competitor_intelligence: exactly 2 items (one per competitor)
- Every descriptive string: up to 40 words. Verbatim quotes: up to 25 words, cut with …
- Complete the full JSON object — use null for any field you cannot fill from real sources.
- Nothing before or after the JSON.

Return ONLY this JSON:
{
  "competitor_intelligence": [
    {
      "competitor": "<name>",
      "what_changed_recently": "<specific change with date and source — from real page or announcement>",
      "top_complaint": "<verbatim quote from real G2 or Reddit review — up to 25 words>",
      "second_complaint": "<another verbatim complaint from a different real source — up to 25 words, or null>",
      "product_opportunity": "<exactly how ${product} wins the top complaint — one concrete sentence>",
      "feature_gap": "<one thing they have that ${product} lacks — from real evidence, or null>",
      "key_strength": "<one thing buyers genuinely love about this competitor — from real reviews>",
      "source": "<exact URL — required>"
    }
  ],
  "whitespace_opportunity": "<gap no competitor fills well — buyers keep asking for it, cite the thread or review>",
  "market_signal": "<one real ${industry} trend or shift in 2026 — include source URL>",
  "summary": "<the single most important real finding from this research. What ${product} must do next. 2-3 sentences.>"
}
`,
  }
}

function buildTab2Prompts(product, industry, competitors) {
  const compList = competitors.filter(Boolean).slice(0, 2)
  return {
    system: `
You surface reality. You do not generate it.
Your job: search the live web right now and extract what real buyers actually say —
real Reddit threads, real G2 reviews, real community posts.
Not marketing copy. Not company claims. What buyers actually say in their own words.

Rules with no exceptions:
- Every quote must be verbatim from a real post or review you found now.
- No URL, no finding. Cut it.
- No paraphrasing. No training data. No invented quotes.
- "Not found" is a valid and honest answer. Invented data is not.
- One real buyer quote beats ten synthesised observations.
- CRITICAL: Always output a complete, valid JSON object. If running low on space, use null for optional fields — never stop mid-object.

Return only valid JSON. No markdown. Start with {
`,
    user: `
Real buyer voice for ${product} and competitors in ${industry}.
IMPORTANT: Focus only on the first 2 competitors. Ignore any others.
Run these searches now:
1. site:reddit.com "${product}" complaint OR problem OR switching OR overpriced 2025 OR 2026
2. site:reddit.com "${compList[0] || 'competitor'}" pricing OR cancel OR frustrating OR "switched to"
3. "${product}" site:g2.com — read 1 and 2 star reviews; copy exact phrases buyers use
4. "${compList[0] || 'competitor'}" site:g2.com — read 1 and 2 star reviews; copy exact phrases
5. "${industry} tool" recommendation site:reddit.com — what do people recommend and why?
6. "${product} review" site:trustpilot.com OR site:capterra.com — any patterns in negative reviews?
For each finding: record exact URL, subreddit or page, verbatim quote, job title if shown.
If no URL — omit the finding.
OUTPUT RULES:
- top_pain_points: up to 6 items
- what_buyers_wish_existed: up to 5 items
- competitor_complaints: up to 4 items across the first 2 competitors
- buyer_language: up to 5 items
- Every descriptive string: up to 40 words. Verbatim quotes: up to 25 words.
- Complete the full JSON — use null for any field you cannot fill from real sources.
- Nothing before the JSON. Nothing after it.

Return ONLY this JSON:
{
  "top_pain_points": [
    {
      "pain": "<one plain-language sentence describing the pattern>",
      "frequency": "very common|common|occasional",
      "verbatim_quote": "<exact words from real post or review — up to 25 words>",
      "source_url": "<exact URL>"
    }
  ],
  "what_buyers_wish_existed": [
    "<specific unmet need in buyer's own language — sourced from real post or review>"
  ],
  "competitor_complaints": [
    {
      "competitor": "<name>",
      "complaint": "<specific complaint in buyer words — one sentence>",
      "verbatim_quote": "<exact words from real post — up to 25 words>",
      "source_url": "<exact URL>",
      "product_opportunity": "<exactly how ${product} addresses this gap>"
    }
  ],
  "buyer_language": [
    {
      "phrase": "<exact phrase buyers use — in quotes>",
      "use_in_copy": "<one concrete way ${product} should use this phrase in messaging>"
    }
  ],
  "emerging_concern_2026": "<one new trend or event changing buyer priorities in ${industry} — include source URL>"
}
Nothing before this JSON. Nothing after it.
`,
  }
}

function buildTab3Prompts(product, industry, competitors, ahrefsData = null) {
  const compList = competitors.filter(Boolean).slice(0, 2)
  const ahrefsSection = ahrefsData ? `LIVE AHREFS DATA:\n${JSON.stringify(ahrefsData, null, 2)}\n\n` : ''
  return {
    system: `
You surface reality. You do not generate it.
Your job: search the live web right now and report exactly what you find —
real search rankings, real AI-generated answers, real content gaps.
GEO means appearing in AI-generated answers on Perplexity,
Google AI Overviews, ChatGPT, Bing Copilot, and Gemini.

Rules with no exceptions:
- Search as an anonymous buyer. Report ONLY what you actually find.
- Every GEO finding must be verbatim — never invent what an AI said.
- If a platform does not mention the product, that IS the finding — report it.
- No URL or verbatim quote, no finding. Cut it.
- One real ranking or AI citation beats ten guessed ones.
- CRITICAL: Always output a complete, valid JSON object. If running low on space, use null for optional fields — never stop mid-object.

Return only valid JSON. No markdown. Start with {
`,
    user: `
${ahrefsSection}SEO and GEO analysis for ${product} vs ${compList.join(', ') || 'competitors'} in ${industry}.
IMPORTANT: Compare against only the first 2 competitors. Ignore any others.

SEO — run these searches now:
1. Identify the 5 most important buyer search queries for ${industry} (think: what someone types before buying)
2. Search each query — record who ranks positions 1-5, whether ${product} appears, whether competitors appear
3. Search "${product} alternative" — what tools appear? What do people say?
4. Search "${product} vs ${compList[0] || 'competitor'}" — what comparison content exists?
5. Search "${compList[0] || 'competitor'} blog site:${(compList[0] || 'competitor').toLowerCase().replace(/\s/g,'')}.com 2026" — what content are they producing?

GEO — run these searches now:
1. Search Perplexity with the top buyer question for ${industry} — copy the EXACT AI answer verbatim
2. Search Google for the same query — does an AI Overview appear? Copy it verbatim if so
3. Search "${product}" on Perplexity — does it appear? What does it say exactly?
4. Search "best ${industry} tool" on Perplexity — is ${product} mentioned? Quote exactly

Report exactly what you find. Verbatim. Never invent AI quotes.

OUTPUT RULES:
- seo_gaps: up to 6 items
- content_gaps: up to 5 items
- GEO verbatim quotes: copy exactly, up to 40 words each
- Every other string: up to 40 words
- CRITICAL: Complete the full JSON object — use null for any field you cannot fill. Never truncate mid-object.
- Nothing before the JSON. Nothing after it.

Return ONLY this JSON:
{
  "seo_gaps": [
    {
      "query": "<exact buyer search query>",
      "monthly_volume": "<number or honest estimate>",
      "who_ranks": ["<tool 1>", "<tool 2>", "<tool 3>"],
      "product_ranking": "<exact position or 'not ranking'>",
      "opportunity": "<why this gap matters for ${product} — one clear sentence>"
    }
  ],
  "content_gaps": [
    {
      "topic": "<specific content topic competitors publish that ${product} does not>",
      "competitor": "<which competitor has it>",
      "priority": "high|medium|low"
    }
  ],
  "content_brief": {
    "target_keyword": "<single highest-priority keyword to target now>",
    "title": "<H1 title that ranks on Google AND gets cited in AI answers>",
    "sections": ["<section 1>", "<section 2>", "<section 3>", "<section 4>"],
    "geo_tip": "<one structural element — FAQ, data table, definition — that makes AI tools cite this>",
    "geo_potential": "high|medium|low"
  },
  "geo_visibility": {
    "overall_score": "<X out of 4 AI platforms checked>",
    "perplexity": "cited as top|mentioned|not mentioned",
    "perplexity_verbatim": "<exact verbatim quote from Perplexity answer — or null if not checked>",
    "google_ai": "cited|mentioned|not mentioned",
    "google_ai_verbatim": "<exact verbatim quote from Google AI Overview — or null if no AI Overview appeared>",
    "chatgpt": "cited as top|mentioned|not mentioned",
    "bing_copilot": "cited|mentioned|not mentioned",
    "competitor_scores": [
      {
        "competitor": "<name>",
        "score": "<X out of 4>",
        "why_they_appear": "<one evidence-based sentence on why AI tools cite them>"
      }
    ]
  },
  "geo_opportunity": "<the single most actionable change that will get ${product} cited in AI answers>",
  "quick_seo_win": "<one specific action ${product} can take in the next 30 days to gain rankings>"
}

Nothing before this JSON. Nothing after it.
`,
  }
}

function buildTab4Prompts(product, industry, tab1Output, tab2Output, tab3Output, tab5Output) {
  return {
    system: `
You surface reality. You do not generate it.
You are Chief Strategy Officer advising ${product} leadership.
You have four fresh intelligence reports — real findings from live web research.
Your job is decisions grounded in what was actually found, not observations.

Rules with no exceptions:
- Every recommendation must cite a specific verbatim line from the reports below.
- If a recommendation cannot be backed by the reports, cut it.
- No padding. No preamble. No commentary after JSON.
- One recommendation backed by real evidence beats four backed by inference.
- "Not enough evidence" is a valid answer. Invented strategy is not.
- CRITICAL: Always output a complete, valid JSON object. If running low on space, use null for optional fields — never stop mid-object.

Return only valid JSON. Start with {
`,
    user: `
Four intelligence reports. Read every word before responding.
IMPORTANT: All analysis covers the first 2 competitors only. Ignore any others.

COMPETITOR INTELLIGENCE:
${tab1Output || `No data yet. Search best ${industry} tool 2026 and proceed.`}

BUYER SIGNALS:
${tab2Output || `No data yet. Search ${product} reviews and proceed.`}

SEO AND GEO:
${tab3Output || `No data yet. Search ${product} on Perplexity and proceed.`}

ICP DISCOVERY:
${tab5Output || `No data yet. Search ${product} customers and proceed.`}

Also search now:
- "${industry} news OR regulation 2026" — any breaking context that changes priorities?

Rules — non-negotiable:
- Every recommendation must cite a specific quote or finding from the reports above
- Product rec: name the exact feature, user flow, and success metric
- Marketing rec: name the exact piece — title, keyword, format, distribution channel
- SEO/GEO rec: name the exact platform or keyword and why it matters now
- ICP rec: name the exact segment and one concrete action this week
- Opportunity buyer must come from ICP rank 1 — copy fields verbatim from ICP report

OUTPUT RULES:
- 4 recommendations (one of each type)
- Every field: up to 50 words — be specific, not padded
- Evidence: cite specific line from reports above, not a general summary
- CRITICAL: Complete the full JSON object — use null for any optional field you cannot fill. Never truncate mid-object.
- Nothing before the JSON. Nothing after it.

Return ONLY this JSON:
{
  "intelligence_summary": "<the most important cross-layer finding and its implication for ${product}. 2-3 sentences.>",
  "breaking_context": "<2026 news or regulation that changes the competitive picture — include source URL — or null>",
  "recommendations": [
    {
      "type": "product",
      "title": "<verb-first, 5-8 words>",
      "what": "<exact feature or user flow to build — include success metric>",
      "evidence": "<verbatim quote or specific finding from the reports above>",
      "urgency": "high|medium|low",
      "effort": "low|medium|high"
    },
    {
      "type": "marketing",
      "title": "<verb-first, 5-8 words>",
      "what": "<exact content piece — title, keyword, format, and distribution channel>",
      "evidence": "<verbatim quote or specific finding from the reports above>",
      "urgency": "high|medium|low",
      "content_brief_summary": "<write [exact title] targeting [exact keyword] — [high/medium/low] GEO potential>"
    },
    {
      "type": "seo_geo",
      "title": "<verb-first, 5-8 words>",
      "what": "<exact keyword or AI platform to optimise for — and the specific gap to close>",
      "evidence": "<verbatim finding from SEO/GEO report>",
      "urgency": "high|medium|low"
    },
    {
      "type": "icp",
      "title": "<verb-first, 5-8 words>",
      "segment": "<exact ICP segment name from ICP report>",
      "what": "<one concrete action to reach or convert this segment this week>",
      "evidence": "<verbatim finding from ICP report>",
      "urgency": "high|medium|low"
    }
  ],
  "quick_win": "<one action achievable today with no engineering work — specific and concrete>",
  "report_summary": "STRATEGY REPORT\\nTop finding: <one sentence>\\nTop action: <one sentence>\\nQuick win: <one sentence>",
  "opportunity_buyer": {
    "name": "<ICP rank 1 name from ICP report>",
    "role": "<ICP rank 1 title and company type — verbatim>",
    "company_size": "<ICP rank 1 company size range>",
    "pain": "<verbatim pain quote from ICP report>",
    "trigger": "<verbatim trigger from ICP report>",
    "anxiety_2026": "<what this buyer fears most in 2026 — from ICP report or null>",
    "where_they_search": "<where this buyer researches solutions — from ICP report>"
  }
}
Nothing before this JSON. Nothing after it.
`,
  }
}

function buildCopyValidationPrompts(buyer, intelligenceSummary, contentType, copyText) {
  return {
    system: `
You are ${buyer.name}, ${buyer.role} at a ${buyer.company_size || 'mid-size'} company.
You are skeptical, busy, and have seen every tool claim before.
Pain: ${buyer.pain}

Trigger: ${buyer.trigger}
2026 anxiety: ${buyer.anxiety_2026}
Where you look: ${buyer.where_they_search || 'Google, Reddit, Perplexity, G2'}
React as you would in real life. Not as you wish you would.
Score ruthlessly. You are not trying to be helpful.
Return only valid JSON. No markdown. Start with {
`,
    user: `
Context: ${intelligenceSummary}
Read this ${contentType} once as ${buyer.name}:
"""
${copyText}
"""
React. Then score.
Return ONLY this JSON:
{
  "overall_score": <1-10>,
  "relevance_score": <1-10>,
  "clarity_score": <1-10>,
  "trust_score": <1-10>,
  "urgency_score": <1-10>,
  "verdict": "Would click|Would not click|Saves for later|Forwards to team|Deletes immediately",
  "first_reaction": "<3 words — raw and honest>",
  "inner_monologue": "<4 sentences. Reference specific words from copy. Connect to your pain. Brutally honest.>",
  "what_worked": ["<specific phrase and exactly why>", "<another>"],
  "what_didnt": ["<specific phrase and exactly why it missed>", "<another>"],
  "the_one_thing_missing": "<the single line that would make you stop — one sentence>",
  "rewrite": "<full rewrite in your language — same format, impossible to ignore>"
}
Nothing before this JSON. Nothing after it.
`,
  }
}

function buildTab5Prompts(product, industry, competitors) {
  const compList = competitors.filter(Boolean).slice(0, 2)
  return {
    system: `
You surface reality. You do not generate it.
Your job: search the live web right now and discover who actually buys —
not who companies claim to target, but who real reviewers and community members are.

Rules with no exceptions:
- Every ICP must be backed by specific evidence from a real source you found now.
- No URL, no ICP. Cut it.
- No training data. No invented profiles. No assumed personas.
- "Not found" is a valid and honest answer. Invented buyer profiles are not.
- One real buyer profile with a URL beats four invented ones without.
- Maximum 3 distinct ICPs. Quality over quantity.
- CRITICAL: Always output a complete, valid JSON object. If running low on space, use null for optional fields — never stop mid-object.

Return only valid JSON. No markdown. Start with {
`,
    user: `
Discover real buyer profiles for ${product} vs ${compList.join(', ') || 'competitors'} in ${industry}.
No assumptions. Everything from live research right now.
IMPORTANT: Research only the first 2 competitors. Ignore any others.

STEP 1 — WHO ACTUALLY BUYS ${product}?
Search: "${product} reviews" site:g2.com — record exact reviewer job titles, company types, verbatim quotes
Search: "${product} case study" OR "${product} customer story" — who is featured? What's their role?
Search: "${product}" site:reddit.com — who is posting, what are they saying about their job/company?
Search: "${product} review" site:capterra.com OR site:trustpilot.com — reviewer profiles

STEP 2 — WHO ACTUALLY BUYS EACH COMPETITOR?
Search each competitor on G2 and Reddit — record reviewer titles and company types.
Identify which buyer segments appear for competitors but NOT for ${product}.

STEP 3 — WHO IS UNDERSERVED?
Search: "${industry} tool" site:reddit.com 2025 OR 2026 — who asks with no clear answer?
Search: "${industry} software" for agency OR freelancer OR startup OR SMB — who struggles most?
Search: "${industry}" pain OR frustration OR "we need" site:reddit.com — what buyer segments surface?

STEP 4 — VALIDATE EACH ICP (only include profiles you can confirm):
- Job title evidence from a real G2/Capterra review or case study
- Specific pain quote in their own words
- Evidence URL that proves this persona exists

OUTPUT RULES:
- recommended_icp_priority: up to 3 entries (REQUIRED — fill this even if brief)
- product_icps: up to 3 profiles (quality over quantity — must have evidence_url)
- competitor_icps: up to 2 entries
- icp_gaps: up to 3 items
- whitespace_segments: up to 2 entries
- Every descriptive string: up to 40 words. Pain quotes: verbatim, up to 25 words.
- icp_comparison_matrix and trending_2026 are OPTIONAL — include only if you have space
- CRITICAL: Complete the JSON object fully — use null for optional fields you cannot fill. Never truncate mid-object.
- Nothing before the JSON. Nothing after it.

Return ONLY this JSON (fill in this exact order — priority first):
{
  "research_summary": "<what sources you searched, what patterns emerged, overall confidence — 2-3 sentences>",
  "recommended_icp_priority": [
    {
      "rank": 1,
      "icp": "<name from product_icps below>",
      "why_prioritise": "<specific business reason backed by evidence — one sentence>",
      "first_action": "<one concrete action this week to reach or convert this ICP>"
    }
  ],
  "product_icps": [
    {
      "icp_id": 1,
      "name": "<realistic full name>",
      "title": "<specific job title from real reviewer — not generic>",
      "seniority": "C-suite|VP|Director|Manager|Individual Contributor",
      "company_type": "<specific type e.g. B2B SaaS startup, digital agency, ecommerce brand>",
      "company_size": "<employee range>",
      "industry_vertical": "<specific vertical from evidence>",
      "geography": "<primary geography — from reviewer location or case study>",
      "pain_in_their_words": "<verbatim quote from real review or post — up to 25 words>",
      "trigger": "<specific event that makes them start searching today>",
      "what_they_search": "<exact query they type into Google>",
      "why_they_choose_product": "<one sentence backed by review evidence>",
      "what_they_compare": ["<competitor 1>", "<competitor 2>"],
      "objections": ["<real objection before buying>", "<another real objection>"],
      "evidence_url": "<exact URL — required, omit ICP if no URL>",
      "confidence": "high|medium|low",
      "segment_size": "large|medium|small"
    }
  ],
  "competitor_icps": [
    {
      "competitor": "<name>",
      "primary_buyer": {
        "title": "<job title from real review>",
        "company_type": "<company type>",
        "company_size": "<size>",
        "why_they_choose_this": "<one evidence-based sentence>",
        "evidence_url": "<exact URL>"
      },
      "secondary_buyers": [
        { "title": "<job title>", "company_type": "<type>", "evidence_url": "<URL>" }
      ],
      "buyers_we_could_steal": "<which segment and what it would take — one sentence>"
    }
  ],
  "icp_gaps": [
    {
      "segment": "<buyer type with clear intent but not choosing ${product}>",
      "size": "large|medium|small",
      "currently_buying": "<which competitor or no one>",
      "why_not_buying_product": "<specific barrier — one honest sentence>",
      "what_would_make_them_switch": "<one specific change ${product} could make>",
      "evidence_url": "<URL where this gap is visible>"
    }
  ],
  "whitespace_segments": [
    {
      "name": "<realistic full name for persona>",
      "title": "<specific job title>",
      "company_type": "<type>",
      "company_size": "<range>",
      "why_unserved": "<one sentence — why no tool wins them today>",
      "search_signal_url": "<URL of a post or thread showing this persona is searching>",
      "pain": "<verbatim pain quote — up to 25 words>",
      "what_they_need": "<one specific thing that would make them buy>",
      "size": "large|medium|small",
      "urgency": "high|medium|low"
    }
  ],
  "icp_comparison_matrix": null,
  "trending_2026": null
}

Nothing before this JSON. Nothing after it.
`,
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REC_TYPE_LABEL = { product: 'Product', marketing: 'Marketing', seo_geo: 'SEO / GEO', icp: 'ICP' }
const FIT_COLOR = { strong: '#0d9488', present: '#d4a017', weak: '#ef4444', absent: '#6b7280' }

function buildStrategyReportPlainText(data, productLabel) {
  const date = new Date().toLocaleDateString()
  let t = `STRATEGY REPORT\n${productLabel || 'Product'} · ${date}\n\n`
  t += `INTELLIGENCE SUMMARY\n${data.intelligence_summary || '—'}\n\n`
  if (data.breaking_context) t += `BREAKING CONTEXT\n${data.breaking_context}\n\n`
  t += `RECOMMENDATIONS\n`
  ;(data.recommendations || []).forEach((r, i) => {
    t += `${i + 1}. [${REC_TYPE_LABEL[r.type] || r.type}] ${r.title || ''}\n`
    if (r.what) t += `   ${r.what}\n`
    if (r.segment) t += `   Segment: ${r.segment}\n`
    if (r.evidence) t += `   Evidence: ${r.evidence}\n`
    if (r.why_now) t += `   Why now: ${r.why_now}\n`
    if (r.content_brief_summary) t += `   Content: ${r.content_brief_summary}\n`
    t += '\n'
  })
  t += `QUICK WIN\n${data.quick_win || '—'}\n\n`
  const snapshot = data.report_summary || data.slack_message
  if (snapshot) t += `EXECUTIVE SNAPSHOT\n${snapshot}\n\n`
  if (data.opportunity_buyer) {
    const b = data.opportunity_buyer
    t += `OPPORTUNITY BUYER\n`
    t += `Name: ${b.name || '—'}\nRole: ${b.role || '—'}\n`
    if (b.company_size) t += `Company size: ${b.company_size}\n`
    t += `Pain: ${b.pain || '—'}\nTrigger: ${b.trigger || '—'}\n`
    t += `2026 anxiety: ${b.anxiety_2026 || '—'}\n`
    t += `Where they search: ${b.where_they_search || '—'}\n`
  }
  return t.trim()
}

function downloadStrategyReportPdf(data, productLabel) {
  const body = buildStrategyReportPlainText(data, productLabel)
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const margin = 14
  const maxW = 182
  let y = 18
  doc.setFontSize(11)
  const lines = doc.splitTextToSize(body, maxW)
  const lineH = 5
  for (const line of lines) {
    if (y > 285) {
      doc.addPage()
      y = 18
    }
    doc.text(line, margin, y)
    y += lineH
  }
  const safe = (productLabel || 'strategy-report').replace(/[^\w\-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'strategy-report'
  doc.save(`${safe}-${new Date().toISOString().slice(0, 10)}.pdf`)
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

function SourceLink({ url, label }) {
  if (!url || url === 'not found') return null
  const isUrl = url.startsWith('http')
  return isUrl
    ? <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">{label || new URL(url).hostname.replace('www.', '')}</a>
    : <span className="source-chip">{url}</span>
}

// ─── Tab 1 Result ─────────────────────────────────────────────────────────────

function Tab1Result({ data }) {
  if (!data) return null
  const [openCards, setOpenCards] = useState(() => new Set([0]))
  const toggle = (i) => setOpenCards(prev => {
    const next = new Set(prev)
    next.has(i) ? next.delete(i) : next.add(i)
    return next
  })
  const marketList = (data.market_signals && data.market_signals.length)
    ? data.market_signals
    : (data.market_signal ? [data.market_signal] : [])
  const whitespaceList = (data.whitespace_features && data.whitespace_features.length)
    ? data.whitespace_features
    : (data.whitespace_opportunity ? [data.whitespace_opportunity] : [])

  return (
    <div className="result-section">
      <div className="result-lede">
        <div className="summary-box">{data.summary}</div>

        {marketList.length > 0 && (
          <div className="market-signals-box">
            <strong>Market Signals 2026</strong>
            <ul>{marketList.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </div>
        )}

        {whitespaceList.length > 0 && (
          <div className="market-signals-box" style={{ background: '#f5f3ff', borderColor: '#ddd6fe' }}>
            <strong>Whitespace opportunities</strong>
            <ul>{whitespaceList.map((f, i) => <li key={i}>{f}</li>)}</ul>
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
      </div>

      <div className="comp-list">
        {(data.competitor_intelligence || []).map((c, i) => {
          const isOpen = openCards.has(i)
          const urgency = c.recommended_action?.urgency || c.urgency
          const opp = c.product_opportunity || c.cookieyes_opportunity
          return (
            <div key={i} className={`comp-card${isOpen ? ' comp-card-open' : ''}`}>
              <div className="comp-card-header" onClick={() => toggle(i)}>
                <div className="comp-card-title">
                  <h3>{c.competitor}</h3>
                  {urgency && <Badge urgency={urgency} />}
                </div>
                {!isOpen && c.what_changed_recently && (
                  <p className="comp-preview-text">{c.what_changed_recently}</p>
                )}
                <span className="comp-toggle">{isOpen ? '−' : '+'}</span>
              </div>

              {isOpen && (
                <div className="comp-card-body">
                  <div className="comp-section">
                    <span className="comp-section-label">Recent change</span>
                    <p className="comp-text">{c.what_changed_recently}</p>
                  </div>

                  {(c.biggest_weakness || c.feature_gap || c.top_complaint_quote || c.top_complaint) && (
                    <div className="comp-section">
                      {(c.biggest_weakness || c.feature_gap) && (
                        <>
                          <span className="comp-section-label">Biggest weakness / gap</span>
                          <p className="comp-text">{c.biggest_weakness || c.feature_gap}</p>
                        </>
                      )}
                      {(c.top_complaint_quote || c.top_complaint) && (
                        <>
                          <span className="comp-section-label">Top complaint</span>
                          <blockquote className="bq-complaint">"{c.top_complaint_quote || c.top_complaint}"</blockquote>
                        </>
                      )}
                    </div>
                  )}

                  {opp && (
                    <div className="comp-section comp-action-section">
                      <span className="comp-section-label">Our opportunity</span>
                      <p className="comp-action-text">{opp}</p>
                    </div>
                  )}

                  {((c.feature_gaps_they_have || []).length > 0 || (c.feature_gaps_we_have || []).length > 0) && (
                    <div className="comp-section comp-gaps-row">
                      {(c.feature_gaps_they_have || []).length > 0 && (
                        <div className="comp-gap-col">
                          <span className="comp-section-label">They have, we don't</span>
                          <div className="gap-pills">
                            {c.feature_gaps_they_have.map((f, j) => <span key={j} className="gap-pill gap-red">{f}</span>)}
                          </div>
                        </div>
                      )}
                      {(c.feature_gaps_we_have || []).length > 0 && (
                        <div className="comp-gap-col">
                          <span className="comp-section-label">We have, they don't</span>
                          <div className="gap-pills">
                            {c.feature_gaps_we_have.map((f, j) => <span key={j} className="gap-pill gap-green">{f}</span>)}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(c.what_buyers_love || []).length > 0 && (
                    <div className="comp-section">
                      <span className="comp-section-label">What buyers love</span>
                      {c.what_buyers_love.map((l, j) => (
                        <div key={j} className="love-item">
                          <strong>{l.feature}</strong>
                          {l.exact_quote && <blockquote className="bq-love">"{l.exact_quote}"</blockquote>}
                          {l.implication_for_product && <p className="implication">{l.implication_for_product}</p>}
                        </div>
                      ))}
                    </div>
                  )}

                  {(c.what_buyers_hate || []).length > 0 && (
                    <div className="comp-section">
                      <span className="comp-section-label">What buyers hate</span>
                      {c.what_buyers_hate.map((h, j) => (
                        <div key={j} className="hate-item">
                          <p>{h.complaint}</p>
                          {h.exact_quote && <blockquote className="bq-hate">"{h.exact_quote}"</blockquote>}
                          {h.product_opportunity && <div className="opportunity-tag">{h.product_opportunity}</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {(c.top_user_complaint || c.second_complaint) && (
                    <div className="comp-section">
                      <span className="comp-section-label">Top complaints (verbatim)</span>
                      {c.top_user_complaint && <blockquote className="bq-complaint">"{c.top_user_complaint}"</blockquote>}
                      {c.second_complaint && <blockquote className="bq-complaint">"{c.second_complaint}"</blockquote>}
                    </div>
                  )}

                  {c.buyer_profile && (
                    <div className="comp-section">
                      <span className="comp-section-label">Who buys this</span>
                      <p className="comp-text">{c.buyer_profile}</p>
                    </div>
                  )}

                  {c.recommended_action && (
                    <div className="comp-section comp-action-section">
                      <span className="comp-section-label">Recommended action</span>
                      {typeof c.recommended_action === 'string'
                        ? <p className="comp-action-text">{c.recommended_action}</p>
                        : <>
                            {c.recommended_action.build && <p className="comp-action-text"><strong>Build:</strong> {c.recommended_action.build}</p>}
                            {c.recommended_action.counter && <p className="comp-action-text"><strong>Counter:</strong> {c.recommended_action.counter}</p>}
                          </>
                      }
                    </div>
                  )}

                  {(c.source || c.evidence_url) && (
                    <div className="comp-source">
                      <SourceLink url={c.source || c.evidence_url} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
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
              <h4 className="pain-label">{p.pain}</h4>
              {p.frequency && <span className={`freq-badge freq-${p.frequency?.replace(' ', '-')}`}>{p.frequency}</span>}
            </div>
            {(p.buyer_quote || p.verbatim_quote) && (
              <blockquote className="bq-complaint">"{p.buyer_quote || p.verbatim_quote}"</blockquote>
            )}
            <div className="pain-meta">
              {p.reviewer_context && <span className="reviewer-context">{p.reviewer_context}</span>}
              <SourceLink url={p.source_url || p.source} />
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
              {wish.evidence && <blockquote className="bq-neutral">"{wish.evidence}"</blockquote>}
              <SourceLink url={wish.source_url || wish.source} />
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
            {(c.exact_quote || c.verbatim_quote) && (
              <blockquote className="bq-complaint">"{c.exact_quote || c.verbatim_quote}"</blockquote>
            )}
            <div className="opportunity-tag">Opportunity → {c.opportunity || c.product_opportunity}</div>
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

      {(data.emerging_concern_2026 || (data.emerging_concerns_2026 || []).length > 0) && (
        <section>
          <h3 className="section-title">Emerging concerns 2026</h3>
          {data.emerging_concern_2026 && <p className="complaint-text">{data.emerging_concern_2026}</p>}
          {(data.emerging_concerns_2026 || []).length > 0 && (
            <ul className="wish-list">
              {data.emerging_concerns_2026.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

// ─── Tab 3 Result ─────────────────────────────────────────────────────────────

function Tab3Result({ data, productLabel }) {
  if (!data) return null
  const rankingCol = productLabel?.trim() || 'Your product'
  const gv = data.geo_visibility || {}
  const overallGeo = data.overall_geo_score ?? gv.overall_geo_score ?? gv.overall_score
  const perplexityLabel = gv.perplexity_score ?? gv.perplexity
  const googleLabel = gv.google_ai_overview ?? gv.google_ai
  const perplexityFinding = gv.perplexity_exact_finding ?? gv.perplexity_verbatim ?? gv.perplexity_finding
  const googleFinding = gv.google_ai_exact_finding ?? gv.google_ai_verbatim ?? gv.google_ai_finding
  const chatgptLabel = gv.chatgpt_score ?? gv.chatgpt
  const bingLabel = gv.bing_copilot_score ?? gv.bing_copilot
  const showSeverity = (data.seo_gaps || []).some(g => g.gap_severity)
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
                {showSeverity && <th>Severity</th>}
                <th>Opportunity</th>
              </tr>
            </thead>
            <tbody>
              {(data.seo_gaps || []).map((g, i) => (
                <tr key={i}>
                  <td><strong>{g.query}</strong></td>
                  <td>{g.monthly_volume}</td>
                  <td>{Array.isArray(g.top_rankers)
                    ? g.top_rankers.join(', ')
                    : (Array.isArray(g.who_ranks) ? g.who_ranks.join(', ') : g.top_rankers || g.who_ranks || g.competitor_ranking)}</td>
                  <td className="not-ranking">{g.product_ranking}</td>
                  {showSeverity && <td>{g.gap_severity ? <Badge urgency={g.gap_severity} /> : '—'}</td>}
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
                    <td className="table-cell-finding">{s.exact_finding}</td>
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
                {(gap.competitor_who_has_it || gap.competitor) && (
                  <span className="geo-tag">{gap.competitor_who_has_it || gap.competitor}</span>
                )}
                {(gap.value || gap.priority || gap.estimated_traffic_value) && (
                  <span className={`geo-potential-badge geo-${gap.value || gap.priority || gap.estimated_traffic_value}`}>
                    {gap.value || gap.priority || gap.estimated_traffic_value}
                  </span>
                )}
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
            {[
              { label: 'Perplexity', val: perplexityLabel },
              { label: 'Google AI', val: googleLabel },
              { label: 'ChatGPT', val: chatgptLabel },
              { label: 'Bing Copilot', val: bingLabel },
            ].filter(p => p.val).map(p => (
              <div key={p.label} className={`geo-item ${String(p.val).includes('not') ? 'geo-bad' : 'geo-good'}`}>
                <span>{p.label}</span>
                <strong>{p.val}</strong>
              </div>
            ))}
          </div>
          {overallGeo && (
            <div className="overall-geo-score">
              <strong>Overall GEO Score</strong>
              <span>{overallGeo}</span>
            </div>
          )}
          {perplexityFinding && (
            <div className="geo-finding-box">
              <label>Perplexity said:</label>
              <p>"{perplexityFinding}"</p>
            </div>
          )}
          {googleFinding && (
            <div className="geo-finding-box">
              <label>Google AI said:</label>
              <p>"{googleFinding}"</p>
            </div>
          )}
          {(gv.competitor_geo_scores || gv.competitor_scores || []).map((c, i) => (
            <div key={i} className="competitor-geo-row">
              <span>{c.competitor}</span>
              {c.strongest_platform && <span className="geo-tag">{c.strongest_platform}</span>}
              {(c.overall || c.score) && <span className="geo-tag">{c.overall || c.score}</span>}
              {c.perplexity && <span className="geo-tag">Perplexity: {c.perplexity}</span>}
              {c.google_ai && <span className="geo-tag">Google AI: {c.google_ai}</span>}
              {c.chatgpt && <span className="geo-tag">ChatGPT: {c.chatgpt}</span>}
              {(c.why_they_rank || c.why_they_appear || c.geo_advantage) && (
                <span className="geo-advantage">{c.why_they_rank || c.why_they_appear || c.geo_advantage}</span>
              )}
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
            {data.content_brief.topic && (
              <div className="brief-row">
                <label>Topic</label><span>{data.content_brief.topic}</span>
              </div>
            )}
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
              <label>Recommended title</label><span>{data.content_brief.recommended_title || data.content_brief.title}</span>
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
            {(data.content_brief.what_to_cover || []).length > 0 && (
              <div className="brief-sections">
                <label>What to cover</label>
                <ol>{data.content_brief.what_to_cover.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </div>
            )}
            {((data.content_brief.top_3_sections || data.content_brief.sections) || []).length > 0 && (
              <div className="brief-sections">
                <label>Top sections</label>
                <ol>{(data.content_brief.top_3_sections || data.content_brief.sections || []).map((s, i) => <li key={i}>{s}</li>)}</ol>
              </div>
            )}
            {data.content_brief.beat_the_competition && (
              <div className="brief-row">
                <label>Beat the competition</label><span>{data.content_brief.beat_the_competition}</span>
              </div>
            )}
            {(data.content_brief.geo_optimisation_tip || data.content_brief.geo_tip) && (
              <div className="brief-row geo-tip-row">
                <label>GEO tip</label><span>{data.content_brief.geo_optimisation_tip || data.content_brief.geo_tip}</span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

// ─── Tab 4 Result ─────────────────────────────────────────────────────────────

function Tab4Result({ data, productLabel }) {
  if (!data) return null
  const [snapshotCopied, setSnapshotCopied] = useState(false)
  const snapshotText = data.report_summary || data.slack_message || ''
  const fullReportText = buildStrategyReportPlainText(data, productLabel)

  function copySnapshot() {
    const text = snapshotText || fullReportText
    navigator.clipboard.writeText(text)
    setSnapshotCopied(true)
    setTimeout(() => setSnapshotCopied(false), 2000)
  }

  function onDownloadPdf() {
    downloadStrategyReportPdf(data, productLabel)
  }

  return (
    <div className="result-section">
      <div className="result-lede">
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
      </div>

      <section className="result-block">
        <h3 className="section-title">Strategic Recommendations</h3>
        <div className="recommendations-stack">
          {(data.recommendations || []).map((r, i) => (
            <div key={i} className={`recommendation-card rec-card-${r.type}`}>
              <div className="rec-header">
                <span className={`rec-type rec-type-${r.type}`}>{REC_TYPE_LABEL[r.type] || r.type}</span>
                {r.urgency && <Badge urgency={r.urgency} />}
                {r.effort && <span className="effort-tag">Effort: {r.effort}</span>}
                {r.impact && <span className="impact-tag">Impact: {r.impact}</span>}
                {r.segment && <span className="segment-tag">{r.segment}</span>}
              </div>
              <h4>{r.title}</h4>
              <p className="rec-what">{r.what}</p>
              {r.why_now && (
                <div className="rec-why-now">
                  <label>Why now</label>
                  <p>{r.why_now}</p>
                </div>
              )}
              {r.evidence && (
                <div className="rec-evidence">
                  <label>Evidence</label>
                  <blockquote className="bq-neutral">"{r.evidence}"</blockquote>
                </div>
              )}
              {r.content_brief_summary && (
                <div className="content-brief-summary">
                  <label>Content Brief</label>
                  <p>{r.content_brief_summary}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="quick-win-box">
        <strong>Quick Win Today</strong>
        <p>{data.quick_win}</p>
      </div>

      <div className="report-export-box">
        <div className="report-export-header">
          <strong>{snapshotText ? 'Executive snapshot' : 'Export report'}</strong>
          <div className="report-export-actions">
            <button type="button" className="copy-btn" onClick={copySnapshot}>
              {snapshotCopied ? 'Copied!' : snapshotText ? 'Copy snapshot' : 'Copy full text'}
            </button>
            <button type="button" className="pdf-download-btn" onClick={onDownloadPdf}>
              Download PDF
            </button>
          </div>
        </div>
        {snapshotText ? (
          <pre className="report-export-pre">{snapshotText}</pre>
        ) : (
          <p className="report-export-hint">No executive snapshot in this run — use Copy or PDF for the full strategy report.</p>
        )}
      </div>

      {data.opportunity_buyer && (
        <div className="result-block">
          <h3 className="section-title">Opportunity Buyer</h3>
          <div className="buyer-card buyer-card--in-panel">
            <div className="buyer-persona-header">
              <div className="buyer-avatar">{(data.opportunity_buyer.name || '?')[0]}</div>
              <div>
                <p className="buyer-name">{data.opportunity_buyer.name}</p>
                <p className="buyer-role">{data.opportunity_buyer.role}</p>
                {data.opportunity_buyer.company_size && <p className="buyer-co">{data.opportunity_buyer.company_size}</p>}
              </div>
            </div>
            <div className="buyer-grid">
              <div className="buyer-full">
                <label>Pain</label>
                <blockquote className="bq-complaint">"{data.opportunity_buyer.pain}"</blockquote>
              </div>
              <div className="buyer-full"><label>Trigger</label><p>{data.opportunity_buyer.trigger}</p></div>
              <div className="buyer-full"><label>2026 Anxiety</label><p>{data.opportunity_buyer.anxiety_2026}</p></div>
              {data.opportunity_buyer.where_they_search && (
                <div className="buyer-full"><label>Where they search</label><p>{data.opportunity_buyer.where_they_search}</p></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Copy Validation Result ───────────────────────────────────────────────────

function ScoreDot({ score }) {
  const color = score >= 8 ? '#0d9488' : score >= 6 ? '#d4a017' : '#ef4444'
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

      <section className="result-block">
        <h3 className="section-title">Scores &amp; verdict</h3>
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
      </section>

      <section className="result-block">
        <h3 className="section-title">Buyer voice</h3>
        <div className="inner-monologue-box">
          <label>Inner Monologue</label>
          <p>{data.inner_monologue}</p>
        </div>
        <div className="two-col cv-split">
          <div>
            <h4 className="worked-label">What Worked</h4>
            <ul className="cv-list">{(data.what_worked || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
          <div>
            <h4 className="didnt-label">What Didn't</h4>
            <ul className="cv-list">{(data.what_didnt || []).map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        </div>
      </section>

      <section className="result-block">
        <h3 className="section-title">Refine the copy</h3>
        {data.strategy_alignment_gap && (
          <div className="alignment-gap-box">
            <label>Strategy Alignment Gap</label>
            <p>{data.strategy_alignment_gap}</p>
          </div>
        )}
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
      </section>
    </div>
  )
}

// ─── Tab 5 Result ─────────────────────────────────────────────────────────────

function Tab5Result({ data }) {
  if (!data) return null
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
              <p className="rec-what">{r.why ?? r.why_prioritise}</p>
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
                  {icp.seniority && <div className="field"><label>Seniority</label><p>{icp.seniority}</p></div>}
                  <div className="field"><label>Company</label><p>{[icp.company_type, icp.company_size].filter(Boolean).join(' · ')}</p></div>
                  {icp.industry_vertical && <div className="field"><label>Vertical</label><p>{icp.industry_vertical}</p></div>}
                  {icp.geography && <div className="field"><label>Geography</label><p>{icp.geography}</p></div>}
                  {icp.pain_in_their_words && (
                    <div className="field">
                      <label>Pain in their words</label>
                      <blockquote className="bq-complaint">"{icp.pain_in_their_words}"</blockquote>
                    </div>
                  )}
                  {icp.trigger && <div className="field"><label>Trigger</label><p>{icp.trigger}</p></div>}
                  {icp.why_they_choose_product && (
                    <div className="field">
                      <label>Why they choose us</label>
                      <p className="icp-positive">{icp.why_they_choose_product}</p>
                    </div>
                  )}
                  {icp.what_they_search && <div className="field"><label>What they search</label><p>{icp.what_they_search}</p></div>}
                  {(icp.what_they_compare || []).length > 0 && (
                    <div className="field">
                      <label>They compare us with</label>
                      <div className="gap-pills">{icp.what_they_compare.map((c, j) => <span key={j} className="gap-pill gap-neutral">{c}</span>)}</div>
                    </div>
                  )}
                  {(icp.objections || []).length > 0 && (
                    <div className="field">
                      <label>Objections before buying</label>
                      <ul>{icp.objections.map((o, j) => <li key={j}>{o}</li>)}</ul>
                    </div>
                  )}
                  {(icp.segment_size || icp.estimated_segment_size) && (
                    <div className="field"><label>Segment size</label><p>{icp.segment_size || icp.estimated_segment_size}</p></div>
                  )}
                  {(icp.evidence_url || icp.evidence) && (
                    <div className="field source-field"><label>Evidence</label><SourceLink url={icp.evidence_url || icp.evidence} /></div>
                  )}
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
                  <div className="field"><label>Company</label><p>{[s.company_type, s.company_size].filter(Boolean).join(' · ') || '—'}</p></div>
                  {s.pain && <div className="field"><label>Pain</label><blockquote className="bq-complaint">"{s.pain}"</blockquote></div>}
                  {s.why_unserved && <div className="field"><label>Why unserved</label><p>{s.why_unserved}</p></div>}
                  {s.what_they_need && <div className="field"><label>What they need</label><p>{s.what_they_need}</p></div>}
                  {(s.search_signal_url || s.search_signal) && (
                    <div className="field source-field">
                      <label>Search signal</label>
                      <SourceLink url={s.search_signal_url || s.search_signal} label="View thread" />
                    </div>
                  )}
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
              <SourceLink url={g.evidence_url || g.evidence} />
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
                  {typeof c.primary_buyer === 'string' ? (
                    <p><strong>Primary:</strong> {c.primary_buyer}</p>
                  ) : (
                    <p><strong>Primary:</strong> {c.primary_buyer.title} · {c.primary_buyer.company_type} · {c.primary_buyer.company_size}</p>
                  )}
                  {typeof c.primary_buyer === 'object' && c.primary_buyer?.why_they_choose_this && (
                    <p style={{ color: 'var(--text-2)', fontSize: '13px' }}>{c.primary_buyer.why_they_choose_this}</p>
                  )}
                  {typeof c.primary_buyer === 'object' && c.primary_buyer?.evidence_url && (
                    <span className="source-chip" style={{ marginTop: '6px', display: 'inline-block' }}>{c.primary_buyer.evidence_url}</span>
                  )}
                  {Array.isArray(c.secondary_buyers) && c.secondary_buyers.length > 0 && (
                    <ul style={{ marginTop: '8px', fontSize: '13px' }}>
                      {c.secondary_buyers.map((sb, j) => (
                        <li key={j}>{[sb.title, sb.company_type].filter(Boolean).join(' · ')}{sb.evidence_url ? ` — ${sb.evidence_url}` : ''}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {c.why_they_choose_this && typeof c.primary_buyer === 'string' && (
                <p style={{ color: 'var(--text-2)', fontSize: '13px', marginTop: '6px' }}>{c.why_they_choose_this}</p>
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
                    <td style={{ color: FIT_COLOR[row.product_fit] || 'inherit', fontWeight: 600 }}>{row.product_fit}</td>
                    {(row.competitor_fits || []).map((cf, j) => (
                      <td key={j} style={{ color: FIT_COLOR[cf.fit] || 'inherit' }}>{cf.fit}</td>
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
                  {(t.evidence_url || t.evidence) && (
                    <span style={{ marginLeft: '6px' }}><SourceLink url={t.evidence_url || t.evidence} /></span>
                  )}
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
  const [product, setProduct] = useState('')
  const [industry, setIndustry] = useState('')
  const [competitors, setCompetitors] = useState(['', '', '', ''])
  const [economyMode, setEconomyMode] = useState(() => {
    try {
      const s = localStorage.getItem('strategyCopilotEconomy')
      if (s === '0') return false
      if (s === '1') return true
    } catch { /* ignore */ }
    // Full quality by default. Set VITE_DEFAULT_ECONOMY=true to default new sessions to economy.
    return import.meta.env.VITE_DEFAULT_ECONOMY === 'true'
  })
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
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setTab1Raw(raw)
      setTab1Data(extractJSON(raw))
    } catch (e) {
      setErr(1, e.message)
    } finally {
      setLoad(1, false)
    }
  }, [apiKey, economyMode, product, industry, competitors])

  const runTab2 = useCallback(async () => {
    if (!apiKey) return setErr(2, 'API key required')
    setLoad(2, true); setErr(2, null)
    try {
      const { system, user } = buildTab2Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setTab2Raw(raw)
      setTab2Data(extractJSON(raw))
    } catch (e) {
      setErr(2, e.message)
    } finally {
      setLoad(2, false)
    }
  }, [apiKey, economyMode, product, industry, competitors])

  const runTab3 = useCallback(async () => {
    if (!apiKey) return setErr(3, 'API key required')
    setLoad(3, true); setErr(3, null)
    try {
      const { system, user } = buildTab3Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setTab3Raw(raw)
      setTab3Data(extractJSON(raw))
    } catch (e) {
      setErr(3, e.message)
    } finally {
      setLoad(3, false)
    }
  }, [apiKey, economyMode, product, industry, competitors])

  const runTab4 = useCallback(async () => {
    if (!apiKey) return setErr(4, 'API key required')
    setLoad(4, true); setErr(4, null)
    try {
      const { system, user } = buildTab4Prompts(product, industry, tab1Raw, tab2Raw, tab3Raw, tab5Raw)
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setTab4Raw(raw)
      setTab4Data(extractJSON(raw))
    } catch (e) {
      setErr(4, e.message)
    } finally {
      setLoad(4, false)
    }
  }, [apiKey, economyMode, product, industry, tab1Raw, tab2Raw, tab3Raw, tab5Raw])

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
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setCvData(extractJSON(raw))
    } catch (e) {
      setErr('cv', e.message)
    } finally {
      setLoad('cv', false)
    }
  }, [apiKey, economyMode, tab4Data, contentType, copyText])

  const runTab5 = useCallback(async () => {
    if (!apiKey) return setErr(5, 'API key required')
    setLoad(5, true); setErr(5, null)
    try {
      const { system, user } = buildTab5Prompts(product, industry, competitors)
      const raw = await callClaude({ apiKey, system, user, economy: economyMode })
      setTab5Raw(raw)
      setTab5Data(extractJSON(raw))
    } catch (e) {
      setErr(5, e.message)
    } finally {
      setLoad(5, false)
    }
  }, [apiKey, economyMode, product, industry, competitors])

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
          const raw = await callClaude({ apiKey, system, user, economy: economyMode })
          setTab1Raw(raw); setTab1Data(extractJSON(raw)); setLoad(1, false)
          return raw
        })(),
        // Tab 2
        (async () => {
          const { system, user } = buildTab2Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user, economy: economyMode })
          setTab2Raw(raw); setTab2Data(extractJSON(raw)); setLoad(2, false)
          return raw
        })(),
        // Tab 3
        (async () => {
          const { system, user } = buildTab3Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user, economy: economyMode })
          setTab3Raw(raw); setTab3Data(extractJSON(raw)); setLoad(3, false)
          return raw
        })(),
        // Tab 5 — ICP Discovery
        (async () => {
          const { system, user } = buildTab5Prompts(product, industry, competitors)
          const raw = await callClaude({ apiKey, system, user, economy: economyMode })
          setTab5Raw(raw); setTab5Data(extractJSON(raw)); setLoad(5, false)
          return raw
        })(),
      ])

      // Tab 4 (What to Build Next) runs after all four complete
      setActiveTab(4); setLoad(4, true); setErr(4, null)
      const { system: s4, user: u4 } = buildTab4Prompts(product, industry, r1, r2, r3, r5)
      const r4 = await callClaude({ apiKey, system: s4, user: u4, economy: economyMode })
      setTab4Raw(r4); setTab4Data(extractJSON(r4)); setLoad(4, false)
    } catch (e) {
      setLoad(1, false); setLoad(2, false); setLoad(3, false); setLoad(4, false); setLoad(5, false)
      setErr('all', e.message)
    }
  }, [apiKey, economyMode, product, industry, competitors])

  const isRunningAll = loading[1] || loading[2] || loading[3] || loading[4] || loading[5]

  const tabs = [
    { label: 'Competitor Intelligence', num: 1 },
    { label: 'Dark Funnel Signals', num: 2 },
    { label: 'SEO & GEO', num: 3 },
    { label: 'ICP Discovery', num: 4 },
    { label: 'What to Build Next', num: 5 },
  ]

  const competitorCount = [0, 1]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo-row">
            <img
              className="logo-mark-img"
              src="/signal-logo.svg"
              alt="Signalboard"
              width={44}
              height={44}
            />
            <div>
              <h1>Signalboard</h1>
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

      <div className="config-bar">
        <div className="config-inner">
          <div className="config-field">
            <label>Product</label>
            <input
              value={product}
              onChange={e => setProduct(e.target.value)}
              placeholder="Your product name"
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
          <div className="config-field config-toggle">
            <label className="config-toggle-label">
              <input
                type="checkbox"
                checked={economyMode}
                onChange={e => {
                  const v = e.target.checked
                  setEconomyMode(v)
                  try {
                    localStorage.setItem('strategyCopilotEconomy', v ? '1' : '0')
                  } catch { /* ignore */ }
                }}
              />
              Economy mode
            </label>
            <span className="config-toggle-hint">
              Smaller output budget and fewer tool rounds — can truncate or thin results vs full mode
            </span>
          </div>
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
                  Live web search for SEO gaps and AI visibility (Perplexity, Google AI Overviews, etc.).
                </p>
              </div>
              <RunButton onClick={runTab3} loading={loading[3]} />
            </div>
            <ErrorBox error={errors[3]} onRetry={runTab3} />
            {!tab3Data && !loading[3] && !errors[3] && (
              <div className="empty-state">Click <strong>Run Analysis</strong> to check SEO gaps and GEO visibility.</div>
            )}
            {loading[3] && <div className="loading-state"><span className="spinner" /> Checking SEO gaps and AI search visibility…</div>}
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
                  Cross-references all four intelligence layers including ICP Discovery. Copy the snapshot or download the full report as a PDF.
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
            <Tab4Result data={tab4Data} productLabel={product} />

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
