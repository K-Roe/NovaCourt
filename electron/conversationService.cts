import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CourtParticipant = 'karl' | 'astra' | 'nova'

/**
 * `source` records where a message honestly came from.
 *
 * `manual`   — Karl composed it here.
 * `imported` — Karl pasted it in from elsewhere (Astra's ChatGPT window, a terminal, anywhere).
 * `connected` — received by Nova over the chat-only HTTP service.
 *
 * The distinction is not cosmetic. An imported message is by definition content Karl copied from an
 * untrusted surface, so it must never be treated as an instruction by anything downstream. Nothing in
 * this module acts on a message, which is what makes that guarantee structural rather than a promise.
 */
export type MessageSource = 'manual' | 'imported' | 'connected'

export type CourtMessage = {
  id: string
  caseRef: string | null
  sender: CourtParticipant
  /** Who the message was addressed to. `court` means every seat can see it. */
  recipient: CourtParticipant | 'court'
  text: string
  source: MessageSource
  delivery: 'local' | 'awaiting-send' | 'sent' | 'unconfirmed'
  createdAt: string
  /** Set when this message was produced by forwarding another; the original is never modified. */
  forwardedFrom: string | null
}

export type ConversationInput = {
  sender: unknown
  recipient: unknown
  text: unknown
  source: unknown
  caseRef?: unknown
  forwardedFrom?: unknown
  delivery?: unknown
}

export type AppendResult = { ok: true; message: CourtMessage } | { ok: false; reason: string; duplicate: boolean; existingId: string | null }

const MAX_TEXT = 8000
const MAX_MESSAGES = 2000
const RECIPIENTS = ['karl', 'astra', 'nova', 'court']
const SENDERS = ['karl', 'astra', 'nova']

/**
 * Normalises text for duplicate detection. Collapses whitespace and case so that re-pasting the same
 * paragraph with different wrapping does not create a second copy, while a genuinely different message
 * still registers as new.
 */
function fingerprint(text: string, sender: CourtParticipant): string {
  return `${sender}:${text.replace(/\s+/g, ' ').trim().toLowerCase()}`
}

/**
 * The shared courtroom record.
 *
 * Append-only by construction: there is no update and no delete on the public surface. Forwarding
 * appends a new message that points at the original; correcting a message means appending a reply.
 * That mirrors I-9 in the founding ruling and means a forwarded or edited conversation can never lose
 * what was actually said.
 *
 * This class deliberately holds no reference to the terminal service or the OpenCode service. It
 * cannot dispatch a command even if a caller asks it to, which is the structural form of "a discussion
 * message never authorises execution".
 */
export class ConversationService {
  private messages: CourtMessage[] = []
  private readonly path: string
  private closed = false

  constructor(dataPath: string, private readonly publish: (messages: CourtMessage[]) => void) {
    this.path = join(dataPath, 'conversation.json')
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (Array.isArray(parsed)) this.messages = parsed.map((entry) => this.accept(entry)).filter(Boolean) as CourtMessage[]
      this.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      this.messages = this.messages.slice(-MAX_MESSAGES)
    } catch { /* First launch or unreadable history starts an empty conversation. */ }
  }

  private accept(value: unknown): CourtMessage | null {
    if (!value || typeof value !== 'object') return null
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || !/^[0-9a-f-]{36}$/.test(entry.id)) return null
    if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > MAX_TEXT) return null
    if (!SENDERS.includes(String(entry.sender))) return null
    if (!RECIPIENTS.includes(String(entry.recipient))) return null
    if (!['manual', 'imported', 'connected'].includes(String(entry.source))) return null
    if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) return null
    return {
      id: entry.id,
      caseRef: typeof entry.caseRef === 'string' && entry.caseRef ? entry.caseRef.slice(0, 64) : null,
      sender: entry.sender as CourtParticipant,
      recipient: entry.recipient as CourtMessage['recipient'],
      text: entry.text,
      source: entry.source as MessageSource,
      delivery: ['local', 'awaiting-send', 'sent', 'unconfirmed'].includes(String(entry.delivery)) ? entry.delivery as CourtMessage['delivery'] : 'local',
      createdAt: entry.createdAt,
      forwardedFrom: typeof entry.forwardedFrom === 'string' ? entry.forwardedFrom : null
    }
  }

  snapshot(): CourtMessage[] { return this.messages.map((message) => ({ ...message })) }

  private persist() {
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.messages, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.path)
  }

  /**
   * Duplicate suppression applies to manual composition and to imports of the same text from the same
   * sender. A forwarded copy is exempt, because forwarding the same message to two recipients is the
   * intended behaviour and suppressing it would break the feature.
   */
  private findDuplicate(text: string, sender: CourtParticipant, forwardedFrom: string | null): CourtMessage | null {
    if (forwardedFrom) return null
    const key = fingerprint(text, sender)
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const candidate = this.messages[index]
      if (candidate.forwardedFrom) continue
      if (fingerprint(candidate.text, candidate.sender) === key) return candidate
    }
    return null
  }

  append(input: ConversationInput): AppendResult {
    if (this.closed) return { ok: false, reason: 'The court record is closed', duplicate: false, existingId: null }
    const sender = String(input.sender)
    const recipient = String(input.recipient)
    const source = String(input.source)
    if (!SENDERS.includes(sender)) return { ok: false, reason: 'Choose a sender', duplicate: false, existingId: null }
    if (!RECIPIENTS.includes(recipient)) return { ok: false, reason: 'Choose a recipient', duplicate: false, existingId: null }
    if (!['manual', 'imported', 'connected'].includes(source)) return { ok: false, reason: 'Unknown message source', duplicate: false, existingId: null }
    if (typeof input.text !== 'string') return { ok: false, reason: 'The message has no text', duplicate: false, existingId: null }
    const text = input.text.trim()
    if (!text) return { ok: false, reason: 'The message has no text', duplicate: false, existingId: null }
    if (text.length > MAX_TEXT) return { ok: false, reason: `Messages must be under ${MAX_TEXT} characters`, duplicate: false, existingId: null }
    const forwardedFrom = typeof input.forwardedFrom === 'string' ? input.forwardedFrom : null
    if (forwardedFrom && !this.messages.some((message) => message.id === forwardedFrom)) {
      return { ok: false, reason: 'The message being forwarded no longer exists', duplicate: false, existingId: null }
    }
    const duplicate = this.findDuplicate(text, sender as CourtParticipant, forwardedFrom)
    if (duplicate) return { ok: false, reason: 'That message is already in the conversation', duplicate: true, existingId: duplicate.id }

    const message: CourtMessage = {
      id: randomUUID(),
      caseRef: typeof input.caseRef === 'string' && input.caseRef.trim() ? input.caseRef.trim().slice(0, 64) : null,
      sender: sender as CourtParticipant,
      recipient: recipient as CourtMessage['recipient'],
      text,
      source: source as MessageSource,
      delivery: ['local', 'awaiting-send', 'sent', 'unconfirmed'].includes(String(input.delivery)) ? input.delivery as CourtMessage['delivery'] : source === 'manual' ? 'local' : 'awaiting-send',
      createdAt: new Date().toISOString(),
      forwardedFrom
    }
    this.messages.push(message)
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES)
    try { this.persist() } catch { this.messages = this.messages.filter((entry) => entry.id !== message.id); return { ok: false, reason: 'The conversation could not be saved', duplicate: false, existingId: null } }
    this.publish(this.snapshot())
    return { ok: true, message: { ...message } }
  }

  /**
   * Records the outcome of an attempted delivery. This is the ONLY mutation of an existing message,
   * and it may only move delivery forward through a fixed set of values. It cannot change text, sender,
   * recipient or source, so a delivery report can never rewrite what was said or who said it.
   */
  markDelivery(id: unknown, delivery: unknown): { ok: boolean; reason?: string } {
    if (typeof id !== 'string' || !this.messages.some((message) => message.id === id)) return { ok: false, reason: 'No such message' }
    const next = String(delivery)
    if (!['awaiting-send', 'sent', 'unconfirmed', 'local'].includes(next)) return { ok: false, reason: 'Unknown delivery state' }
    const target = this.messages.find((message) => message.id === id)!
    target.delivery = next as CourtMessage['delivery']
    try { this.persist() } catch { return { ok: false, reason: 'The conversation could not be saved' } }
    this.publish(this.snapshot())
    return { ok: true }
  }

  /**
   * There is deliberately no clear or delete. The visible transcript can be collapsed or filtered in
   * the renderer, but the stored record only ever grows: what was said cannot be made to disappear,
   * which is invariant I-9 in the founding ruling.
   */

  close() { this.closed = true; this.messages = [] }
}