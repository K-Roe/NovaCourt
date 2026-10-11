import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { Participant, PortraitRecord, PortraitState } from './types'


type PortraitEntry = { record: PortraitRecord | null; url: string | null }

type PortraitContextValue = {
  entries: Record<Participant, PortraitEntry>
  ready: boolean
  refresh: () => void
  save: (participant: Participant, data: string, framing: { zoom: number; x: number; y: number }) => Promise<PortraitRecord>
  frame: (participant: Participant, framing: { zoom: number; x: number; y: number }) => Promise<PortraitRecord>
  reset: (participant: Participant) => Promise<void>
}

const empty = (): Record<Participant, PortraitEntry> => ({ karl: { record: null, url: null }, astra: { record: null, url: null }, nova: { record: null, url: null } })

const PortraitContext = createContext<PortraitContextValue | null>(null)

/**
 * One portrait store for the whole renderer, mounted once in App. Every avatar subscribes to it, so a
 * save updates Karl, Astra and Nova's avatars at once without a page reload and without each panel
 * holding its own copy of the image bytes.
 */
export function PortraitProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<Record<Participant, PortraitEntry>>(empty)
  const [ready, setReady] = useState(false)

  const loadImage = useCallback(async (participant: Participant, record: PortraitRecord | null) => {
    if (!record) return { record: null, url: null }
    try { return { record, url: await window.novaCourt.readPortraitImage(participant) } }
    catch { return { record, url: null } }
  }, [])

  const refresh = useCallback(() => {
    void window.novaCourt.getPortraits().then(async (states: PortraitState[]) => {
      const next = empty()
      await Promise.all(states.map(async (state) => { next[state.participant] = await loadImage(state.participant, state.portrait) }))
      setEntries(next)
      setReady(true)
    }).catch(() => setReady(true))
  }, [loadImage])

  useEffect(() => {
    refresh()
    // The main process publishes after every save, framing change and reset, which is what makes the
    // UI update immediately rather than on the next poll.
    return window.novaCourt.onPortraitState(() => refresh())
  }, [refresh])

  const save = useCallback(async (participant: Participant, data: string, framing: { zoom: number; x: number; y: number }) => {
    const record = await window.novaCourt.savePortrait(participant, { encoding: 'base64', data, framing })
    setEntries((previous) => ({ ...previous, [participant]: { record, url: record.url } }))
    return record
  }, [])

  const frame = useCallback(async (participant: Participant, framing: { zoom: number; x: number; y: number }) => {
    const record = await window.novaCourt.framePortrait(participant, framing)
    setEntries((previous) => ({ ...previous, [participant]: { ...previous[participant], record } }))
    return record
  }, [])

  const reset = useCallback(async (participant: Participant) => {
    await window.novaCourt.resetPortrait(participant)
    setEntries((previous) => ({ ...previous, [participant]: { record: null, url: null } }))
  }, [])

  const value = useMemo(() => ({ entries, ready, refresh, save, frame, reset }), [entries, ready, refresh, save, frame, reset])
  return <PortraitContext.Provider value={value}>{children}</PortraitContext.Provider>
}

export function usePortraits() {
  const value = useContext(PortraitContext)
  if (!value) throw new Error('usePortraits must be used inside PortraitProvider')
  return value
}

export function usePortrait(participant: Participant) { return usePortraits().entries[participant] }