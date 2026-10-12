import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, '')
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
  await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
  return { app, page }
}

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'm52-routing-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

/**
 * Records a court message through the preload bridge.
 *
 * The unified-chat renderer has one composer for the whole court, so there is no longer a recipient
 * picker that routes on the spot. Each route is therefore requested explicitly below through the same
 * handler the renderer used to call, and the assertions on delivery state, the clipboard, the PTY and
 * the guarded send are unchanged.
 */
async function composeAndGetId(page: Page, text: string, to: 'astra' | 'nova' | 'court' | 'both' = 'court'): Promise<string> {
  const message = await page.evaluate(
    ({ body, recipient }) => window.novaCourt.appendCourtMessage({ sender: 'karl', recipient, text: body, source: 'manual' }),
    { body: text, recipient: to }
  )
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text === text).length).toBeGreaterThanOrEqual(1)
  return message.id
}

/** All court messages carrying the given text, since a "both" message produces two. */
async function idsForText(page: Page, text: string): Promise<string[]> {
  const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
  return messages.filter((m: any) => m.text === text).map((m: any) => m.id)
}

async function deliveryOf(page: Page, id: string): Promise<string> {
  const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
  return messages.find((m: any) => m.id === id)!.delivery
}

async function startTerminal(page: Page, tab: 'OpenCode Terminal' | 'PowerShell') {
  await page.getByRole('tab', { name: tab }).click()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')
}

test.describe('M5.2 Nova routing — terminal preparation', () => {
  test('a Nova message is prepared in the OpenCode terminal and never executed', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'OpenCode Terminal')
      expect((await page.evaluate(() => window.novaCourt.getTerminalState())).mode).toBe('opencode')

      const msgId = await composeAndGetId(page, 'Test message for OpenCode terminal', 'nova')
      const result = await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'opencode'), msgId)
      expect(result.ok).toBe(true)
      expect(result.deliveryStatus).toBe('prepared-for-opencode')
      expect(await deliveryOf(page, msgId)).toBe('prepared-for-opencode')

      // OpenCode's --mini mode is a TUI that may not echo stdin back, so the buffer cannot confirm the
      // write. What matters is that preparation was recorded and nothing ran.
      expect((await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')
    } finally { await app.close() }
  })

  test('a Nova message is prepared in PowerShell and lands in the shell input line, unexecuted', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'PowerShell')
      expect((await page.evaluate(() => window.novaCourt.getTerminalState())).mode).toBe('powershell')

      const msgId = await composeAndGetId(page, 'Test message for PowerShell terminal', 'nova')
      const result = await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), msgId)
      expect(result.ok).toBe(true)
      expect(result.deliveryStatus).toBe('prepared-for-powershell')
      expect(await deliveryOf(page, msgId)).toBe('prepared-for-powershell')

      await expect.poll(async () => {
        const buffer = stripAnsi((await page.evaluate(() => window.novaCourt.getTerminalState())).buffer)
        return buffer.includes('Test message for PowerShell terminal')
      }, { timeout: 10_000, intervals: [100, 200, 500, 1000, 2000] }).toBeTruthy()
    } finally { await app.close() }
  })

  test('multiline text is sanitised to a single shell line so it cannot become two commands', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'PowerShell')
      const msgId = await composeAndGetId(page, 'First line of the request\nSecond line of the request', 'nova')
      const result = await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), msgId)
      expect(result.ok).toBe(true)
      expect(result.text).not.toContain('\n')
      expect(result.text).toBe('First line of the request Second line of the request')
    } finally { await app.close() }
  })

  test('preparation is refused, not silently ignored, when no terminal is running', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const msgId = await composeAndGetId(page, 'No terminal is running', 'nova')
      const result = await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), msgId)
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/terminal is not running/i)
      // The record is untouched by a refused preparation.
      expect(await deliveryOf(page, msgId)).toBe('local')
    } finally { await app.close() }
  })
})

test.describe('M5.2 Nova routing — guarded chat', () => {
  test('a Nova message without a connected server fails honestly and fabricates no reply', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const msgId = await composeAndGetId(page, 'Test message for Nova Chat', 'nova')
      const failure = await page.evaluate(
        (id) => window.novaCourt.sendToNova(id).then(() => 'sent', (e: Error) => e.message),
        msgId
      )
      expect(failure).toMatch(/Connect to OpenCode first/)
      // The prompt may or may not have landed, so the record says exactly that.
      expect(['delivery-unknown', 'awaiting-send', 'sent']).toContain(await deliveryOf(page, msgId))
      expect(await deliveryOf(page, msgId)).not.toBe('sent')
      // No Nova reply was invented to paper over the failure.
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      expect(messages.filter((m: any) => m.sender === 'nova')).toHaveLength(0)
    } finally { await app.close() }
  })
})

test.describe('M5.2 Astra routing — clipboard handoff', () => {
  test('an Astra message is copied to the clipboard and awaits Karl', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const msgId = await composeAndGetId(page, 'Test message for Astra', 'astra')
      await page.evaluate((id) => window.novaCourt.prepareForAstra(id), msgId)
      expect(await deliveryOf(page, msgId)).toBe('prepared-for-astra')
      expect(await page.evaluate(() => window.novaCourt.readClipboard())).toBe('Test message for Astra')
      expect(await page.evaluate(() => window.novaCourt.getHandoffState())).toMatchObject({ status: 'awaiting-karl', target: 'astra' })
    } finally { await app.close() }
  })

  test('a "both" message reaches Astra by clipboard and Nova by terminal independently', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'PowerShell')
      await composeAndGetId(page, 'Test message for Both', 'both')
      const [astraId, novaId] = await idsForText(page, 'Test message for Both')

      await page.evaluate((id) => window.novaCourt.prepareForAstra(id), astraId)
      await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), novaId)

      expect(await deliveryOf(page, astraId)).toBe('prepared-for-astra')
      expect(await deliveryOf(page, novaId)).toBe('prepared-for-powershell')
      // The clipboard holds Astra's copy; Nova's text went to the shell instead.
      expect(await page.evaluate(() => window.novaCourt.readClipboard())).toBe('Test message for Both')
    } finally { await app.close() }
  })
})

test.describe('M5.2 Routing invariants', () => {
  test('each delivery type is reported honestly and claims nothing more', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'PowerShell')
      const localId = await composeAndGetId(page, 'Never routed anywhere', 'court')
      const astraId = await composeAndGetId(page, 'Prepared for Astra only', 'astra')
      const novaId = await composeAndGetId(page, 'Prepared for Nova only', 'nova')

      expect(await deliveryOf(page, localId)).toBe('local')

      await page.evaluate((id) => window.novaCourt.prepareForAstra(id), astraId)
      expect(await deliveryOf(page, astraId)).toBe('prepared-for-astra')

      await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), novaId)
      expect(await deliveryOf(page, novaId)).toBe('prepared-for-powershell')

      // "Prepared" never becomes "sent" on its own. Only Astra's explicit confirmation may do that,
      // and only for the copied message.
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      expect(messages.every((m: any) => m.delivery !== 'confirmed-delivered')).toBe(true)
      expect(messages.every((m: any) => m.acknowledged === false)).toBe(true)
    } finally { await app.close() }
  })

  test('preparing a message does not redirect a different message', async () => {
    test.setTimeout(180_000)
    // Switching seats used to re-target a pending message. Preparing one message must leave every other
    // message's delivery state exactly as it was.
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const first = await composeAndGetId(page, 'First pending message', 'nova')
      const second = await composeAndGetId(page, 'Second pending message', 'nova')
      await page.evaluate((id) => window.novaCourt.prepareForAstra(id), first)
      expect(await deliveryOf(page, first)).toBe('prepared-for-astra')
      expect(await deliveryOf(page, second)).toBe('local')
    } finally { await app.close() }
  })

  test('duplicate messages are refused rather than routed twice', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await composeAndGetId(page, 'Duplicate routing message', 'nova')
      const duplicate = await page.evaluate(
        () => window.novaCourt.appendCourtMessage({ sender: 'karl', recipient: 'nova', text: 'Duplicate routing message', source: 'manual' })
          .then(() => 'accepted', (e: Error) => e.message)
      )
      expect(duplicate).toMatch(/already in the conversation/)
      expect(await idsForText(page, 'Duplicate routing message')).toHaveLength(1)
    } finally { await app.close() }
  })

  test('no automatic command execution when preparing a terminal message', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startTerminal(page, 'PowerShell')
      const msgId = await composeAndGetId(page, 'Get-ChildItem C:\\Windows', 'nova')
      await page.evaluate((id) => window.novaCourt.prepareForTerminal(id, 'powershell'), msgId)

      // The text is sitting in the shell's input line. Nothing has been run, so no output exists.
      const buffer = stripAnsi((await page.evaluate(() => window.novaCourt.getTerminalState())).buffer)
      expect(buffer).not.toMatch(/Windows\s+Directory/i)
      // Karl still has to press Enter himself; the process is alive and idle.
      expect((await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')
    } finally { await app.close() }
  })

  test('security: court handlers never reach a terminal, and terminal staging happens in exactly one place', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app } = await launch(userData)
    try {
      const { readFileSync } = await import('node:fs')
      const bundle = readFileSync(resolve(cwd, 'dist-electron/main.cjs'), 'utf8')
      const chunks = bundle.split(/(?=ipcMain\.(?:handle|on)\()/)

      // A court message is a record. No handler that only touches the record may reach a terminal or
      // the OpenCode service, because that is the guarantee that discussion text can never authorise
      // execution.
      const courtChunks = chunks.filter((chunk) => /^ipcMain\.(?:handle|on)\('court:/.test(chunk))
      expect(courtChunks.length).toBeGreaterThan(0)
      for (const chunk of courtChunks) {
        expect(chunk).not.toContain('terminalService')
        expect(chunk).not.toContain('novaService')
        expect(chunk).not.toContain('spawn')
      }

      // `handoff:prepareForTerminal` is the single deliberate case where a handoff writes to a PTY: it
      // stages text into the shell's input line for Karl to submit. It must never press Enter, or
      // "staged for Karl" would become "executed by NovaCourt". The line-collapsing behaviour itself is
      // verified for real by the multiline sanitisation test above.
      //
      // The handler body is sliced up to the next registration, because a chunk from a naive split also
      // contains whatever follows it — including the Astra send path, which does legitimately press Enter
      // into ChatGPT.
      const prepareStart = bundle.indexOf("ipcMain.handle('handoff:prepareForTerminal'")
      expect(prepareStart).toBeGreaterThan(-1)
      const prepareBody = bundle.slice(prepareStart, bundle.indexOf('ipcMain.', prepareStart + 10))
      expect(prepareBody).not.toMatch(/keyCode:\s*'Enter'/)
      expect(prepareBody).toContain('terminalService.write')
    } finally { await app.close() }
  })
})