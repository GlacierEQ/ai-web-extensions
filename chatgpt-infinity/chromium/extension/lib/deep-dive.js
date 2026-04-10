// ==============================================================
// deep-dive.js — Intelligent follow-up prompt engine
// for ChatGPT Infinity ∞
// Casey Barton / GlacierEQ fork — April 2026
//
// Exposes window.deepDive:
//   deepDive.nextPrompt(lastReplyText, topic) → string
//   deepDive.reset()   — clear state on stop/restart
//   deepDive.state     — read-only view of internal state
// ==============================================================

window.deepDive = (() => {
  'use strict'

  // ── Epistemological lens templates ──────────────────────────
  // Each receives (concept, conceptHistory) so thread-back lenses
  // can reference earlier concepts.
  const LENSES = [
    // Conceptual deepening
    (c) => `The previous answer mentioned "${c}". Explain the *underlying mechanism* that makes this true — go one level deeper than the surface explanation and identify any hidden assumptions.`,
    (c) => `"${c}" was just described. Now steelman the strongest objection or counterexample someone could raise against this — then resolve it.`,
    (c) => `Given "${c}", trace the causal chain: what must be true *upstream* for this to hold, and what does this *downstream* imply that most people overlook?`,
    // Comparative / contrastive
    (c) => `Contrast "${c}" with its most commonly confused neighbour concept. Where do they diverge in a way that actually matters in practice?`,
    (c) => `"${c}" — in what domain does this principle *break down* or invert? Give a specific, non-obvious edge case.`,
    // Applicative
    (c) => `How would an expert practitioner apply "${c}" differently from a novice? What tacit knowledge separates them?`,
    (c) => `Design a minimal experiment or test that would let you falsify or validate "${c}". What would a positive result look like vs. a negative one?`,
    // Historical / evolutionary
    (c) => `How did the understanding of "${c}" evolve over time? What was the key insight that replaced the previous (wrong) model?`,
    (c) => `What was the first-principles argument that originally established "${c}", and which part of that argument is most contested today?`,
    // Cross-domain synthesis
    (c) => `Find an analogy for "${c}" in a completely different field. What does that analogy reveal that a within-domain explanation cannot?`,
    (c) => `Where do complexity or emergent behaviour complicate a simple explanation of "${c}"?`,
    // Quantitative / structural
    (c) => `What are the key variables or parameters governing "${c}"? How does the behaviour change as each one is pushed to extremes?`,
    (c) => `Break "${c}" into its irreducible sub-components. Which component contributes most to the overall effect, and why?`,
    // Implications
    (c) => `If "${c}" were suddenly no longer true, what would be the first-order and second-order consequences?`,
    (c) => `What is the single most important practical implication of "${c}" that is routinely ignored or underweighted?`,
    // Thread-back lenses — weave earlier concepts back in
    (c, h) => h.length > 1 ? `Earlier in this conversation you covered "${h[Math.floor(Math.random()*Math.min(h.length-1,4))]}". How does "${c}" relate to, extend, or challenge that earlier idea?` : `What is the most surprising or counter-intuitive aspect of "${c}"?`,
    (c, h) => h.length > 2 ? `You have now discussed "${h.slice(-3).join('", "')}". What single unifying principle connects all three?` : `What question about "${c}" do most people never think to ask?`,
    (c, h) => h.length > 1 ? `Considering everything discussed so far, where does "${c}" sit on the spectrum between well-established consensus and genuinely open question?` : `What would a sceptic's strongest critique of "${c}" be, and how would you answer it?`,
  ]

  // ── Domain-specific lens libraries ──────────────────────────
  const TOPIC_LENSES = {
    law: [
      c => `Regarding "${c}": identify the controlling statutory authority, the leading case, and the circuit split (if any). Which jurisdiction's rule is most protective of the individual?`,
      c => `Under "${c}", what is the burden of proof, who bears it, and how have courts defined the evidentiary standard in practice?`,
    ],
    code: [
      c => `For "${c}": what is the asymptotic complexity, and are there known algorithmic improvements that achieve better bounds?`,
      c => `Show the minimal reproducible anti-pattern for "${c}" and refactor it to idiomatic, production-grade code with an explanation of each change.`,
    ],
    science: [
      c => `What is the current scientific consensus on "${c}", and what is the strongest dissenting hypothesis still held by credible researchers?`,
      c => `Describe the experimental setup that would provide the most definitive evidence for or against "${c}". What would a null result mean?`,
    ],
    history: [
      c => `Who were the key actors in "${c}", what incentives drove them, and which contingent factor most altered the outcome?`,
      c => `How have historians' interpretations of "${c}" shifted across generations, and what drove the historiographical revision?`,
    ],
    math: [
      c => `State "${c}" formally and prove or disprove it for the simplest non-trivial case.`,
      c => `What generalisation of "${c}" opens the richest unexplored territory in current research?`,
    ],
    philosophy: [
      c => `What is the strongest incompatibilist argument against "${c}", and how does the compatibilist respond?`,
      c => `Trace "${c}" through at least three major philosophical traditions. Where do they most sharply diverge, and why?`,
    ],
    economics: [
      c => `What does standard neoclassical theory predict about "${c}", and where does behavioural economics most significantly deviate from that prediction?`,
      c => `Model "${c}" as a game: who are the players, what are their strategies, and what is the Nash equilibrium? Is it socially optimal?`,
    ],
    medicine: [
      c => `What is the current first-line clinical guideline for "${c}", what is the evidence grade, and what are the most common reasons clinicians deviate from it?`,
      c => `Explain the pathophysiology of "${c}" at the cellular/molecular level, then map that mechanism to the observable symptoms.`,
    ],
    engineering: [
      c => `What are the dominant failure modes for "${c}", how are they detected, and what design patterns prevent them?`,
      c => `Walk through the trade-off space for "${c}": performance vs. reliability vs. cost. Where does the Pareto frontier sit?`,
    ],
    psychology: [
      c => `What does the replication crisis reveal about the empirical status of "${c}"? Which findings have held up, and which have failed to replicate?`,
      c => `Describe the cognitive or neural mechanism behind "${c}" and explain how individual differences modulate its expression.`,
    ],
  }

  // Domain keyword map
  const DOMAIN_KEYWORDS = {
    law:         /\b(statute|court|jurisdiction|plaintiff|defendant|habeas|writ|§|usc|haw\.rev\.stat|precedent|common law|tort|appeal)\b/,
    code:        /\b(function|algorithm|async|api|runtime|o\(n\)|typescript|python|class|interface|refactor|repo|git|deploy)\b/,
    science:     /\b(hypothesis|experiment|peer.reviewed|study|p.value|rct|mechanism|protein|genome|empirical|data|sample)\b/,
    history:     /\b(century|empire|treaty|war|revolution|dynasty|historian|archive|colonial|medieval|ancient)\b/,
    math:        /\b(theorem|proof|axiom|lemma|manifold|algebra|topology|set theory|calculus|integer|prime)\b/,
    philosophy:  /\b(epistemology|ontology|ethics|metaphysics|consciousness|free will|Kant|Aristotle|Plato|Nietzsche|phenomenology)\b/i,
    economics:   /\b(market|supply|demand|gdp|inflation|utility|marginal|elasticity|equilibrium|fiscal|monetary|trade)\b/,
    medicine:    /\b(diagnosis|symptom|treatment|clinical|pathology|patient|prognosis|dosage|syndrome|disease|therapy)\b/,
    engineering: /\b(design|system|tolerance|load|stress|circuit|voltage|protocol|architecture|failure mode|safety factor)\b/,
    psychology:  /\b(cognitive|behaviour|bias|heuristic|perception|memory|emotion|personality|therapy|disorder|replication)\b/,
  }

  // ── Concept extraction — scored multi-candidate ──────────────
  // Extracts ALL candidate concepts, scores them, returns best.
  function extractConcept(replyText) {
    if (!replyText) return null
    try {
      const candidates = []

      // Bold terms (up to 5, with position score)
      let m, re = /\*\*([^*]{4,60}?)\*\*/g
      let pos = 0
      while ((m = re.exec(replyText)) !== null && candidates.length < 5) {
        const score = 10 - Math.min(pos++, 9) // earlier = higher score
        candidates.push({ text: m[1].trim(), score })
      }

      // First heading
      const hm = replyText.match(/^#{1,3}\s+(.{4,80})/m)
      if (hm) candidates.push({ text: hm[1].trim(), score: 8 })

      // First capitalised NP in first sentence
      const firstSentence = replyText.split(/[.!?]/)[0] || ''
      const npMatch = firstSentence.match(/\b([A-Z][a-z]+(?:\s[A-Za-z]+){1,4})\b/)
      if (npMatch) candidates.push({ text: npMatch[1].trim(), score: 4 })

      if (!candidates.length) return replyText.split(/\s+/).slice(0, 6).join(' ')

      // Boost multi-word concepts (more specific = better)
      candidates.forEach(c => { c.score += Math.min(c.text.split(' ').length - 1, 3) })

      // Pick highest scorer
      candidates.sort((a, b) => b.score - a.score)
      return candidates[0].text
    } catch (e) { return null }
  }

  // ── Domain detector ──────────────────────────────────────────
  function detectDomain(text) {
    const t = (text || '').toLowerCase()
    // Score each domain by keyword hit count — return highest
    let best = null, bestScore = 0
    for (const [domain, re] of Object.entries(DOMAIN_KEYWORDS)) {
      const hits = (t.match(new RegExp(re.source, re.flags + 'g')) || []).length
      if (hits > bestScore) { bestScore = hits; best = domain }
    }
    return bestScore >= 1 ? best : null
  }

  // ── State ─────────────────────────────────────────────────────
  const usedLensIndices = []   // recent lens IDs — prevent repetition
  const conceptHistory  = []   // recent concepts — enable threading
  const MAX_LENS_HISTORY    = 6
  const MAX_CONCEPT_HISTORY = 8
  let   turnCount = 0

  // ── Lens picker ───────────────────────────────────────────────
  function pickLens(concept, domain, history) {
    let candidates = LENSES.map((fn, i) => ({ fn, i: String(i), isDomain: false }))
    if (domain && TOPIC_LENSES[domain])
      TOPIC_LENSES[domain].forEach((fn, j) =>
        candidates.push({ fn, i: `${domain}_${j}`, isDomain: true }))

    const fresh = candidates.filter(c => !usedLensIndices.includes(c.i))
    const pool  = fresh.length ? fresh : candidates // full reset if exhausted

    // Weight domain lenses 3× — replicate them in the pool
    const weighted = [
      ...pool.filter(c => !c.isDomain),
      ...pool.filter(c => c.isDomain),
      ...pool.filter(c => c.isDomain),
      ...pool.filter(c => c.isDomain),
    ]

    const pick = weighted[Math.floor(Math.random() * weighted.length)]
    usedLensIndices.push(pick.i)
    if (usedLensIndices.length > MAX_LENS_HISTORY) usedLensIndices.shift()

    // Thread-back lenses receive the full history array
    return pick.fn(concept, history)
  }

  // ── Adaptive chain-of-thought suffix ─────────────────────────
  // Scales with apparent complexity of the concept.
  const COT_SIMPLE  = ['', ' Be concise.']
  const COT_MEDIUM  = [' Think step by step before answering.', ' Reason carefully before giving your final answer.', '']
  const COT_COMPLEX = [' Show your reasoning chain before reaching a conclusion.', ' Work through the logic explicitly before summarising.', ' Think step by step before answering.']

  function addCoT(prompt, concept) {
    const words = (concept || '').split(/\s+/).length
    const bank  = words <= 2 ? COT_SIMPLE : words <= 4 ? COT_MEDIUM : COT_COMPLEX
    return prompt + bank[Math.floor(Math.random() * bank.length)]
  }

  // ── Escalating synthesis turns ────────────────────────────────
  const SYNTHESIS = [
    // Turn 6 — local thread synthesis
    h => `You have just explored several related ideas${
      h.length ? `, including "${h.slice(-3).join('", "')}"` : ''
    }. Synthesise these into a single coherent model. What one insight ties them together, and what key tension or gap remains unresolved?`,
    // Turn 12 — meta-synthesis
    h => `Stepping back across everything discussed so far${
      h.length ? ` (topics have included: ${h.slice(-6).join(', ')})` : ''
    }: what is the single deepest structural pattern or governing principle that unifies all of it? Where does that pattern break down?`,
    // Turn 18+ — grand unification / open frontier
    h => `Given the full arc of this conversation${
      h.length ? ` — from "${h[0]}" to "${h[h.length-1]}"` : ''
    } — what is the most important question that remains genuinely open? Who is working on it, what is the current best attempt at an answer, and why is it hard?`,
  ]

  function maybeSynthesise(basePrompt, history) {
    turnCount++
    if (turnCount % 6 === 0) {
      const tier = Math.min(Math.floor(turnCount / 6) - 1, SYNTHESIS.length - 1)
      return SYNTHESIS[tier](history)
    }
    return basePrompt
  }

  // ── Concept memory updater ────────────────────────────────────
  function recordConcept(concept) {
    if (!concept) return
    // Deduplicate consecutive same concept
    if (conceptHistory[conceptHistory.length - 1] === concept) return
    conceptHistory.push(concept)
    if (conceptHistory.length > MAX_CONCEPT_HISTORY) conceptHistory.shift()
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    /**
     * Generate the next intelligent follow-up prompt.
     * @param {string} lastReply  Full text of the last ChatGPT response
     * @param {string} [topic]    User-configured topic (app.config.replyTopic)
     * @returns {string}          The prompt to send
     */
    nextPrompt(lastReply, topic) {
      try {
        const concept = extractConcept(lastReply)
          || (topic && !/^(all|any|every)$/i.test(topic) ? topic : null)
          || 'this concept'
        recordConcept(concept)
        const domain   = detectDomain(lastReply)
        const lens     = pickLens(concept, domain, [...conceptHistory])
        const withCoT  = addCoT(lens, concept)
        return maybeSynthesise(withCoT, [...conceptHistory])
      } catch (e) {
        // Graceful degradation — never crash the loop
        console.warn('[DeepDive] nextPrompt error, using fallback:', e)
        return 'Continue exploring this topic. Go deeper on the most interesting aspect of your last answer.'
      }
    },

    // Expose internals for debugging
    extractConcept,
    detectDomain,
    get state() {
      return {
        turnCount,
        conceptHistory: [...conceptHistory],
        usedLenses: [...usedLensIndices],
      }
    },
    reset() {
      usedLensIndices.length = 0
      conceptHistory.length  = 0
      turnCount = 0
    },
  }
})()
