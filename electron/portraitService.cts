import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Participant = 'karl' | 'astra' | 'nova'

/**
 * Crop and framing are stored as presentation parameters rather than baked into the file, so the
 * same uploaded image can be re-framed later without a second copy on disk. `zoom` is a scale factor
 * applied to the cover-fitted image; `x` and `y` are the normalised focal offsets the user dragged,
 * each in [-1, 1], where 0 is the centre.
 */
export type Framing = { zoom: number; x: number; y: number }
export type PortraitRecord = {
  participant: Participant
  file: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: number
  width: number
  height: number
  framing: Framing
  updatedAt: string
}
export type PortraitState = { participant: Participant; portrait: PortraitRecord | null }

const PARTICIPANTS: readonly Participant[] = ['karl', 'astra', 'nova']
export const portraitParticipants = PARTICIPANTS

const MAX_BYTES = 4 * 1024 * 1024
const MAX_EDGE = 4096
const DEFAULT_FRAMING: Framing = { zoom: 1, x: 0, y: 0 }

export function isParticipant(value: unknown): value is Participant {
  return typeof value === 'string' && (PARTICIPANTS as readonly string[]).includes(value)
}

/**
 * Formats are recognised from their magic bytes, never from the file extension or the MIME type the
 * renderer claims. An attacker who can reach this IPC channel must not be able to talk NovaCourt
 * into writing an arbitrary payload into the portraits directory with an image extension.
 */
function sniff(buffer: Buffer): { mime: PortraitRecord['mime']; extension: string; width: number; height: number } | null {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', extension: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    // Walk the JPEG marker segments to the first SOF, which carries the real frame size.
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const size = buffer.readUInt16BE(offset + 2)
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) return { mime: 'image/jpeg', extension: 'jpg', width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      if (size < 2) return null
      offset += 2 + size
    }
    return null
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { mime: 'image/webp', extension: 'webp', width, height }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { mime: 'image/webp', extension: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21)
      return { mime: 'image/webp', extension: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  return null
}

function validFraming(value: unknown): Framing {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const clamp = (raw: unknown, limit: number, fallback: number) => {
    const number = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
    return Math.max(-limit, Math.min(limit, Math.round(number * 1000) / 1000))
  }
  return { zoom: clamp(input.zoom, 3, 1), x: clamp(input.x, 1, 0), y: clamp(input.y, 1, 0) }
}

/**
 * Portraits live under the app's userData directory, never in the repository and never at a path the
 * renderer chooses. The renderer supplies bytes; this service decides where they land.
 */
export class PortraitService {
  private readonly directory: string
  private readonly indexPath: string
  private index: Record<Participant, PortraitRecord | null>

  constructor(dataPath: string, private readonly publish: (state: PortraitState) => void) {
    this.directory = join(dataPath, 'portraits')
    this.indexPath = join(dataPath, 'portraits.json')
    this.index = { karl: null, astra: null, nova: null }
    mkdirSync(this.directory, { recursive: true })
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, unknown>
      for (const participant of PARTICIPANTS) this.index[participant] = this.acceptRecord(parsed?.[participant])
    } catch { /* First launch or an unreadable index falls back to placeholders. */ }
    this.pruneOrphans()
  }

  private acceptRecord(value: unknown): PortraitRecord | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.file !== 'string' || !/^[a-z]+-[0-9a-f-]{36}\.(png|jpg|webp)$/.test(record.file)) return null
    if (!isParticipant(record.participant) || typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const path = join(this.directory, record.file)
    try {
      if (!existsSync(path)) return null
      if (statSync(path).size !== record.bytes) return null
    } catch { return null }
    return {
      participant: record.participant,
      file: record.file,
      mime: record.mime as PortraitRecord['mime'],
      bytes: Number(record.bytes),
      width: record.width,
      height: record.height,
      framing: validFraming(record.framing),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString()
    }
  }

  /** Removes files on disk that the index no longer claims, so a failed save cannot leak images. */
  private pruneOrphans() {
    const claimed = new Set(Object.values(this.index).filter(Boolean).map((record) => record!.file))
    try {
      for (const entry of readdirSync(this.directory)) if (!claimed.has(entry)) rmSync(join(this.directory, entry), { force: true })
    } catch { /* The directory is best-effort; a missing one simply means nothing to prune. */ }
  }

  snapshot(): PortraitState[] { return PARTICIPANTS.map((participant) => ({ participant, portrait: this.index[participant] ? { ...this.index[participant]!, framing: { ...this.index[participant]!.framing } } : null })) }

  record(participant: Participant): PortraitRecord | null { return this.index[participant] }

  private emit(participant: Participant) { this.publish({ participant, portrait: this.index[participant] }) }

  private persist() {
    const temporary = `${this.indexPath}.tmp`
    writeFileSync(temporary, JSON.stringify(this.index, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.indexPath)
  }

  /** Raw bytes for a participant's stored image, or null. Used only to serve the renderer. */
  read(participant: unknown): { record: PortraitRecord; data: Buffer } | null {
    if (!isParticipant(participant)) return null
    const record = this.index[participant]
    if (!record) return null
    try { return { record, data: readFileSync(join(this.directory, record.file)) } } catch { return null }
  }

  save(participant: unknown, payload: unknown): PortraitRecord {
    if (!isParticipant(participant)) throw new Error('Unknown participant')
    if (!payload || typeof payload !== 'object') throw new Error('No image was supplied')
    const input = payload as Record<string, unknown>
    const encoding = input.encoding
    if (encoding !== 'base64') throw new Error('Images must be uploaded as base64 data')
    if (typeof input.data !== 'string' || !input.data) throw new Error('No image was supplied')
    // 4 bytes of base64 per 3 bytes of file, plus slack. Checked before decoding so an oversized
    // string never becomes an oversized buffer.
    if (input.data.length > Math.ceil((MAX_BYTES * 4) / 3) + 1024) throw new Error(`Images must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
    let buffer: Buffer
    try { buffer = Buffer.from(input.data, 'base64') } catch { throw new Error('The image could not be decoded') }
    if (!buffer.length) throw new Error('No image was supplied')
    if (buffer.length > MAX_BYTES) throw new Error(`Images must be under ${Math.round(MAX_BYTES / 1024 / 1024)} MB`)
    const sniffed = sniff(buffer)
    if (!sniffed) throw new Error('Only PNG, JPG and WebP images are accepted')
    if (sniffed.width < 1 || sniffed.height < 1) throw new Error('The image has no readable dimensions')
    if (sniffed.width > MAX_EDGE || sniffed.height > MAX_EDGE) throw new Error(`Images must be at most ${MAX_EDGE}px on each side`)

    const record: PortraitRecord = {
      participant,
      file: `${participant}-${randomUUID()}.${sniffed.extension}`,
      mime: sniffed.mime,
      bytes: buffer.length,
      width: sniffed.width,
      height: sniffed.height,
      framing: validFraming(input.framing),
      updatedAt: new Date().toISOString()
    }
    mkdirSync(this.directory, { recursive: true })
    const destination = join(this.directory, record.file)
    try {
      writeFileSync(destination, buffer, { mode: 0o600 })
    } catch {
      throw new Error('The image could not be saved')
    }
    // The previous file is only unlinked after the new one exists and the index names it, so a
    // failed replace leaves the previous portrait intact rather than removing both.
    const previous = this.index[participant]
    this.index[participant] = record
    try { this.persist() } catch {
      this.index[participant] = previous
      rmSync(destination, { force: true })
      throw new Error('The portrait index could not be written')
    }
    if (previous) rmSync(join(this.directory, previous.file), { force: true })
    this.emit(participant)
    return { ...record, framing: { ...record.framing } }
  }

  setFraming(participant: unknown, framing: unknown): PortraitRecord {
    if (!isParticipant(participant)) throw new Error('Unknown participant')
    const record = this.index[participant]
    if (!record) throw new Error('Upload an image before setting framing')
    record.framing = validFraming(framing)
    record.updatedAt = new Date().toISOString()
    try { this.persist() } catch { throw new Error('The portrait index could not be written') }
    this.emit(participant)
    return { ...record, framing: { ...record.framing } }
  }

  reset(participant: unknown): PortraitState {
    if (!isParticipant(participant)) throw new Error('Unknown participant')
    const record = this.index[participant]
    this.index[participant] = null
    try { this.persist() } catch { this.index[participant] = record; throw new Error('The portrait index could not be written') }
    if (record) { try { rmSync(join(this.directory, record.file), { force: true }) } catch { /* A stranded file is pruned on next launch. */ } }
    this.emit(participant)
    return { participant, portrait: null }
  }

  close() { this.index = { karl: null, astra: null, nova: null } }
}