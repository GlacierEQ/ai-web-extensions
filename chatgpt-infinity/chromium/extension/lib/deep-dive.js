// ==============================================================
// deep-dive.js — Intelligent follow-up prompt engine
// for ChatGPT Infinity ∞
// Casey Barton / GlacierEQ fork — April 2026
//
// Loaded BEFORE infinity.js via manifest.json / @require.
// Exposes window.deepDive with a single public method:
//
//   deepDive.nextPrompt(lastReplyText, topic) → string
//
// Also exposes deepDive.reset() to clear lens history on stop.
// ==============================================================

window.deepDive = (() => {
  'use strict'

  // ── Epistemological "lens" templates ────────────────────────
  // Each lens transforms the last reply's key concept into a
  // genuinely different angle, preventing repetition and
  // forcing the model to go deeper rather than wider.
  const LENSES = [
    // Conceptual deepening
    concept => `The previous answer mentioned "${concept}". Explain the *underlying mechanism* that makes this true — go one level deeper than the surface explanation and identify any hidden assumptions.`,
    concept => `"${concept}" was just described. Now steelman the strongest objection or counterexample someone could raise against this — then resolve it.`,
    concept => `Given "${concept}", trace the causal chain: what must be true *upstream* for this to hold, and what does this *downstream* imply that most people overlook?`,
    // Comparative / contrastive
    concept => `Contrast "${concept}" with its most commonly confused neighbor concept. Where do they diverge in a way that actually matters in practice?`,
    concept => `"${concept}" — in what domain does this principle *break down* or invert? Give a specific, non-obvious edge case.`,
    // Applicative
    concept => `How would an expert practitioner apply "${concept}" differently from a novice? What tacit knowledge separates them?`,
    concept => `Design a minimal experiment or test that would let you falsify or validate "${concept}". What would a positive result look like vs. a negative one?`,
    // Historical / evolutionary
    concept => `How did the understanding of "${concept}" evolve over time? What was the key insight that replaced the previous (wrong) model?`,
    concept => `What was the first-principles argument that originally established "${concept}", and which part of that argument is most contested today?`,
    // Cross-domain synthesis
    concept => `Find an analogy for "${concept}" in a completely different field. What does that analogy reveal that a within-domain explanation cannot?`,
    concept => `Where do complexity or emergent behaviour complicate a simple explanation of "${concept}"?`,
    // Quantitative / structural
    concept => `What are the key variables or parameters governing "${concept}"? How does the behaviour change as each one is pushed to extremes?`,
    concept => `Break "${concept}" into its irreducible sub-components. Which component contributes most to the overall effect, and why?`,
    // Implications
    concept => `If "${concept}" were suddenly no longer true, what would be the first-order and second-order consequences?`,
    concept => `What is the single most important practical implication of "${concept}" that is routinely ignored or underweighted?`,
  ]

  // ── Topic-aware lens boosters ────────────────────────────────
  // When a known domain keyword appears in the last response,
  // inject topic-specific follow-up frames.
  const TOPIC_LENSES = {
    law: [
      concept => `Regarding "${concept}": identify the controlling statutory authority, the leading case, and the circuit split (if any). Which jurisdiction's rule is most protective of the individual?`,
      concept => `Under "${concept}", what is the burden of proof, who bears it, and how have courts defined the evidentiary standard in practice?`,
    ],
    code: [
      concept => `For "${concept}": what is the asymptotic complexity, and are there known algorithmic improvements that achieve better bounds?`,
      concept => `Show the minimal reproducible anti-pattern for "${concept}" and refactor it to idiomatic, production-grade code.`,
    ],
    science: [
      concept => `What is the current scientific consensus on "${concept}", and what is the strongest dissenting hypothesis still held by credible researchers?`,
      concept => `Describe the experimental setup that would provide the most definitive evidence for or against "${concept}".`,
    ],
    history: [
      concept => `Who were the key actors in "${concept}", what incentives drove them, and which contingent factor most altered the outcome?`,
      concept => `How have historians' interpretations of "${concept}" shifted across generations, and what drove the historiographical revision?`,
    ],
    math: [
      concept => `State "${concept}" formally and prove or disprove it for the simplest non-trivial case.`,
      concept => `What generalisation of "${concept}" opens the richest unexplored territory in current research?`,
    ],
  }

  // ── Concept extraction ───────────────────────────────────────
  // Pull the most salient noun-phrase from the last ChatGPT reply.
  // Tries: bolded terms → first heading → first meaningful NP
  function extractConcept(replyText) {
    if (!replyText) return null
    // 1. Bold markdown: **term**
    const boldMatch = replyText.match(/\*\*([^*]{4,60}?)\*\*/)
    if (boldMatch) return boldMatch[1].trim()
    // 2. Heading: # Term or ## Term
    const headingMatch = replyText.match(/^#{1,3}\s+(.{4,80})/m)
    if (headingMatch) return headingMatch[1].trim()
    // 3. First sentence's longest capitalised noun phrase (heuristic)
    const firstSentence = replyText.split(/[.!?]/)[0] || ''
    const npMatch = firstSentence.match(/\b([A-Z][a-z]+(?:\s[A-Za-z]+){0,4})\b/)
    if (npMatch) return npMatch[1].trim()
    // 4. Fallback: use first 6 words
    return replyText.split(/\s+/).slice(0, 6).join(' ')
  }

  // ── Domain detector ──────────────────────────────────────────
  function detectDomain(text) {
    const t = (text || '').toLowerCase()
    if (/\b(statute|court|jurisdiction|plaintiff|defendant|habeas|writ|§|usc|haw\.rev\.stat)\b/.test(t)) return 'law'
    if (/\b(function|algorithm|async|api|runtime|o\(n\)|typescript|python|class|interface)\b/.test(t)) return 'code'
    if (/\b(hypothesis|experiment|peer.reviewed|study|p.value|rct|mechanism|protein|genome)\b/.test(t)) return 'science'
    if (/\b(century|empire|treaty|war|revolution|dynasty|historian|archive)\b/.test(t)) return 'history'
    if (/\b(theorem|proof|axiom|lemma|manifold|algebra|topology|set theory)\b/.test(t)) return 'math'
    return null
  }

  // ── Prompt history tracker ────────────────────────────────────
  // Avoid repeating the same lens in succession.
  const usedLensIndices = []
  const MAX_HISTORY = 5

  function pickLens(concept, domain) {
    // Gather candidate lenses (generic + domain-specific)
    let candidates = LENSES.map((fn, i) => ({ fn, i, isDomain: false }))
    if (domain && TOPIC_LENSES[domain]) {
      TOPIC_LENSES[domain].forEach((fn, j) => {
        candidates.push({ fn, i: `${domain}_${j}`, isDomain: true })
      })
    }
    // Filter out recently used
    const fresh = candidates.filter(c => !usedLensIndices.includes(String(c.i)))
    // Weight domain lenses 3x higher by duplicating them
    const weighted = [
      ...fresh.filter(c => !c.isDomain),
      ...fresh.filter(c => c.isDomain),
      ...fresh.filter(c => c.isDomain),
      ...fresh.filter(c => c.isDomain),
    ]
    // Pick randomly from weighted pool
    const pool = weighted.length ? weighted : candidates
    const pick = pool[Math.floor(Math.random() * pool.length)]
    // Track history
    usedLensIndices.push(String(pick.i))
    if (usedLensIndices.length > MAX_HISTORY) usedLensIndices.shift()
    return pick.fn(concept)
  }

  // ── Chain-of-thought suffix ───────────────────────────────────
  const COT_SUFFIXES = [
    ' Think step by step before answering.',
    ' Reason carefully before giving your final answer.',
    ' Show your reasoning chain before reaching a conclusion.',
    ' Work through the logic explicitly before summarising.',
    '', // no scaffold — let the question speak
  ]
  function addCoT(prompt) {
    return prompt + COT_SUFFIXES[Math.floor(Math.random() * COT_SUFFIXES.length)]
  }

  // ── Depth escalation ─────────────────────────────────────────
  // Every SYNTHESIS_EVERY turns, ask for a cross-thread synthesis.
  let turnCount = 0
  const SYNTHESIS_EVERY = 6
  function maybeSynthesise(basePrompt) {
    turnCount++
    if (turnCount % SYNTHESIS_EVERY === 0) {
      return 'So far you have explored several aspects of this topic. ' +
             'Synthesise the key threads into a single unified model or framework. ' +
             'What single insight ties them all together, and what important gap remains open?'
    }
    return basePrompt
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    /**
     * Generate the next intelligent follow-up prompt.
     *
     * @param {string} lastReply  – full text of the last ChatGPT response
     * @param {string} [topic]    – user-configured topic (app.config.replyTopic)
     * @returns {string}          – the prompt to send
     */
    nextPrompt(lastReply, topic) {
      const concept = extractConcept(lastReply) || (topic && topic !== 'All' ? topic : 'this concept')
      const domain  = detectDomain(lastReply)
      const lens    = pickLens(concept, domain)
      const withCoT = addCoT(lens)
      return maybeSynthesise(withCoT)
    },

    // Expose internals for testing
    extractConcept,
    detectDomain,
    reset() { usedLensIndices.length = 0; turnCount = 0 },
  }
})()
