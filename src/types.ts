export type PanelWidths = { karl: number; astra: number; nova: number }
export type Settings = { panelWidths: PanelWidths; threadHeight: number }
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
export type CourtParticipant = 'karl' | 'astra' | 'nova'
export type CourtRecipient = CourtParticipant | 'court' | 'both'
export type DiscussionTurn = 'karl' | 'astra' | 'nova'
export type DiscussionState = 'idle' | 'ready' | 'awaiting-astra' | 'awaiting-nova' | 'awaiting-karl' | 'paused' | 'completed' | 'error'
export type DiscussionTurnRecord = {
  id: string
  discussionId: string
  turn: number
  speaker: DiscussionTurn
  recipient: CourtRecipient
  messageId: string | null
  createdAt: string
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
  isThreeWay: boolean
}
export type CourtMessage = {
  id: string
  caseRef: string | null
  sender: CourtParticipant
  recipient: CourtRecipient
  text: string
  source: 'manual' | 'imported' | 'connected'
  delivery: 'local' | 'awaiting-send' | 'sent' | 'unconfirmed' | 'delivery-unknown' | 'prepared-for-astra' | 'prepared-for-opencode' | 'prepared-for-powershell' | 'awaiting-karl-submission' | 'confirmed-delivered' | 'failed'
  acknowledged: boolean
  acknowledgedAt: string | null
  externalId: string | null
  /** The unified turn this message belongs to, when it came from a three-way conversation. */
  turnId: string | null
  createdAt: string
  forwardedFrom: string | null
}
export type UnifiedStage = 'karl-recorded' | 'astra-submitted' | 'astra-responded' | 'nova-submitted' | 'nova-responded' | 'returned-to-karl'
export type UnifiedStageStatus = 'pending' | 'complete' | 'uncertain' | 'awaiting-approval' | 'failed'
export type UnifiedTurn = {
  id: string
  topic: string
  discussionId: string | null
  karlMessageId: string | null
  astraResponseMessageId: string | null
  novaResponseMessageId: string | null
  stages: Record<UnifiedStage, { status: UnifiedStageStatus; attempt: number; at: string | null; detail: string | null }>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
export type HandoffTarget = 'astra' | 'nova'
export type HandoffStatus = 'idle' | 'preparing' | 'awaiting-karl' | 'awaiting-reply' | 'paused' | 'error'
export type HandoffState = {
  status: HandoffStatus
  target: HandoffTarget | null
  messageId: string | null
  detail: string | null
  paused: boolean
  since: string | null
}
export type Participant = 'karl' | 'astra' | 'nova'
export type PortraitFraming = { zoom: number; x: number; y: number }
export type PortraitRecord = {
  participant: Participant
  file: string
  mime: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: number
  width: number
  height: number
  framing: PortraitFraming
  updatedAt: string
}
export type PortraitState = { participant: Participant; portrait: PortraitRecord | null }
export type PortraitWithImage = PortraitRecord & { url: string | null }
export type TerminalMode = 'opencode' | 'powershell'
export type TerminalState = {
  id: string | null
  mode: TerminalMode | null
  status: 'idle' | 'running' | 'stopping' | 'exited' | 'error'
  workspace: string | null
  pid: number | null
  cols: number | null
  rows: number | null
  exitCode: number | null
  error: string | null
  buffer: string
}
export type TerminalSize = { cols: number; rows: number }
declare global {
  interface Window {
    novaCourt: {
      readSettings: () => Promise<Settings>
      saveWidths: (widths: Settings) => Promise<Settings>
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
      getTerminalState: () => Promise<TerminalState>
      onTerminalState: (callback: (state: TerminalState) => void) => () => void
      onTerminalData: (callback: (event: { id: string; data: string }) => void) => () => void
      startTerminal: (mode: TerminalMode, size: TerminalSize) => Promise<TerminalState>
      stopTerminal: () => Promise<TerminalState>
      restartTerminal: (mode: TerminalMode, size: TerminalSize) => Promise<TerminalState>
      clearTerminal: () => Promise<TerminalState>
      writeTerminal: (id: string, data: string) => void
      resizeTerminal: (id: string, size: TerminalSize) => void
      getCourtMessages: () => Promise<CourtMessage[]>
      onCourtMessages: (callback: (messages: CourtMessage[]) => void) => () => void
      appendCourtMessage: (input: { sender: CourtParticipant; recipient: CourtRecipient; text: string; source: 'manual' | 'imported'; caseRef?: string }) => Promise<CourtMessage>
      forwardCourtMessage: (id: string, recipient: CourtRecipient) => Promise<CourtMessage>
      markCourtDelivery: (id: string, delivery: CourtMessage['delivery']) => Promise<CourtMessage[]>
      acknowledgeCourtMessage: (id: string) => Promise<CourtMessage[]>
      getHandoffState: () => Promise<HandoffState>
      onHandoffState: (callback: (state: HandoffState) => void) => () => void
      pauseHandoffs: (paused: boolean) => void
      cancelHandoff: () => Promise<HandoffState>
      writeClipboard: (text: string) => Promise<boolean>
      readClipboard: () => Promise<string>
      copyForAstra: (id: string) => Promise<HandoffState>
      confirmAstraSent: (id: string) => Promise<CourtMessage[]>
      copyForTerminal: (id: string) => Promise<{ copied: boolean; notice: string }>
      prepareForTerminal: (messageId: string, mode: TerminalMode) => Promise<{ ok: boolean; text?: string; deliveryStatus?: string; reason?: string }>
      prepareForAstra: (id: string) => Promise<HandoffState>
      pasteToAstra: () => Promise<{ attempted: boolean; reason: string; diagnostics?: Record<string, unknown> }>
      sendAndWaitAstra: (messageId: string, timeoutMs?: number, discussionId?: string) => Promise<{ success: boolean; reason: string; response: string | null; diagnostics: Record<string, unknown>; messageId?: string }>
      sendToNova: (id: string) => Promise<HandoffState>
      getPortraits: () => Promise<PortraitState[]>
      onPortraitState: (callback: (state: PortraitState) => void) => () => void
      readPortraitImage: (participant: Participant) => Promise<string | null>
      savePortrait: (participant: Participant, payload: { encoding: 'base64'; data: string; framing?: PortraitFraming }) => Promise<PortraitWithImage>
      framePortrait: (participant: Participant, framing: PortraitFraming) => Promise<PortraitRecord>
      resetPortrait: (participant: Participant) => Promise<PortraitState>
      testViewBounds: () => Promise<{ bounds: ViewRequest['rect'] | null; attached: boolean; registered: boolean }>
      getDiscussionState: () => Promise<{ discussion: Discussion | null; turns: DiscussionTurnRecord[] }>
      onDiscussionState: (callback: (state: { discussion: Discussion | null; turns: DiscussionTurnRecord[] }) => void) => () => void
startDiscussion: (input: { topic: string; maxTurns?: number; participants?: DiscussionTurn[]; isThreeWay?: boolean }) => Promise<Discussion>
  nextDiscussionTurn: () => Promise<{ discussion: Discussion; turn: DiscussionTurnRecord | null }>
  pauseDiscussion: () => Promise<Discussion | null>
  resumeDiscussion: () => Promise<Discussion | null>
  endDiscussion: () => Promise<Discussion | null>
  sendUnifiedMessage: (text: string) => Promise<void>
  reconcileUnifiedTurn: (turnId: string) => Promise<{ observation: string; turn?: UnifiedTurn | null; reason?: string }>
  resolveUncertainTurn: (turnId: string, decision: 'resend' | 'cancel') => Promise<UnifiedTurn | null>
  getUnifiedTurnState: () => Promise<{ active: UnifiedTurn | null; turns: UnifiedTurn[] }>
  cancelUnifiedTurn: (turnId: string) => Promise<UnifiedTurn | null>
  onUnifiedTurn: (callback: (state: { turn: UnifiedTurn | null; turns: UnifiedTurn[] }) => void) => () => void
  onUnifiedStatus: (callback: (status: { phase: string; detail?: string }) => void) => () => void
}
  }
}
