import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const detector = require(resolve(cwd, 'dist-electron', 'astraDetector.cjs'))
const { UnifiedTurnService } = require(resolve(cwd, 'dist-electron', 'unifiedTurnService.cjs'))
const { ConversationService } = require(resolve(cwd, 'dist-electron', 'conversationService.cjs'))

const { captureUserBaseline, confirmSubmittedWithBaseline, countNewUserMessages, fingerprintOf, evaluateCompletion, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS } = detector

type Probe = any

/** A probe with the given user messages already in the thread and no assistant messages. */
function thread(userTexts: string[]): Probe {
  return {
    messages: [],
    selectorCounts: {},
    composerCount: 1,
    stopControlPresent: false,
    userFingerprints: userTexts.map(fingerprintOf),
    userMessageCount: userTexts.length,
    threadReady: true
  }
}

function tempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'nc-turns-'))
}

/**
 * These cover the delivery-stability rules end to end at the module level.
 *
 * Each test names the failure it exists to prevent. They run without Electron because the behaviour
 * under test is pure decision-making over observed data — which is also why it was previously
 * untestable and therefore shipped broken.
 */
test.describe('Astra submission confirmation', () => {
  test('a slow acknowledgement still confirms once the message appears', async () => {
    // The original bug: a 2.5s window was treated as proof the message never arrived. Confirmation is
    // now a poll that keeps waiting, so however long ChatGPT takes, a late arrival is still a success.
    const baseline = captureUserBaseline(thread(['earlier question']))
    const prompt = 'A considerably longer prompt that will arrive late'
    const arrivalPoll = 30

    let probe = thread(['earlier question'])
    for (let poll = 0; poll < arrivalPoll; poll += 1) {
      expect(confirmSubmittedWithBaseline(prompt, probe, baseline).confirmed, `poll ${poll}`).toBe(false)
    }

    // ChatGPT finally renders the user's own message, well past the old 2.5 second window.
    probe = thread(['earlier question', prompt])
    const late = confirmSubmittedWithBaseline(prompt, probe, baseline)
    expect(late.confirmed).toBe(true)
    expect(late.matchedBy).toBe('new-text')
  })

  test('short messages such as "OK" and "Yes" are confirmed', () => {
    // These are the messages the old eight-character minimum could never confirm, so a reply to a
    // one-word answer could never be captured.
    for (const prompt of ['OK', 'Yes', 'No', 'Go', 'ok']) {
      const baseline = captureUserBaseline(thread([]))
      const verdict = confirmSubmittedWithBaseline(prompt, thread([prompt]), baseline)
      expect(verdict.confirmed, `"${prompt}" should confirm`).toBe(true)
    }
  })

  test('a historical message alone does not confirm the current submission', () => {
    // The old substring search matched any message ever sent. If Karl asked the same thing in an
    // earlier turn, that old text would confirm the new send before it had even left the composer.
    const prompt = 'Please review the change I just made to the parser'
    const baseline = captureUserBaseline(thread([prompt]))
    expect(confirmSubmittedWithBaseline(prompt, thread([prompt]), baseline).confirmed).toBe(false)
  })

  test('no substring match against unrelated messages can confirm', () => {
    const baseline = captureUserBaseline(thread([]))
    // An old, unrelated bubble that merely contains the beginning of the prompt.
    const verdict = confirmSubmittedWithBaseline(
      'Please review the change',
      thread(['Please review the change log while you are there'])
    , baseline)
    expect(verdict.confirmed).toBe(false)
  })

  test('the same prompt in two different turns confirms independently', () => {
    const prompt = 'Same question twice'

    const firstBaseline = captureUserBaseline(thread([]))
    expect(confirmSubmittedWithBaseline(prompt, thread([prompt]), firstBaseline).confirmed).toBe(true)

    // Second turn: the first turn's message is now history, so it must not confirm on its own.
    const secondBaseline = captureUserBaseline(thread([prompt]))
    expect(confirmSubmittedWithBaseline(prompt, thread([prompt]), secondBaseline).confirmed).toBe(false)

    // The second send genuinely arrives, producing a second identical bubble. It must be recognised as
    // new by position, or the delivery would be reported undelivered and a retry would send a third.
    const repeated = confirmSubmittedWithBaseline(prompt, thread([prompt, prompt]), secondBaseline)
    expect(repeated.confirmed).toBe(true)
    expect(repeated.matchedBy).toBe('new-position')
  })

  test('a repeat is not confirmed until the thread actually grows', () => {
    // The positional rule must not fire just because the text is already known — that would confirm a
    // submission that never happened, which is the worse of the two errors.
    const prompt = 'Repeat question'
    const baseline = captureUserBaseline(thread([prompt]))
    expect(confirmSubmittedWithBaseline(prompt, thread([prompt]), baseline).confirmed).toBe(false)
  })

  test('an unidentifiable new message is counted so reconciliation can escalate', () => {
    // "Something arrived but we cannot tell what" must be distinguishable from "nothing happened",
    // because only the first of those needs Karl before a resend.
    const baseline = captureUserBaseline(thread(['first']))
    const after = thread(['first', 'something from another client'])
    expect(countNewUserMessages(after, baseline)).toBe(1)
    expect(confirmSubmittedWithBaseline('never sent', after, baseline)).toEqual({ confirmed: false, observedNewUserMessages: 1 })
    expect(countNewUserMessages(thread(['first']), baseline)).toBe(0)
  })
})

test.describe('Astra response completion detection', () => {
  const baseProbe = (overrides: Partial<Probe> = {}): Probe => ({
    messages: [],
    selectorCounts: {},
    composerCount: 1,
    stopControlPresent: false,
    userFingerprints: [],
    userMessageCount: 0,
    threadReady: true,
    ...overrides
  })

  /** A finished, settled reply with no live evidence of streaming. */
  const settledReply = (overrides: Record<string, unknown> = {}): Probe => ({
    key: 'astra-1',
    index: 0,
    text: 'The full ruling.',
    fingerprint: 'the full ruling.',
    hasRegenerate: false,
    isStreaming: false,
    hasStopControl: false,
    hasCaret: false,
    hasThinkingIndicator: false,
    ...overrides
  })

  test('the stability fallback is far longer than the old one second', () => {
    // The defect: two polls at 500ms read as "finished", so any pause could be mistaken for completion.
    expect(ASTRA_STABLE_POLLS_REQUIRED).toBeGreaterThanOrEqual(6)
    expect(ASTRA_MIN_STABLE_MS).toBeGreaterThanOrEqual(3000)
  })

  test('a pause in streaming does not complete the response', () => {
    // A pause looks exactly like stability: the text has not moved across many polls. The only thing
    // distinguishing it from a finished reply is the caret still sitting in the prose, which is what
    // this asserts.
    const probe = baseProbe()
    const reply = settledReply({ hasCaret: true })
    for (let unchanged = 0; unchanged <= 20; unchanged += 1) {
      const result = evaluateCompletion(reply, probe, unchanged, ASTRA_STABLE_POLLS_REQUIRED, 60_000, ASTRA_MIN_STABLE_MS)
      expect(result.complete, `pause at ${unchanged} unchanged polls`).toBe(false)
      expect(result.signal).toBe('message-caret-present')
    }
  })

  test('streaming attributes on the message veto completion even when the text is stable', () => {
    const probe = baseProbe()
    for (const overrides of [
      { isStreaming: true },
      { hasThinkingIndicator: true },
      { hasStopControl: true }
    ]) {
      const result = evaluateCompletion(settledReply(overrides), probe, 30, ASTRA_STABLE_POLLS_REQUIRED, 60_000, ASTRA_MIN_STABLE_MS)
      expect(result.complete).toBe(false)
    }
  })

  test('a page-wide stop control still blocks completion', () => {
    const probe = baseProbe({ stopControlPresent: true })
    const result = evaluateCompletion(settledReply(), probe, 30, ASTRA_STABLE_POLLS_REQUIRED, 60_000, ASTRA_MIN_STABLE_MS)
    expect(result.complete).toBe(false)
    expect(result.signal).toBe('stop-control-present')
  })

  test('the regenerate button completes the response as soon as evidence of streaming clears', () => {
    const probe = baseProbe()
    // No stability wait at all: the site has stated the response is complete.
    const result = evaluateCompletion(settledReply({ hasRegenerate: true }), probe, 0, ASTRA_STABLE_POLLS_REQUIRED, 0, ASTRA_MIN_STABLE_MS)
    expect(result.complete).toBe(true)
    expect(result.signal).toBe('regenerate-button')
  })

  test('text stability completes only after both the poll count and the time floor', () => {
    const probe = baseProbe()
    const reply = settledReply()

    // Enough polls, but not enough elapsed time.
    const tooSoon = evaluateCompletion(reply, probe, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS - 1, ASTRA_MIN_STABLE_MS)
    expect(tooSoon.complete).toBe(false)
    expect(tooSoon.signal).toBe('awaiting-stability')

    // Enough time, but not enough polls.
    const tooFewPolls = evaluateCompletion(reply, probe, ASTRA_STABLE_POLLS_REQUIRED - 1, ASTRA_STABLE_POLLS_REQUIRED, 60_000, ASTRA_MIN_STABLE_MS)
    expect(tooFewPolls.complete).toBe(false)
    expect(tooFewPolls.signal).toBe('awaiting-stability')

    // Both satisfied.
    const settled = evaluateCompletion(reply, probe, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS, ASTRA_MIN_STABLE_MS)
    expect(settled.complete).toBe(true)
    expect(settled.signal).toBe('content-stable')
  })

  test('a response that streams, pauses, then continues is never completed mid-pause', () => {
    // The full shape of the original bug, end to end: text grows, stalls, then grows again.
    const probe = baseProbe()
    const history = [
      'The ruling begins and ',
      'The ruling begins and continues for a while before it',
      // --- pause: identical text across several polls, caret still present ---
      'The ruling begins and continues for a while before it pauses mid',
      'The ruling begins and continues for a while before it pauses mid',
      'The ruling begins and continues for a while before it pauses mid',
      'The ruling begins and continues for a while before it pauses mid'
    ]
    let unchanged = 0
    let completedDuringPause = false

    for (const text of history) {
      const reply = settledReply({ text, fingerprint: fingerprintOf(text), hasCaret: true })
      const result = evaluateCompletion(reply, probe, unchanged, ASTRA_STABLE_POLLS_REQUIRED, 3_000, ASTRA_MIN_STABLE_MS)
      unchanged += 1
      if (result.complete) completedDuringPause = true
    }
    expect(completedDuringPause).toBe(false)

    // Streaming resumes and finishes; only then, with no caret and no streaming marks, is it complete.
    const finalText = 'The ruling begins and continues for a while before it pauses mid-sentence and then finishes properly.'
    expect(evaluateCompletion(settledReply({ text: finalText }), probe, 0, ASTRA_STABLE_POLLS_REQUIRED, 0, ASTRA_MIN_STABLE_MS).complete).toBe(false)
    expect(evaluateCompletion(settledReply({ text: finalText }), probe, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_STABLE_POLLS_REQUIRED, ASTRA_MIN_STABLE_MS, ASTRA_MIN_STABLE_MS).complete).toBe(true)
  })

  test('a stopped generation is not read as a finished one', () => {
    // If Astra is interrupted, the half-written text must not be recorded as a complete ruling.
    const probe = baseProbe({ stopControlPresent: false })
    const stopped = settledReply({ hasStopControl: false, hasCaret: true })
    const result = evaluateCompletion(stopped, probe, 50, ASTRA_STABLE_POLLS_REQUIRED, 60_000, ASTRA_MIN_STABLE_MS)
    expect(result.complete).toBe(false)
  })
})

test.describe('Unified turn stage machine', () => {
  test('each stage is tracked independently and a later failure preserves earlier work', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'A question for the court' })
      const id = turn.id

      service.markStage(id, 'karl-recorded', 'complete')
      service.markStage(id, 'astra-submitted', 'complete')
      service.markStage(id, 'astra-responded', 'complete')
      // Nova then fails.
      service.markStage(id, 'nova-submitted', 'failed', 'Nova disconnected')

      const saved = service.get(id)
      // Astra's work survives Nova's failure — this is the resumability requirement.
      expect(saved.stages['karl-recorded'].status).toBe('complete')
      expect(saved.stages['astra-submitted'].status).toBe('complete')
      expect(saved.stages['astra-responded'].status).toBe('complete')
      expect(saved.stages['nova-submitted'].status).toBe('failed')
      expect(saved.stages['nova-responded'].status).toBe('pending')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a stage cannot complete while an earlier stage is incomplete', () => {
    // Without this, a turn could claim Nova answered when Astra never did.
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'Ordering matters' })
      service.markStage(turn.id, 'karl-recorded', 'complete')

      const result = service.markStage(turn.id, 'nova-responded', 'complete')
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/astra-submitted/)
      expect(service.get(turn.id)!.stages['nova-responded'].status).toBe('pending')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a completed stage can never be moved backwards', () => {
    // Otherwise a later failure could erase the record of what a seat actually said.
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'Immutable progress' })
      service.markStage(turn.id, 'karl-recorded', 'complete')
      service.markStage(turn.id, 'astra-submitted', 'complete')
      service.markStage(turn.id, 'astra-responded', 'complete')

      expect(service.markStage(turn.id, 'astra-responded', 'failed').ok).toBe(false)
      expect(service.get(turn.id)!.stages['astra-responded'].status).toBe('complete')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('an uncertain submission blocks resending until it is reconciled', () => {
    // This is the duplicate-prevention guarantee, enforced as the only way to ask permission.
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'Maybe delivered' })
      service.markStage(turn.id, 'karl-recorded', 'complete')

      expect(service.guardSubmission(turn.id, 'astra-submitted').allowed).toBe(true)
      service.markStage(turn.id, 'astra-submitted', 'uncertain')

      const blocked = service.guardSubmission(turn.id, 'astra-submitted')
      expect(blocked.allowed).toBe(false)
      expect(blocked.code).toBe('delivery-uncertain')
      expect(blocked.reason).toMatch(/Reconcile/i)

      // Reconciliation finds it in the thread, so no resend is needed.
      service.reconcile(turn.id, 'astra-submitted', 'accepted', 'Prompt found in the ChatGPT thread')
      expect(service.get(turn.id)!.stages['astra-submitted'].status).toBe('complete')

      // And once complete, a resend is refused outright.
      const refused = service.guardSubmission(turn.id, 'astra-submitted')
      expect(refused.allowed).toBe(false)
      expect(refused.code).toBe('already-complete')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('reconciliation that cannot settle the question escalates to Karl', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'Unresolvable' })
      service.markStage(turn.id, 'karl-recorded', 'complete')
      service.markStage(turn.id, 'astra-submitted', 'uncertain')

      service.reconcile(turn.id, 'astra-submitted', 'unresolvable', 'Page could not be read')
      const stage = service.get(turn.id)!.stages['astra-submitted']
      expect(stage.status).toBe('awaiting-approval')

      const guard = service.guardSubmission(turn.id, 'astra-submitted')
      expect(guard.allowed).toBe(false)
      expect(guard.code).toBe('awaiting-approval')
      expect(guard.reason).toMatch(/Karl/i)

      // Only an explicit approval clears it.
      service.approve(turn.id, 'astra-submitted', 'Karl approved a fresh attempt')
      expect(service.guardSubmission(turn.id, 'astra-submitted').allowed).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a turn survives an application restart with its completed stages intact', () => {
    const dir = tempDir()
    try {
      const first = new UnifiedTurnService(dir, () => {})
      const { turn } = first.start({ topic: 'Survives a restart' })
      first.markStage(turn.id, 'karl-recorded', 'complete')
      first.markStage(turn.id, 'astra-submitted', 'complete')
      first.markStage(turn.id, 'astra-responded', 'complete')
      first.markStage(turn.id, 'nova-submitted', 'uncertain')
      first.setResponse(turn.id, 'astra', 'astra-message-id')
      first.close()

      const restarted = new UnifiedTurnService(dir, () => {})
      const recovered = restarted.active()
      expect(recovered).toBeTruthy()
      expect(recovered.id).toBe(turn.id)
      // Resume must continue at Nova, not restart the conversation with Astra.
      expect(recovered.stages['astra-responded'].status).toBe('complete')
      expect(recovered.astraResponseMessageId).toBe('astra-message-id')
      expect(restarted.nextIncompleteStage(turn.id)).toBe('nova-submitted')
      // And it must not offer to send to Astra again.
      expect(restarted.guardSubmission(turn.id, 'astra-submitted').allowed).toBe(false)
      restarted.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('only one turn may be in flight, and correlation is by identity not time', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'Only one at a time' })
      service.markStage(turn.id, 'karl-recorded', 'complete')
      expect(service.start({ topic: 'A second question' }).ok).toBe(false)

      // Two rulings recorded; the turn names which one is its own.
      service.setResponse(turn.id, 'astra', 'the-second-ruling')
      expect(service.get(turn.id)!.astraResponseMessageId).toBe('the-second-ruling')
      restartedGuard(service, turn.id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a completed turn does not block a new one', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const { turn } = service.start({ topic: 'First' })
      for (const stage of ['karl-recorded', 'astra-submitted', 'astra-responded', 'nova-submitted', 'nova-responded', 'returned-to-karl']) {
        service.markStage(turn.id, stage, 'complete')
      }
      expect(service.get(turn.id)!.completedAt).toBeTruthy()
      expect(service.active()).toBeNull()
      expect(service.start({ topic: 'Second' }).ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/** Asserts the Astra stage is still protected after unrelated progress. */
function restartedGuard(service: any, turnId: string) {
  expect(service.guardSubmission(turnId, 'nova-submitted').code).toBe('prior-stage-incomplete')
}

test.describe('Court record correlation', () => {
  test('the same text in different turns is not treated as a duplicate', () => {
    // Global duplicate suppression would have silently collapsed the second turn's prompt, leaving
    // nothing to send.
    const dir = tempDir()
    try {
      const service = new ConversationService(dir, () => {})
      const first = service.append({ sender: 'karl', recipient: 'astra', text: 'Same question', source: 'manual', turnId: 'turn-1' })
      const second = service.append({ sender: 'karl', recipient: 'astra', text: 'Same question', source: 'manual', turnId: 'turn-2' })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)

      // But writing the same message twice within one turn is still refused.
      const repeat = service.append({ sender: 'karl', recipient: 'astra', text: 'Same question', source: 'manual', turnId: 'turn-1' })
      expect(repeat.ok).toBe(false)
      expect(repeat.duplicate).toBe(true)
      service.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a response carries the turn it belongs to', () => {
    const dir = tempDir()
    try {
      const service = new ConversationService(dir, () => {})
      const ruling = service.append({
        sender: 'astra', recipient: 'court', text: 'The ruling', source: 'connected', delivery: 'sent', turnId: 'turn-7'
      })
      expect(ruling.ok).toBe(true)
      expect(ruling.message.turnId).toBe('turn-7')

      const reread = new ConversationService(dir, () => {})
      const found = reread.snapshot().find((entry: any) => entry.id === ruling.message.id)
      expect(found.turnId).toBe('turn-7')
      service.close()
      reread.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('delivery-unknown survives a restart and is distinct from failed', () => {
    // Uncertainty must not decay into a definite claim on the next launch.
    const dir = tempDir()
    try {
      const service = new ConversationService(dir, () => {})
      const added = service.append({ sender: 'karl', recipient: 'astra', text: 'Possibly delivered', source: 'manual' })
      expect(added.ok).toBe(true)
      expect(service.markDelivery(added.message.id, 'delivery-unknown').ok).toBe(true)
      service.close()

      const reopened = new ConversationService(dir, () => {})
      const found = reopened.snapshot().find((entry: any) => entry.id === added.message.id)
      expect(found.delivery).toBe('delivery-unknown')
      expect(found.delivery).not.toBe('failed')
      reopened.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/**
 * The stuck-turn recovery path.
 *
 * These exist because the guard against resending an unconfirmed message was correct, and the way out of
 * it did not exist. A turn whose delivery could not be confirmed refused every subsequent message with
 * "reconcile it or cancel it", and nothing in the application could do either: the handlers were written
 * and never wired to anything Karl could click. Each test names the state it proves is now reachable.
 */
test.describe('uncertain delivery recovery', () => {
  const { promptPresentInNovaHistory } = require(resolve(cwd, 'dist-electron', 'unifiedTurnService.cjs'))

  /** Drives a turn to the point where the named seat's submission is uncertain. */
  function stuckTurn(service: any, seat: 'astra' | 'nova') {
    const { turn } = service.start({ topic: 'Stuck turn' })
    service.markStage(turn.id, 'karl-recorded', 'complete')
    if (seat === 'astra') {
      service.markStage(turn.id, 'astra-submitted', 'uncertain', 'Could not confirm the message reached Astra.')
    } else {
      service.markStage(turn.id, 'astra-submitted', 'complete')
      service.markStage(turn.id, 'astra-responded', 'complete')
      service.markStage(turn.id, 'nova-submitted', 'uncertain', 'Delivery to Nova is uncertain.')
    }
    return turn
  }

  test('the blocking stage is named, so the refusal and the button describe the same state', () => {
    // The refusal message said "something is uncertain" and offered nothing. It has to name the seat,
    // because an Astra submission and a Nova submission need different reconciliation.
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const astraTurn = stuckTurn(service, 'astra')
      expect(service.blockedStage(astraTurn.id)).toBe('astra-submitted')
      service.abandon(astraTurn.id, 'test cleanup')

      const novaTurn = stuckTurn(service, 'nova')
      expect(service.blockedStage(novaTurn.id)).toBe('nova-submitted')

      // A clean turn blocks nothing, so the banner never appears without a cause.
      service.abandon(novaTurn.id, 'test cleanup')
      const clean = service.start({ topic: 'Nothing outstanding' })
      expect(service.blockedStage(clean.turn.id)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('successful reconciliation of an Astra delivery clears the block without resending', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const turn = stuckTurn(service, 'astra')

      // "Accepted" means the prompt is demonstrably in the thread. The stage completes and the turn
      // continues from Nova — Astra is not asked the same question twice.
      service.reconcile(turn.id, 'astra-submitted', 'accepted', 'Prompt found in the ChatGPT thread')
      expect(service.get(turn.id)!.stages['astra-submitted'].status).toBe('complete')
      expect(service.blockedStage(turn.id)).toBeNull()

      // Duplicate protection is still armed: a completed stage refuses another submission outright.
      const resend = service.guardSubmission(turn.id, 'astra-submitted')
      expect(resend.allowed).toBe(false)
      expect(resend.code).toBe('already-complete')

      // Nova still cannot be reached, and deliberately so. Finding the prompt in the thread proves it
      // was accepted; it does not produce Astra's ruling, so astra-responded is still outstanding and
      // the turn must not hand Nova an empty seat.
      const toNova = service.guardSubmission(turn.id, 'nova-submitted')
      expect(toNova.allowed).toBe(false)
      expect(toNova.code).toBe('prior-stage-incomplete')
      expect(toNova.reason).toMatch(/astra-responded/)
      expect(service.get(turn.id)!.stages['nova-submitted'].attempt).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('successful reconciliation of a Nova delivery accepts the prompt from Nova chat history', () => {
    // Nova's delivery can be unconfirmed for the same reason Astra's is, and previously had no
    // reconciliation path at all, which left the turn permanently stuck.
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const turn = stuckTurn(service, 'nova')

      const prompt = 'Astra said the thing'
      // The assistant merely echoing the prompt is not proof it was accepted.
      expect(promptPresentInNovaHistory([{ role: 'assistant', text: prompt }], prompt)).toBe(false)
      expect(promptPresentInNovaHistory([{ role: 'user', text: 'unrelated earlier question' }], prompt)).toBe(false)
      expect(promptPresentInNovaHistory([{ role: 'user', text: prompt }], prompt)).toBe(true)

      service.reconcile(turn.id, 'nova-submitted', 'accepted', "Prompt found in Nova's chat history")
      expect(service.get(turn.id)!.stages['nova-submitted'].status).toBe('complete')
      expect(service.blockedStage(turn.id)).toBeNull()
      expect(service.guardSubmission(turn.id, 'nova-submitted').code).toBe('already-complete')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('failed reconciliation escalates to Karl instead of guessing, and keeps the turn blocked', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const turn = stuckTurn(service, 'astra')

      // "Absent" is a real finding: nothing matching arrived, so the send may safely be retried.
      service.reconcile(turn.id, 'astra-submitted', 'absent', 'No matching prompt in the ChatGPT thread')
      expect(service.get(turn.id)!.stages['astra-submitted'].status).toBe('failed')

      // "Unresolvable" is not. The page could not be read, which is silence, not absence.
      service.markStage(turn.id, 'astra-submitted', 'uncertain', 'Retried while still unreadable')
      service.reconcile(turn.id, 'astra-submitted', 'unresolvable', 'The Astra conversation could not be read.')
      const record = service.get(turn.id)!.stages['astra-submitted']
      expect(record.status).toBe('awaiting-approval')

      // It stays blocked. Unresolved uncertainty must never quietly become permission to resend.
      expect(service.blockedStage(turn.id)).toBe('astra-submitted')
      const guard = service.guardSubmission(turn.id, 'astra-submitted')
      expect(guard.allowed).toBe(false)
      expect(guard.code).toBe('awaiting-approval')
      // Four attempts: the original send, the "absent" reconcile, the retry, and the unresolvable
      // reconcile. Attempts accumulate so the record shows how many times this was actually tried.
      expect(service.get(turn.id)!.stages['astra-submitted'].attempt).toBe(4)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('cancelling a pending turn unblocks Karl without erasing the record or sending anything', () => {
    const dir = tempDir()
    try {
      const service = new UnifiedTurnService(dir, () => {})
      const turn = stuckTurn(service, 'astra')

      service.abandon(turn.id, 'Cancelled by Karl')

      // The turn is finished, so it is no longer the active turn and no longer blocks a new message.
      expect(service.active()).toBeNull()
      expect(service.get(turn.id)!.completedAt).not.toBeNull()

      // But "we stopped" is not "this never happened": the stages and the history survive.
      const kept = service.snapshot().find((entry: any) => entry.id === turn.id)
      expect(kept).toBeTruthy()
      expect(kept.stages['astra-submitted'].status).toBe('uncertain')
      expect(kept.stages['karl-recorded'].status).toBe('complete')

      // Karl can start a genuinely new turn immediately.
      const next = service.start({ topic: 'A different question' })
      expect(next.ok).toBe(true)
      expect(service.active()!.id).toBe(next.turn.id)
      expect(service.blockedStage(next.turn.id)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a cancelled stuck turn stays cancelled across a restart', () => {
    const dir = tempDir()
    try {
      const first = new UnifiedTurnService(dir, () => {})
      const turn = stuckTurn(first, 'astra')
      first.abandon(turn.id, 'Cancelled by Karl')
      first.close()

      const restarted = new UnifiedTurnService(dir, () => {})
      expect(restarted.active()).toBeNull()
      expect(restarted.blockedStage(turn.id)).toBeNull()
      expect(restarted.snapshot()).toHaveLength(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})