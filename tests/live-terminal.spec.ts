import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('M3.1 live OpenCode interactive prompt and permission prompt', async () => {
  test.setTimeout(300_000)
  test.skip(process.env.NC_V2_REAL_TERMINAL_SMOKE !== '1', 'Set NC_V2_REAL_TERMINAL_SMOKE=1 to run a real OpenCode CLI prompt')
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const results = resolve(cwd, 'test-results')
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'terminal-live-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  try {
    await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.getByRole('tab', { name: 'OpenCode Terminal' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer.length, { timeout: 20_000 }).toBeGreaterThan(100)
    await page.locator('.xterm-helper-textarea').focus()
    // Select a known free model through the TUI, then send a real prompt.
    await page.keyboard.type('/model opencode/ling-3.1-flash-free')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
    await page.screenshot({ path: resolve(results, 'live-1-model.png') })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('Reply with exactly NOVATERMINALOK and nothing else.')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 180_000 }).toContain('NOVATERMINALOK')
    await page.screenshot({ path: resolve(results, 'live-2-prompt.png') })
    // Exercise a tool call so the CLI permission prompt is rendered.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('Use the bash tool to run: echo NOVAPERMISSIONPROMPT')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(6000)
    await page.screenshot({ path: resolve(results, 'live-3-permission.png') })
    const state = await page.evaluate(() => window.novaCourt.getTerminalState())
    console.log('TAIL>>>', JSON.stringify(state.buffer.slice(-1400)))
    expect(errors).toEqual([])
  } finally { await app.close() }
})
