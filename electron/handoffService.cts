/**
 * Handoff workflow state.
 *
 * These states describe what NovaCourt is doing and what it is waiting for Karl to do. They are NOT
 * claims about the ChatGPT website: NovaCourt cannot see whether a message arrived there, so it never
 * asserts that it did. The strongest state reachable for an Astra handoff is "awaiting Karl", which
 * is exactly as far as the evidence goes.
 *
 * The service is deliberately ignorant of the terminal and of the clipboard. It cannot type into a
 * PTY and it cannot read a clipboard; the main process performs both, on an explicit user action,
 * outside this class. Nothing here can cause a command to run.
 */
export type HandoffTarget = 'astra' | 'nova'
export type HandoffStatus = 'idle' | 'preparing' | 'awaiting-karl' | 'awaiting-reply' | 'paused' | 'error'

export type HandoffState = {
  status: HandoffStatus
  target: HandoffTarget | null
  messageId: string | null
  detail: string | null
  /** True when Karl has paused handoffs. A paused workflow refuses to start new ones. */
  paused: boolean
  since: string | null
}

const initial = (): HandoffState => ({ status: 'idle', target: null, messageId: null, detail: null, paused: false, since: null })

export class HandoffService {
  private state: HandoffState = initial()

  constructor(private readonly publish: (state: HandoffState) => void) {}

  snapshot(): HandoffState { return { ...this.state } }

  private move(next: Partial<HandoffState>) {
    this.state = { ...this.state, ...next }
    this.publish(this.snapshot())
  }

  /** Refuses a new handoff while Karl has paused the workflow. */
  private guard(target: HandoffTarget) {
    if (this.state.paused) return 'Handoffs are paused. Resume them before sending.'
    if (this.state.status === 'awaiting-reply' && this.state.target === target) return 'A reply from that seat is still outstanding. Wait for it, or cancel the handoff.'
    return null
  }

  prepare(target: HandoffTarget, messageId: string, detail: string) {
    const refusal = this.guard(target)
    if (refusal) return { ok: false as const, reason: refusal }
    this.move({ status: 'preparing', target, messageId, detail, since: new Date().toISOString() })
    return { ok: true as const }
  }

  /** Astra only: the bytes are on the clipboard and the next move belongs to Karl. */
  awaitingKarl(messageId: string, detail: string) {
    this.move({ status: 'awaiting-karl', target: 'astra', messageId, detail })
    return { ok: true as const }
  }

  /** Nova only: OpenCode accepted the prompt, so the reply is genuinely outstanding. */
  awaitingReply(messageId: string, detail: string) {
    this.move({ status: 'awaiting-reply', target: 'nova', messageId, detail })
    return { ok: true as const }
  }

  fail(detail: string) {
    this.move({ status: 'error', detail })
    return { ok: true as const }
  }

  settle(detail: string | null = null) {
    // A paused workflow stays paused: resuming is Karl's decision, not a side effect of finishing.
    this.move(this.state.paused ? { status: 'paused', target: null, messageId: null, detail: null, since: null } : { status: 'idle', target: null, messageId: null, detail, since: null })
    return { ok: true as const }
  }

  pause() {
    this.move({ paused: true, status: 'paused', target: null, messageId: null, detail: this.state.detail ?? 'Handoffs are paused. Nova will not send anything until you resume.', since: null })
    return this.snapshot()
  }

  resume() {
    this.move({ paused: false, status: 'idle', target: null, messageId: null, detail: null, since: null })
    return this.snapshot()
  }

  /** Cancels the outstanding handoff without pretending it was ever delivered. */
  cancel(detail = 'Handoff cancelled. Nothing was sent.') {
    this.move({ status: this.state.paused ? 'paused' : 'idle', target: null, messageId: null, detail: this.state.paused ? null : detail, since: null })
    return this.snapshot()
  }

  /** True when a reply from Nova is genuinely outstanding. */
  isAwaitingNova(): boolean { return !this.state.paused && this.state.status === 'awaiting-reply' && this.state.target === 'nova' }

  close() { this.state = initial() }
}