import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, WebContentsView, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OpenCodeService, validWorkspace, type NovaState } from './openCodeService.cjs'
import { ConversationService, type CourtMessage } from './conversationService.cjs'
import { HandoffService } from './handoffService.cjs'
import { DiscussionService, type Discussion, type DiscussionTurnRecord } from './discussionService.cjs'
import { UnifiedTurnService, promptPresentInNovaHistory, type UnifiedStage, type UnifiedTurn } from './unifiedTurnService.cjs'
import { PortraitService } from './portraitService.cjs'
import { TerminalService } from './terminalService.cjs'
import {
  ASTRA_MIN_STABLE_MS,
  ASTRA_STABLE_POLLS_REQUIRED,
  buildAstraComposerFocusScript,
  buildAstraProbeScript,
  buildBaseline,
  clampToViewport,
  captureUserBaseline,
  confirmSubmittedWithBaseline,
  countNewUserMessages,
  evaluateCompletion,
  fingerprintOf,
  parseAstraComposerTarget,
  parseAstraProbe,
  pickCandidate,
  type AstraBaseline,
  type UserBaseline,
  type AstraProbe
} from './astraDetector.cjs'

/**
 * The three outcomes of trying to confirm that a prompt reached ChatGPT.
 *
 * `not-sent` means we positively established the prompt never left the composer — the paste and Enter
 * genuinely went nowhere, and it is safe to offer a retry.
 *
 * `confirmed` means a new matching user message appeared in the thread.
 *
 * `unknown` means we ran out of time, or the page stopped being readable, and cannot tell. This is the
 * outcome the old code never had, and it is the important one: it is the state in which the message may
 * or may not have been accepted, so it must trigger reconciliation against ChatGPT rather than a resend.
 */
type SubmissionOutcome =
  | { outcome: 'not-sent'; reason: string }
  | { outcome: 'confirmed'; polls: number; elapsedMs: number }
  | { outcome: 'unknown'; reason: 'timeout' | 'page-unreadable'; polls?: number; elapsedMs?: number; newUserMessagesObserved?: number }

/**
 * How long the send path waits for a submitted prompt to appear in the thread before it gives up
 * trying to verify it. This used to be a fixed ten polls of 250ms — 2.5 seconds in total — which was
 * shorter than ChatGPT sometimes needs to render the user's own message on a cold or busy page.
 *
 * A short window is not merely inconvenient. It produced a false negative: the prompt had been
 * accepted and was being answered, NovaCourt could not see it yet, so the send was reported as failed
 * and the delivery was recorded as `unconfirmed`. Karl's reasonable response to "it did not send" is to
 * press send again, and that is how the same question reached ChatGPT twice.
 *
 * Exceeding this window is not treated as proof of failure. It is treated as `unknown` — a state that
 * explicitly preserves the possibility that the message was accepted — because the only honest reading
 * of "I could not see it" is "I do not know", and acting on "I do not know" as though it were "it did
 * not arrive" is what causes duplicate submissions.
 */
const ASTRA_SUBMISSION_CONFIRM_TIMEOUT_MS = 15_000
/** Gap between confirmation probes. Kept short so a fast acknowledgement is noticed promptly. */
const ASTRA_SUBMISSION_POLL_MS = 250
/**
 * Overrides for how long the response must look settled before text stability alone can end the wait.
 *
 * The poll count and the wall-clock floor both matter. The poll count bounds the work in the common case;
 * the floor is what actually protects against a pause, because a slow poll schedule must not be able to
 * satisfy a small poll count in less time than a real pause could last.
 */
const astraStablePolls = () => {
  const raw = Number(process.env.NC_V2_ASTRA_STABLE_POLLS)
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : ASTRA_STABLE_POLLS_REQUIRED
}
const astraMinStableMs = () => {
  const raw = Number(process.env.NC_V2_ASTRA_MIN_STABLE_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : ASTRA_MIN_STABLE_MS
}

type PanelWidths = { karl: number; astra: number; nova: number }
type Settings = { panelWidths: PanelWidths; threadHeight?: number }
type ViewRequest = { visible: boolean; rect: { x: number; y: number; width: number; height: number }; zoom: number }
type AstraStatus = { source: 'fixture' | 'chatgpt'; phase: 'loading' | 'open' | 'sign-in-page' | 'offline' | 'error' | 'blocked'; detail: string }

const defaultSettings: Settings = { panelWidths: { karl: 34, astra: 35, nova: 31 }, threadHeight: 320 }
const chatGptUrl = 'https://chatgpt.com/'
/**
 * A second, opt-in fixture that reproduces ChatGPT's conversation markup so the response detector can
 * be exercised offline. It is a separate flag rather than a variant of the layout fixture because the
 * layout fixture deliberately contains no message structure — it exists to check panel geometry, and
 * giving it messages would stop it testing what it was written to test.
 *
 * The detector is allowed to run against this page even though it is not chatgpt.com. That is a test
 * affordance only: it is reachable solely because the caller set the environment variable, and
 * navigation remains pinned to this exact file.
 */
const conversationFixtureMode = process.env.NC_V2_ASTRA_CONVERSATION_FIXTURE === '1'
/** Either local fixture counts as fixture mode for loading, navigation and status purposes. */
const fixtureMode = process.env.NC_V2_ASTRA_FIXTURE === '1' || conversationFixtureMode
const allowedHosts = new Set(['chatgpt.com', 'auth.openai.com', 'openai.com', 'accounts.google.com', 'appleid.apple.com', 'login.live.com', 'login.microsoftonline.com'])
const views = new Map<string, WebContentsView>()
let mainWindow: BrowserWindow | null = null
let attached = false
let lastBounds: Rectangle | null = null
let novaService: OpenCodeService | null = null
let terminalService: TerminalService | null = null
let portraitService: PortraitService | null = null
let conversationService: ConversationService | null = null
let handoffService: HandoffService | null = null
let discussionService: DiscussionService | null = null
let unifiedTurnService: UnifiedTurnService | null = null
let astraStatus: AstraStatus = fixtureMode
  ? { source: 'fixture', phase: 'loading', detail: 'Loading local fixture' }
  : { source: 'chatgpt', phase: 'loading', detail: 'Loading chatgpt.com' }

if (process.env.NC_V2_USER_DATA) app.setPath('userData', resolve(process.env.NC_V2_USER_DATA))

function settingsPath() { return join(app.getPath('userData'), 'settings.json') }
function validWidths(value: unknown): value is PanelWidths {
  if (!value || typeof value !== 'object') return false
  const widths = value as Record<string, unknown>
  const numbers = [widths.karl, widths.astra, widths.nova]
  return numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 20 && n <= 60) && Math.abs((numbers as number[]).reduce((a, b) => a + b, 0) - 100) < 0.01
}
function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>
    if (validWidths(parsed.panelWidths)) return { panelWidths: parsed.panelWidths, threadHeight: typeof parsed.threadHeight === 'number' && Number.isFinite(parsed.threadHeight) && parsed.threadHeight >= 120 ? parsed.threadHeight : defaultSettings.threadHeight }
  } catch { /* First launch or invalid settings use safe defaults. */ }
  return defaultSettings
}
function saveSettings(value: Settings) {
  const path = settingsPath()
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}
function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return mainWindow !== null && event.sender.id === mainWindow.webContents.id && event.senderFrame === mainWindow.webContents.mainFrame
}
function publishAstraStatus(phase: AstraStatus['phase'], detail: string) {
  astraStatus = { source: fixtureMode ? 'fixture' : 'chatgpt', phase, detail }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('astra:status', astraStatus)
}
function allowedNavigation(rawUrl: string, fixtureUrl: string) {
  if (fixtureMode) return rawUrl === fixtureUrl
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && allowedHosts.has(url.hostname) && !url.username && !url.password
  } catch { return false }
}
function loadedPhase(rawUrl: string): AstraStatus['phase'] {
  if (fixtureMode) return 'open'
  try {
    const url = new URL(rawUrl)
    if (url.hostname === 'auth.openai.com' || /^\/(auth\/login|login|signin)(\/|$)/i.test(url.pathname)) return 'sign-in-page'
  } catch { /* Keep the conservative open state. */ }
  return 'open'
}
function clampView(request: ViewRequest): Rectangle | null {
  if (!mainWindow || !request || typeof request !== 'object' || !request.visible) return null
  const { rect, zoom } = request
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  if (zoom < 0.5 || zoom > 3 || rect.width <= 0 || rect.height <= 0) return null
  const { width, height } = mainWindow.getContentBounds()
  const left = Math.max(0, Math.min(width, Math.round(rect.x * zoom)))
  const top = Math.max(0, Math.min(height, Math.round(rect.y * zoom)))
  const right = Math.max(left, Math.min(width, Math.round((rect.x + rect.width) * zoom)))
  const bottom = Math.max(top, Math.min(height, Math.round((rect.y + rect.height) * zoom)))
  if (right - left < 20 || bottom - top < 20) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
function updateAstra(request: ViewRequest) {
  const view = views.get('astra')
  if (!mainWindow || mainWindow.isDestroyed() || !view) return
  const bounds = clampView(request)
  if (!bounds) {
    if (attached) mainWindow.contentView.removeChildView(view)
    attached = false
    lastBounds = null
    return
  }
  view.setBounds(bounds)
  if (!attached) mainWindow.contentView.addChildView(view)
  attached = true
  lastBounds = bounds
}
/**
 * Records genuine Nova replies into the shared transcript.
 *
 * It only ever runs while a Nova handoff is outstanding, it records the service's real assistant
 * messages, and it stamps each with the OpenCode message id so the same reply cannot be recorded
 * twice as the service republishes its state. Nothing here fabricates a response, and a refusal or an
 * error message is never dressed up as an answer.
 */
let novaReplyBaseline = new Set<string>()
let threeWayProcessing = false

/** Called when a prompt is accepted, so replies already in the session are not mistaken for new ones. */
function primeNovaReplyBaseline(state: { messages: { id: string; role: string }[] }) {
  novaReplyBaseline = new Set(state.messages.filter((message) => message.role === 'assistant').map((message) => message.id))
}

/**
 * Reads the Astra view and returns what it can see.
 *
 * Returns null when the page could not be read at all, which is distinct from an empty probe meaning
 * "the thread genuinely has no assistant messages". The distinction matters: the first is an error to
 * report, the second is a legitimate starting state.
 */
async function probeAstra(webContents: Electron.WebContents): Promise<AstraProbe | null> {
  if (webContents.isDestroyed()) return null
  try {
    return parseAstraProbe(await webContents.executeJavaScript(buildAstraProbeScript()))
  } catch (error) {
    return null
  }
}

/**
 * Captures what was already in Astra's thread before the prompt is sent.
 *
 * An empty baseline is a normal outcome, not a failure: the first message of a new conversation has no
 * prior assistant replies to record. `buildBaseline` records the thread length alongside the identities
 * so that "empty" costs nothing in accuracy — every message seen afterwards is new, which is correct.
 */
async function captureAstraMessageBaseline(webContents: Electron.WebContents): Promise<AstraBaseline | null> {
  const probe = await probeAstra(webContents)
  if (!probe) {
    console.warn('[Astra] Baseline capture failed: the view could not be read')
    return null
  }

  const baseline = buildBaseline(probe)
  const matched = Object.entries(probe.selectorCounts).filter(([, count]) => count > 0)

  console.log('[Astra] Baseline captured', {
    assistantMessages: baseline.count,
    // Reported so a selector that silently stops matching is visible in the log rather than showing up
    // only as an unexplained empty baseline.
    selectorsMatched: matched.map(([name, count]) => `${name} => ${count}`),
    selectorsMissing: Object.entries(probe.selectorCounts).filter(([, count]) => count === 0).map(([name]) => name),
    composerCount: probe.composerCount,
    threadReady: probe.threadReady
  })

  return baseline
}

/**
 * Waits for Astra to finish replying, then returns the reply text.
 *
 * The detector's rules live in `astraDetector`; this function owns only the polling, the stability
 * bookkeeping, and the diagnostics. On success the caller records the response and advances the
 * discussion, so this function must not return a partial, invented, or borrowed message: it returns
 * either text that arrived after the baseline was taken, or null.
 */
async function waitForAstraResponse(
  webContents: Electron.WebContents,
  timeoutMs: number,
  diagnostics: Record<string, unknown>,
  baseline: AstraBaseline,
  sentMessagePreview: string
): Promise<{ text: string | null; completed: boolean; reason: string }> {
  const startTime = Date.now()
  const pollMs = 500
  const requiredStablePolls = astraStablePolls()

  let responseKey: string | null = null
  let responseText: string | null = null
  let previousText: string | null = null
  let unchangedPolls = 0
  /** When the response text last changed. The stability fallback is gated on elapsed time, not poll count. */
  let lastChangeAt = Date.now()
  let firstDetectionMs: number | null = null
  let lastSignal = 'no-response'

  diagnostics.baselineSize = baseline.count
  diagnostics.baselineKeys = Array.from(baseline.keys).slice(0, 10)
  diagnostics.sentMessagePreview = sentMessagePreview.slice(0, 100)
  diagnostics.polls = 0

  while (Date.now() - startTime < timeoutMs) {
    const probe = await probeAstra(webContents)
    diagnostics.polls = Number(diagnostics.polls) + 1

    if (!probe) {
      lastSignal = 'probe-failed'
      diagnostics.lastFailure = 'The Astra view could not be read'
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }

    const picked = pickCandidate(probe, baseline)

    diagnostics.lastCheck = new Date().toISOString()
    diagnostics.lastSelectorCounts = probe.selectorCounts
    diagnostics.stopControlPresent = probe.stopControlPresent

    if (!picked.found) {
      lastSignal = picked.reason
      diagnostics.noCandidateReason = picked.reason
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }

    const candidate = picked.candidate

    // Latch onto the first new message. Later polls keep watching this one even if other messages
    // appear, because the reply we are waiting for is the one that started arriving after our prompt.
    if (responseKey === null) {
      responseKey = candidate.key
      firstDetectionMs = Date.now() - startTime
      console.log('[Astra] Response detected', {
        key: responseKey,
        afterMs: firstDetectionMs,
        length: candidate.text.length,
        streaming: candidate.isStreaming,
        hasRegenerate: candidate.hasRegenerate
      })
    }

    if (candidate.key !== responseKey) {
      diagnostics.superseded = { expected: responseKey, saw: candidate.key }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      continue
    }

    if (candidate.text !== previousText) unchangedPolls = 0
    else unchangedPolls += 1
    if (candidate.text !== previousText) lastChangeAt = Date.now()
    previousText = candidate.text
    responseText = candidate.text

    const stableForMs = Date.now() - lastChangeAt
    const completion = evaluateCompletion(
      candidate,
      probe,
      unchangedPolls,
      requiredStablePolls,
      stableForMs,
      astraMinStableMs()
    )
    lastSignal = completion.signal

    diagnostics.completionSignal = completion.signal
    diagnostics.unchangedPolls = unchangedPolls
    diagnostics.stableForMs = stableForMs
    diagnostics.responseLength = candidate.text.length
    diagnostics.firstDetectionMs = firstDetectionMs
    diagnostics.messageHasCaret = candidate.hasCaret === true
    diagnostics.messageIsStreaming = candidate.isStreaming === true
    diagnostics.pageStopControl = probe.stopControlPresent

    if (completion.complete && candidate.text.trim()) {
      diagnostics.totalWaitMs = Date.now() - startTime
      diagnostics.firstDetectionMs = firstDetectionMs
      diagnostics.completedSignal = completion.signal
      diagnostics.failureMode = 'response-captured'
      console.log('[Astra] Response complete', {
        afterMs: diagnostics.totalWaitMs,
        detectedMs: firstDetectionMs,
        length: candidate.text.length,
        signal: completion.signal
      })
      return { text: candidate.text, completed: true, reason: 'completed' }
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  diagnostics.totalWaitMs = Date.now() - startTime
  diagnostics.firstDetectionMs = firstDetectionMs
  diagnostics.timeout = true
  diagnostics.failureMode = firstDetectionMs === null ? 'no-response-detected' : 'response-never-completed'
  diagnostics.lastSignal = lastSignal

  console.warn('[Astra] Timed out waiting for a completed response', {
    waitedMs: diagnostics.totalWaitMs,
    detectedMs: firstDetectionMs,
    partialLength: responseText?.length ?? 0,
    lastSignal,
    selectors: diagnostics.lastSelectorCounts
  })

  // A partial answer is still Astra's real words and is returned for inspection, but `completed` is
  // false so the caller will not record it as a ruling or advance the turn on it.
  return {
    text: responseText && responseText.trim().length > 0 ? responseText : null,
    completed: false,
    reason: firstDetectionMs === null ? 'no-response' : 'incomplete-response'
  }
}

/**
 * Puts keyboard focus into Astra's prompt box.
 *
 * Focus is the whole difficulty of sending a message to a third-party site: the clipboard paste and the
 * Enter key both go to whatever currently holds focus, and if that is the conversation rather than the
 * input they do nothing at all, silently. So the page is asked where its input is, the view is focused,
 * a real click is delivered at that point, and the page is asked again whether focus actually landed.
 *
 * The reported `focusedAfterClick` is returned even when focus failed so the caller can report the
 * difference between "the prompt was rejected" and "the prompt was never typed anywhere".
 */
async function focusAstraComposer(webContents: Electron.WebContents): Promise<{ found: boolean; selector: string | null; alreadyFocused: boolean; focusedAfterClick: boolean }> {
  const ask = async () => {
    try {
      return parseAstraComposerTarget(await webContents.executeJavaScript(buildAstraComposerFocusScript()))
    } catch {
      return parseAstraComposerTarget(null)
    }
  }

  const initial = await ask()
  if (initial.alreadyFocused) return { ...initial, focusedAfterClick: true }

  try { webContents.focus() } catch { /* Focus can be refused when the window is not active; the click below still applies. */ }
  await new Promise((resolve) => setTimeout(resolve, 150))

  const target = initial.found && initial.rect
    ? clampToViewport({ x: initial.rect.x, y: initial.rect.y }, lastBounds ?? { width: initial.rect.x, height: initial.rect.y })
    : null

  if (target) {
    try {
      webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers: [] })
      await new Promise((resolve) => setTimeout(resolve, 60))
      webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1, modifiers: [] })
      await new Promise((resolve) => setTimeout(resolve, 200))
    } catch {
      return { ...initial, focusedAfterClick: false }
    }
  }

  const after = await ask()
  return { found: initial.found, selector: initial.selector, alreadyFocused: initial.alreadyFocused, focusedAfterClick: after.alreadyFocused }
}

/**
 * Confirms the prompt reached the conversation, by waiting for a user message that was not there before.
 *
 * `baseline` MUST be captured before the prompt is pasted and Enter is pressed. Taking it here instead —
 * after the send — would put the very message being confirmed into the baseline, and the comparison
 * could then never succeed: the new message would look pre-existing and every send would time out as
 * `unknown`. The baseline is therefore captured by the caller, deliberately, before the send.
 *
 * On timeout the result is `unknown`, not `false`. We could not see the message in time; that is not
 * evidence it was never received, and reporting it as a failure is what caused duplicate submissions.
 */
async function confirmAstraSubmission(
  webContents: Electron.WebContents,
  sentText: string,
  baseline: UserBaseline,
  timeoutMs: number = ASTRA_SUBMISSION_CONFIRM_TIMEOUT_MS,
  pollMs: number = ASTRA_SUBMISSION_POLL_MS
): Promise<SubmissionOutcome> {
  const start = Date.now()
  let polls = 0
  let lastNewUserMessages = 0

  while (Date.now() - start < timeoutMs) {
    polls += 1
    const probe = await probeAstra(webContents)
    if (probe) {
      const verdict = confirmSubmittedWithBaseline(sentText, probe, baseline)
      lastNewUserMessages = verdict.observedNewUserMessages
      if (verdict.confirmed) {
        return { outcome: 'confirmed', polls, elapsedMs: Date.now() - start }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }

  console.warn('[Astra] Submission confirmation timed out', {
    waitedMs: Date.now() - start,
    polls,
    newUserMessagesObserved: lastNewUserMessages,
    sentTextLength: sentText.length
  })

  // Distinguish "nothing at all happened" from "something arrived we could not identify". They are
  // different situations for Karl: the first suggests the prompt never left, the second suggests it
  // may be sitting in ChatGPT unrecognised and must be reconciled before any retry.
  const finalProbe = await probeAstra(webContents)
  const newMessages = finalProbe ? countNewUserMessages(finalProbe, baseline) : lastNewUserMessages
  return {
    outcome: 'unknown',
    reason: 'timeout',
    polls,
    elapsedMs: Date.now() - start,
    newUserMessagesObserved: newMessages
  }
}


/**
 * Finds Karl's opening message for a three-way discussion.
 * Returns the messageId of the most recent Karl message addressed to Astra or Both.
 */
function findKarlOpeningMessage(discussionId: string): string | null {
  if (!conversationService) return null
  const messages = conversationService.snapshot()
  const karlMessage = [...messages].reverse().find(m => 
    m.sender === 'karl' && (m.recipient === 'astra' || m.recipient === 'both' as CourtMessage['recipient'])
  )
  return karlMessage?.id ?? null
}

/**
 * Sends a message to Astra and waits for the complete response.
 * Records the response in the conversation and advances the discussion turn.
 * This is the internal version of the astra:sendAndWait IPC handler.
 */
async function sendToAstraAndWait(
  messageId: string,
  discussionId: string,
  responseTimeoutMs = 120000,
  turnId: string | null = null
): Promise<{ success: boolean; uncertain?: boolean; response?: string; responseMessageId?: string; error?: string; diagnostics?: Record<string, unknown> }> {
  if (!conversationService || !handoffService || !discussionService) {
    return { success: false, error: 'Services unavailable' }
  }

  const view = views.get('astra')
  if (!view || view.webContents.isDestroyed()) {
    return { success: false, error: 'Astra view not available' }
  }

  const url = view.webContents.getURL()
  const isChatPage = conversationFixtureMode
    || (url.startsWith('https://chatgpt.com/') && !url.includes('/auth/') && !url.includes('/login') && !url.includes('/signin'))
  
  if (!isChatPage) {
    return { success: false, error: 'Astra is not on the ChatGPT chat page' }
  }
  const message = conversationService.snapshot().find((m) => m.id === messageId)
  if (!message) {
    return { success: false, error: 'Message not found' }
  }

  const diagnostics: Record<string, unknown> = {
    messageId,
    discussionId,
    sentTextLength: message.text.length,
    sentTextPreview: message.text.slice(0, 100),
  };

  conversationService.markDelivery(messageId, 'awaiting-send')
  handoffService.prepare('astra', messageId, 'Sending to Astra and waiting for response...')

  try {
    // Focus the composer itself. Clicking the centre of the view used to stand in for this, but the
    // composer is not in the centre of the page, so the click landed on the conversation and the paste
    // that followed had nowhere to go.
    const focused = await focusAstraComposer(view.webContents)
    diagnostics.composerFound = focused.found
    diagnostics.composerSelector = focused.selector
    diagnostics.composerAlreadyFocused = focused.alreadyFocused
    diagnostics.composerFocusedAfterClick = focused.focusedAfterClick

    if (!focused.found) {
      // Not fatal on its own: some layouts accept a paste without an identifiable composer element. The
      // submission check afterwards is what actually decides whether the prompt arrived.
      console.warn('[Astra] Composer element not found; attempting paste without targeting it')
    }

    // CAPTURE BOTH BASELINES BEFORE SENDING.
    //
    // The user-message baseline has to be taken before the prompt is pasted, or the prompt itself would
    // be part of the history it is compared against and could never be recognised as new.
    console.log('[Astra] Capturing message baseline before send...');
    const baseline = await captureAstraMessageBaseline(view.webContents);
    if (!baseline) {
      handoffService.fail('Could not read Astra’s conversation, so the message was not sent.');
      return { success: false, error: 'Could not read the Astra conversation before sending', diagnostics };
    }
    const submissionProbe = await probeAstra(view.webContents)
    if (!submissionProbe) {
      handoffService.fail('Could not read Astra’s conversation, so the message was not sent.');
      return { success: false, error: 'Could not read the Astra conversation before sending', diagnostics };
    }
    const userBaseline = captureUserBaseline(submissionProbe)
    diagnostics.baselineCaptured = true;
    diagnostics.baselineSize = baseline.count;
    diagnostics.userBaselineSize = userBaseline.count;
    console.log('[Astra] Baseline captured', { assistantMessages: baseline.count, userMessages: userBaseline.count });
    
    clipboard.writeText(message.text)
    await new Promise((resolve) => setTimeout(resolve, 100))
    view.webContents.paste()
    await new Promise((resolve) => setTimeout(resolve, 500))
    
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [] })
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // The prompt must actually be in the conversation before waiting begins, otherwise a focus problem
    // is indistinguishable from a slow model and the user just watches a spinner for two minutes.
    const submission = await confirmAstraSubmission(view.webContents, message.text, userBaseline)
    diagnostics.submission = submission

    if (submission.outcome === 'unknown') {
      // Deliberately NOT a failure. We could not see the message, which is not evidence it was never
      // received. `unknown` preserves that possibility so the turn is not resent blindly; the stage
      // machine will require reconciliation against ChatGPT before any further submission.
      conversationService.markDelivery(messageId, 'delivery-unknown')
      handoffService.settle(
        submission.newUserMessagesObserved
          ? `Could not confirm the message reached Astra within ${Math.round(submission.elapsedMs! / 1000)}s, and ${submission.newUserMessagesObserved} new message(s) appeared that could not be identified. The message may have been accepted. Reconcile before resending.`
          : `Could not confirm the message reached Astra within ${Math.round(submission.elapsedMs! / 1000)}s. The message may have been accepted. Reconcile before resending.`
      )
      diagnostics.failureMode = 'submission-unknown'
      return { success: false, uncertain: true, error: 'Could not confirm the message reached Astra. It may have been sent.', diagnostics }
    }

    diagnostics.promptConfirmedInThread = true

    const sendTime = Date.now();
    diagnostics.messageSentAt = new Date(sendTime).toISOString();
    
    conversationService.markDelivery(messageId, 'sent')
    handoffService.awaitingReply(messageId, 'Message sent to Astra. Waiting for response...')

    const outcome = await waitForAstraResponse(view.webContents, responseTimeoutMs, diagnostics, baseline, message.text)

    diagnostics.responseReceived = outcome.text !== null;
    diagnostics.responseLength = outcome.text?.length || 0;
    diagnostics.responseCompleted = outcome.completed;

    // Only a completed reply advances the discussion. A partial answer is Astra's real words, but it is
    // an unfinished sentence, and handing a truncated ruling to Nova as though it were the verdict would
    // be worse than stopping and letting Karl decide.
    if (outcome.completed && outcome.text) {
      const result = conversationService.append({
        sender: 'astra',
        recipient: 'court',
        text: outcome.text,
        source: 'connected',
        delivery: 'sent',
        externalId: `astra-${turnId ?? 'standalone'}-${Date.now()}`,
        turnId,
      })

      if (result.ok) {
        handoffService.settle('Astra responded. Reply recorded in transcript.')

        discussionService.recordMessage(discussionId, result.message.id)
        discussionService.advanceTurnAfterResponse(discussionId)

        return { success: true, response: outcome.text, responseMessageId: result.message.id, diagnostics }
      } else {
        handoffService.fail('Failed to record Astra response in transcript')
        return { success: false, error: 'Failed to record response', diagnostics }
      }
    }

    const reason = outcome.reason === 'incomplete-response'
      ? 'Astra began replying but never finished. The partial text is in the diagnostics and was not recorded.'
      : 'Astra did not reply in time.'
    handoffService.fail(reason)
    return { success: false, error: reason, diagnostics }
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    diagnostics.exception = errorMsg;
    conversationService.markDelivery(messageId, 'failed')
    handoffService.fail(`Error communicating with Astra: ${errorMsg}`)
    return { success: false, error: errorMsg, diagnostics }
  }
}

/**
 * Checks everything Nova needs before it can be sent anything, and returns a specific reason if not.
 *
 * This is deliberately separated from the send itself so the check happens before any stage is marked
 * complete. Checking after the fact was how a turn could record a Nova submission as done and then
 * discover the session was not chat-only — leaving the stage machine claiming something untrue.
 */
function novaPrerequisiteFailure(novaState: NovaState): string | null {
  if (novaState.connection !== 'connected') {
    return novaState.connection === 'connecting'
      ? 'Nova is connecting to the OpenCode server…'
      : novaState.connection === 'error'
        ? `Nova chat error: ${novaState.error || 'Unknown error'}. Connect to OpenCode first.`
        : 'Nova chat is disconnected. Connect to the OpenCode server first.'
  }
  if (!novaState.config.sessionId) {
    return 'No active Nova chat session. Start or select a chat-only session in the Nova panel.'
  }
  const session = novaState.sessions.find((candidate) => candidate.id === novaState.config.sessionId)
  if (!session || !session.safe) {
    return 'The active Nova session is not a verified chat-only session. Create a new chat-only session.'
  }
  if (!novaState.config.modelId) {
    return 'No Nova model selected. Choose a model in the Nova panel.'
  }
  return null
}

/**
 * Sends a message to Nova through the guarded chat service.
 * The response is recorded asynchronously via recordNovaReplies callback.
 *
 * Note that this message is Astra's *answer*, being forwarded for Nova's opinion. A failure here is not
 * a failure of Astra's work, and the delivery state must not imply otherwise — which is why the failure
 * path records `delivery-unknown` on the forwarded message while Astra's own stage in the turn remains
 * complete and untouched.
 */
async function sendToNova(messageId: string, discussionId: string): Promise<{ success: boolean; uncertain?: boolean; error?: string }> {
  if (!handoffService || !conversationService || !novaService) {
    return { success: false, error: 'Handoffs are unavailable' }
  }

  const message = conversationService.snapshot().find((entry) => entry.id === messageId)
  if (!message) {
    return { success: false, error: 'No such message' }
  }

  const prepared = handoffService.prepare('nova', message.id, 'Sending to Nova through the guarded chat service.')
  if (!prepared.ok) {
    return { success: false, error: prepared.reason }
  }

  const before = novaService.snapshot()
  primeNovaReplyBaseline(before)
  conversationService.markDelivery(message.id, 'awaiting-send')

  try {
    await novaService.send(message.text)
  } catch (error) {
    // The guarded service sets its own `deliveryUncertain` flag in this path, because a failed prompt
    // POST may still have reached OpenCode. Mirroring that as `delivery-unknown` rather than
    // `unconfirmed` keeps the transcript from asserting something we do not know.
    const reason = error instanceof Error ? error.message : String(error)
    conversationService.markDelivery(message.id, 'delivery-unknown')
    handoffService.settle(`Nova delivery is uncertain: ${reason}. Astra's response is preserved.`)
    return { success: false, uncertain: true, error: reason }
  }

  conversationService.markDelivery(message.id, 'sent')
  handoffService.awaitingReply(message.id, 'Nova has the message. Waiting for its genuine reply…')

  recordNovaReplies(novaService.snapshot())
  return { success: true }
}

/**
 * Processes the next turn in a three-way conversation.
 * Called when discussion state changes to awaiting-astra or awaiting-nova.
 */
async function processThreeWayTurn(discussion: Discussion, turns: DiscussionTurnRecord[]) {
  if (!discussion.isThreeWay) return
  if (discussion.state !== 'awaiting-astra' && discussion.state !== 'awaiting-nova') return
  if (threeWayProcessing) return // Prevent concurrent processing

  const currentTurn = turns.find(t => t.discussionId === discussion.id && t.turn === discussion.turnCount)
  if (!currentTurn || currentTurn.messageId) return // Already processed or no current turn

  threeWayProcessing = true
  
  try {
    let inputMessageId: string | null = null
    
    if (discussion.turnCount === 1 && discussion.state === 'awaiting-astra') {
      // Turn 1: Astra responds to Karl's opening message
      inputMessageId = findKarlOpeningMessage(discussion.id)
    } else {
      // Subsequent turns: use previous turn's response
      const prevTurn = turns.find(t => t.discussionId === discussion.id && t.turn === discussion.turnCount - 1)
      inputMessageId = prevTurn?.messageId ?? null
    }

    if (!inputMessageId) {
      console.log('[ThreeWay] No input message found for turn', discussion.turnCount, 'state:', discussion.state)
      return
    }

    console.log('[ThreeWay] Processing turn', discussion.turnCount, 'for', discussion.state, 'with messageId:', inputMessageId)
    
    if (discussion.state === 'awaiting-astra') {
      await sendToAstraAndWait(inputMessageId, discussion.id)
    } else if (discussion.state === 'awaiting-nova') {
      await sendToNova(inputMessageId, discussion.id)
    }
  } catch (error) {
    console.error('[ThreeWay] Error processing turn:', error)
  } finally {
    threeWayProcessing = false
  }
}

/** The turn currently in flight, or null. Used to stamp outgoing and incoming court messages. */
function activeUnifiedTurnId(): string | null {
  return unifiedTurnService?.active()?.id ?? null
}

function recordNovaReplies(state: { messages: { id: string; role: string; text: string; error?: string }[] }) {
  if (!handoffService?.isAwaitingNova() || !conversationService) return
  for (const id of [...novaReplyBaseline]) if (!state.messages.some((message) => message.id === id)) novaReplyBaseline.delete(id)
  let recorded = 0
  let lastRecordedMessageId: string | null = null
  for (const message of state.messages) {
    if (message.role !== 'assistant' || novaReplyBaseline.has(message.id)) continue
    if (message.error) { novaReplyBaseline.add(message.id); handoffService.fail(`Nova could not answer: ${message.error}`); return }
    if (!message.text.trim()) continue
    const result = conversationService.append({
      sender: 'nova',
      recipient: 'court',
      text: message.text,
      source: 'connected',
      delivery: 'sent',
      externalId: message.id,
      turnId: activeUnifiedTurnId()
    })
    if (result.ok) { novaReplyBaseline.add(message.id); recorded += 1; lastRecordedMessageId = result.message.id }
  }
  if (recorded > 0) {
    handoffService.settle('Nova replied. The genuine reply is in the transcript.')

    // The stage machine only learns about Nova's answer here, when it has genuinely arrived. Completing
    // these stages any earlier — or optimistically after the prompt POST returned — would let the turn
    // claim Nova spoke when she did not, which is the one thing the stage list exists to prevent.
    const turn = unifiedTurnService?.active() ?? null
    if (turn && lastRecordedMessageId) {
      unifiedTurnService?.setResponse(turn.id, 'nova', lastRecordedMessageId)
      unifiedTurnService?.markStage(turn.id, 'nova-responded', 'complete', 'Nova reply captured')
      unifiedTurnService?.markStage(turn.id, 'returned-to-karl', 'complete', 'Control returned to Karl')
    }

    // Notify renderer that Nova has replied and we're ready for Karl
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('unified:status', { phase: 'ready' })
    }
    
    if (discussionService && lastRecordedMessageId) {
      const activeDiscussion = discussionService.getActive()
      if (activeDiscussion) {
        discussionService.recordMessage(activeDiscussion.id, lastRecordedMessageId)
        const advanceResult = discussionService.advanceTurnAfterResponse(activeDiscussion.id)
        if (advanceResult.ok && advanceResult.nextTurn) {
        } else if (advanceResult.ok && advanceResult.completed) {
        }
        // Process next turn for three-way conversations
        if (advanceResult.ok) {
          const updatedDiscussion = advanceResult.discussion
          const updatedTurns = discussionService.snapshot().turns.filter(t => t.discussionId === updatedDiscussion.id)
          void processThreeWayTurn(updatedDiscussion, updatedTurns)
        }
      }
    }
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    show: false, backgroundColor: '#100f18', title: 'NovaCourt V2',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  mainWindow = window
  novaService = new OpenCodeService(app.getPath('userData'), (state) => {
    recordNovaReplies(state)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('nova:state', state)
  })
  terminalService = new TerminalService(
    (state) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:state', state) },
    (id, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:data', { id, data }) },
  )
  portraitService = new PortraitService(app.getPath('userData'), (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('portrait:state', state)
  })
  // The conversation service is constructed with no reference to the terminal or OpenCode services.
  // That is the enforcement for "a discussion message never authorises execution": there is no object
  // graph from a court message to a command, so no sequence of messages can produce one.
  conversationService = new ConversationService(app.getPath('userData'), (messages) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('court:messages', messages)
  })
  discussionService = new DiscussionService(app.getPath('userData'), (discussion, turns) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('discussion:state', { discussion, turns })
  })
  handoffService = new HandoffService((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('handoff:state', state)
  })
  unifiedTurnService = new UnifiedTurnService(app.getPath('userData'), (turn, turns) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('unified:turn', { turn, turns })
  })
  const confirmTerminalStop = async (reason: string) => {
    if (!terminalService?.isRunning()) return true
    const choice = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Keep running', 'Stop terminal'], defaultId: 0, cancelId: 0,
      title: 'Stop active terminal?', message: reason,
      detail: 'Commands or OpenCode work running in this terminal will be interrupted.',
    })
    return choice.response === 1
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const fixtureName = conversationFixtureMode ? 'astra-conversation-fixture.html' : 'fixture.html'
  const fixturePath = resolve(__dirname, `../dist/${fixtureName}`)
  const fixtureUrl = process.env.NC_V2_DEV_URL ? `${process.env.NC_V2_DEV_URL}/${fixtureName}` : pathToFileURL(fixturePath).toString()
  const partition = fixtureMode ? 'astra-layout-fixture' : 'persist:chatgpt'
  const astraSession = session.fromPartition(partition)
  astraSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const astra = new WebContentsView({ webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  views.set('astra', astra)
  astra.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  astra.webContents.on('will-navigate', (event) => {
    if (!allowedNavigation(event.url, fixtureUrl)) { event.preventDefault(); publishAstraStatus('blocked', 'Navigation outside the permitted sign-in sites was blocked') }
  })
  astra.webContents.on('will-redirect', (event) => {
    if (!allowedNavigation(event.url, fixtureUrl)) { event.preventDefault(); publishAstraStatus('blocked', 'Redirect outside the permitted sign-in sites was blocked') }
  })
  astra.webContents.on('did-start-navigation', (event) => { if (event.isMainFrame && !event.isSameDocument) publishAstraStatus('loading', 'Loading ChatGPT website') })
  astra.webContents.on('did-finish-load', () => {
    const phase = loadedPhase(astra.webContents.getURL())
    publishAstraStatus(phase, fixtureMode ? 'Local layout fixture loaded' : phase === 'sign-in-page' ? 'Sign-in page displayed; account status unverified' : 'Website loaded; account status unverified')
  })
  astra.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      const phase = loadedPhase(url)
      publishAstraStatus(phase, phase === 'sign-in-page' ? 'Sign-in page displayed; account status unverified' : 'Website loaded; account status unverified')
    }
  })
  astra.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    publishAstraStatus(errorCode === -106 ? 'offline' : 'error', errorCode === -106 ? 'Network disconnected; reconnect and retry' : `Website failed to load (network error ${errorCode}); retry`)
  })
  astra.webContents.on('render-process-gone', () => publishAstraStatus('error', 'Website process stopped; retry'))
  void astra.webContents.loadURL(fixtureMode ? fixtureUrl : chatGptUrl)

  ipcMain.handle('settings:read', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return loadSettings() })
  ipcMain.handle('settings:saveWidths', (event, value: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!value || typeof value !== 'object') throw new Error('Invalid settings')
    const input = value as Record<string, unknown>
    let widths: PanelWidths
    let threadHeight = defaultSettings.threadHeight
    if ('panelWidths' in input && input.panelWidths && typeof input.panelWidths === 'object') {
      const pw = input.panelWidths as Record<string, unknown>
      widths = { karl: pw.karl, astra: pw.astra, nova: pw.nova } as PanelWidths
      threadHeight = typeof input.threadHeight === 'number' && Number.isFinite(input.threadHeight) && input.threadHeight >= 120 ? input.threadHeight : defaultSettings.threadHeight
    } else {
      widths = { karl: input.karl, astra: input.astra, nova: input.nova } as PanelWidths
    }
    if (!validWidths(widths)) throw new Error('Invalid panel widths')
    const settings = { panelWidths: widths, threadHeight }
    saveSettings(settings)
    return settings
  })
  ipcMain.on('astra:bounds', (event, request: ViewRequest) => { if (trustedSender(event)) updateAstra(request) })
  ipcMain.handle('nova:getState', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.snapshot() })
  ipcMain.handle('nova:configure', async (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (terminalService?.isRunning() && input && typeof input === 'object' && 'workspace' in input) {
      const workspace = validWorkspace(input.workspace)
      if (workspace.toLowerCase() !== novaService?.snapshot().config.workspace.toLowerCase()) {
        if (!await confirmTerminalStop('Changing Nova workspace will stop the active terminal.')) return novaService?.snapshot()
        await terminalService.stop()
      }
    }
    return novaService?.configure(input)
  })
  ipcMain.handle('nova:connect', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.connect() })
  ipcMain.handle('nova:startServer', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.startServer() })
  ipcMain.handle('nova:createSession', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.createSession() })
  ipcMain.handle('nova:selectSession', (event, id: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.selectSession(id) })
  ipcMain.handle('nova:chooseModel', (event, id: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.chooseModel(id) })
  ipcMain.handle('nova:send', (event, message: unknown) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.send(message) })
  ipcMain.handle('nova:stop', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.stop() })
  ipcMain.handle('nova:refresh', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return novaService?.refreshSessions() })
  ipcMain.handle('terminal:getState', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return terminalService?.snapshot() })
  ipcMain.handle('terminal:start', (event, mode: unknown, size: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const config = novaService?.snapshot().config
    if (!config || !terminalService) throw new Error('Terminal is unavailable')
    return terminalService.start(mode, config.workspace, config.executablePath, size)
  })
  ipcMain.handle('terminal:stop', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!await confirmTerminalStop('Stop this terminal session?')) return terminalService?.snapshot()
    return terminalService?.stop()
  })
  ipcMain.handle('terminal:restart', async (event, mode: unknown, size: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!await confirmTerminalStop('Restart this terminal session?')) return terminalService?.snapshot()
    await terminalService?.stop()
    const config = novaService?.snapshot().config
    if (!config || !terminalService) throw new Error('Terminal is unavailable')
    return terminalService.start(mode, config.workspace, config.executablePath, size)
  })
  ipcMain.handle('terminal:clear', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return terminalService?.clear() })
  ipcMain.on('terminal:write', (event, id: unknown, data: unknown) => { if (trustedSender(event)) { try { terminalService?.write(id, data) } catch { /* Ignore stale or invalid input. */ } } })
  ipcMain.on('terminal:resize', (event, id: unknown, size: unknown) => { if (trustedSender(event)) { try { terminalService?.resize(id, size) } catch { /* Ignore stale or invalid dimensions. */ } } })
  ipcMain.handle('court:messages', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return conversationService?.snapshot() })
  ipcMain.handle('court:append', (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    const result = conversationService.append(input as Parameters<ConversationService['append']>[0])
    if (!result.ok) throw new Error(result.reason)
    return result.message
  })
  ipcMain.handle('court:forward', (event, id: unknown, recipient: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    if (typeof id !== 'string') throw new Error('No such message')
    const original = conversationService.snapshot().find((message) => message.id === id)
    if (!original) throw new Error('No such message')
    // The original is never modified. A forward is a new message that names the one it came from.
    const result = conversationService.append({
      sender: original.sender,
      recipient,
      text: original.text,
      source: 'manual',
      caseRef: original.caseRef,
      forwardedFrom: original.id
    })
    if (!result.ok) throw new Error(result.reason)
    return result.message
  })
  ipcMain.handle('court:delivery', (event, id: unknown, delivery: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    const result = conversationService.markDelivery(id, delivery)
    if (!result.ok) throw new Error(result.reason)
    return conversationService.snapshot()
  })
  ipcMain.handle('handoff:state', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return handoffService?.snapshot() })
  ipcMain.on('handoff:pause', (event, paused: unknown) => { if (!trustedSender(event)) return; if (paused === true) handoffService?.pause(); else handoffService?.resume() })
  ipcMain.handle('handoff:cancel', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return handoffService?.cancel() })

  // Discussion management. Karl controls the three-way conversation flow.
  ipcMain.handle('discussion:start', async (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const startInput = input as { topic: unknown; maxTurns?: unknown; participants?: unknown; isThreeWay?: unknown }
    const result = discussionService.start(startInput)
    if (!result.ok) throw new Error(result.reason)
    
    // For three-way conversations, automatically advance to the first turn (Astra)
    if (result.discussion.isThreeWay) {
      const nextResult = discussionService.nextTurn()
      if (nextResult.ok) {
        const turns = discussionService.snapshot().turns.filter(t => t.discussionId === nextResult.discussion.id)
        void processThreeWayTurn(nextResult.discussion, turns)
        return nextResult.discussion
      }
    }
    return result.discussion
  })
  ipcMain.handle('discussion:nextTurn', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const result = discussionService.nextTurn()
    if (!result.ok) throw new Error(result.reason)
    // Process next turn for three-way conversations
    if (result.discussion.isThreeWay && (result.discussion.state === 'awaiting-astra' || result.discussion.state === 'awaiting-nova')) {
      const turns = discussionService.snapshot().turns.filter(t => t.discussionId === result.discussion.id)
      void processThreeWayTurn(result.discussion, turns)
    }
    return { discussion: result.discussion, turn: result.turn }
  })
  ipcMain.handle('discussion:pause', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const result = discussionService.pause()
    if (!result.ok) throw new Error(result.reason)
    return result.discussion
  })
  ipcMain.handle('discussion:resume', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const result = discussionService.resume()
    if (!result.ok) throw new Error(result.reason)
    // Process next turn for three-way conversations when resuming
    const resumedDiscussion = result.discussion
    if (resumedDiscussion && resumedDiscussion.isThreeWay && (resumedDiscussion.state === 'awaiting-astra' || resumedDiscussion.state === 'awaiting-nova')) {
      const turns = discussionService.snapshot().turns.filter(t => t.discussionId === resumedDiscussion.id)
      void processThreeWayTurn(resumedDiscussion, turns)
    }
    return result.discussion
  })
  ipcMain.handle('discussion:end', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const result = discussionService.end()
    if (!result.ok) throw new Error(result.reason)
    return result.discussion
  })
  ipcMain.handle('discussion:state', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const snapshot = discussionService.snapshot()
    const active = snapshot.discussions.find((d) => d.state !== 'completed' && d.state !== 'idle' && d.state !== 'error') ?? null
    return { discussion: active, turns: snapshot.turns }
  })
  ipcMain.handle('discussion:advanceTurn', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!discussionService) throw new Error('Discussion service is unavailable')
    const active = discussionService.getActive()
    if (!active) throw new Error('No active discussion')
    const result = discussionService.advanceTurnAfterResponse(active.id)
    if (!result.ok) throw new Error(result.reason)
    // Process next turn for three-way conversations
    if (result.discussion.isThreeWay && (result.discussion.state === 'awaiting-astra' || result.discussion.state === 'awaiting-nova')) {
      const turns = discussionService.snapshot().turns.filter(t => t.discussionId === result.discussion.id)
      void processThreeWayTurn(result.discussion, turns)
    }
    return { discussion: result.discussion, nextTurn: result.nextTurn, completed: result.completed }
  })

  //
  // Every entry point here is resumable. The handler walks the persisted turn from whichever stage it
  // is actually at, so calling it again after a failure — or after the app was restarted — continues
  // rather than repeating. Two properties are load-bearing:
  //
  //   * Karl's message is recorded exactly once per turn. Resuming never appends a second one.
  //   * Astra is contacted only while `astra-responded` is incomplete. Once her answer is captured the
  //     turn moves on to Nova regardless of what happens to Nova, so her work is never thrown away.
  ipcMain.handle('unified:sendMessage', async (event, text: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService || !handoffService || !discussionService || !novaService || !unifiedTurnService) {
      throw new Error('Required services unavailable')
    }
    const body = String(text ?? '').trim()
    if (!body) throw new Error('Message cannot be empty')

    const sendStatus = (status: { phase: string; detail?: string }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('unified:status', status)
      }
    }

    const existing = unifiedTurnService.active()

    // A different question while a turn is in flight is a new conversation, not a resume. Silently
    // discarding the previous turn is only safe when nothing is outstanding, because an uncertain
    // delivery is exactly the thing that must not be dropped without a decision.
    if (existing && existing.topic !== body) {
      const blocked = unifiedTurnService.blockedStage(existing.id)
      if (blocked) {
        // The refusal names the stage and the seat, because "something is uncertain" is not an action.
        // The renderer reads the same stage to offer Reconcile and Cancel, so the message Karl sees and
        // the buttons under it always describe the same state.
        throw new Error(`A previous turn has uncertain delivery at ${blocked}. Reconcile it or cancel it before starting a new one.`)
      }
      unifiedTurnService.abandon(existing.id, 'Superseded by a new message')
    }

    // ---- Stage: karl-recorded -------------------------------------------------
    let turn = unifiedTurnService.active()
    let karlMessageId: string | null = null

    if (turn && turn.topic === body) {
      karlMessageId = turn.karlMessageId
    } else {
      sendStatus({ phase: 'recording', detail: 'Recording your message…' })
      const started = unifiedTurnService.start({ topic: body })
      if (!started.ok) throw new Error(started.reason)
      turn = started.turn

      const karlMessageResult = conversationService.append({
        sender: 'karl',
        recipient: 'astra',
        text: body,
        source: 'manual',
        delivery: 'local',
        turnId: turn.id
      })
      if (!karlMessageResult.ok) {
        unifiedTurnService.abandon(turn.id, 'Karl message could not be recorded')
        throw new Error(karlMessageResult.reason)
      }
      karlMessageId = karlMessageResult.message.id
      unifiedTurnService.setKarlMessage(turn.id, karlMessageId)
      unifiedTurnService.markStage(turn.id, 'karl-recorded', 'complete', 'Recorded in the transcript')
      turn = unifiedTurnService.get(turn.id)!

      const discussion = discussionService.start({ topic: body, maxTurns: 6, participants: ['astra', 'nova'], isThreeWay: true })
      if (discussion.ok) {
        const advanced = discussionService.nextTurn()
        if (advanced.ok) unifiedTurnService.setDiscussion(turn.id, advanced.discussion.id)
      }
    }

    if (!karlMessageId) throw new Error('This turn has no recorded message')

    const discussionId = unifiedTurnService.get(turn.id)?.discussionId ?? discussionService.getActive()?.id
    if (!discussionId) throw new Error('No active discussion for this turn')

    try {
      // ---- Stage: astra-submitted / astra-responded ---------------------------
      // Skipped entirely on resume when Astra has already answered.
      const current = unifiedTurnService.get(turn.id)!
      if (current.stages['astra-responded'].status !== 'complete') {
        const guard = unifiedTurnService.guardSubmission(turn.id, 'astra-submitted')
        if (!guard.allowed) {
          sendStatus({ phase: 'needs-approval', detail: guard.reason })
          throw new Error(guard.reason)
        }

        sendStatus({ phase: 'awaiting-astra', detail: 'Sending to Astra…' })
        const astraResult = await sendToAstraAndWait(karlMessageId, discussionId, 120000, turn.id)

        if (astraResult.uncertain) {
          unifiedTurnService.markStage(turn.id, 'astra-submitted', 'uncertain', astraResult.error ?? 'Submission could not be confirmed')
          sendStatus({ phase: 'uncertain', detail: astraResult.error ?? 'Delivery to Astra is uncertain' })
          throw new Error(astraResult.error ?? 'Delivery to Astra is uncertain. Reconcile before resending.')
        }

        if (!astraResult.success || !astraResult.responseMessageId) {
          unifiedTurnService.markStage(turn.id, 'astra-submitted', 'failed', astraResult.error ?? 'Astra did not respond')
          sendStatus({ phase: 'error', detail: astraResult.error || 'Astra did not respond' })
          throw new Error(astraResult.error || 'Astra did not respond')
        }

        unifiedTurnService.markStage(turn.id, 'astra-submitted', 'complete', 'Prompt confirmed in Astra conversation')
        unifiedTurnService.setResponse(turn.id, 'astra', astraResult.responseMessageId)
        unifiedTurnService.markStage(turn.id, 'astra-responded', 'complete', 'Astra ruling captured')
      }

      // ---- Stage: nova-submitted ------------------------------------------------
      const afterAstra = unifiedTurnService.get(turn.id)!
      if (afterAstra.stages['nova-submitted'].status !== 'complete') {
        const novaGuard = unifiedTurnService.guardSubmission(turn.id, 'nova-submitted')
        if (!novaGuard.allowed) {
          sendStatus({ phase: 'needs-approval', detail: novaGuard.reason })
          throw new Error(novaGuard.reason)
        }

        sendStatus({ phase: 'nova-thinking', detail: 'Checking Nova chat connection…' })
        const blocker = novaPrerequisiteFailure(novaService.snapshot())
        if (blocker) {
          unifiedTurnService.markStage(turn.id, 'nova-submitted', 'failed', blocker)
          sendStatus({ phase: 'error', detail: blocker })
          throw new Error(blocker)
        }

        // Astra's answer is located by the turn's own record, not by scanning for whichever Astra
        // message happens to be newest. That scan was the bug: with two rulings in the thread it
        // selected the first one newer than Karl's prompt, which was not necessarily this turn's.
        const astraMessageId = unifiedTurnService.get(turn.id)?.astraResponseMessageId
        if (!astraMessageId) {
          unifiedTurnService.markStage(turn.id, 'nova-submitted', 'failed', 'Astra response could not be located')
          const missing = 'Could not locate Astra response for this turn'
          sendStatus({ phase: 'error', detail: missing })
          throw new Error(missing)
        }

        sendStatus({ phase: 'nova-thinking', detail: 'Sending to Nova…' })
        const novaResult = await sendToNova(astraMessageId, discussionId)
        if (novaResult.uncertain) {
          unifiedTurnService.markStage(turn.id, 'nova-submitted', 'uncertain', novaResult.error ?? 'Delivery to Nova is uncertain')
          sendStatus({ phase: 'uncertain', detail: novaResult.error ?? 'Delivery to Nova is uncertain. Astra’s response is preserved.' })
          throw new Error(novaResult.error ?? 'Delivery to Nova is uncertain. Astra’s response is preserved.')
        }
        if (!novaResult.success) {
          unifiedTurnService.markStage(turn.id, 'nova-submitted', 'failed', novaResult.error ?? 'Failed to send to Nova')
          sendStatus({ phase: 'error', detail: novaResult.error || 'Failed to send to Nova' })
          throw new Error(novaResult.error || 'Failed to send to Nova')
        }
        unifiedTurnService.markStage(turn.id, 'nova-submitted', 'complete', 'Nova accepted the prompt')
      }

      // ---- Stage: nova-responded / returned-to-karl ----------------------------
      // Nova's answer arrives asynchronously via recordNovaReplies, which completes these stages when
      // the genuine reply is observed. Nothing here advances past Nova on a promise.
      sendStatus({ phase: 'awaiting-nova', detail: 'Waiting for Nova’s reply…' })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      // An uncertain outcome already published its own, gentler status. Overwriting it with a flat
      // red "error" is what made a possibly-delivered message look definitively lost.
      const alreadyReported = unifiedTurnService.get(turn.id)?.stages
        && Object.values(unifiedTurnService.get(turn.id)!.stages).some((record) => record.status === 'uncertain')
      if (!alreadyReported) sendStatus({ phase: 'error', detail: errorMsg })
      throw error
    }
  })

  /**
   * Reconciles an uncertain submission against the conversation that seat actually receives it in.
   *
   * This is the only path that may clear an `uncertain` or `awaiting-approval` stage, and it cannot send
   * anything — it only reads. `accepted` means the prompt is demonstrably present, so the stage completes
   * and no resend follows. `absent` means no matching new message exists, so the send may safely be
   * retried. Anything else escalates to Karl rather than guessing.
   *
   * The seat is chosen from the stage that is genuinely blocking rather than hardcoded to Astra, because
   * a Nova delivery can fail the same way: `prompt_async` returns before OpenCode has committed the
   * message, so a network error there leaves Nova's history as the only evidence of what happened.
   */
  ipcMain.handle('unified:reconcile', async (event, turnId: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!unifiedTurnService || !conversationService) throw new Error('Required services unavailable')
    const turn = unifiedTurnService.get(turnId)
    if (!turn) throw new Error('No such turn')

    const stage = unifiedTurnService.blockedStage(turn.id)
    if (stage !== 'astra-submitted' && stage !== 'nova-submitted') {
      const reason = stage
        ? `${stage} is outstanding. Nothing can be reconciled automatically; cancel the turn to move on.`
        : 'There is nothing uncertain to reconcile.'
      return { observation: 'not-applicable' as const, reason }
    }

    // Astra receives Karl's prompt; Nova receives Astra's ruling. Whichever seat is blocking decides
    // which of those two texts has to be looked for.
    const sourceMessageId = stage === 'astra-submitted' ? turn.karlMessageId : turn.astraResponseMessageId
    const prompt = sourceMessageId
      ? conversationService.snapshot().find((entry) => entry.id === sourceMessageId)?.text
      : null
    if (!prompt) {
      return { observation: 'unresolvable' as const, reason: `The text that was sent to ${stage === 'astra-submitted' ? 'Astra' : 'Nova'} could not be located.` }
    }

    const wanted = fingerprintOf(prompt)
    let present: boolean
    if (stage === 'astra-submitted') {
      const view = views.get('astra')
      if (!view || view.webContents.isDestroyed()) throw new Error('Astra view not available')
      const probe = await probeAstra(view.webContents)
      if (!probe) return { observation: 'unresolvable' as const, reason: 'The Astra conversation could not be read.' }
      present = probe.userFingerprints.some((candidate) => candidate === wanted)
    } else {
      if (!novaService) return { observation: 'unresolvable' as const, reason: 'Nova chat is not available.' }
      // Nova's own session history is the record of what OpenCode actually accepted. This reads the
      // messages the service already fetched; it does not send, retry or resend anything.
      present = promptPresentInNovaHistory(novaService.snapshot().messages, prompt)
    }

    const observation = present ? 'accepted' as const : 'absent' as const
    unifiedTurnService.reconcile(
      turn.id,
      stage,
      observation,
      present
        ? `Prompt found in ${stage === 'astra-submitted' ? 'the ChatGPT thread' : "Nova's chat history"}`
        : `No matching prompt in ${stage === 'astra-submitted' ? 'the ChatGPT thread' : "Nova's chat history"}`
    )
    return { observation, turn: unifiedTurnService.get(turn.id) }
  })

  /**
   * Karl's explicit decision on a turn that reconciliation could not settle.
   *
   * `resend` is the only way to send again after an uncertain delivery, and it is deliberately a
   * separate, named, human-initiated action rather than something a retry path can fall into by
   * accident. `cancel` preserves the turn's record and abandons it.
   */
  ipcMain.handle('unified:resolveUncertain', (event, turnId: unknown, decision: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!unifiedTurnService) throw new Error('Required services unavailable')
    const turn = unifiedTurnService.get(turnId)
    if (!turn) throw new Error('No such turn')
    if (decision === 'resend') {
      // Approve whichever stage reconciliation left outstanding. Using the same accessor the refusal
      // uses means the button can never approve a different stage than the one it named.
      const stage = unifiedTurnService.blockedStage(turn.id) ?? 'astra-submitted'
      unifiedTurnService.approve(turn.id, stage, 'Karl approved a fresh submission')
      return unifiedTurnService.get(turn.id)
    }
    if (decision === 'cancel') {
      unifiedTurnService.abandon(turn.id, 'Cancelled by Karl')
      return unifiedTurnService.get(turn.id)
    }
    throw new Error('Unknown decision')
  })

  ipcMain.handle('unified:turnState', (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    return { active: unifiedTurnService?.active() ?? null, turns: unifiedTurnService?.snapshot() ?? [] }
  })

  ipcMain.handle('unified:cancelTurn', (event, turnId: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!unifiedTurnService) throw new Error('Required services unavailable')
    unifiedTurnService.abandon(turnId, 'Cancelled by Karl')
    return unifiedTurnService.get(turnId) ?? null
  })

  // Clipboard helpers. The clipboard is read ONLY on an explicit click of "Import Astra Reply", and
  // written only on an explicit copy action. Nothing here runs on a timer or on receipt of a message.
  ipcMain.handle('handoff:writeClipboard', (event, text: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('Nothing to copy')
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle('handoff:readClipboard', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    return (await clipboard.readText()).slice(0, 8000)
  })

  ipcMain.handle('handoff:copyForAstra', (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!handoffService || !conversationService) throw new Error('Handoffs are unavailable')
    const message = conversationService.snapshot().find((entry) => entry.id === id)
    if (!message) throw new Error('No such message')
    const prepared = handoffService.prepare('astra', message.id, 'Preparing a copy for Astra.')
    if (!prepared.ok) throw new Error(prepared.reason)
    clipboard.writeText(message.text)
    // Mark as prepared for Astra (clipboard delivery)
    conversationService.markDelivery(message.id, 'prepared-for-astra')
    handoffService.awaitingKarl(message.id, 'Copied to your clipboard. Paste it into ChatGPT and send it there, then press “I sent this in ChatGPT”.')
    return handoffService.snapshot()
  })

  ipcMain.handle('handoff:confirmAstraSent', (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!handoffService || !conversationService) throw new Error('Handoffs are unavailable')
    const result = conversationService.acknowledge(id)
    if (!result.ok) throw new Error(result.reason)
    handoffService.settle('You confirmed this was sent in ChatGPT.')
    return conversationService.snapshot()
  })

  ipcMain.handle('handoff:copyForTerminal', (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!handoffService || !conversationService) throw new Error('Handoffs are unavailable')
    const message = conversationService.snapshot().find((entry) => entry.id === id)
    if (!message) throw new Error('No such message')
    // Clipboard only. There is deliberately no path from this handler to the PTY: Karl pastes into
    // the terminal himself, which keeps the terminal's trust boundary exactly where M3.1 left it.
    clipboard.writeText(message.text)
    return { copied: true, notice: 'Copied. Paste it into the terminal yourself — NovaCourt never writes to a terminal.' }
  })

  ipcMain.handle('handoff:prepareForTerminal', (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService || !terminalService) throw new Error('Terminal preparation unavailable')
    const { messageId, mode } = input as { messageId: string; mode: 'opencode' | 'powershell' }
    const message = conversationService.snapshot().find((entry) => entry.id === messageId)
    if (!message) throw new Error('No such message')
    if (mode !== 'opencode' && mode !== 'powershell') throw new Error('Invalid terminal mode')
    // Check if the requested terminal mode is currently running
    const termState = terminalService.snapshot()
    if (termState.mode !== mode || termState.status !== 'running') {
      return { ok: false, reason: `${mode === 'opencode' ? 'OpenCode' : 'PowerShell'} terminal is not running. Start it first.` }
    }
    // Sanitize text for safe terminal preparation: replace newlines with spaces to prevent
    // accidental multi-command execution. The text is placed in the shell's input buffer
    // waiting for Karl to press Enter. It is NOT executed automatically.
    const sanitized = message.text.replace(/\r?\n/g, ' ').trim()
    if (!sanitized) {
      return { ok: false, reason: 'Message is empty after sanitization' }
    }
    // Write to the PTY - this places text in the shell's input line, NOT executing it.
    // The shell's line editor will display it and wait for Enter.
    terminalService.write(termState.id, sanitized)
    // Update delivery status
    const deliveryStatus = mode === 'opencode' ? 'prepared-for-opencode' : 'prepared-for-powershell'
    conversationService.markDelivery(message.id, deliveryStatus)
    return { ok: true, text: sanitized, deliveryStatus }
  })

  ipcMain.handle('handoff:prepareForAstra', (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!handoffService || !conversationService) throw new Error('Handoffs are unavailable')
    const message = conversationService.snapshot().find((entry) => entry.id === id)
    if (!message) throw new Error('No such message')
    // For Astra, we can only prepare via clipboard - Electron cannot safely inject into WebContentsView
    // without weakening security (no JS injection, no scraping, preserve sandbox)
    clipboard.writeText(message.text)
    conversationService.markDelivery(message.id, 'prepared-for-astra')
    handoffService.awaitingKarl(message.id, 'Prepared for Astra. Text is on your clipboard. Paste into ChatGPT and send manually.')
    return handoffService.snapshot()
  })

  ipcMain.handle('handoff:sendToNova', async (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!handoffService || !conversationService || !novaService) throw new Error('Handoffs are unavailable')
    const message = conversationService.snapshot().find((entry) => entry.id === id)
    if (!message) throw new Error('No such message')

    // This delegates to the one send path rather than re-implementing it. The handler previously had its
    // own copy of the logic, and the two had already drifted: the unified flow recorded an uncertain Nova
    // delivery as `delivery-unknown` while this handler recorded `unconfirmed` for the identical failure.
    // Two names for one state meant the transcript could not be reasoned about consistently.
    const discussionId = discussionService?.getActive()?.id ?? ''
    const result = await sendToNova(message.id, discussionId)
    if (!result.success) throw new Error(result.error ?? 'Could not send to Nova')
    return handoffService.snapshot()
  })

  ipcMain.handle('court:acknowledge', (event, id: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!conversationService) throw new Error('The conversation is unavailable')
    const result = conversationService.acknowledge(id)
    if (!result.ok) throw new Error(result.reason)
    return conversationService.snapshot()
  })
  ipcMain.handle('portrait:list', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return portraitService?.snapshot() })
  ipcMain.handle('portrait:image', (event, participant: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const found = portraitService?.read(participant)
    // Served as a data URL rather than a file:// path so the renderer never learns a filesystem
    // location and never gains a path it could resolve itself.
    return found ? `data:${found.record.mime};base64,${found.data.toString('base64')}` : null
  })
  ipcMain.handle('portrait:save', (event, participant: unknown, payload: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    const record = portraitService.save(participant, payload)
    const stored = portraitService.read(participant)
    return { ...record, url: stored ? `data:${record.mime};base64,${stored.data.toString('base64')}` : null }
  })
  ipcMain.handle('portrait:framing', (event, participant: unknown, framing: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    return portraitService.setFraming(participant, framing)
  })
  ipcMain.handle('portrait:reset', (event, participant: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    if (!portraitService) throw new Error('Portraits are unavailable')
    return portraitService.reset(participant)
  })
  ipcMain.handle('astra:readStatus', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return astraStatus })
  ipcMain.on('astra:retry', (event) => {
    if (!trustedSender(event)) return
    const view = views.get('astra')
    if (!view || view.webContents.isDestroyed()) return
    publishAstraStatus('loading', fixtureMode ? 'Loading local fixture' : 'Loading chatgpt.com')
    void view.webContents.loadURL(fixtureMode ? fixtureUrl : chatGptUrl)
  })
  ipcMain.handle('astra:paste', async (event) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const view = views.get('astra')
    if (!view || view.webContents.isDestroyed()) return { attempted: false, reason: 'Astra view not available', diagnostics: { viewExists: false } }
    const url = view.webContents.getURL()
    const isChatPage = url.startsWith('https://chatgpt.com/') && !url.includes('/auth/') && !url.includes('/login') && !url.includes('/signin')
    const webContentsFocused = view.webContents.isFocused()
    const mainWindowFocused = mainWindow?.isFocused() ?? false
    const viewVisible = attached
    const clipboardText = await clipboard.readText()
    const diagnostics: Record<string, unknown> = {
      url,
      isChatPage,
      webContentsFocusedBefore: webContentsFocused,
      mainWindowFocused,
      viewVisible,
      viewBounds: lastBounds,
      clipboardTextLength: clipboardText.length,
    }
    if (!isChatPage) {
      return { attempted: false, reason: 'Astra is not on the ChatGPT chat page (sign-in or unexpected navigation)', diagnostics }
    }
    try {
      const focusResult = view.webContents.focus()
      const focusedAfter = view.webContents.isFocused()
      diagnostics.webContentsFocusedAfter = focusedAfter
      diagnostics.focusCallResult = focusResult
      await new Promise((resolve) => setTimeout(resolve, 500))
      const focusedAfterWait = view.webContents.isFocused()
      diagnostics.webContentsFocusedAfterWait = focusedAfterWait
      // Attempt to click the center of the view to focus the ChatGPT editor
      if (lastBounds && lastBounds.width > 0 && lastBounds.height > 0) {
        const clickX = Math.round(lastBounds.width / 2)
        const clickY = Math.round(lastBounds.height / 2)
        diagnostics.clickAttempted = true
        diagnostics.clickCoordinates = { x: clickX, y: clickY }
        view.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1, modifiers: [] })
        await new Promise((resolve) => setTimeout(resolve, 50))
        view.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1, modifiers: [] })
        await new Promise((resolve) => setTimeout(resolve, 100))
        diagnostics.webContentsFocusedAfterClick = view.webContents.isFocused()
      } else {
        diagnostics.clickAttempted = false
        diagnostics.clickReason = 'No valid view bounds'
      }
      // Use Electron's native paste() method instead of synthetic Ctrl+V key events
      // This uses the proper editing command and may be more reliable
      const pasteResult = view.webContents.paste()
      diagnostics.pasteMethod = 'webContents.paste()'
      diagnostics.pasteCallResult = pasteResult
      return { attempted: true, reason: 'Paste command dispatched via webContents.paste()', diagnostics }
    } catch (error) {
      diagnostics.error = error instanceof Error ? error.message : String(error)
      return { attempted: false, reason: error instanceof Error ? error.message : String(error), diagnostics }
    }
  })

  /**
   * Sends a message to Astra (ChatGPT) and waits for the complete response.
   * Delegates to the internal sendToAstraAndWait function for the actual work.
   */
  ipcMain.handle('astra:sendAndWait', async (event, input: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted sender')
    const { messageId, timeoutMs = 120000, discussionId } = input as { messageId: string; timeoutMs?: number; discussionId?: string }
    // Bounded rather than trusted: an unvalidated caller value must not be able to ask for a wait of any
    // length it likes, and the wait is a courtesy ceiling on a remote site rather than a correctness knob.
    const responseTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.max(1000, Math.min(timeoutMs, 300000))
      : 120000
    
    if (!conversationService || !handoffService) {
      return { success: false, reason: 'Services unavailable', response: null, diagnostics: {} }
    }
    
    const message = conversationService.snapshot().find((m) => m.id === messageId)
    if (!message) {
      return { success: false, reason: 'Message not found', response: null, diagnostics: {} }
    }
    
    const targetDiscussionId = discussionId || discussionService?.getActive()?.id
    if (!targetDiscussionId) {
      return { success: false, reason: 'No active discussion', response: null, diagnostics: {} }
    }
    
    // The caller's timeout is honoured rather than replaced by a hardcoded one. It was previously
    // accepted on the IPC surface and then discarded, so a caller asking for a five second wait sat
    // through two minutes, which is indistinguishable from the detector hanging.
    const result = await sendToAstraAndWait(messageId, targetDiscussionId, responseTimeout)
    
    if (result.success) {
      return { success: true, reason: 'Astra responded successfully', response: result.response, diagnostics: result.diagnostics || {}, messageId: messageId }
    } else {
      return { success: false, reason: result.error || 'Unknown error', response: null, diagnostics: result.diagnostics || {} }
    }
  })
  
  if (process.env.NC_V2_TEST === '1') ipcMain.handle('test:viewBounds', (event) => { if (!trustedSender(event)) throw new Error('Untrusted sender'); return { bounds: lastBounds, attached, registered: views.has('astra') } })

  if (process.env.NC_V2_TEST === '1') {
    /**
     * Evaluates a script inside the Astra view, for tests only.
     *
     * This exists because the detector reads a page that cannot be reached any other way offline. It is
     * registered only under NC_V2_TEST, requires the same sender check as every other handler, and is
     * restricted to the fixture page — in a normal build the handler does not exist, and in a test build
     * against the live site it refuses. Without the last restriction it would be a way to run arbitrary
     * script in a webContentsView holding a live session, which is exactly the kind of capability the
     * rest of this file is careful not to create.
     */
    ipcMain.handle('test:astraEval', async (event, script: unknown) => {
      if (!trustedSender(event)) throw new Error('Untrusted sender')
      if (!conversationFixtureMode) throw new Error('Script evaluation is only available against the conversation fixture')
      const view = views.get('astra')
      if (!view || view.webContents.isDestroyed()) throw new Error('Astra view not available')
      const url = view.webContents.getURL()
      if (!url.includes('astra-conversation-fixture.html')) throw new Error('Astra view is not on the conversation fixture')
      if (typeof script !== 'string' || !script.trim() || script.length > 20000) throw new Error('Invalid script')
      return await view.webContents.executeJavaScript(script, true)
    })

    /** Reads the Astra view through the real detector probe, so tests observe what the detector sees. */
    ipcMain.handle('test:astraProbe', async (event) => {
      if (!trustedSender(event)) throw new Error('Untrusted sender')
      if (!conversationFixtureMode) throw new Error('Probing is only available against the conversation fixture')
      const view = views.get('astra')
      if (!view || view.webContents.isDestroyed()) throw new Error('Astra view not available')
      const probe = await probeAstra(view.webContents)
      if (!probe) throw new Error('The Astra view could not be read')
      return { ...probe, keys: Array.from(probe.messages, (message) => message.key) }
    })
  }

  window.on('resize', () => window.webContents.send('window:resize'))
  window.on('close', () => updateAstra({ visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, zoom: 1 }))
  window.on('closed', () => {
    terminalService?.close()
    terminalService = null
    portraitService?.close()
    portraitService = null
    conversationService?.close()
    conversationService = null
    handoffService?.close()
    handoffService = null
    discussionService?.close()
    discussionService = null
    unifiedTurnService?.close()
    unifiedTurnService = null
    novaService?.close()
    novaService = null
    for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
    views.clear()
    mainWindow = null
  })
  window.once('ready-to-show', () => window.show())
  if (process.env.NC_V2_DEV_URL) void window.loadURL(process.env.NC_V2_DEV_URL)
  else if (existsSync(resolve(__dirname, '../dist/index.html'))) void window.loadFile(resolve(__dirname, '../dist/index.html'))
  else throw new Error('Renderer build missing. Run npm run build before npm start.')
  void novaService.connect()
}

/**
 * The application menu.
 *
 * `Menu.setApplicationMenu(null)` removed every standard editing role, which is what registers
 * Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+A as real application accelerators and gives the user a visible
 * Edit ▸ Copy / Paste fallback. Without it, the renderer had no accelerator-backed editing command
 * to fall back on, and xterm's DOM-level `copy` / `paste` listeners had nothing to drive them.
 *
 * The menu is intentionally minimal: Edit only, with the stock roles and no accelerators of our
 * own, so Electron installs exactly its standard bindings. Nothing here is a custom command, so
 * nothing here can be used to reach the terminal, OpenCode, or any privileged surface — the
 * renderer bridge and its sender checks remain the only way to call into the main process.
 */
function applicationMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ])
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(applicationMenu())
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
