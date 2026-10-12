import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fingerprintOf } from './astraDetector.cjs'

/**
 * The six stages of a unified three-way turn, in the order they must happen.
 *
 * Karl → Astra → Nova → Karl.
 */
export type UnifiedStage =
  | 'karl-recorded'
  | 'astra-submitted'
  | 'astra-responded'
  | 'nova-submitted'
  | 'nova-responded'
  | 'returned-to-karl'

export const UNIFIED_STAGE_ORDER: readonly UnifiedStage[] = [
  'karl-recorded',
  'astra-submitted',
  'astra-responded',
  'nova-submitted',
  'nova-responded',
  'returned-to-karl'
]

/**
 * Why a stage is in a given state.
 *
 * `pending` — not attempted yet.
 * `complete` — genuinely finished.
 * `uncertain` — attempted, and we cannot tell whether it succeeded. This is the state that must never
 *               be treated as either success or failure, and that gates any retry.
 * `awaiting-approval` — reconciliation could not settle an uncertain stage, so Karl must decide.
 * `failed` — established not to have happened.
 */
export type UnifiedStageStatus = 'pending' | 'complete' | 'uncertain' | 'awaiting-approval' | 'failed'

export type UnifiedStageRecord = {
  status: UnifiedStageStatus
  /** How many times this stage has been attempted. Guards against unbounded retry loops. */
  attempt: number
  at: string | null
  detail: string | null
}

export type UnifiedTurn = {
  /** Persistent identity for this turn. Survives restart. Everything else hangs off this. */
  id: string
  topic: string
  discussionId: string | null
  karlMessageId: string | null
  astraResponseMessageId: string | null
  novaResponseMessageId: string | null
  stages: Record<UnifiedStage, UnifiedStageRecord>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type StageRefusal = { allowed: false; reason: string; code: RefusalCode }

export type RefusalCode =
  | 'already-complete'
  | 'delivery-uncertain'
  | 'awaiting-approval'
  | 'prior-stage-incomplete'
  | 'no-such-turn'
  | 'unknown-stage'

export type GuardResult = { allowed: true } | StageRefusal

const emptyStage = (): UnifiedStageRecord => ({ status: 'pending', attempt: 0, at: null, detail: null })

/**
 * Whether a prompt handed to Nova's chat service actually appears in the session history.
 *
 * Nova's side needs the same treatment Astra's does, for the same reason. `prompt_async` returns before
 * OpenCode has committed anything, so a timeout or a dropped connection there leaves the session history
 * as the only evidence of what happened. Only user-role entries are considered: an assistant reply that
 * merely echoes the prompt is not proof that the prompt was accepted, and treating it as proof would
 * silently authorise a resend that duplicates the message.
 *
 * Kept pure and exported so the decision is testable without a running OpenCode server.
 */
export function promptPresentInNovaHistory(
  history: { role: string; text: string }[],
  prompt: string
): boolean {
  const wanted = fingerprintOf(prompt)
  return history.some((entry) => entry.role === 'user' && fingerprintOf(entry.text) === wanted)
}

function emptyStages(): Record<UnifiedStage, UnifiedStageRecord> {
  const stages = {} as Record<UnifiedStage, UnifiedStageRecord>
  for (const stage of UNIFIED_STAGE_ORDER) stages[stage] = emptyStage()
  return stages
}

function isStage(value: unknown): value is UnifiedStage {
  return typeof value === 'string' && (UNIFIED_STAGE_ORDER as readonly string[]).includes(value)
}

function acceptStageRecord(value: unknown): UnifiedStageRecord {
  const entry = (value ?? {}) as Record<string, unknown>
  const status = entry.status
  return {
    status: typeof status === 'string' && ['pending', 'complete', 'uncertain', 'awaiting-approval', 'failed'].includes(status)
      ? status as UnifiedStageStatus
      : 'pending',
    attempt: typeof entry.attempt === 'number' && Number.isFinite(entry.attempt) && entry.attempt >= 0
      ? Math.floor(entry.attempt)
      : 0,
    at: typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)) ? entry.at : null,
    detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 500) : null
  }
}

export type UnifiedTurnInput = { topic: unknown; discussionId?: unknown; karlMessageId?: unknown }

/**
 * The state machine for a unified three-way turn.
 *
 * This exists because the previous implementation kept the position of a turn in three unrelated
 * places — the discussion service's current turn, a `handoff` status enum, and delivery flags on two
 * separate court messages — and advancing any one of them could strand the others. Concretely, if
 * Astra answered and Nova then failed, the only record that Astra had spoken was the delivery flag on
 * her court message, which nothing consulted on resume, so the retry went back to Astra and asked her
 * the same question twice.
 *
 * The invariants this class enforces:
 *
 *   1. Stages are independent and only ever move forward. A failure at stage N leaves stages 0..N-1
 *      exactly as they were, so a partial turn keeps its completed work.
 *   2. A stage cannot be marked complete while an earlier stage is not complete. This is what stops a
 *      turn from claiming Nova answered when Astra never did.
 *   3. A stage that is `uncertain` or `awaiting-approval` blocks any further submission to that seat.
 *      This is the structural form of "never resend a message that may have been accepted" — the guard
 *      is not a convention the send path is trusted to observe, it is the only way to ask permission.
 */
export class UnifiedTurnService {
  private turns: UnifiedTurn[] = []
  private readonly path: string
  private closed = false

  constructor(
    dataPath: string,
    private readonly publish: (turn: UnifiedTurn | null, turns: UnifiedTurn[]) => void
  ) {
    this.path = join(dataPath, 'unified-turns.json')
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? (parsed as { turns?: unknown }).turns
          : null
      if (Array.isArray(list)) this.turns = list.map((entry) => this.acceptTurn(entry)).filter(Boolean) as UnifiedTurn[]
      this.turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    } catch { /* First launch or unreadable history starts with no turns. */ }
  }

  private acceptTurn(value: unknown): UnifiedTurn | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) return null
    if (typeof entry.topic !== 'string' || !entry.topic.trim()) return null
    if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) return null
    const rawStages = entry.stages && typeof entry.stages === 'object' ? entry.stages as Record<string, unknown> : {}
    const stages = emptyStages()
    for (const stage of UNIFIED_STAGE_ORDER) {
      if (isStage(stage) && stage in rawStages) stages[stage] = acceptStageRecord(rawStages[stage])
    }
    return {
      id: entry.id,
      topic: entry.topic.trim().slice(0, 500),
      discussionId: typeof entry.discussionId === 'string' ? entry.discussionId : null,
      karlMessageId: typeof entry.karlMessageId === 'string' ? entry.karlMessageId : null,
      astraResponseMessageId: typeof entry.astraResponseMessageId === 'string' ? entry.astraResponseMessageId : null,
      novaResponseMessageId: typeof entry.novaResponseMessageId === 'string' ? entry.novaResponseMessageId : null,
      stages,
      createdAt: entry.createdAt,
      updatedAt: typeof entry.updatedAt === 'string' && !Number.isNaN(Date.parse(entry.updatedAt)) ? entry.updatedAt : entry.createdAt,
      completedAt: typeof entry.completedAt === 'string' && !Number.isNaN(Date.parse(entry.completedAt)) ? entry.completedAt : null
    }
  }

  private persist() {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.turns, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  private emit() {
    this.publish(this.active(), this.turns.map((turn) => ({ ...turn, stages: { ...turn.stages } })))
  }

  snapshot(): UnifiedTurn[] { return this.turns.map((turn) => ({ ...turn, stages: { ...turn.stages } })) }

  get(id: unknown): UnifiedTurn | null {
    if (typeof id !== 'string') return null
    const found = this.turns.find((turn) => turn.id === id)
    return found ? { ...found, stages: { ...found.stages } } : null
  }

  /**
   * The turn that is still in flight, if any.
   *
   * This is what makes a restart recoverable. After a crash or a quit, the persisted turn is still
   * here, still carrying its completed stages, so resume can continue from the Nova stage rather than
   * starting a fresh turn and asking Astra to rule on the same matter twice.
   */
  active(): UnifiedTurn | null {
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index].completedAt === null) {
        const turn = this.turns[index]
        return { ...turn, stages: { ...turn.stages } }
      }
    }
    return null
  }

  start(input: UnifiedTurnInput): { ok: true; turn: UnifiedTurn } | { ok: false; reason: string } {
    if (this.closed) return { ok: false, reason: 'The unified turn service is closed' }
    const topic = String(input.topic ?? '').trim()
    if (!topic) return { ok: false, reason: 'A turn needs a topic' }
    if (topic.length > 500) return { ok: false, reason: 'Topic must be under 500 characters' }

    // Only one turn may be in flight. Starting a second would mean two concurrent questions in
    // Astra's thread, which is precisely the ambiguity the turn ID exists to prevent.
    const inFlight = this.active()
    if (inFlight) return { ok: false, reason: 'A unified turn is already in progress. Resume or cancel it first.' }

    const now = new Date().toISOString()
    const turn: UnifiedTurn = {
      id: randomUUID(),
      topic,
      discussionId: typeof input.discussionId === 'string' ? input.discussionId : null,
      karlMessageId: typeof input.karlMessageId === 'string' ? input.karlMessageId : null,
      astraResponseMessageId: null,
      novaResponseMessageId: null,
      stages: emptyStages(),
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }
    this.turns.push(turn)
    try { this.persist() } catch {
      this.turns = this.turns.filter((entry) => entry.id !== turn.id)
      return { ok: false, reason: 'The unified turn could not be saved' }
    }
    this.emit()
    return { ok: true, turn: { ...turn, stages: { ...turn.stages } } }
  }

  /** The first stage that is not yet complete, or null when the turn is finished. */
  nextIncompleteStage(id: unknown): UnifiedStage | null {
    const turn = this.get(id)
    if (!turn) return null
    for (const stage of UNIFIED_STAGE_ORDER) {
      if (turn.stages[stage].status !== 'complete') return stage
    }
    return null
  }

  /**
   * The stage that is currently blocking this turn, or null when nothing is outstanding.
   *
   * A stage blocks when it is `uncertain` or `awaiting-approval`: both mean an attempt was made whose
   * outcome is genuinely unknown, so the only ways onward are a human reconciling against the real
   * conversation or a human cancelling. The send path reads this to name what is in the way, and the
   * renderer reads the same thing to offer the matching action, so the refusal message and the button
   * that clears it can never describe different states.
   *
   * A turn that is already settled reports null even if it carries an uncertain stage. Karl abandoning a
   * turn is what releases the court; the stage record stays uncertain forever because that is the honest
   * claim, and letting it keep reporting as outstanding would mean a settled turn could still be
   * reconciled or approved into changing after Karl had already moved on.
   */
  blockedStage(turnId: unknown): UnifiedStage | null {
    const turn = this.get(turnId)
    if (!turn || turn.completedAt !== null) return null
    for (const stage of UNIFIED_STAGE_ORDER) {
      const status = turn.stages[stage].status
      if (status === 'uncertain' || status === 'awaiting-approval') return stage
    }
    return null
  }

  /**
   * Asks permission to (re)submit to a seat.
   *
   * This is the duplicate-prevention gate. Refusal is the default for anything uncertain, and the
   * only ways through are for a human to reconcile or to approve, which is what "require explicit Karl
   * approval if reconciliation cannot establish whether submission succeeded" means in practice.
   */
  guardSubmission(turnId: unknown, stage: UnifiedStage): GuardResult {
    if (!isStage(stage)) return { allowed: false, code: 'unknown-stage', reason: 'Unknown stage' }
    const turn = this.get(turnId)
    if (!turn) return { allowed: false, code: 'no-such-turn', reason: 'No such turn' }

    const record = turn.stages[stage]
    if (record.status === 'complete') {
      return {
        allowed: false,
        code: 'already-complete',
        reason: `${stage} has already completed for this turn. Sending again would duplicate the message.`
      }
    }
    if (record.status === 'uncertain') {
      return {
        allowed: false,
        code: 'delivery-uncertain',
        reason: `Delivery for ${stage} is uncertain. Reconcile against ChatGPT before sending again.`
      }
    }
    if (record.status === 'awaiting-approval') {
      return {
        allowed: false,
        code: 'awaiting-approval',
        reason: `${stage} needs Karl's explicit approval before it can be sent again.`
      }
    }

    const order = UNIFIED_STAGE_ORDER.indexOf(stage)
    for (let index = 0; index < order; index += 1) {
      const earlier = UNIFIED_STAGE_ORDER[index]
      const earlierRecord = turn.stages[earlier]
      if (earlierRecord.status !== 'complete') {
        return {
          allowed: false,
          code: 'prior-stage-incomplete',
          reason: `${earlier} has not completed, so ${stage} cannot begin.`
        }
      }
    }
    return { allowed: true }
  }

  /**
   * Records the outcome of a stage attempt.
   *
   * A stage that is already `complete` is not moved. That immutability is what preserves an earlier
   * seat's work when a later stage fails: the Nova failure can mark `nova-submitted` uncertain, but it
   * cannot quietly un-complete `astra-responded`.
   */
  markStage(
    turnId: unknown,
    stage: UnifiedStage,
    status: UnifiedStageStatus,
    detail: string | null = null
  ): { ok: true; turn: UnifiedTurn } | { ok: false; reason: string } {
    if (this.closed) return { ok: false, reason: 'The unified turn service is closed' }
    if (!isStage(stage)) return { ok: false, reason: 'Unknown stage' }
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }

    const record = turn.stages[stage]
    if (record.status === 'complete' && status !== 'complete') {
      return { ok: false, reason: `${stage} is already complete and cannot be moved to ${status}` }
    }
    if (status === 'complete') {
      const order = UNIFIED_STAGE_ORDER.indexOf(stage)
      for (let index = 0; index < order; index += 1) {
        const earlier = UNIFIED_STAGE_ORDER[index]
        if (turn.stages[earlier].status !== 'complete') {
          return { ok: false, reason: `${stage} cannot complete while ${earlier} is ${turn.stages[earlier].status}` }
        }
      }
    }

    record.status = status
    record.detail = detail ? detail.slice(0, 500) : null
    if (status === 'complete' || status === 'uncertain' || status === 'awaiting-approval' || status === 'failed') {
      record.at = new Date().toISOString()
    }
    // Attempts are counted on every outcome, including successes, so that the count reads as
    // "how many times this was tried" rather than "how many times it failed".
    record.attempt += 1
    turn.updatedAt = record.at ?? new Date().toISOString()

    if (UNIFIED_STAGE_ORDER.every((entry) => turn.stages[entry].status === 'complete') && turn.completedAt === null) {
      turn.completedAt = new Date().toISOString()
    }

    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true, turn: { ...turn, stages: { ...turn.stages } } }
  }

  /** Records the court message Karl's prompt lives in, so reconciliation can find that text again. */
  setKarlMessage(turnId: unknown, messageId: unknown): { ok: boolean; reason?: string } {
    if (typeof messageId !== 'string' || !messageId) return { ok: false, reason: 'Invalid message id' }
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }
    turn.karlMessageId = messageId
    turn.updatedAt = new Date().toISOString()
    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true }
  }

  /** Records the court message that carries a seat's answer, for correlation without timestamps. */
  setResponse(turnId: unknown, seat: 'astra' | 'nova', messageId: unknown): { ok: boolean; reason?: string } {
    if (typeof messageId !== 'string' || !messageId) return { ok: false, reason: 'Invalid message id' }
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }
    if (seat === 'astra') turn.astraResponseMessageId = messageId
    else turn.novaResponseMessageId = messageId
    turn.updatedAt = new Date().toISOString()
    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true }
  }

  setDiscussion(turnId: unknown, discussionId: unknown): { ok: boolean; reason?: string } {
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }
    if (typeof discussionId !== 'string' || !discussionId) return { ok: false, reason: 'Invalid discussion id' }
    turn.discussionId = discussionId
    turn.updatedAt = new Date().toISOString()
    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true }
  }

  /**
   * Reconciles an uncertain submission against what is actually in the thread.
   *
   * `accepted` means a matching new message is there, so the stage completes and no resend happens.
   * `absent` means nothing matching arrived, so it is safe to treat as not-sent and offer a retry.
   * Anything else is unresolvable and escalates to Karl, because guessing is what produces duplicates.
   */
  reconcile(
    turnId: unknown,
    stage: UnifiedStage,
    observation: 'accepted' | 'absent' | 'unresolvable',
    detail: string | null = null
  ): { ok: true; turn: UnifiedTurn } | { ok: false; reason: string } {
    if (observation === 'accepted') return this.markStage(turnId, stage, 'complete', detail)
    if (observation === 'absent') return this.markStage(turnId, stage, 'failed', detail)
    return this.markStage(turnId, stage, 'awaiting-approval', detail)
  }

  /** Karl's decision on a stage that reconciliation could not settle. */
  approve(turnId: unknown, stage: UnifiedStage, detail: string | null = null) {
    return this.markStage(turnId, stage, 'failed', detail ?? 'Karl approved a fresh attempt.')
  }

  settle(turnId: unknown): { ok: boolean; reason?: string } {
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }
    if (turn.completedAt !== null) return { ok: true }
    turn.completedAt = new Date().toISOString()
    turn.updatedAt = turn.completedAt
    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true }
  }

  /**
   * Abandons an in-flight turn.
   *
   * This exists for Karl to escape a turn he no longer wants. It deliberately does not erase the
   * record: an abandoned turn stays in history with its completed stages intact, because "we stopped"
   * and "this never happened" are different claims and the transcript should not claim the latter.
   */
  abandon(turnId: unknown, detail: string | null = null) {
    const turn = this.turns.find((entry) => entry.id === turnId)
    if (!turn) return { ok: false, reason: 'No such turn' }
    turn.completedAt = new Date().toISOString()
    turn.updatedAt = turn.completedAt
    const pending = UNIFIED_STAGE_ORDER.find((stage) => turn.stages[stage].status === 'pending')
    if (pending) turn.stages[pending].detail = detail ?? 'Abandoned by Karl'
    try { this.persist() } catch { return { ok: false, reason: 'The unified turn could not be saved' } }
    this.emit()
    return { ok: true }
  }

  close() { this.closed = true; this.turns = [] }
}