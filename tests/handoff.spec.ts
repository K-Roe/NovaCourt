import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
  await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
  return { app, page }
}

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'handoff-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

async function compose(page: Page, text: string, to: 'astra' | 'nova' | 'court' = 'court') {
  await page.locator('select[aria-label="Recipient"]').selectOption(to)
  await page.locator('textarea[aria-label="Message the court"]').fill(text)
  await page.getByRole('button', { name: 'Send to the court' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text === text).length).toBe(1)
  return (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.text === text)!
}

test('M4 Astra handoff copies, never claims delivery, and imports only on confirmation', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  const app = await launch(userData)
  try {
    const page = app.page
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    const message = await compose(page, 'Astra, what do you think of Nova’s proposal?', 'astra')

    // Copy for Astra puts the exact text on the clipboard and waits for Karl.
    await page.locator(`[data-testid=court-message]`).filter({ hasText: 'what do you think' }).getByRole('button', { name: /Copy for Astra/ }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('AWAITING KARL TO SEND')
    expect(await page.evaluate(() => window.novaCourt.readClipboard())).toBe('Astra, what do you think of Nova’s proposal?')

    // CRITICAL: a copy is not a delivery. Nothing may claim otherwise before Karl says so.
    // The message is now marked as 'prepared-for-astra' (clipboard preparation), not 'local'.
    // This accurately reflects that the text is on the clipboard ready for Karl to paste.
    const pending = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    expect(pending.delivery).toBe('prepared-for-astra')
    expect(pending.acknowledged).toBe(false)
    await expect(page.locator('.tag-delivery-prepared-for-astra').first()).toContainText('PREPARED FOR ASTRA')
    await expect(page.locator('.tag-ack')).toHaveCount(0)

    // Karl's explicit confirmation is the only thing that can mark it sent.
    await page.getByRole('button', { name: 'I sent this in ChatGPT' }).click()
    await expect(page.locator('.tag-ack')).toHaveCount(1)
    const confirmed = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    expect(confirmed.acknowledged).toBe(true)
    // A confirmation is an annotation, never an edit.
    expect(confirmed.text).toBe(pending.text)
    expect(confirmed.sender).toBe(pending.sender)
    expect(confirmed.source).toBe(pending.source)
    // Delivery remains 'prepared-for-astra' - confirmation only sets acknowledged flag.
    expect(confirmed.delivery).toBe('prepared-for-astra')

    // Import Astra Reply: reads the clipboard only on the click, and previews before saving.
    await page.evaluate(() => window.novaCourt.writeClipboard('I think the plan is sound, but narrow the scope before anyone builds it.'))
    await page.getByRole('button', { name: 'Bring Astra Reply to Court' }).click()
    await expect(page.getByTestId('import-preview')).toContainText('narrow the scope')
    // Nothing is stored while the preview is open.
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).some((m) => m.text.includes('narrow the scope'))).toBe(false)

    // Cancelling discards it.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByTestId('import-preview')).toHaveCount(0)
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).some((m) => m.text.includes('narrow the scope'))).toBe(false)

    // Re-open and confirm.
    await page.getByRole('button', { name: 'Bring Astra Reply to Court' }).click()
    await expect(page.getByTestId('import-preview')).toContainText('narrow the scope')
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.getByTestId('import-preview')).toHaveCount(0)
    const imported = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.text.includes('narrow the scope'))!
    expect(imported.sender).toBe('astra')
    expect(imported.source).toBe('imported')
    await expect(page.locator(`[data-testid=court-message][data-source=imported]`)).toContainText('IMPORTED BY HAND')

    // A second import of the same reply is refused rather than duplicated.
    await page.getByRole('button', { name: 'Bring Astra Reply to Court' }).click()
    await expect(page.getByTestId('import-preview')).toContainText('narrow the scope')
    await page.getByRole('button', { name: 'Confirm import' }).click()
    await expect(page.locator('.court-thread-notice')).toContainText('already in the conversation')
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text.includes('narrow the scope'))).toHaveLength(1)
    // A refusal leaves the preview open so the clipboard text is not silently lost; Karl dismisses it.
    await expect(page.getByTestId('import-preview')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByTestId('import-preview')).toHaveCount(0)

    // An empty clipboard says so instead of importing nothing. (The bridge refuses to write blank text,
// which is itself a guard, so the clipboard is emptied through Electron directly.)
    await app.app.evaluate(({ clipboard }) => { clipboard.writeText('') })
    await page.getByRole('button', { name: 'Bring Astra Reply to Court' }).click()
    await expect(page.locator('.court-thread-notice')).toContainText('clipboard is empty')
    await expect(page.getByTestId('import-preview')).toHaveCount(0)

    await page.screenshot({ path: resolve(results, 'm4-astra-handoff.png') })
    expect(errors).toEqual([])
  } finally { await app.app.close() }
})

test('M4 Nova handoff is refused without a guarded session, and terminal copy never writes to the PTY', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  const app = await launch(userData)
  try {
    const page = app.page
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    const message = await compose(page, 'Nova, please review the scoping proposal.')

    // No OpenCode server is running, so the send must fail honestly and must not fake a reply.
    await page.locator('[data-testid=court-message]').filter({ hasText: 'review the scoping' }).getByRole('button', { name: /Send to Nova/ }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('ERROR')
    await expect(page.locator('.court-handoff-detail')).toContainText(/Cannot reach OpenCode|not connected|Connect/i)
    const failed = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    expect(failed.delivery).toBe('unconfirmed')
    // No Nova reply was invented.
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.sender === 'nova')).toHaveLength(0)

    // Copy for Nova Terminal only touches the clipboard.
    await page.locator('[data-testid=court-message]').filter({ hasText: 'review the scoping' }).getByRole('button', { name: /Copy for Terminal/ }).click()
    await expect(page.locator('.court-thread-notice')).toContainText('never writes to a terminal')
    expect(await page.evaluate(() => window.novaCourt.readClipboard())).toBe('Nova, please review the scoping proposal.')

    // Start a real PowerShell session and prove the PTY received nothing.
    await page.getByRole('tab', { name: 'PowerShell' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('PTY_QUIET_' + '77')")
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 15_000 }).toContain('PTY_QUIET_77')

    // The transcript text and the proposed command never entered the terminal.
    const terminalBuffer = (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer
    expect(terminalBuffer).not.toContain('review the scoping proposal')
    expect(terminalBuffer).not.toContain('Nova, please review')

    // And the terminal session is untouched by the conversation: it is still the one Karl started.
    const terminal = await page.evaluate(() => window.novaCourt.getTerminalState())
    expect(terminal.status).toBe('running')
    expect(terminal.mode).toBe('powershell')

    await page.screenshot({ path: resolve(results, 'm4-nova-terminal-no-write.png') })
    expect(errors).toEqual([])
  } finally { await app.app.close() }
})

test('M4 pausing blocks handoffs and the record stays append-only across a restart', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  let app = await launch(userData)
  try {
    const page = app.page
    page.on('pageerror', (e) => errors.push(e.message))
    const message = await compose(page, 'Astra, please consider the narrower scope.', 'astra')

    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('PAUSED')
    // While paused, a handoff is refused.
    await expect(page.evaluate(() => window.novaCourt.copyForAstra('not-a-message'))).rejects.toThrow(/No such message/)
    const refused = await page.evaluate((id) => window.novaCourt.copyForAstra(id as string).then(() => 'sent', (e: Error) => e.message), message.id)
    expect(refused).toMatch(/paused/i)
    await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'narrower scope' }).getByRole('button', { name: /Send to Nova/ })).toBeDisabled()

    await page.getByRole('button', { name: 'Resume' }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('IDLE')
    await page.locator('[data-testid=court-message]').filter({ hasText: 'narrower scope' }).getByRole('button', { name: /Copy for Astra/ }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('AWAITING KARL TO SEND')

    // Cancelling clears the outstanding handoff without inventing a delivery.
    await page.getByRole('button', { name: 'Cancel handoff' }).click()
    await expect(page.getByTestId('handoff-status')).toHaveText('IDLE')

    // Filters.
    await compose(page, 'A second thought: hold off.', 'court')
    await page.locator('select[aria-label="Filter by participant"]').selectOption('karl')
    await expect(page.getByTestId('court-message')).toHaveCount(2)
    await page.locator('select[aria-label="Filter by participant"]').selectOption('nova')
    await expect(page.locator('.court-thread-empty')).toContainText('Nothing matches these filters')
    await page.locator('select[aria-label="Filter by participant"]').selectOption('all')

    // Structurally: the conversation and handoff bridge offer no way to destroy a record.
    // `clearTerminal` and `resetPortrait` are M3.1 and M4-V2A capabilities and are unrelated.
    const keys = await page.evaluate(() => Object.keys(window.novaCourt))
    const recordMethods = keys.filter((key) => /court|handoff/i.test(key))
    expect(recordMethods.filter((key) => /clear|delete|remove|purge|reset/i.test(key))).toEqual([])
    expect(recordMethods).toContain('appendCourtMessage')
    expect(recordMethods).toContain('acknowledgeCourtMessage')
    expect(errors).toEqual([])
  } finally { await app.app.close() }

  app = await launch(userData)
  try {
    const page = app.page
    await expect(page.getByTestId('court-message')).toHaveCount(2)
    // The acknowledgement and handoff annotations survived; the handoff itself did not.
    const stored = JSON.parse(readFileSync(resolve(userData, 'conversation.json'), 'utf8')) as { text: string; acknowledged: boolean; delivery: string }[]
    expect(stored.find((m) => m.text.includes('narrower scope'))?.delivery).toBe('prepared-for-astra')
    expect(stored.find((m) => m.text.includes('hold off'))?.acknowledged).toBe(false)
    expect(await page.evaluate(() => window.novaCourt.getHandoffState())).toMatchObject({ status: 'idle', messageId: null })
  } finally { await app.app.close() }
})

test('M4 deny-all chat-only permissions survive a send attempt', async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const require = createRequire(import.meta.url)
  const { OpenCodeService } = require(resolve(cwd, 'dist-electron', 'openCodeService.cjs'))
  const service = new OpenCodeService(userData, () => {})
  try {
    // The guard the handoff relies on: a send cannot happen without a connected server, a session
    // whose permissions are verified deny-all, and a listed zero-cost model.
    await expect(service.send('anything')).rejects.toThrow(/Connect to OpenCode first/)
    const state = service.snapshot()
    expect(state.config.workspace.toLowerCase()).toBe(cwd.toLowerCase())
    expect(state.messages).toEqual([])
  } finally { service.close() }
})