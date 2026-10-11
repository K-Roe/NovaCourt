import type { Participant } from './types'

/**
 * Portrait manifest, keyed by participant and mood. The set is deliberately open: adding a mood is a
 * one-line change here and nothing else, which is what lets a future milestone add expressions
 * without touching the avatar component or the upload path.
 *
 * The letter-and-colour fallback is not a placeholder to be embarrassed about — it is the honest
 * default while a participant has no approved artwork, so the app never displays an invented likeness
 * of a real person.
 */
export type Mood = 'default' | 'judge' | 'hammer' | 'worried' | 'building' | 'celebrate'

export const PARTICIPANT_META: Record<Participant, { name: string; role: string; initial: string; hue: number; theme: string }> = {
  karl: { name: 'Karl', role: 'The Owner', initial: 'K', hue: 176, theme: 'teal' },
  astra: { name: 'Astra', role: 'The Judge', initial: 'A', hue: 272, theme: 'purple' },
  nova: { name: 'Nova', role: 'The Defendant', initial: 'N', hue: 24, theme: 'orange' }
}

export const MOODS: readonly Mood[] = ['default', 'judge', 'hammer', 'worried', 'building', 'celebrate']

/** Mirrors `portraitParticipants` in the main process, which is the authority that validates writes. */
export const portraitParticipants: readonly Participant[] = ['karl', 'astra', 'nova']

export const moodFor = (_participant: Participant, mood?: Mood): Mood => mood ?? 'default'

/**
 * CSS transform for the saved crop. The image is cover-fitted to the frame first, then scaled and
 * translated by the user's focal offset, clamped so the image can never be dragged off its own frame.
 */
export function framingStyle(framing?: { zoom: number; x: number; y: number }): React.CSSProperties {
  const zoom = Math.max(1, Math.min(3, framing?.zoom ?? 1))
  const x = Math.max(-1, Math.min(1, framing?.x ?? 0))
  const y = Math.max(-1, Math.min(1, framing?.y ?? 0))
  // At zoom 1 the overflow is zero, so any offset must be ignored or the image would slide out of view.
  const travelX = ((zoom - 1) / 2) * 100
  const travelY = ((zoom - 1) / 2) * 100
  return { transform: `translate(${(x * travelX).toFixed(2)}%, ${(y * travelY).toFixed(2)}%) scale(${zoom.toFixed(3)})` }
}