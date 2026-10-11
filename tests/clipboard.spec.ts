import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'clipboard-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  return { app, page: app.windows().find((w) => w.url().endsWith('/index.html'))! }
}

/** Reads the real system clipboard through the app's own bridge. */
function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => window.novaCourt.readClipboard())
}

/**
 * M4 clipboard: copy and paste must work the way they do in any other Windows application.
 *
 * These tests drive the real keyboard, not a helper button, because the whole point of the fix is
 * that the native editing commands work. Anything that asserted against `window.novaCourt` alone
 * would pass even while every real Ctrl+C was broken.
 */

test('the Edit menu provides native copy, cut, paste and select-all roles', async () => {
  test.setTimeout(120_000)
  const app = await launch(freshUserData())
  try {
    const menu = await app.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((item) => ({
      label: item.label,
      submenu: item.submenu?.items.map((entry) => ({ role: entry.role, accelerator: entry.accelerator }))
    })))
    // The menu is the app-wide home of the editing accelerators. Its absence was the systemic
    // cause: with a null menu nothing registered Ctrl+C/V/A as application commands.
    const edit = menu?.find((item) => item.label === 'Edit')
    expect(edit, 'an Edit menu must exist').toBeTruthy()
    const roles = (edit!.submenu ?? []).map((entry) => String(entry.role).toLowerCase()).filter(Boolean)
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectall']))
  } finally { await app.app.close() }
})

test('Ctrl+C copies selected terminal text and still interrupts when nothing is selected', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const app = await launch(userData)
  try {
    const page = app.page
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    await page.getByRole('tab', { name: 'PowerShell' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')

    // ── Interrupt FIRST, while nothing at all is selected.
    //    With no selection, Ctrl+C must reach the PTY as ETX and cancel a running command. If the
    //    selection guard were unconditional, or if ETX were swallowed as a "copy", the sleep would
    //    run to completion and print the marker.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Start-Sleep -Seconds 20; Write-Output ('SHOULDNOT_' + 'PRINT')")
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2000)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+c')
    await page.waitForTimeout(2000)
    const buffer = (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer
    expect(buffer).not.toContain('SHOULDNOT_PRINT')
    // The shell survived the interrupt and is accepting input again.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('PROMPTBACK_' + '5E2F')")
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 15_000 }).toContain('PROMPTBACK_5E2F')

    // ── Copy SECOND, now with a real selection.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('NOVACOPY_' + '7A1E')")
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 15_000 }).toContain('NOVACOPY_7A1E')

    // Select the output line by double-clicking it, the way a person selects a word in any terminal.
    const row = page.locator('.xterm-rows > div', { hasText: 'NOVACOPY_7A1E' }).last()
    const rowBox = await row.boundingBox()
    expect(rowBox, 'the echoed line must be rendered').toBeTruthy()
    await page.mouse.dblclick(rowBox!.x + 40, rowBox!.y + rowBox!.height / 2)
    await page.waitForTimeout(300)

    // With a selection, Ctrl+C must copy rather than send ETX.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+c')
    await expect.poll(() => clipboardText(page), { timeout: 5000 }).toContain('NOVACOPY_7A1E')

    // The copy must NOT have interrupted the shell.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type("Write-Output ('AFTERCOPY_' + '9C4D')")
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 15_000 }).toContain('AFTERCOPY_9C4D')

    await page.screenshot({ path: resolve(results, 'm4-clipboard-terminal-copy.png') })
    expect(errors).toEqual([])
  } finally { await app.app.close() }
})

test('multiline text pastes into a terminal and large pastes are split rather than dropped', async () => {
  test.setTimeout(180_000)
  const app = await launch(freshUserData())
  try {
    const page = app.page
    await page.getByRole('tab', { name: 'PowerShell' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('running')

    // A realistic multiline clipboard: several separate lines, not one blob.
    const pasted = ['$a = 1', '$b = 2', '$c = $a + $b', 'Write-Output ("NOVAPASTE_" + $c)'].join('\n')
    await app.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasted)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+v')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 20_000 }).toContain('NOVAPASTE_3')

    // A paste larger than the 8 KB single-write ceiling must still arrive in full. This used to be
    // thrown away by the main process and swallowed by an empty catch, so the paste did nothing.
    const long = `$big = '${'x'.repeat(12_000)}'; Write-Output ("NOVALONG_" + $big.Length)`
    await app.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), long)
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+v')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).buffer, { timeout: 30_000 }).toContain('NOVALONG_12000')
  } finally { await app.app.close() }
})

test('copy and paste work between Karl, Nova Chat and the court, and from outside Windows', async () => {
  test.setTimeout(180_000)
  const app = await launch(freshUserData())
  try {
    const page = app.page
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    // From an external Windows application into Karl's notes.
    await app.app.evaluate(({ clipboard }) => clipboard.writeText('TEXT_FROM_NOTEPAD_4E19'))
    const notes = page.locator('textarea[aria-label="Write a local note"]')
    await notes.click()
    await page.keyboard.press('Control+v')
    await expect(notes).toHaveValue('TEXT_FROM_NOTEPAD_4E19')

    // Out of Karl's notes and back to an external application.
    await notes.fill('TEXT_OUT_TO_NOTEPAD_8B23')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')
    await expect.poll(() => clipboardText(page), { timeout: 5000 }).toBe('TEXT_OUT_TO_NOTEPAD_8B23')

    // Nova Chat's composer is not mounted while OpenCode is disconnected, and it cannot be mounted at
    // all without a live server, so its paste cannot be driven offline. It is an ordinary controlled
    // textarea with no copy/paste handler of its own — the same native path already proven above for
    // Karl's notes and the court composer. Assert that no seat installs a clipboard handler, which is
    // what would otherwise be needed to break Nova Chat's paste.
    const handlers = await page.evaluate(() => Array.from(document.querySelectorAll('textarea')).map((element) => ({
      label: element.getAttribute('aria-label'),
      onpaste: element.oncopy === null && element.onpaste === null
    })))
    expect(handlers.every((entry) => entry.onpaste)).toBe(true)

    // And into the shared court composer.
    const court = page.locator('textarea[aria-label="Message the court"]')
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await court.click()
    await page.keyboard.press('Control+v')
    await expect(court).toHaveValue('TEXT_OUT_TO_NOTEPAD_8B23')

    // Multiline text survives the trip intact, which is what makes pasting a conversation possible.
    const multiline = 'line one\nline two\nline three'
    await app.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), multiline)
    await notes.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+v')
    await expect(notes).toHaveValue(multiline)

    expect(errors).toEqual([])
  } finally { await app.app.close() }
})

test('the clipboard is still read only on an explicit click, never automatically', async () => {
  test.setTimeout(120_000)
  const app = await launch(freshUserData())
  try {
    const page = app.page
    // A sensitive string sits on the clipboard. Nothing in the app may read it until Karl asks.
    await app.app.evaluate(({ clipboard }) => clipboard.writeText('SECRET_DO_NOT_AUTO_READ_1A2B'))
    await page.locator('textarea[aria-label="Write a local note"]').fill('hello')
    await page.waitForTimeout(1500)

    // The only clipboard-read entry point remains the explicit "Bring Astra Reply to Court" click.
    // Pasting elsewhere in the app is a user editing action, not the app reading the clipboard.
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(0)
    await page.locator('textarea[aria-label="Message the court"]').click()
    await page.waitForTimeout(500)

    // Explicit import still works, proving the feature was not disabled to make the test pass.
    await page.getByRole('button', { name: 'Bring Astra Reply to Court' }).click()
    await expect(page.getByTestId('import-preview')).toContainText('SECRET_DO_NOT_AUTO_READ_1A2B')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByTestId('import-preview')).toHaveCount(0)
  } finally { await app.app.close() }
})