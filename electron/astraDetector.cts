/**
 * Astra's response detector.
 *
 * This module exists because the detector was previously two large inline script strings buried in
 * `main.cts`, which meant it could not be tested at all: the only way to exercise it was to point the
 * app at the live ChatGPT site and hope. Everything that decides "is Astra finished, and is this
 * message actually new?" now lives here as plain functions over plain data, so it can be tested
 * offline against fixtures, including the cases that are impossible to reproduce on demand against a
 * real site (a legitimately empty baseline, a response that never arrives, a response that streams).
 *
 * Two rules are enforced structurally rather than by convention, because both were real bugs:
 *
 *   1. Newness is decided by POSITION and identity, never by content alone. ChatGPT streams text in,
 *      so a response's text changes while it is being written; any detector that identifies messages
 *      by their content loses track of the message it is watching. Baseline entries are therefore
 *      keyed by `data-message-id` when the site provides one, and by their index in the thread when it
 *      does not. A message at an index below the baseline count is an old message, always.
 *
 *   2. Completion is decided from signals scoped to the message being watched. An earlier version
 *      asked the whole page whether *anything* looked like it was animating, using class substrings
 *      such as `cursor` and `blink`. ChatGPT's composer keeps a caret element permanently, so that
 *      test was true forever, "complete" was never satisfied, and the wait always ran to its timeout
 *      and reported no response. Scoping to the watched message removes the latch.
 */

/**
 * Selectors that locate an assistant message. Ordered most-specific first; the probe tries each and
 * de-duplicates the elements, so a message matched by several selectors is only counted once.
 *
 * `data-message-author-role` is ChatGPT's own attribute and is the primary signal. The class-based
 * entries are fallbacks for when that attribute is absent, and the `:has()` entries locate the
 * wrapper that carries the per-message action bar (regenerate/copy), which lives outside the message
 * element itself.
 */
export const ASTRA_MESSAGE_SELECTORS: readonly string[] = [
  '[data-message-author-role="assistant"]',
  'article[data-message-author-role="assistant"]',
  'div[class*="message"][class*="assistant"]',
  'div[class*="Message"][class*="assistant"]',
  'div[class*="group"][class*="w-full"]:has([data-message-author-role="assistant"])',
  'article:has([data-message-author-role="assistant"])',
  '[data-testid*="assistant"]'
]

/**
 * Regions that contain the message composer. Streaming evidence found inside one of these belongs to
 * the caret or to UI chrome, not to a generated response, so it must never be read as "still
 * streaming" — that mistake is the one described in rule 2 above.
 */
export const ASTRA_COMPOSER_SELECTORS: readonly string[] = [
  '#composer',
  // The live site's own composer. It is a plain textarea, not the contenteditable the older markup used,
  // and it carries an `id` rather than a `data-testid`.
  'form:has(textarea#prompt-textarea)',
  'form:has(textarea[id$="-composer-prompt"])',
  'form:has(textarea[placeholder])',
  'form',
  'footer',
  '[data-testid="composer"]',
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  'textarea[placeholder]'
]

/**
 * Controls that mean "a response is still being generated". These are checked for existence rather
 * than for class substrings, because a real control has a stable, intentional identity whereas a
 * substring match also catches decoration.
 */
export const ASTRA_STOP_SELECTORS: readonly string[] = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop response"]'
]

/** Controls that mean "generation for this message has finished". */
export const ASTRA_REGENERATE_SELECTORS: readonly string[] = [
  'button[aria-label="Regenerate response"]',
  'button[aria-label="Regenerate"]',
  '[data-testid="regenerate-button"]'
]

/** Containers that hold the generated text, tried in order so UI chrome is not mistaken for prose. */
export const ASTRA_PROSE_SELECTORS: readonly string[] = [
  '.markdown',
  '.prose',
  '[class*="markdown"]',
  '[class*="prose"]'
]

/** Affordances meaning "this message is still being produced", scoped to the message. */
const ASTRA_THINKING_SELECTORS: readonly string[] = [
  '[data-testid*="thinking"]',
  '[aria-label*="Thinking"]',
  '.thinking-indicator',
  '[class*="reasoning"]'
]

/**
 * How many consecutive polls the response text must be unchanged before it is accepted as final.
 *
 * This is the LAST resort, not the primary signal, and it is deliberately slow. It used to be 2 polls at
 * 500ms — about one second — which meant any pause in generation long enough to outlast two polls was
 * read as "finished", and a half-written sentence was recorded as a complete ruling. A model pausing
 * mid-thought, or a network stall while it composes a long paragraph, looks exactly like that.
 *
 * Six polls at 500ms is three seconds of genuine quiet, which a mid-generation pause does not sustain
 * while the caret is still present — and the caret check is what actually enforces that. This window
 * exists only for sites that offer no completion affordance at all.
 */
export const ASTRA_STABLE_POLLS_REQUIRED = 6

/** Wall-clock floor for the stability fallback, independent of how often we happen to poll. */
export const ASTRA_MIN_STABLE_MS = 3000

/**
 * Per-message evidence that this message is still being written.
 *
 * These attributes are scoped to the message being watched, never the page, so a caret or toolbar
 * elsewhere cannot keep a finished reply looking unfinished — and, more importantly, so the absence of
 * one is evidence about *this* reply rather than about the page.
 */
const ASTRA_STREAMING_SELECTORS: readonly string[] = [
  '[data-message-model-slug][data-streaming]',
  '.result-streaming',
  '[data-testid*="streaming"]',
  '.markdown.streaming',
  '[data-is-streaming="true"]',
  '[data-streaming="true"]'
]

export type AstraObservedMessage = {
  /** Stable identity when the site provides one; otherwise a content-derived key. */
  key: string
  /** Position in the thread, in document order. Newness is decided from this. */
  index: number
  text: string
  fingerprint: string
  hasRegenerate: boolean
  isStreaming: boolean
  /**
   * True while a stop control is present on this message specifically.
   *
   * The page-level stop control is a weaker signal than it looks: on a page with several messages, one
   * of them generating keeps the control present for all of them. Per-message scoping is what lets a
   * finished earlier reply be recognised as finished while a later one is still streaming.
   */
  hasStopControl: boolean
  /** True while the message's prose still carries a blinking or animating caret. */
  hasCaret: boolean
  /** True when the message carries its own "still working" affordance, such as a thinking indicator. */
  hasThinkingIndicator: boolean
}

export type AstraProbe = {
  messages: AstraObservedMessage[]
  /** How many elements each selector matched. Logged so a selector that stops matching is visible. */
  selectorCounts: Record<string, number>
  /** Count of composer regions, to prove streaming evidence is being scoped away from the caret. */
  composerCount: number
  /** True while a stop control is present, meaning generation is genuinely in progress. */
  stopControlPresent: boolean
  /** Fingerprints of user messages currently in the thread, used to confirm the prompt was sent. */
  userFingerprints: string[]
  /**
   * How many user message elements are in the thread, including any with no readable text.
   *
   * Counting rather than inferring from `userFingerprints` is what lets a repeated identical prompt be
   * recognised as a new arrival: two messages with the same text have the same fingerprint, so only a
   * count can tell the second one apart from the first.
   */
  userMessageCount: number
  /** False when the page does not look like a loaded conversation at all. */
  threadReady: boolean
}

export type AstraBaselineEntry = { key: string; text: string; fingerprint: string; index: number }

export type AstraBaseline = {
  count: number
  keys: Set<string>
  fingerprints: Set<string>
}

export type AstraRejectionReason = 'known-key' | 'known-position' | 'known-fingerprint'

export type AstraClassification = {
  /** New messages, in document order. */
  fresh: AstraObservedMessage[]
  /** Messages that were present before the send, with the rule that identified each one. */
  rejected: { key: string; index: number; reason: AstraRejectionReason }[]
}

/** Collapses whitespace and case so that re-wrapped text compares equal to itself. */
export function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function fingerprintOf(text: string): string {
  return normaliseText(text).slice(0, 200)
}

/**
 * Records what was already in the thread before the prompt was sent. An empty thread produces an
 * empty baseline with `count: 0`, which is a legitimate state and not an error: every message seen
 * afterwards is then new, which is exactly right for the first exchange of a conversation.
 */
export function buildBaseline(probe: AstraProbe): AstraBaseline {
  return {
    count: probe.messages.length,
    keys: new Set(probe.messages.map((message) => message.key)),
    fingerprints: new Set(probe.messages.map((message) => message.fingerprint).filter((value) => value.length > 0))
  }
}

/**
 * Splits observed messages into those that were already present and those that arrived after the send.
 *
 * The checks run strongest-first. Identity beats position because a site-provided id survives
 * re-rendering, which React does constantly. Position beats content because streaming changes content
 * under us. Content is only consulted as a last resort and only for messages long enough that a
 * coincidental match is implausible, so that two short identical replies are not collapsed into one.
 */
export function classifyMessages(probe: AstraProbe, baseline: AstraBaseline): AstraClassification {
  const fresh: AstraObservedMessage[] = []
  const rejected: AstraClassification['rejected'] = []

  for (const message of probe.messages) {
    if (baseline.keys.has(message.key)) {
      rejected.push({ key: message.key, index: message.index, reason: 'known-key' })
      continue
    }
    if (message.index < baseline.count) {
      rejected.push({ key: message.key, index: message.index, reason: 'known-position' })
      continue
    }
    if (message.fingerprint.length > 20 && baseline.fingerprints.has(message.fingerprint)) {
      rejected.push({ key: message.key, index: message.index, reason: 'known-fingerprint' })
      continue
    }
    fresh.push(message)
  }

  return { fresh, rejected }
}

export type AstraCandidateResult =
  | { found: true; candidate: AstraObservedMessage; freshCount: number }
  | { found: false; reason: 'thread-not-ready' | 'no-assistant-messages' | 'all-messages-known'; observedCount: number }

/**
 * Chooses the response to follow. When more than one message is new the last in document order wins,
 * because a reply is the most recent thing added to the thread. This is deliberately a positional
 * choice: the previous implementation sorted candidates by their content hash and took the last, which
 * ordered messages by an arbitrary hash value rather than by when they were written.
 *
 * No content filtering happens here. An earlier version rejected any response containing the word
 * "chatgpt", on the theory that it was reading UI chrome — which meant Astra's own ruling in this very
 * case, and any legitimate reply mentioning the site, was silently thrown away.
 */
export function pickCandidate(probe: AstraProbe, baseline: AstraBaseline): AstraCandidateResult {
  if (!probe.threadReady) return { found: false, reason: 'thread-not-ready', observedCount: 0 }
  if (probe.messages.length === 0) return { found: false, reason: 'no-assistant-messages', observedCount: 0 }
  const { fresh } = classifyMessages(probe, baseline)
  if (fresh.length === 0) return { found: false, reason: 'all-messages-known', observedCount: probe.messages.length }
  return { found: true, candidate: fresh[fresh.length - 1], freshCount: fresh.length }
}

export type AstraCompletion = { complete: boolean; signal: string }

/**
 * Decides whether the watched message is finished.
 *
 * The ordering matters, and it is the whole point of the change. Generation-in-progress evidence is
 * checked first and always wins, so a response that merely *looks* idle while it is still being written
 * cannot be accepted:
 *
 *   1. A stop control, page-wide or scoped to this message, means the site is generating. Always wins.
 *   2. Streaming attributes on the message itself mean the site says this one is being written.
 *   3. A caret inside the message means the text has not settled. This is the check that actually
 *      prevents premature advancement: a generation pause is brief and the caret is present throughout
 *      it, whereas a finished reply has no caret in its prose at all.
 *   4. A "thinking" affordance on the message means the site has not finished producing it.
 *
 * Only once none of those hold does the signal become positive, and then the *reliable* one is preferred:
 * a regenerate button is the site stating that this response is complete.
 *
 * Text stability is the last fallback, for sites that provide no affordance whatsoever. It is gated on
 * three things at once — a minimum number of unchanged polls, a minimum wall-clock duration, and the
 * absence of any live caret — so that a momentary pause cannot pass for completion.
 */
export function evaluateCompletion(
  candidate: AstraObservedMessage,
  probe: AstraProbe,
  unchangedPolls: number,
  requiredStablePolls: number = ASTRA_STABLE_POLLS_REQUIRED,
  stableForMs: number = 0,
  minStableMs: number = ASTRA_MIN_STABLE_MS
): AstraCompletion {
  // --- Evidence that generation is still under way. Any of these vetoes completion outright. ---
  if (candidate.hasStopControl) return { complete: false, signal: 'message-stop-control' }
  if (probe.stopControlPresent) return { complete: false, signal: 'stop-control-present' }
  if (candidate.isStreaming) return { complete: false, signal: 'message-streaming' }
  if (candidate.hasCaret) return { complete: false, signal: 'message-caret-present' }
  if (candidate.hasThinkingIndicator) return { complete: false, signal: 'message-thinking-indicator' }

  // --- Positive, site-provided signal. Preferred. ---
  if (candidate.hasRegenerate) return { complete: true, signal: 'regenerate-button' }

  // --- Last-resort fallback, gated on duration as well as poll count. ---
  if (unchangedPolls >= requiredStablePolls && stableForMs >= minStableMs) {
    return { complete: true, signal: 'content-stable' }
  }
  if (unchangedPolls > 0) return { complete: false, signal: 'awaiting-stability' }
  return { complete: false, signal: 'awaiting-first-stability' }
}

/**
 * What was in the thread before the prompt was submitted.
 *
 * Both halves are needed. Fingerprints alone cannot tell "this exact text was already here" from "the
 * same text was sent again": identical prompts in the same thread are indistinguishable by content, so
 * a count is kept as well. That is the same position-over-content rule the assistant-message detector
 * already relies on, applied to user messages.
 */
export type UserBaseline = { fingerprints: Set<string>; count: number }

/**
 * Captures the user messages currently in the thread.
 *
 * Submission confirmation is decided against this baseline rather than against the thread's history.
 * The previous implementation searched every user message ever sent and accepted a substring match,
 * which meant a message could be "confirmed" by text Karl had sent in an entirely different turn, and
 * a prompt shorter than eight characters could never be confirmed at all. Comparing against a baseline
 * makes the test a statement about *this* submission: either a new matching user message appeared
 * after the baseline was taken, or it did not.
 */
export function captureUserBaseline(probe: AstraProbe): UserBaseline {
  const fingerprints = probe.userFingerprints.filter((value) => value.length > 0)
  // The count is taken from the page when it provides one, so that user messages with no text — a
  // placeholder, a failed send — still register as "the thread grew" rather than being invisible.
  const count = Number.isFinite(probe.userMessageCount) ? probe.userMessageCount : fingerprints.length
  return { fingerprints: new Set(fingerprints), count }
}

/** Counts user messages that appeared after the baseline was taken. */
export function countNewUserMessages(probe: AstraProbe, baseline: UserBaseline): number {
  const fingerprints = probe.userFingerprints.filter((value) => value.length > 0)
  const observed = Number.isFinite(probe.userMessageCount) ? probe.userMessageCount : fingerprints.length
  return Math.max(0, observed - baseline.count)
}

export type SubmissionVerdict =
  | { confirmed: true; observedNewUserMessages: number; matchedBy: 'new-text' | 'new-position' }
  | { confirmed: false; observedNewUserMessages: number }

/**
 * Decides whether a genuinely new user message matching `sentText` has appeared since the baseline.
 *
 * Three properties matter more than anything else here, and all three were real bugs:
 *
 *   1. Only messages absent from the baseline count. A historical message with identical text is not
 *      evidence that this submission arrived, so identical prompts in different turns each confirm
 *      independently instead of the first one confirming every later send forever.
 *
 *   2. No minimum length and no substring matching. "OK" and "Yes" are legitimate prompts and must
 *      confirm; conversely a prompt must not be confirmed because some older, unrelated bubble merely
 *      contains its first few characters. Exact fingerprint equality is the only content test.
 *
 *   3. A new position can confirm a repeated text. When Karl sends the same wording twice, the second
 *      send produces a user message with a fingerprint already in the baseline, so content alone would
 *      report it as undelivered — and a retry would then deliver it a third time. If the thread has
 *      grown since the baseline and its newest message matches, that is the repeat arriving.
 */
export function confirmSubmittedWithBaseline(
  sentText: string,
  probe: AstraProbe,
  baseline: UserBaseline
): SubmissionVerdict {
  const wanted = fingerprintOf(sentText)
  const observedNewUserMessages = countNewUserMessages(probe, baseline)

  if (!wanted) return { confirmed: false, observedNewUserMessages }

  for (const candidate of probe.userFingerprints) {
    if (candidate && !baseline.fingerprints.has(candidate) && candidate === wanted) {
      return { confirmed: true, observedNewUserMessages, matchedBy: 'new-text' }
    }
  }

  // The prompt is already in the thread's history, so only a *new* arrival of it can be this
  // submission. Require the thread to have grown, and require the newest message to be ours.
  if (baseline.fingerprints.has(wanted) && observedNewUserMessages > 0) {
    const newest = probe.userFingerprints.filter((value) => value.length > 0).at(-1)
    if (newest === wanted) return { confirmed: true, observedNewUserMessages, matchedBy: 'new-position' }
  }

  return { confirmed: false, observedNewUserMessages }
}

/**
 * Legacy confirmation, retained only so existing callers and tests still compile.
 *
 * It is still history-based substring matching and must not be used by a new send path. Send paths
 * call `captureUserBaseline` once before submitting, then `confirmSubmittedWithBaseline` on each poll.
 */
export function confirmSubmitted(sentText: string, probe: AstraProbe): boolean {
  const wanted = fingerprintOf(sentText)
  if (wanted.length < 8) return false

  const head = wanted.slice(0, 60)
  return probe.userFingerprints.some((candidate) => {
    if (!candidate) return false
    if (candidate === wanted) return true
    if (candidate.includes(head)) return true
    return candidate.length >= 8 && head.includes(candidate)
  })
}

/**
 * Coerces whatever the page returned into a well-formed probe.
 *
 * The value crossing this boundary came out of `executeJavaScript` on a remote site, so it is
 * untrusted in the ordinary sense: it may be malformed, partially populated, or not an object at all.
 * Parsing defensively means a surprise in the page degrades to "nothing observed yet" instead of
 * throwing inside the polling loop, which would otherwise be indistinguishable from a detector bug.
 *
 * Positions are re-densified on the way in. If the page skips an index, or omits an empty message,
 * every later message would appear shifted relative to the baseline and the whole comparison would be
 * wrong, so indices are assigned from the array itself rather than trusted from the page.
 */
export function parseAstraProbe(raw: unknown): AstraProbe {
  const empty: AstraProbe = {
    messages: [],
    selectorCounts: {},
    composerCount: 0,
    stopControlPresent: false,
    userFingerprints: [],
    userMessageCount: 0,
    threadReady: false
  }
  if (!raw || typeof raw !== 'object') return empty
  const input = raw as Record<string, unknown>

  const messages: AstraObservedMessage[] = []
  if (Array.isArray(input.messages)) {
    for (const entry of input.messages) {
      if (!entry || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text.trim()) continue
      const fingerprint = typeof item.fingerprint === 'string' && item.fingerprint ? item.fingerprint : fingerprintOf(text)
      const key = typeof item.key === 'string' && item.key ? item.key : `derived-${fingerprint.slice(0, 60)}-${messages.length}`
      messages.push({
        key,
        index: messages.length,
        text,
        fingerprint,
        // Every per-message completion signal defaults to false rather than true when the page omits it,
        // so a site that reports nothing extra behaves as "no evidence of streaming" and falls through
        // to the stability window, exactly as before this change.
        hasRegenerate: item.hasRegenerate === true,
        isStreaming: item.isStreaming === true,
        hasStopControl: item.hasStopControl === true,
        hasCaret: item.hasCaret === true,
        hasThinkingIndicator: item.hasThinkingIndicator === true
      })
    }
  }

  const selectorCounts: Record<string, number> = {}
  if (input.selectorCounts && typeof input.selectorCounts === 'object') {
    for (const [name, count] of Object.entries(input.selectorCounts as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) selectorCounts[name] = count
    }
  }

  const userFingerprints = Array.isArray(input.userFingerprints)
    ? input.userFingerprints.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []

  return {
    messages,
    selectorCounts,
    composerCount: typeof input.composerCount === 'number' && Number.isFinite(input.composerCount) ? input.composerCount : 0,
    stopControlPresent: input.stopControlPresent === true,
    userFingerprints,
    userMessageCount: typeof input.userMessageCount === 'number' && Number.isFinite(input.userMessageCount)
      ? Math.max(0, Math.floor(input.userMessageCount))
      : userFingerprints.length,
    threadReady: input.threadReady === true
  }
}

/**
 * Locates the message composer and reports where to click to focus it.
 *
 * The send path used to click the centre of the view and hope that focus landed in the input. ChatGPT's
 * composer sits along the bottom of the window, so that click lands on the conversation, not the
 * prompt — the paste then goes nowhere, Enter does nothing, and the turn hangs with no error anywhere.
 * Asking the page where its input is removes the guess.
 *
 * Returns the target in CSS pixels relative to the view, which is the coordinate space
 * `sendInputEvent` expects.
 */
export function buildAstraComposerFocusScript(): string {
  return `
(function() {
  var COMPOSER = ${JSON.stringify(ASTRA_COMPOSER_SELECTORS)};
  for (var i = 0; i < COMPOSER.length; i += 1) {
    var element;
    try {
      element = document.querySelector(COMPOSER[i]);
    } catch (error) {
      continue;
    }
    if (!element) continue;

    /**
     * Choose the editable Karl can actually type into.
     *
     * The obvious \`querySelector('[contenteditable], textarea, input')\` is wrong on the live site: the
     * composer form contains hidden inputs (tracking, voice, file) that come first in document order, so
     * the first match was an input with a 0x0 rect. The click was then aimed at the top-left corner of
     * the view, the paste went nowhere, and submission could never be confirmed. Candidates are therefore
     * ranked by whether they are actually visible, and only a visible one is accepted.
     */
    function pickEditable(scope) {
      var nodes;
      try {
        nodes = Array.prototype.slice.call(scope.querySelectorAll('[contenteditable="true"], textarea, input'));
      } catch (error) {
        return scope;
      }
      var best = null;
      var bestArea = 0;
      for (var n = 0; n < nodes.length; n += 1) {
        var node = nodes[n];
        var rect;
        try { rect = node.getBoundingClientRect(); } catch (error) { continue; }
        // A disabled or hidden control cannot receive a paste either.
        if (node.disabled || node.getAttribute('aria-hidden') === 'true') continue;
        var style = null;
        try { style = window.getComputedStyle(node); } catch (error) { /* keep going */ }
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
        var area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = node; }
      }
      // Nothing visible inside the matched element: use it itself rather than an invisible descendant.
      return best || scope;
    }

    var editable = pickEditable(element);
    var active = document.activeElement;
    var alreadyFocused = !!active && (element.contains(active) || active === editable);

    var rect = editable.getBoundingClientRect();
    return {
      found: true,
      selector: COMPOSER[i],
      alreadyFocused: alreadyFocused,
      editableTag: editable.tagName ? editable.tagName.toLowerCase() : null,
      editableArea: Math.round(rect.width * rect.height),
      rect: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }
  return { found: false, selector: null, alreadyFocused: false, rect: null };
})()
`
}

export type AstraComposerTarget = {
  found: boolean
  selector: string | null
  alreadyFocused: boolean
  rect: { x: number; y: number; width: number; height: number } | null
  /** Tag of the control the click lands on. Reported so a zero-area target is visible in the log. */
  editableTag: string | null
  editableArea: number
}

/** Reads the composer location, tolerating a page that returns something unexpected. */
export function parseAstraComposerTarget(raw: unknown): AstraComposerTarget {
  const empty: AstraComposerTarget = { found: false, selector: null, alreadyFocused: false, rect: null, editableTag: null, editableArea: 0 }
  if (!raw || typeof raw !== 'object') return empty
  const input = raw as Record<string, unknown>
  const rect = input.rect
  if (!rect || typeof rect !== 'object') return { ...empty, found: input.found === true, selector: typeof input.selector === 'string' ? input.selector : null, alreadyFocused: input.alreadyFocused === true }
  const box = rect as Record<string, unknown>
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    found: input.found === true,
    selector: typeof input.selector === 'string' ? input.selector : null,
    alreadyFocused: input.alreadyFocused === true,
    rect: { x: numeric(box.x), y: numeric(box.y), width: numeric(box.width), height: numeric(box.height) },
    editableTag: typeof input.editableTag === 'string' ? input.editableTag : null,
    editableArea: numeric(input.editableArea)
  }
}

/**
 * Keeps a click inside the view.
 *
 * `sendInputEvent` coordinates outside the view's own size are delivered nowhere useful, and a
 * composer that has scrolled partly off-screen would otherwise produce an off-view click. Clamping
 * here means a reported position can never turn into a click on nothing.
 */
export function clampToViewport(point: { x: number; y: number }, viewport: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(Math.round(viewport.width), Math.round(point.x))),
    y: Math.max(0, Math.min(Math.round(viewport.height), Math.round(point.y)))
  }
}

/**
 * The script injected into the Astra view.
 *
 * It performs no DOM writes and reads only within the page it is already executing in; it returns
 * observations as JSON. Keeping it as one shared builder means baseline capture and the wait loop can
 * no longer drift apart, which they had: capture knew about five more selectors than the wait did, so
 * a message could be in the baseline and be invisible to the detector, or vice versa.
 */
export function buildAstraProbeScript(): string {
  return `
(function() {
  var SELECTORS = ${JSON.stringify(ASTRA_MESSAGE_SELECTORS)};
  var COMPOSER = ${JSON.stringify(ASTRA_COMPOSER_SELECTORS)};
  var STOP = ${JSON.stringify(ASTRA_STOP_SELECTORS)};
  var REGENERATE = ${JSON.stringify(ASTRA_REGENERATE_SELECTORS)};
  var PROSE = ${JSON.stringify(ASTRA_PROSE_SELECTORS)};
  var STREAMING = ${JSON.stringify(ASTRA_STREAMING_SELECTORS)};
  var THINKING = ${JSON.stringify(ASTRA_THINKING_SELECTORS)};

  // The action bar and per-message affordances often live on a wrapper rather than inside the message
  // element itself, so they are looked up on both.
  function wrapperOf(node) {
    try { return node.closest('.group, [data-message-id]') || node; } catch (error) { return node; }
  }

  function norm(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  function fingerprint(value) {
    return norm(value).slice(0, 200);
  }

  function insideComposer(element) {
    for (var i = 0; i < COMPOSER.length; i += 1) {
      try {
        if (element.closest && element.closest(COMPOSER[i])) return true;
      } catch (error) { /* A selector the engine rejects must not abort the whole probe. */ }
    }
    return false;
  }

  function hasControl(scope, selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      try {
        if (scope && scope.querySelector && scope.querySelector(selectors[i])) return true;
      } catch (error) { /* As above. */ }
    }
    return false;
  }

  function textOf(element) {
    for (var i = 0; i < PROSE.length; i += 1) {
      try {
        var prose = element.querySelector(PROSE[i]);
        if (prose && prose.innerText && prose.innerText.trim()) return prose.innerText.trim();
      } catch (error) { /* As above. */ }
    }
    return (element.innerText || '').trim();
  }

  var selectorCounts = {};
  var seen = [];
  var ordered = [];

  for (var s = 0; s < SELECTORS.length; s += 1) {
    var found;
    try {
      found = document.querySelectorAll(SELECTORS[s]);
    } catch (error) {
      selectorCounts[SELECTORS[s]] = -1;
      continue;
    }
    selectorCounts[SELECTORS[s]] = found.length;
    for (var e = 0; e < found.length; e += 1) {
      var element = found[e];
      if (seen.indexOf(element) !== -1) continue;
      if (insideComposer(element)) continue;
      seen.push(element);
      // Document order, not selector order, so that "newest" is a real ordering.
      ordered.push(element);
    }
  }

  ordered.sort(function (a, b) {
    if (a === b) return 0;
    var relation = a.compareDocumentPosition(b);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  var messages = [];
  for (var m = 0; m < ordered.length; m += 1) {
    var node = ordered[m];
    var text = textOf(node);
    if (!text) continue;

    var key = node.getAttribute('data-message-id')
      || (node.closest('[data-message-id]') && node.closest('[data-message-id]').getAttribute('data-message-id'))
      || node.getAttribute('data-testid')
      || node.id
      || null;

    if (!key) {
      // Content-derived, but derived from the whole message so that two replies which happen to open
      // alike still differ, and stable across polls because the message does not move.
      key = 'derived-' + fingerprint(text).slice(0, 60) + '-' + messages.length;
    }

    // Scoped to this message only. A streaming caret elsewhere on the page — the composer, a toolbar —
    // must not make a finished reply look unfinished.
    var streaming = hasControl(node, STREAMING) || hasControl(wrapperOf(node), STREAMING);

    // The action bar lives on a wrapper rather than inside the message, so check both.
    var wrapper = wrapperOf(node);
    var regenerate = hasControl(node, REGENERATE) || hasControl(wrapper, REGENERATE);

    // Scoped to this message as well. A stop control somewhere else on the page is evidence about the
    // page; this one is evidence about *this* reply, which is what completion is judged on.
    var stopScoped = hasControl(node, STOP) || hasControl(wrapper, STOP);

    // A caret inside the generated prose means the text has not settled. Generation pauses leave the
    // caret in place and only remove it when the reply is genuinely finished, so this is the signal
    // that stops a brief pause being mistaken for completion.
    var caret = false;
    try {
      caret = !!node.querySelector('.blinking-cursor, .cursor-blink, [class*="blinking"], [class*="animate-cursor"], .caret');
    } catch (error) { /* A selector the engine rejects must not abort the probe. */ }

    // Some builds show an explicit "still working" element on the message itself.
    var thinking = hasControl(node, THINKING) || hasControl(wrapper, THINKING);

    messages.push({
      key: key,
      index: messages.length,
      text: text,
      fingerprint: fingerprint(text),
      hasRegenerate: regenerate,
      isStreaming: streaming,
      hasStopControl: stopScoped,
      hasCaret: caret,
      hasThinkingIndicator: thinking
    });
  }

  var userFingerprints = [];
  var userMessageCount = 0;
  try {
    var userNodes = document.querySelectorAll('[data-message-author-role="user"]');
    userMessageCount = userNodes.length;
    for (var u = 0; u < userNodes.length; u += 1) {
      var userText = (userNodes[u].innerText || '').trim();
      if (userText) userFingerprints.push(fingerprint(userText));
    }
  } catch (error) { /* No user messages means nothing to confirm against. */ }

  return {
    messages: messages,
    selectorCounts: selectorCounts,
    composerCount: document.querySelectorAll('#composer, form, footer, [data-testid="composer"]').length,
    stopControlPresent: hasControl(document, STOP),
    userFingerprints: userFingerprints,
    userMessageCount: userMessageCount,
    threadReady: document.readyState !== 'loading' && !!document.body
  };
})()
`
}
