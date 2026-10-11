import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

test('M2 offline fixture preserves Electron layout, bounds, resize and navigation', async () => {
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const testResults = resolve(cwd, 'test-results')
  mkdirSync(testResults, { recursive: true })
  const userData = mkdtempSync(resolve(testResults, 'user-'))
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  try {
    await expect.poll(() => app.windows().find((candidate) => candidate.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = app.windows().find((candidate) => candidate.url().endsWith('/index.html'))!
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    await expect(page.getByRole('heading', { name: 'Karl' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Astra' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Nova', exact: true })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.readAstraStatus())).phase).toBe('open')
    expect((await page.evaluate(() => window.novaCourt.readAstraStatus())).source).toBe('fixture')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(true)
    const seats = await page.locator('.participant-panel').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }))
    expect(seats).toHaveLength(3)
    expect(seats[0].y).toBe(seats[1].y)
    expect(seats[1].y).toBe(seats[2].y)
    expect(seats[0].height).toBe(seats[1].height)
    expect(seats[1].height).toBe(seats[2].height)
    expect(seats[0].x + seats[0].width).toBeLessThan(seats[1].x)
    expect(seats[1].x + seats[1].width).toBeLessThan(seats[2].x)
    const viewport = await page.getByTestId('astra-viewport').boundingBox()
    const native = await page.evaluate(() => window.novaCourt.testViewBounds())
    expect(native.registered).toBe(true)
    expect(native.bounds).toEqual({ x: Math.round(viewport!.x), y: Math.round(viewport!.y), width: Math.round(viewport!.width), height: Math.round(viewport!.height) })
    await page.screenshot({ path: resolve(cwd, 'test-results', 'm2-offline-fixture-renderer.png') })
    const browserWindow = await app.browserWindow(page)
    await browserWindow.evaluate((window) => window.focus())
    if (process.platform === 'win32') {
      const bounds = await browserWindow.evaluate((window) => window.getBounds())
      execFileSync('powershell', ['-NoProfile', '-File', resolve(cwd, 'tests', 'capture-window.ps1'), resolve(cwd, 'test-results', 'm2-offline-fixture-window.png'), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)])
    }

    await page.getByRole('textbox', { name: 'Write a local note' }).fill('A real local note from Karl.')
    await page.getByRole('button', { name: 'Save local note' }).click()
    await expect(page.getByText('A real local note from Karl.')).toBeVisible()

    const before = await page.getByTestId('astra-viewport').boundingBox()
    const divider = page.getByRole('separator', { name: 'Resize Karl and Astra panels' })
    const handle = await divider.boundingBox()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x + 55, handle!.y + handle!.height / 2, { steps: 8 })
    await page.mouse.up()
    const after = await page.getByTestId('astra-viewport').boundingBox()
    expect(after!.x).toBeGreaterThan(before!.x + 30)
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).bounds?.x).toBe(Math.round(after!.x))
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.readSettings())).panelWidths.karl).toBeGreaterThan(34)

    const novaBefore = await page.locator('.nova-panel').boundingBox()
    const rightHandle = await page.getByRole('separator', { name: 'Resize Astra and Nova panels' }).boundingBox()
    await page.mouse.move(rightHandle!.x + rightHandle!.width / 2, rightHandle!.y + rightHandle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(rightHandle!.x - 35, rightHandle!.y + rightHandle!.height / 2, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await page.locator('.nova-panel').boundingBox())!.x).toBeLessThan(novaBefore!.x - 20)

    await browserWindow.evaluate((window) => window.setSize(1120, 720))
    await expect.poll(async () => (await page.getByTestId('astra-viewport').boundingBox())!.width).toBeLessThan(after!.width)
    const resized = await page.getByTestId('astra-viewport').boundingBox()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).bounds?.width).toBe(Math.round(resized!.width))
    await page.screenshot({ path: resolve(cwd, 'test-results', 'm2-offline-fixture-resized-renderer.png') })
    if (process.platform === 'win32') {
      await browserWindow.evaluate((window) => window.focus())
      const bounds = await browserWindow.evaluate((window) => window.getBounds())
      execFileSync('powershell', ['-NoProfile', '-File', resolve(cwd, 'tests', 'capture-window.ps1'), resolve(cwd, 'test-results', 'm2-offline-fixture-resized-window.png'), String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height)])
    }

    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'Make room for every voice.' })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(false)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.testViewBounds())).attached).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
