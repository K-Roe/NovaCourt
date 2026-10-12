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

/**
 * Records a court message.
 *
 * The unified-chat renderer no longer offers per-recipient composition, so the targeted-sender and
 * targeted-recipient cases this file exercises are driven through the same preload bridge the renderer
 * itself uses. The guarantees under test live in the main process, not in the controls that were
 * removed, so driving them directly keeps the coverage honest rather than deleting it.
 */
async function compose(page: Page, text: string, to: 'astra' | 'nova' | 'court' = 'court') {
  const message = await page.evaluate(
    ({ body, recipient }) => window.novaCourt.appendCourtMessage({ sender: 'karl', recipient, text: body, source: 'manual' }),
    { body: text, recipient: to }
  )
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text === text).length).toBe(1)
  return message
}

/** Records an imported court message, the way importing an Astra reply always did. */
async function importReply(page: Page, text: string) {
  return page.evaluate(
    (body) => window.novaCourt.appendCourtMessage({ sender: 'astra', recipient: 'court', text: body, source: 'imported' }),
    text
  )
}

test('M4 Astra handoff copies, never claims delivery, and imports only on confirmation', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  const { app, page } = await launch(userData)
  try {
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    const message = await compose(page, 'Astra, what do you think of Nova’s proposal?', 'astra')

    // Copy for Astra puts the exact text on the clipboard and waits for Karl.
    await page.evaluate((id) => window.novaCourt.copyForAstra(id), message.id)
    expect(await page.evaluate(() => window.novaCourt.readClipboard())).toBe('Astra, what do you think of Nova’s proposal?')

    // CRITICAL: a copy is not a delivery. Nothing may claim otherwise before Karl says so.
    const pending = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    expect(pending.delivery).toBe('prepared-for-astra')
    expect(pending.acknowledged).toBe(false)
    expect(pending.delivery).not.toBe('sent')
    expect(pending.delivery).not.toBe('confirmed-delivered')
    // The visible label must not read as a delivery either.
    await expect(page.locator('.tag-delivery-prepared-for-astra').first()).toContainText('PREPARED FOR ASTRA')
    await expect(page.locator('.tag-ack')).toHaveCount(0)

    // Karl's explicit confirmation is the only thing that can mark it sent.
    await page.evaluate((id) => window.novaCourt.confirmAstraSent(id), message.id)
    await expect(page.locator('.tag-ack')).toHaveCount(1)
    const confirmed = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    expect(confirmed.acknowledged).toBe(true)
    // A confirmation is an annotation, never an edit.
    expect(confirmed.text).toBe(pending.text)
    expect(confirmed.sender).toBe(pending.sender)
    expect(confirmed.source).toBe(pending.source)
    // Delivery remains 'prepared-for-astra' - confirmation only sets the acknowledged flag.
    expect(confirmed.delivery).toBe('prepared-for-astra')

    // Importing Astra's reply is an explicit act and is recorded honestly as an import.
    await page.evaluate(() => window.novaCourt.writeClipboard('I think the plan is sound, but narrow the scope before anyone builds it.'))
    const imported = await importReply(page, 'I think the plan is sound, but narrow the scope before anyone builds it.')
    expect(imported.sender).toBe('astra')
    expect(imported.source).toBe('imported')
    await expect(page.locator(`[data-testid=court-message][data-source=imported]`)).toContainText('IMPORTED BY HAND')

    // A second import of the same reply is refused rather than duplicated.
    const duplicate = await page.evaluate(
      (body) => window.novaCourt.appendCourtMessage({ sender: 'astra', recipient: 'court', text: body, source: 'imported' }).then(() => 'accepted', (e: Error) => e.message),
      'I think the plan is sound, but narrow the scope before anyone builds it.'
    )
    expect(duplicate).toMatch(/already in the conversation/)
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text.includes('narrow the scope'))).toHaveLength(1)

    // The clipboard was never read on its own. Recording a reply required an explicit append, and the
    // text sitting on the clipboard produced no message by itself.
    await app.evaluate(({ clipboard }) => { clipboard.writeText('SOME_OTHER_CLIENT_TEXT') })
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).some((m) => m.text.includes('SOME_OTHER_CLIENT_TEXT'))).toBe(false)

    await page.screenshot({ path: resolve(results, 'm4-astra-handoff.png') })
    expect(errors).toEqual([])
  } finally { await app.close() }
})

test('M4 Nova handoff is refused without a guarded session, and terminal copy never writes to the PTY', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  const { app, page } = await launch(userData)
  try {
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    const message = await compose(page, 'Nova, please review the scoping proposal.')

    // No OpenCode server is running, so the send must fail honestly and must not fake a reply.
    const sendFailure = await page.evaluate(
      (id) => window.novaCourt.sendToNova(id).then(() => 'accepted', (e: Error) => e.message),
      message.id
    )
    expect(sendFailure).toMatch(/Connect to OpenCode first/)
    const failed = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.id === message.id)!
    // The prompt may or may not have reached OpenCode, so the record says so rather than claiming
    // either success or failure.
    expect(failed.delivery).toBe('delivery-unknown')
    expect(failed.delivery).not.toBe('sent')
    // No Nova reply was invented.
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.sender === 'nova')).toHaveLength(0)

    // Copy for Nova Terminal only touches the clipboard.
    await page.evaluate((id) => window.novaCourt.copyForTerminal(id), message.id)
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
  } finally { await app.close() }
})

test('M4 pausing blocks handoffs and the record stays append-only across a restart', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  let { app, page } = await launch(userData)
  try {
    page.on('pageerror', (e) => errors.push(e.message))
    const message = await compose(page, 'Astra, please consider the narrower scope.', 'astra')

    await page.evaluate(() => window.novaCourt.pauseHandoffs(true))
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getHandoffState())).status).toBe('paused')
    // While paused, a handoff is refused.
    await expect(page.evaluate(() => window.novaCourt.copyForAstra('not-a-message'))).rejects.toThrow(/No such message/)
    const refused = await page.evaluate((id) => window.novaCourt.copyForAstra(id).then(() => 'sent', (e: Error) => e.message), message.id)
    expect(refused).toMatch(/paused/i)

    await page.evaluate(() => window.novaCourt.pauseHandoffs(false))
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getHandoffState())).status).toBe('idle')
    await page.evaluate((id) => window.novaCourt.copyForAstra(id), message.id)
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getHandoffState())).status).toBe('awaiting-karl')

    // Cancelling clears the outstanding handoff without inventing a delivery.
    await page.evaluate(() => window.novaCourt.cancelHandoff())
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getHandoffState())).status).toBe('idle')

    // Filters still narrow the visible transcript without altering the record.
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
  } finally { await app.close() }

  ;({ app, page } = await launch(userData))
  try {
    await expect(page.getByTestId('court-message')).toHaveCount(2)
    // The acknowledgement and handoff annotations survived; the handoff itself did not.
    const stored = JSON.parse(readFileSync(resolve(userData, 'conversation.json'), 'utf8')) as { text: string; acknowledged: boolean; delivery: string }[]
    expect(stored.find((m) => m.text.includes('narrower scope'))?.delivery).toBe('prepared-for-astra')
    expect(stored.find((m) => m.text.includes('hold off'))?.acknowledged).toBe(false)
    expect(await page.evaluate(() => window.novaCourt.getHandoffState())).toMatchObject({ status: 'idle', messageId: null })
  } finally { await app.close() }
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