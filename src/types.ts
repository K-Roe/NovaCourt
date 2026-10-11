export type PanelWidths = { karl: number; astra: number; nova: number }
export type Settings = { panelWidths: PanelWidths }
export type ViewRequest = { visible: boolean; rect: { x: number; y: number; width: number; height: number }; zoom: number }
export type AstraStatus = { source: 'fixture' | 'chatgpt'; phase: 'loading' | 'open' | 'sign-in-page' | 'offline' | 'error' | 'blocked'; detail: string }
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
      testViewBounds: () => Promise<{ bounds: ViewRequest['rect'] | null; attached: boolean; registered: boolean }>
    }
  }
}
