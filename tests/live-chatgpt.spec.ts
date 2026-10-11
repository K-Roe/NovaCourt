import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

test.skip(process.env.NC_V2_LIVE_SMOKE !== '1', 'Run explicitly with NC_V2_LIVE_SMOKE=1; requires network access')

test('M2 live ChatGPT loads in the native middle view and keeps a persistent partition', async () => {
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const results = resolve(cwd, 'test-results')
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'live-user-'))
  const launch = () => electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_USER_DATA: userData, NC_V2_ASTRA_FIXTURE: '0' } })
  const app = await launch()
  try {
    await expect.poll(() => app.windows().find((candidate) => candidate.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = app.windows().find((candidate) => candidate.url().endsWith('/index.html'))!
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Astra' })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.readAstraStatus())).phase, { timeout: 30_000 }).toMatch(/^(open|sign-in-page)$/)
    const state = await app.evaluate(({ webContents }) => {
      const view = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('https://chatgpt.com/'))
      return view ? { url: view.getURL(), persistent: view.session.isPersistent(), partition: view.session.getStoragePath() } : null
    })
    expect(state?.url).toMatch(/^https:\/\/chatgpt\.com\//)
    expect(state?.persistent).toBe(true)
    expect(state?.partition).toBeTruthy()

    const viewport = await page.getByTestId('astra-viewport').boundingBox()
    const native = await page.evaluate(() => window.novaCourt.testViewBounds())
    expect(native.bounds).toEqual({ x: Math.round(viewport!.x), y: Math.round(viewport!.y), width: Math.round(viewport!.width), height: Math.round(viewport!.height) })
    const browserWindow = await app.browserWindow(page)
    await browserWindow.evaluate((window) => window.focus())
    if (process.platform === 'win32') {
      const bounds = await browserWindow.evaluate((window) => window.getBounds())
      execFileSync('powershell', ['-NoProfile', '-File', resolve(cwd, 'tests', 'capture-window.ps1'), resolve(results, 'm2-live-chatgpt-window.png'), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)])
    }

    await browserWindow.evaluate((window) => window.setSize(1120, 720))
    await expect.poll(async () => (await page.getByTestId('astra-viewport').boundingBox())!.width).toBeLessThan(viewport!.width)
    const resized = await page.getByTestId('astra-viewport').boundingBox()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).bounds?.width).toBe(Math.round(resized!.width))
    if (process.platform === 'win32') {
      await browserWindow.evaluate((window) => window.focus())
      const bounds = await browserWindow.evaluate((window) => window.getBounds())
      execFileSync('powershell', ['-NoProfile', '-File', resolve(cwd, 'tests', 'capture-window.ps1'), resolve(results, 'm2-live-chatgpt-resized-window.png'), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)])
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(false)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(true)
    expect(errors).toEqual([])

    await app.evaluate(async ({ session }) => {
      await session.fromPartition('persist:chatgpt').cookies.set({ url: 'https://example.com/', name: 'nc-v2-persistence-probe', value: 'm2', expirationDate: Math.floor(Date.now() / 1000) + 3600 })
    })
  } finally { await app.close() }

  const restarted = await launch()
  try {
    const persisted = await restarted.evaluate(async ({ session }) => {
      const partition = session.fromPartition('persist:chatgpt')
      const cookies = await partition.cookies.get({ url: 'https://example.com/', name: 'nc-v2-persistence-probe' })
      return { persistent: partition.isPersistent(), probe: cookies[0]?.value }
    })
    expect(persisted).toEqual({ persistent: true, probe: 'm2' })
  } finally { await restarted.close() }
})
