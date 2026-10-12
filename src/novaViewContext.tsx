import { createContext, useContext, useState, ReactNode } from 'react'

export type NovaView = 'opencode' | 'powershell' | 'chat'

type NovaViewContextValue = {
  view: NovaView
  setView: (view: NovaView) => void
}

const NovaViewContext = createContext<NovaViewContextValue | null>(null)

export function NovaViewProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<NovaView>('chat')
  return <NovaViewContext.Provider value={{ view, setView }}>{children}</NovaViewContext.Provider>
}

export function useNovaView() {
  const context = useContext(NovaViewContext)
  if (!context) throw new Error('useNovaView must be used within NovaViewProvider')
  return context
}