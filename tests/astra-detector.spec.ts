import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const detector = require(resolve(cwd, 'dist-electron', 'astraDetector.cjs'))

const {
  buildBaseline,
  classifyMessages,
  pickCandidate,
  evaluateCompletion,
  confirmSubmitted,
  fingerprintOf,
  normaliseText,
  parseAstraProbe,
  parseAstraComposerTarget,
  clampToViewport,
  ASTRA_STABLE_POLLS_REQUIRED,
  ASTRA_MIN_STABLE_MS
} = detector

type Probe = any

/** Builds a probe from a list of assistant messages, defaulting to a finished, non-streaming state. */
function probeOf(entries: { key: string; text: string; isStreaming?: boolean; hasRegenerate?: boolean }[], overrides: Partial<Probe> = {}): Probe {
  return {
    messages: entries.map((entry, index) => ({
      key: entry.key,
      index,
      text: entry.text,
      fingerprint: fingerprintOf(entry.text),
      hasRegenerate: entry.hasRegenerate ?? true,
      isStreaming: entry.isStreaming ?? false
    })),
    selectorCounts: { '[data-message-author-role="assistant"]': entries.length },
    composerCount: 1,
    stopControlPresent: false,
    userFingerprints: [],
    threadReady: true,
    ...overrides
  }
}

test.describe('text normalisation', () => {
  test('collapses whitespace and case so re-wrapped text matches itself', () => {
    expect(normaliseText('  The   ruling\n\nstands  ')).toBe('the ruling stands')
  })

  test('fingerprint is bounded so a very long reply cannot dominate comparison', () => {
    expect(fingerprintOf('x'.repeat(5000))).toHaveLength(200)
  })
})

test.describe('empty baseline', () => {
  test('a thread with no assistant messages produces an empty baseline, not an error', () => {
    const baseline = buildBaseline(probeOf([]))
    expect(baseline.count).toBe(0)
    expect(baseline.keys.size).toBe(0)
    expect(baseline.fingerprints.size).toBe(0)
  })

  test('with an empty baseline the first reply is correctly found as new', () => {
    const baseline = buildBaseline(probeOf([]))
    const picked = pickCandidate(probeOf([{ key: 'a1', text: 'The hammer is raised, Your Honour.' }]), baseline)
    expect(picked.found).toBe(true)
    expect(picked.candidate.key).toBe('a1')
  })

  test('with an empty baseline the detector reports having seen nothing rather than failing', () => {
    const baseline = buildBaseline(probeOf([]))
    const picked = pickCandidate(probeOf([]), baseline)
    expect(picked.found).toBe(false)
    expect(picked.reason).toBe('no-assistant-messages')
  })

  test('a page that has not finished loading is reported as not ready', () => {
    const baseline = buildBaseline(probeOf([]))
    const picked = pickCandidate(probeOf([], { threadReady: false }), baseline)
    expect(picked.found).toBe(false)
    expect(picked.reason).toBe('thread-not-ready')
  })
})

test.describe('never mistaking an existing response for a new one', () => {
  test('an unchanged thread after the send yields no candidate', () => {
    const seeded = probeOf([
      { key: 'm1', text: 'First ruling on the scope of the ruling.' },
      { key: 'm2', text: 'Second ruling on the scope of the ruling.' }
    ])
    const baseline = buildBaseline(seeded)

    // Nothing new has been added: the same two messages, same identities, same positions.
    const unchanged = probeOf([
      { key: 'm1', text: 'First ruling on the scope of the ruling.' },
      { key: 'm2', text: 'Second ruling on the scope of the ruling.' }
    ])

    const picked = pickCandidate(unchanged, baseline)
    expect(picked.found).toBe(false)
    expect(picked.reason).toBe('all-messages-known')
  })

  test('existing messages are rejected by identity even when the site re-renders them', () => {
    const baseline = buildBaseline(probeOf([{ key: 'm1', text: 'An older reply entirely.' }]))
    // Same message id, so it is the same message no matter what the site did to the markup.
    const reRendered = probeOf([{ key: 'm1', text: 'An older reply entirely, reformatted by the renderer.' }])

    const { fresh, rejected } = classifyMessages(reRendered, baseline)
    expect(fresh).toHaveLength(0)
    expect(rejected[0].reason).toBe('known-key')
  })

  test('existing messages are rejected by position when the site offers no identity at all', () => {
    const baseline = buildBaseline(probeOf([
      { key: 'derived-old-one', text: 'First older reply without a stable id.' },
      { key: 'derived-old-two', text: 'Second older reply without a stable id.' }
    ]))

    // Same two replies, but the content-derived keys differ because the renderer rewrote the whitespace.
    const rewritten = probeOf([
      { key: 'derived-a', text: 'First older reply without a stable id' },
      { key: 'derived-b', text: 'Second older reply without a stable id' }
    ])

    const { fresh, rejected } = classifyMessages(rewritten, baseline)
    expect(fresh).toHaveLength(0)
    expect(rejected.map((entry: any) => entry.reason)).toEqual(['known-position', 'known-position'])
  })

  test('a message whose text happens to match an old one is not treated as new', () => {
    const long = 'The scope creep hammer is used when a tiny feature becomes a complete platform.'
    const baseline = buildBaseline(probeOf([{ key: 'm1', text: long }]))
    // A genuinely separate message that happens to repeat the same words, at a position past the baseline.
    const repeated = probeOf([{ key: 'm1', text: long }, { key: 'm2', text: long }])
    const { fresh } = classifyMessages(repeated, baseline)
    expect(fresh).toHaveLength(0)
  })
})

test.describe('delayed responses', () => {
  test('no candidate is reported while the reply has not started, then it is found once it arrives', () => {
    const baseline = buildBaseline(probeOf([]))

    // Several polls pass with the thread unchanged — the model is thinking.
    for (let poll = 0; poll < 5; poll += 1) {
      expect(pickCandidate(probeOf([]), baseline).found).toBe(false)
    }

    // The reply finally lands.
    const arrived = pickCandidate(probeOf([{ key: 'late-1', text: 'I have considered the argument and I concur.' }]), baseline)
    expect(arrived.found).toBe(true)
    expect(arrived.candidate.key).toBe('late-1')
  })

  test('a late reply after an existing conversation is found, not confused with the earlier replies', () => {
    const baseline = buildBaseline(probeOf([
      { key: 'm1', text: 'The first thing Astra said about the matter.' },
      { key: 'm2', text: 'The second thing Astra said about the matter.' }
    ]))

    const withReply = probeOf([
      { key: 'm1', text: 'The first thing Astra said about the matter.' },
      { key: 'm2', text: 'The second thing Astra said about the matter.' },
      { key: 'm3', text: 'The third thing Astra said about the matter.' }
    ])

    const picked = pickCandidate(withReply, baseline)
    expect(picked.found).toBe(true)
    expect(picked.candidate.key).toBe('m3')
  })
})

test.describe('choosing the newest response', () => {
  test('when several messages are new the last in document order wins', () => {
    const baseline = buildBaseline(probeOf([]))
    const probe = probeOf([
      { key: 'zzz-earlier', text: 'An earlier reply that arrived first.' },
      { key: 'mmm-middle', text: 'A middle reply that arrived second.' },
      { key: 'aaa-latest', text: 'The latest reply that arrived last.' }
    ])
    const picked = pickCandidate(probe, baseline)
    // The keys here sort in exactly the opposite order to their document positions, which is the trap
    // that an earlier implementation fell into when it ordered candidates by key.
    expect(picked.candidate.key).toBe('aaa-latest')
    expect(picked.candidate.index).toBe(2)
  })
})

test.describe('replies are never discarded by their content', () => {
  test('a reply mentioning ChatGPT is not filtered out', () => {
    const baseline = buildBaseline(probeOf([]))
    const probe = probeOf([{ key: 'r1', text: 'ChatGPT logged out mid-session, so the paste never reached the composer.' }])
    const picked = pickCandidate(probe, baseline)
    expect(picked.found).toBe(true)
    expect(picked.candidate.text).toContain('ChatGPT')
  })

  test('a reply mentioning regenerate is not filtered out', () => {
    const baseline = buildBaseline(probeOf([]))
    const probe = probeOf([{ key: 'r2', text: 'The regenerate control is not a completion signal on its own, I am afraid.' }])
    expect(pickCandidate(probe, baseline).found).toBe(true)
  })

  test('a short reply is not discarded', () => {
    const baseline = buildBaseline(probeOf([]))
    const probe = probeOf([{ key: 'r3', text: 'Guilty.' }])
    expect(pickCandidate(probe, baseline).found).toBe(true)
  })
})

test.describe('completion detection', () => {
  test('a stop control means generation is still in progress, whatever the message looks like', () => {
    const candidate = probeOf([{ key: 'm1', text: 'Partial text so far', isStreaming: false, hasRegenerate: true }]).messages[0]
    const probe = probeOf([], { stopControlPresent: true })
    const result = evaluateCompletion(candidate, probe, 99)
    expect(result.complete).toBe(false)
    expect(result.signal).toBe('stop-control-present')
  })

  test('a message still streaming is not complete', () => {
    const candidate = probeOf([{ key: 'm1', text: 'Partial text', isStreaming: true, hasRegenerate: false }]).messages[0]
    const result = evaluateCompletion(candidate, probeOf([]), 99)
    expect(result.complete).toBe(false)
    expect(result.signal).toBe('message-streaming')
  })

  test('a finished message with a regenerate control completes immediately', () => {
    const candidate = probeOf([{ key: 'm1', text: 'A finished reply.' }]).messages[0]
    const result = evaluateCompletion(candidate, probeOf([]), 0)
    expect(result.complete).toBe(true)
    expect(result.signal).toBe('regenerate-button')
  })

  test('a message with no completion affordance at all still completes once its text settles', () => {
    // The important case: a site that offers neither a stop control nor a regenerate button. Completion
    // has to come from the text holding still, or the wait can never finish.
    const candidate = probeOf([{ key: 'm1', text: 'A reply with no affordances.', hasRegenerate: false }]).messages[0]
    const probe = probeOf([], { stopControlPresent: false })

    expect(evaluateCompletion(candidate, probe, 0).complete).toBe(false)
    expect(evaluateCompletion(candidate, probe, ASTRA_STABLE_POLLS_REQUIRED - 1, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS).complete).toBe(false)
    // Settled for long enough, not merely for the required number of polls.
    expect(evaluateCompletion(candidate, probe, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS, ASTRA_MIN_STABLE_MS).complete).toBe(true)
  })

  test('a permanently present composer caret does not prevent completion', () => {
    // This is the deadlock that hung the original implementation. The page carries composer decoration
    // whose class names contain "cursor" and "blink" at all times, so any check that asks the whole
    // page whether something is animating is permanently true. Completion must therefore be decided
    // from the watched message and the stop control alone.
    //
    // The per-message caret check added later must not reintroduce that deadlock: it reads a flag the
    // probe derives from the message's own prose, and page-level blink/cursor decoration must not reach
    // it. That is asserted here — a page advertising blink and cursor selectors completes normally.
    const candidate = probeOf([{ key: 'm1', text: 'A reply delivered while the caret blinks.', hasRegenerate: false }]).messages[0]
    const probe = probeOf([], {
      composerCount: 1,
      stopControlPresent: false,
      selectorCounts: { '[class*="blink"]': 1, '[class*="cursor"]': 1 }
    })

    // The per-message caret flag is not set, so page-level blink/cursor decoration cannot reach it.
    expect(candidate.hasCaret).toBeFalsy()
    const result = evaluateCompletion(candidate, probe, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS, ASTRA_MIN_STABLE_MS)
    expect(result.complete).toBe(true)
  })
})

test.describe('confirming the prompt was submitted', () => {
  test('accepts the prompt once it appears in the thread', () => {
    const sent = 'Is the hammer already swinging, Your Honour?'
    const probe = probeOf([], { userFingerprints: [fingerprintOf(sent)] })
    expect(confirmSubmitted(sent, probe)).toBe(true)
  })

  test('rejects a prompt that never reached the thread', () => {
    const probe = probeOf([], { userFingerprints: [] })
    expect(confirmSubmitted('Is the hammer already swinging, Your Honour?', probe)).toBe(false)
  })

  test('does not mistake an unrelated prompt for the one just sent', () => {
    const probe = probeOf([], { userFingerprints: ['something entirely different was asked of the court today'] })
    expect(confirmSubmitted('Is the hammer already swinging, Your Honour?', probe)).toBe(false)
  })

  test('tolerates the site wrapping the prompt in its own furniture', () => {
    const sent = 'Nova requests leave to present evidence on the routing bug that stalled the court.'
    // The site appended a label around the prompt text; the prompt still genuinely arrived.
    const probe = probeOf([], { userFingerprints: [`you said ${fingerprintOf(sent)} 4:31 pm`] })
    expect(confirmSubmitted(sent, probe)).toBe(true)
  })

  test('refuses to confirm a prompt too short to identify safely', () => {
    const probe = probeOf([], { userFingerprints: ['yes', 'no', 'ok'] })
    expect(confirmSubmitted('hi', probe)).toBe(false)
  })

  test('tolerates empty text', () => {
    expect(confirmSubmitted('   ', probeOf([], { userFingerprints: ['anything'] }))).toBe(false)
  })
})

test.describe('probe parsing', () => {
  test('malformed page output degrades to an empty probe instead of throwing', () => {
    for (const bad of [null, undefined, 'nope', 42, [], {}]) {
      const parsed = parseAstraProbe(bad)
      expect(parsed.messages).toEqual([])
      expect(parsed.threadReady).toBe(false)
    }
  })

  test('empty and whitespace-only messages are dropped', () => {
    const parsed = parseAstraProbe({
      messages: [{ key: 'a', text: '   ' }, { key: 'b', text: 'real content' }, 'garbage', null],
      threadReady: true
    })
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0].text).toBe('real content')
  })

  test('positions are re-densified so a gap in the page cannot shift the baseline comparison', () => {
    const parsed = parseAstraProbe({
      messages: [{ key: 'a', text: 'first' }, { key: 'b', text: 'third', index: 7 }],
      threadReady: true
    })
    expect(parsed.messages.map((m: any) => m.index)).toEqual([0, 1])
  })

  test('a message with no fingerprint gets one derived from its text', () => {
    const parsed = parseAstraProbe({ messages: [{ key: 'a', text: 'Some reply' }], threadReady: true })
    expect(parsed.messages[0].fingerprint).toBe(fingerprintOf('Some reply'))
  })

  test('selector counts are preserved so a broken selector is visible', () => {
    const parsed = parseAstraProbe({
      messages: [],
      selectorCounts: { '[data-message-author-role="assistant"]': 0, 'div[class*="assistant"]': 3, bogus: 'x' },
      threadReady: true
    })
    expect(parsed.selectorCounts['[data-message-author-role="assistant"]']).toBe(0)
    expect(parsed.selectorCounts['div[class*="assistant"]']).toBe(3)
    expect(parsed.selectorCounts.bogus).toBeUndefined()
  })

  test('composer targets parse safely from unexpected input', () => {
    expect(parseAstraComposerTarget(null).found).toBe(false)
    const good = parseAstraComposerTarget({ found: true, selector: '#composer', alreadyFocused: false, rect: { x: 10, y: 20, width: 30, height: 40 } })
    expect(good.rect).toEqual({ x: 10, y: 20, width: 30, height: 40 })
    expect(good.found).toBe(true)
  })

  test('click coordinates are clamped inside the view', () => {
    expect(clampToViewport({ x: 500, y: 400 }, { width: 300, height: 200 })).toEqual({ x: 300, y: 200 })
    expect(clampToViewport({ x: -5, y: -5 }, { width: 300, height: 200 })).toEqual({ x: 0, y: 0 })
  })
})
