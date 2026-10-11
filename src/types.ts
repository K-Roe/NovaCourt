export type PanelWidths = { karl: number; astra: number; nova: number }
export type Settings = { panelWidths: PanelWidths }
export type ViewRequest = { visible: boolean; rect: { x: number; y: number; width: number; height: number }; zoom: number }
export type AstraStatus = { source: 'fixture' | 'chatgpt'; phase: 'loading' | 'open' | 'sign-in-page' | 'offline' | 'error' | 'blocked'; detail: string }
export type NovaState = {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  version: string | null
  installedVersion: string | null
  executableFound: boolean
  config: { endpoint: string; executablePath: string; workspace: string; sessionId: string | null; modelId: string | null }
  sessions: { id: string; title: string; directory: string; safe: boolean; updated: number }[]
  messages: { id: string; role: 'user' | 'assistant'; text: string; created: number; tools: { name: string; status: string }[]; error?: string }[]
  models: { id: string; name: string; providerID: string; modelID: string }[]
  busy: boolean
  deliveryUncertain: boolean
}
declare global {
  interface Window {
    novaCourt: {
      readSettings: () => Promise<Settings>
      saveWidths: (widths: PanelWidths) => Promise<Settings>
      setAstraBounds: (request: ViewRequest) => void
      onWindowResize: (callback: () => void) => () => void
      readAstraStatus: () => Promise<AstraStatus>
      onAstraStatus: (callback: (status: AstraStatus) => void) => () => void
      retryAstra: () => void
      getNovaState: () => Promise<NovaState>
      onNovaState: (callback: (state: NovaState) => void) => () => void
      configureNova: (input: { endpoint: string; executablePath: string; workspace: string }) => Promise<NovaState>
      connectNova: () => Promise<NovaState>
      startNovaServer: () => Promise<NovaState>
      createNovaSession: () => Promise<NovaState>
      selectNovaSession: (id: string) => Promise<NovaState>
      chooseNovaModel: (id: string) => Promise<NovaState>
      sendNovaMessage: (message: string) => Promise<NovaState>
      stopNova: () => Promise<NovaState>
      refreshNova: () => Promise<NovaState>
      testViewBounds: () => Promise<{ bounds: ViewRequest['rect'] | null; attached: boolean; registered: boolean }>
    }
  }
}
