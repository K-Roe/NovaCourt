import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type DiscussionTurn = 'karl' | 'astra' | 'nova'
export type DiscussionState = 'idle' | 'ready' | 'awaiting-astra' | 'awaiting-nova' | 'awaiting-karl' | 'paused' | 'completed' | 'error'

export type DiscussionTurnRecord = {
  id: string
  discussionId: string
  turn: number
  speaker: DiscussionTurn
  recipient: 'astra' | 'nova' | 'both' | 'karl'
  messageId: string | null
  createdAt: string
  /** The conversation ID this turn belongs to (same as discussionId for now) */
  conversationId: string
}

export type Discussion = {
  id: string
  topic: string
  maxTurns: number
  state: DiscussionState
  currentTurn: DiscussionTurn | null
  turnCount: number
  participants: DiscussionTurn[]
  createdAt: string
  updatedAt: string
  completedAt: string | null
  /** True if this is an automatic three-way conversation (Karl → Astra → Nova → Karl) */
  isThreeWay: boolean
}

const DEFAULT_MAX_TURNS = 6
const MAX_DISCUSSIONS = 100

/**
 * Who speaks when in an automatic three-way conversation.
 *
 * The cycle deliberately includes Karl. Without him the rotation was simply Astra, Nova, Astra, Nova,
 * forever: Karl opened the discussion and was then never given the floor again, so an automated
 * conversation could run to its turn limit without him ever being asked to judge the result. Including
 * him makes the loop what it claims to be — Karl asks, Astra rules, Nova responds, Karl decides.
 */
const THREE_WAY_CYCLE: DiscussionTurn[] = ['astra', 'nova', 'karl']

/**
 * Picks the speaker for a turn number.
 *
 * `participants` records which agents take part, and is left as Astra and Nova; the court cycle is
 * applied on top for three-way discussions so that the participants list keeps meaning "the agents
 * involved" rather than "the order of the rota".
 */
function speakerFor(active: Discussion, turnNumber: number): DiscussionTurn {
  if (active.isThreeWay) return THREE_WAY_CYCLE[(turnNumber - 1) % THREE_WAY_CYCLE.length]
  return active.participants[(turnNumber - 1) % active.participants.length]
}

/**
 * Works out who a turn's message is addressed to.
 *
 * In an automated conversation a turn is addressed to whoever speaks on the *following* turn, which is
 * what makes the loop legible in the transcript: Astra's ruling is marked as going to Nova, Nova's reply
 * is marked as going to Karl, and Karl's is marked as going to Astra again.
 */
function recipientFor(active: Discussion, turnNumber: number): DiscussionTurnRecord['recipient'] {
  if (active.isThreeWay) return speakerFor(active, turnNumber + 1)

  const speaker = speakerFor(active, turnNumber)
  if (active.participants.length === 2 && active.participants.includes('astra') && active.participants.includes('nova')) {
    return speaker === 'astra' ? 'nova' : 'astra'
  }
  return 'both'
}

export type DiscussionInput = {
  topic: unknown
  maxTurns?: unknown
  participants?: unknown
  isThreeWay?: unknown
}

export class DiscussionService {
  private discussions: Discussion[] = []
  private turns: DiscussionTurnRecord[] = []
  private readonly path: string
  private closed = false

  constructor(dataPath: string, private readonly publish: (discussion: Discussion | null, turns: DiscussionTurnRecord[]) => void) {
    this.path = join(dataPath, 'discussions.json')
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object') {
        const data = parsed as { discussions?: unknown[]; turns?: unknown[] }
        if (Array.isArray(data.discussions)) {
          this.discussions = data.discussions.map((d) => this.acceptDiscussion(d)).filter(Boolean) as Discussion[]
        }
        if (Array.isArray(data.turns)) {
          this.turns = data.turns.map((t) => this.acceptTurn(t)).filter(Boolean) as DiscussionTurnRecord[]
        }
        this.discussions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        this.turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        this.discussions = this.discussions.slice(-MAX_DISCUSSIONS)
        this.turns = this.turns.slice(-MAX_DISCUSSIONS * 10)
      }
    } catch { /* First launch or unreadable history starts empty. */ }
  }

  private acceptDiscussion(value: unknown): Discussion | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) return null
    if (typeof entry.topic !== 'string' || !entry.topic.trim() || entry.topic.length > 500) return null
    if (typeof entry.maxTurns !== 'number' || !Number.isFinite(entry.maxTurns) || entry.maxTurns < 1 || entry.maxTurns > 50) return null
    if (!['idle', 'ready', 'awaiting-astra', 'awaiting-nova', 'awaiting-karl', 'paused', 'completed', 'error'].includes(String(entry.state))) return null
    if (entry.currentTurn !== null && !['karl', 'astra', 'nova'].includes(String(entry.currentTurn))) return null
    if (typeof entry.turnCount !== 'number' || !Number.isFinite(entry.turnCount) || entry.turnCount < 0) return null
    if (!Array.isArray(entry.participants) || !entry.participants.every((p) => ['karl', 'astra', 'nova'].includes(String(p)))) return null
    if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) return null
    if (typeof entry.updatedAt !== 'string' || Number.isNaN(Date.parse(entry.updatedAt))) return null
    if (entry.completedAt !== null && (typeof entry.completedAt !== 'string' || Number.isNaN(Date.parse(entry.completedAt)))) return null
    return {
      id: entry.id,
      topic: entry.topic.trim().slice(0, 500),
      maxTurns: entry.maxTurns,
      state: entry.state as DiscussionState,
      currentTurn: entry.currentTurn as Discussion['currentTurn'],
      turnCount: entry.turnCount,
      participants: entry.participants as DiscussionTurn[],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      completedAt: entry.completedAt,
      isThreeWay: entry.isThreeWay === true
    }
  }

  private acceptTurn(value: unknown): DiscussionTurnRecord | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) return null
    if (typeof entry.discussionId !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.discussionId)) return null
    if (typeof entry.turn !== 'number' || !Number.isFinite(entry.turn) || entry.turn < 1) return null
    if (!['karl', 'astra', 'nova'].includes(String(entry.speaker))) return null
    if (!['astra', 'nova', 'both', 'karl'].includes(String(entry.recipient))) return null
    if (entry.messageId !== null && (typeof entry.messageId !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.messageId))) return null
    if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) return null
    return {
      id: entry.id,
      discussionId: entry.discussionId,
      turn: entry.turn,
      speaker: entry.speaker as DiscussionTurn,
      recipient: entry.recipient as DiscussionTurnRecord['recipient'],
      messageId: entry.messageId,
      createdAt: entry.createdAt,
      conversationId: typeof entry.conversationId === 'string' && entry.conversationId ? entry.conversationId : entry.discussionId
    }
  }

  snapshot(): { discussions: Discussion[]; turns: DiscussionTurnRecord[] } {
    return { discussions: this.discussions.map((d) => ({ ...d })), turns: this.turns.map((t) => ({ ...t })) }
  }

  private persist() {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify({ discussions: this.discussions, turns: this.turns }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  start(input: DiscussionInput): { ok: true; discussion: Discussion } | { ok: false; reason: string } {
    if (this.closed) return { ok: false, reason: 'Discussion service is closed' }
    const topic = String(input.topic ?? '').trim()
    if (!topic) return { ok: false, reason: 'Discussion needs a topic' }
    if (topic.length > 500) return { ok: false, reason: 'Topic must be under 500 characters' }
    const maxTurns = typeof input.maxTurns === 'number' && Number.isFinite(input.maxTurns) && input.maxTurns >= 1 && input.maxTurns <= 50 ? Math.floor(input.maxTurns) : DEFAULT_MAX_TURNS
    const rawParticipants = Array.isArray(input.participants) ? input.participants.filter((p) => ['karl', 'astra', 'nova'].includes(String(p))) : ['astra', 'nova']
    const participants = rawParticipants as DiscussionTurn[]
    if (!participants.length) return { ok: false, reason: 'At least one participant is required' }
    const isThreeWay = input.isThreeWay === true

    const now = new Date().toISOString()
    const discussion: Discussion = {
      id: randomUUID(),
      topic,
      maxTurns,
      state: 'ready',
      currentTurn: participants[0],
      turnCount: 0,
      participants,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      isThreeWay
    }
    this.discussions.push(discussion)
    if (this.discussions.length > MAX_DISCUSSIONS) this.discussions = this.discussions.slice(-MAX_DISCUSSIONS)
    try { this.persist() } catch { this.discussions = this.discussions.filter((d) => d.id !== discussion.id); return { ok: false, reason: 'Discussion could not be saved' } }
    this.publish(discussion, this.turns.filter((t) => t.discussionId === discussion.id))
    return { ok: true, discussion }
  }

  nextTurn(): { ok: true; discussion: Discussion; turn: DiscussionTurnRecord | null } | { ok: false; reason: string } {
    const active = this.discussions.find((d) => d.state !== 'completed' && d.state !== 'idle' && d.state !== 'error')
    if (!active) return { ok: false, reason: 'No active discussion' }
    if (active.state === 'paused') return { ok: false, reason: 'Discussion is paused' }

    const nextTurnNumber = active.turnCount + 1
    const speaker = speakerFor(active, nextTurnNumber)
    const recipient = recipientFor(active, nextTurnNumber)

    const turn: DiscussionTurnRecord = {
      id: randomUUID(),
      discussionId: active.id,
      turn: nextTurnNumber,
      speaker,
      recipient,
      messageId: null,
      createdAt: new Date().toISOString(),
      conversationId: active.id
    }
    this.turns.push(turn)
    active.turnCount = nextTurnNumber
    active.currentTurn = speaker
    active.state = speaker === 'astra' ? 'awaiting-astra' : speaker === 'nova' ? 'awaiting-nova' : 'awaiting-karl'
    active.updatedAt = turn.createdAt

    // Check if we've reached the turn limit after this turn
    if (active.turnCount >= active.maxTurns) {
      active.state = 'completed'
      active.completedAt = new Date().toISOString()
      active.updatedAt = active.completedAt
    }
    try { this.persist() } catch {}
    this.publish(active, this.turns.filter((t) => t.discussionId === active.id))
    return { ok: true, discussion: { ...active }, turn }
  }

  pause(): { ok: true; discussion: Discussion | null } | { ok: false; reason: string } {
    const active = this.discussions.find((d) => d.state !== 'completed' && d.state !== 'idle' && d.state !== 'error')
    if (!active) return { ok: false, reason: 'No active discussion to pause' }
    if (active.state === 'paused') return { ok: true, discussion: { ...active } }
    active.state = 'paused'
    active.updatedAt = new Date().toISOString()
    try { this.persist() } catch {}
    this.publish(active, this.turns.filter((t) => t.discussionId === active.id))
    return { ok: true, discussion: { ...active } }
  }

  resume(): { ok: true; discussion: Discussion | null } | { ok: false; reason: string } {
    const active = this.discussions.find((d) => d.state === 'paused')
    if (!active) return { ok: false, reason: 'No paused discussion to resume' }
    active.state = active.currentTurn === 'astra' ? 'awaiting-astra' : active.currentTurn === 'nova' ? 'awaiting-nova' : 'awaiting-karl'
    active.updatedAt = new Date().toISOString()
    try { this.persist() } catch {}
    this.publish(active, this.turns.filter((t) => t.discussionId === active.id))
    return { ok: true, discussion: { ...active } }
  }

  end(): { ok: true; discussion: Discussion | null } | { ok: false; reason: string } {
    const active = this.discussions.find((d) => d.state !== 'completed' && d.state !== 'idle' && d.state !== 'error')
    if (!active) return { ok: false, reason: 'No active discussion to end' }
    active.state = 'completed'
    active.completedAt = new Date().toISOString()
    active.updatedAt = active.completedAt
    try { this.persist() } catch {}
    this.publish(active, this.turns.filter((t) => t.discussionId === active.id))
    return { ok: true, discussion: { ...active } }
  }

  recordMessage(discussionId: string, messageId: string): { ok: true } | { ok: false; reason: string } {
    const discussion = this.discussions.find((d) => d.id === discussionId)
    if (!discussion) return { ok: false, reason: 'Discussion not found' }
    const turn = this.turns.find((t) => t.discussionId === discussionId && t.turn === discussion.turnCount && t.messageId === null)
    if (!turn) return { ok: false, reason: 'No pending turn for this discussion' }
    turn.messageId = messageId
    try { this.persist() } catch {}
    this.publish(discussion, this.turns.filter((t) => t.discussionId === discussionId))
    return { ok: true }
  }

  /**
   * Advances the discussion to the next turn after a response has been recorded.
   * This is called automatically when Astra or Nova completes their response.
   * Returns the next turn info if the discussion continues, or null if completed.
   */
  advanceTurnAfterResponse(discussionId: string): { ok: true; discussion: Discussion; nextTurn: DiscussionTurnRecord | null; completed: boolean } | { ok: false; reason: string } {
    const discussion = this.discussions.find((d) => d.id === discussionId)
    if (!discussion) return { ok: false, reason: 'Discussion not found' }
    if (discussion.state === 'completed' || discussion.state === 'idle' || discussion.state === 'error') {
      return { ok: false, reason: 'Discussion is not active' }
    }
    if (discussion.state === 'paused') return { ok: false, reason: 'Discussion is paused' }

    // Verify the current turn has a message recorded
    const currentTurn = this.turns.find((t) => t.discussionId === discussionId && t.turn === discussion.turnCount)
    if (!currentTurn || !currentTurn.messageId) {
      return { ok: false, reason: 'Current turn has no recorded response yet' }
    }

    // Check if we've reached max turns
    if (discussion.turnCount >= discussion.maxTurns) {
      discussion.state = 'completed'
      discussion.completedAt = new Date().toISOString()
      discussion.updatedAt = discussion.completedAt
      try { this.persist() } catch {}
      this.publish(discussion, this.turns.filter((t) => t.discussionId === discussionId))
      return { ok: true, discussion: { ...discussion }, nextTurn: null, completed: true }
    }

    // Advance to next turn
    const nextTurnNumber = discussion.turnCount + 1
    const speaker = speakerFor(discussion, nextTurnNumber)
    const recipient = recipientFor(discussion, nextTurnNumber)

    const nextTurn: DiscussionTurnRecord = {
      id: randomUUID(),
      discussionId: discussion.id,
      turn: nextTurnNumber,
      speaker,
      recipient,
      messageId: null,
      createdAt: new Date().toISOString(),
      conversationId: discussion.id
    }
    this.turns.push(nextTurn)
    discussion.turnCount = nextTurnNumber
    discussion.currentTurn = speaker
    discussion.state = speaker === 'astra' ? 'awaiting-astra' : speaker === 'nova' ? 'awaiting-nova' : 'awaiting-karl'
    discussion.updatedAt = nextTurn.createdAt

    // Check if this new turn completes the discussion
    let completed = false
    if (discussion.turnCount >= discussion.maxTurns) {
      discussion.state = 'completed'
      discussion.completedAt = new Date().toISOString()
      discussion.updatedAt = discussion.completedAt
      completed = true
    }

    try { this.persist() } catch {}
    this.publish(discussion, this.turns.filter((t) => t.discussionId === discussionId))
    return { ok: true, discussion: { ...discussion }, nextTurn, completed }
  }

  /**
   * Gets the conversation history for a discussion, formatted for an agent.
   * Returns messages in chronological order with sender labels.
   */
  getConversationHistory(discussionId: string, conversationService: { snapshot: () => { id: string; sender: string; text: string; createdAt: string }[] }): { turn: number; speaker: DiscussionTurn; text: string; messageId: string }[] {
    const turns = this.turns.filter((t) => t.discussionId === discussionId).sort((a, b) => a.turn - b.turn)
    const messages = conversationService.snapshot()
    const history: { turn: number; speaker: DiscussionTurn; text: string; messageId: string }[] = []
    
    for (const turn of turns) {
      if (turn.messageId) {
        const message = messages.find((m) => m.id === turn.messageId)
        if (message) {
          history.push({
            turn: turn.turn,
            speaker: turn.speaker,
            text: message.text,
            messageId: turn.messageId
          })
        }
      }
    }
    return history
  }

  getActive(): Discussion | null {
    return this.discussions.find((d) => d.state !== 'completed' && d.state !== 'idle' && d.state !== 'error') ?? null
  }

  close() {
    this.closed = true
    this.discussions = []
    this.turns = []
  }
}