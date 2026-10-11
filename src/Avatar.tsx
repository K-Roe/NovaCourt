import { usePortrait } from './portraitStore'
import { PARTICIPANT_META, framingStyle, type Mood } from './portraits'
import type { Participant } from './types'

/**
 * Renders an uploaded portrait when one exists and a themed initial when one does not. The frame is
 * a fixed square with overflow hidden, so any aspect ratio of source image is safe and three
 * participants of different artwork still line up in a row.
 */
export default function Avatar({ participant, mood = 'default', size = 34, title }: { participant: Participant; mood?: Mood; size?: number; title?: string }) {
  const { record, url } = usePortrait(participant)
  const meta = PARTICIPANT_META[participant]
  const style = { width: size, height: size }
  const label = title || `${meta.name} · ${meta.role}`

  return <span className={`court-avatar court-avatar-${meta.theme}${url ? ' has-image' : ''}${mood !== 'default' ? ` mood-${mood}` : ''}`} style={style} title={label} aria-label={label} role="img" data-participant={participant} data-mood={mood} data-has-portrait={url ? 'true' : 'false'}>
    {url ? <img src={url} alt="" style={framingStyle(record?.framing)} draggable={false}/> : <span className="court-avatar-initial" aria-hidden="true">{meta.initial}</span>}
  </span>
}