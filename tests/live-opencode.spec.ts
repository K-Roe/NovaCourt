import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'

test.skip(process.env.NC_V2_REAL_OPENCODE_SMOKE !== '1', 'Run explicitly with a local OpenCode server and a verified free model')

test('M3 can start and stop its own local OpenCode server', async () => {
  test.setTimeout(50_000)
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('No local test port')
  await new Promise<void>((done) => probe.close(() => done()))
  const require = createRequire(import.meta.url)
  const { OpenCodeService } = require(resolve(cwd, 'dist-electron', 'openCodeService.cjs'))
  const dataPath = mkdtempSync(resolve(cwd, 'test-results', 'owned-server-'))
  const service = new OpenCodeService(dataPath, () => {})
  const endpoint = `http://127.0.0.1:${address.port}`
  try {
    service.configure({ endpoint, executablePath: service.snapshot().config.executablePath, workspace: cwd })
    const state = await service.startServer()
    expect(state.connection).toBe('connected')
    expect(state.version).toBe('1.18.35')
  } finally { service.close() }
  await expect.poll(async () => {
    try { await fetch(`${endpoint}/global/health`, { signal: AbortSignal.timeout(500) }); return true } catch { return false }
  }, { timeout: 10_000 }).toBe(false)
})

test('M3 real OpenCode exchange, session history and Electron layout', async () => {
  test.setTimeout(150_000)
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const results = resolve(cwd, 'test-results')
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'live-opencode-user-'))
  const launch = () => electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_USER_DATA: userData, NC_V2_ASTRA_FIXTURE: '0' } })
  const app = await launch()
  let originalId = ''
  try {
    await expect.poll(() => app.windows().find((candidate) => candidate.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = app.windows().find((candidate) => candidate.url().endsWith('/index.html'))!
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).connection, { timeout: 20_000 }).toBe('connected')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).models.some((model) => model.id === 'openrouter:poolside/laguna-s-2.1:free')).toBe(true)
    const connected = await page.evaluate(() => window.novaCourt.getNovaState())
    expect(connected.version).toBe('1.18.35')
    await page.getByRole('button', { name: 'New Nova session' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).config.sessionId).toBeTruthy()
    originalId = (await page.evaluate(() => window.novaCourt.getNovaState())).config.sessionId!
    await page.getByRole('combobox', { name: 'Free Nova model' }).selectOption('openrouter:poolside/laguna-s-2.1:free')
    await page.getByRole('textbox', { name: 'Message Nova' }).fill('Connection test. Reply with the exact token NOVA_M3_OK. Do not use tools.')
    await page.getByRole('button', { name: 'Send to Nova' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).messages.find((message) => message.role === 'assistant')?.text, { timeout: 90_000 }).toContain('NOVA_M3_OK')
    const exchanged = await page.evaluate(() => window.novaCourt.getNovaState())
    expect(exchanged.messages.some((message) => message.role === 'user' && message.text.includes('Connection test'))).toBe(true)
    expect(exchanged.messages.flatMap((message) => message.tools)).toEqual([])
    await expect(page.getByText('NOVA_M3_OK', { exact: true })).toBeVisible()
    const browserWindow = await app.browserWindow(page)
    await browserWindow.evaluate((window) => window.focus())
    if (process.platform === 'win32') {
      const bounds = await browserWindow.evaluate((window) => window.getBounds())
      execFileSync('powershell', ['-NoProfile', '-File', resolve(cwd, 'tests', 'capture-window.ps1'), resolve(results, 'm3-live-three-column-window.png'), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)])
    }
    const before = await page.getByTestId('astra-viewport').boundingBox()
    await browserWindow.evaluate((window) => window.setSize(1120, 720))
    await expect.poll(async () => (await page.getByTestId('astra-viewport').boundingBox())!.width).toBeLessThan(before!.width)
    const after = await page.getByTestId('astra-viewport').boundingBox()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).bounds?.width).toBe(Math.round(after!.width))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(false)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(true)
    await page.getByRole('button', { name: 'New Nova session' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).config.sessionId).not.toBe(originalId)
    await page.getByRole('combobox', { name: 'Nova session' }).selectOption(originalId)
    await expect(page.getByText('NOVA_M3_OK', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await app.close() }

  const restarted = await launch()
  try {
    await expect.poll(() => restarted.windows().find((candidate) => candidate.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = restarted.windows().find((candidate) => candidate.url().endsWith('/index.html'))!
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).connection, { timeout: 20_000 }).toBe('connected')
    expect((await page.evaluate(() => window.novaCourt.getNovaState())).config.sessionId).toBe(originalId)
    await expect(page.getByText('NOVA_M3_OK', { exact: true })).toBeVisible()
  } finally { await restarted.close() }
})
