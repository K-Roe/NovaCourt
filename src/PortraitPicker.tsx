import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Trash2, Upload } from 'lucide-react'
import Avatar from './Avatar'
import { usePortraits } from './portraitStore'
import { PARTICIPANT_META } from './portraits'
import type { Participant, PortraitFraming } from './types'

const ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_BYTES = 4 * 1024 * 1024
const ACCEPTED_LABEL = 'PNG, JPG or WebP'

type Draft = { data: string; framing: PortraitFraming; width: number; height: number; bytes: number; name: string }

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The file could not be read'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      // The main process re-validates from magic bytes. Stripping the data-URL prefix here keeps the
      // payload to raw bytes so nothing but the image itself crosses the channel.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.readAsDataURL(file)
  })
}

/** Reads intrinsic size from the browser's decoder. Display only; the service validates independently. */
function measure(data: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: 0, height: 0 })
    image.src = `data:image/png;base64,${data}`
  })
}

export default function PortraitPicker({ participant }: { participant: Participant }) {
  const { entries, save, frame, reset } = usePortraits()
  const { record, url } = entries[participant]
  const meta = PARTICIPANT_META[participant]
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [framing, setFraming] = useState<PortraitFraming>({ zoom: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setFraming(record?.framing ?? { zoom: 1, x: 0, y: 0 })
    setDraft(null)
    setError(null)
  }, [participant, record?.file])

  const shown = draft ? `data:image/png;base64,${draft.data}` : url

  async function choose(file: File | undefined) {
    setError(null)
    if (!file) return
    if (!ACCEPT.split(',').includes(file.type)) { setError(`${meta.name}’s portrait must be ${ACCEPTED_LABEL}.`); return }
    if (file.size > MAX_BYTES) { setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB.`); return }
    const data = await toBase64(file)
    if (!data) { setError('That file could not be read as an image.'); return }
    const size = await measure(data)
    if (!size.width || !size.height) { setError('That file is not a readable image.'); return }
    // Preview only. Nothing is written to disk until Save is pressed.
    setDraft({ data, framing: { zoom: 1, x: 0, y: 0 }, width: size.width, height: size.height, bytes: file.size, name: file.name })
  }

  async function persist(next: Draft | null) {
    if (!next) return
    setBusy(true); setError(null)
    try {
      await save(participant, next.data, next.framing)
      setDraft(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  async function applyFraming() {
    if (draft) { setDraft({ ...draft, framing }); return }
    if (!record) return
    setBusy(true); setError(null)
    try { await frame(participant, framing) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  async function clearImage() {
    setBusy(true); setError(null)
    try { await reset(participant); setDraft(null); if (fileRef.current) fileRef.current.value = '' }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (framing.zoom <= 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: framing.x, y: framing.y }
    setDragging(true)
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    const box = event.currentTarget.getBoundingClientRect()
    const clamp = (value: number) => Math.max(-1, Math.min(1, Math.round(value * 1000) / 1000))
    setFraming((current) => ({ ...current, x: clamp(drag.x + ((event.clientX - drag.pointerX) / Math.max(1, box.width / 2)) * -1), y: clamp(drag.y + ((event.clientY - drag.pointerY) / Math.max(1, box.height / 2)) * -1) }))
  }
  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
    setDragging(false)
    void applyFraming()
  }

  const previewStyle = { transform: `translate(${(framing.x * ((framing.zoom - 1) / 2) * 100).toFixed(2)}%, ${(framing.y * ((framing.zoom - 1) / 2) * 100).toFixed(2)}%) scale(${framing.zoom})` }

  return <div className="portrait-picker" data-participant={participant}>
    <div className="portrait-picker-head">
      <Avatar participant={participant} size={38}/>
      <div><strong>{meta.name}</strong><span>{meta.role}</span></div>
    </div>

    <div
      className={`portrait-crop${framing.zoom > 1 ? ' is-zoomable' : ''}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-testid={`portrait-crop-${participant}`}
    >
      {shown ? <img src={shown} alt="" style={previewStyle} draggable={false}/> : <span className="portrait-crop-empty">{meta.initial}</span>}
    </div>

    <div className="portrait-crop-meta">
      {draft ? <span>Preview · {draft.width}×{draft.height} · {(draft.bytes / 1024).toFixed(0)} KB · {draft.name}</span>
        : record ? <span>{record.width}×{record.height} · {(record.bytes / 1024).toFixed(0)} KB</span>
        : <span>No image uploaded · showing the coloured initial</span>}
    </div>

    <label className="portrait-zoom">Zoom
      <input type="range" min="1" max="3" step="0.05" value={framing.zoom} aria-label={`Zoom ${meta.name} portrait`} onChange={(event) => setFraming({ ...framing, zoom: Number(event.target.value) })} onPointerUp={() => void applyFraming()}/>
    </label>
    <p className="portrait-hint">{framing.zoom > 1 ? 'Drag the image to reposition the face, then release.' : 'Zoom in past 1× to reposition the crop.'}</p>

    <input ref={fileRef} type="file" accept={ACCEPT} className="portrait-file" aria-label={`Choose a ${meta.name} portrait image`} onChange={(event) => void choose(event.target.files?.[0])}/>

    <div className="portrait-actions">
      <button onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={13}/> {record || draft ? 'Replace' : 'Upload'}</button>
      <button onClick={() => setFraming({ zoom: 1, x: 0, y: 0 })} disabled={busy || (framing.zoom === 1 && framing.x === 0 && framing.y === 0)} className="secondary"><RotateCcw size={13}/> Reset crop</button>
      {record && <button onClick={() => void clearImage()} disabled={busy} className="danger"><Trash2 size={13}/> Remove</button>}
    </div>

    <div className="portrait-save">
      {draft
        ? <><button onClick={() => void persist(draft)} disabled={busy}>Save portrait</button><button onClick={() => { setDraft(null); setError(null) }} disabled={busy} className="secondary">Discard</button></>
        : <span className="portrait-saved-note">{record ? 'Saved. Avatars update immediately.' : 'Upload an image to replace the initial.'}</span>}
    </div>

    {error && <div className="portrait-error" role="alert">{error}</div>}
  </div>
}