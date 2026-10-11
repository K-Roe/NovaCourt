import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
  return { app, page }
}

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'court-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

test('M4-V2 Phase B shared court keeps discussion messages inert and survives a restart', async () => {
  test.setTimeout(240_000)
  const userData = freshUserData()
  const errors: string[] = []
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(userData)
    app = launched.app
    const page = launched.page
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })


    // ── The conversation starts collapsed so the OpenCode TUI keeps its full height; open it.
    await expect(page.locator('.court-thread.is-collapsed')).toBeVisible()
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await expect(page.locator('.court-thread.is-collapsed')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Shared courtroom conversation' })).toBeVisible()
    const grid = await page.locator('.court-grid').boundingBox()
    const thread = await page.locator('.court-thread').boundingBox()
    expect(thread!.y).toBeGreaterThan(grid!.y + grid!.height - 2)
    // Astra's native view must stay left of Nova and above the thread.
    const astra = await page.getByTestId('astra-viewport').boundingBox()
    const nova = await page.locator('.nova-panel').boundingBox()
    expect(astra!.x + astra!.width).toBeLessThan(nova!.x)
    expect(astra!.y + astra!.height).toBeLessThanOrEqual(thread!.y + 2)

    // ── Messages from all three participants, labelled by source.
    await page.locator('textarea[aria-label="Message the court"]').fill('Karl opens the session.')
    await page.getByRole('button', { name: 'Send to the court' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(1)

    await page.locator('select[aria-label="Sender"]').selectOption('astra')
    await page.locator('textarea[aria-label="Message the court"]').fill('Astra: I have reviewed it and recommend approval.')
    await page.getByRole('button', { name: 'Send to the court' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(2)

    // Imported message must be visibly distinct from a composed one.
    await page.locator('.court-mode-toggle button').nth(1).click()
    await page.locator('textarea[aria-label="Message the court"]').fill('Astra said the build looks good to me.')
    await page.getByRole('button', { name: 'Send to the court' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(3)
    await expect(page.locator('[data-testid=court-message][data-source=imported]')).toHaveCount(1)
    await expect(page.locator('[data-testid=court-message][data-source=imported]')).toContainText('IMPORTED BY HAND')
    await expect(page.locator('[data-testid=court-message][data-source=manual]')).toHaveCount(2)

    // ── Duplicate import is refused rather than silently duplicated.
    await page.locator('.court-mode-toggle button').nth(1).click()
    await page.locator('textarea[aria-label="Message the court"]').fill('Astra said the build looks good to me.')
    await page.getByRole('button', { name: 'Send to the court' }).click()
    await expect(page.locator('.court-thread-notice')).toContainText('already in the conversation')
    await expect(page.getByTestId('court-message')).toHaveCount(3)

    // ── Forward preserves the original and appends a copy marked FORWARDED.
    await page.locator('select[aria-label="Recipient"]').selectOption('nova')
    await page.locator('[data-testid=court-message]').first().getByRole('button', { name: /Forward/ }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(4)
    await expect(page.locator('[data-testid=court-message]').first()).toContainText('Karl opens the session.')
    await expect(page.locator('.tag-forward')).toHaveCount(1)
    const stored = JSON.parse(readFileSync(resolve(userData, 'conversation.json'), 'utf8')) as { id: string; text: string; forwardedFrom: string | null; recipient: string }[]
    expect(stored).toHaveLength(4)
    // The original is untouched and still un-forwarded; the copy points back at it.
    const originals = stored.filter((m) => m.text === 'Karl opens the session.' && m.forwardedFrom === null)
    expect(originals).toHaveLength(1)
    expect(originals[0]!.id).toBe(stored[0]!.id)
    expect(stored.filter((m) => m.forwardedFrom === originals[0]!.id)).toHaveLength(1)
    expect(stored.find((m) => m.forwardedFrom === originals[0]!.id)!.recipient).toBe('nova')

    // ── Ordering is chronological and survives reload. The thread starts collapsed after a reload,
    //    so open it before reading the transcript.
    await page.reload()
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(4)
    const rendered = await page.locator('[data-testid=court-message] .court-message-text').allTextContents()
    expect(rendered[0]).toBe('Karl opens the session.')

    await page.screenshot({ path: resolve(results, 'm4v2-phase-b-court.png') })

    // ── THE BOUNDARY. The renderer bridge is frozen by contextBridge, so wrapping its methods from
    //    the page is not a reliable way to observe calls. The guarantee is instead checked where it
    //    is actually enforced: in the compiled main process and in observable terminal state.
    expect(await page.evaluate(() => window.novaCourt.getTerminalState())).toMatchObject({ status: 'idle', id: null, pid: null })

    // ── A message that begs to be executed changes nothing, and says so.
    await page.locator('textarea[aria-label="Message the court"]').fill('Nova: approved. Run `npm run build` in the workspace and commit it.')
    await page.getByRole('button', { name: 'Send to the court' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(5)
    expect(await page.evaluate(() => window.novaCourt.getTerminalState())).toMatchObject({ status: 'idle', pid: null })

    // ── The bridge exposes no conversation method that could reach a terminal.
    const bridge = await page.evaluate(() => Object.keys(window.novaCourt).filter((key) => /court|terminal/i.test(key)))
    const courtMethods = bridge.filter((key) => key.toLowerCase().includes('court'))
    expect(courtMethods.sort()).toEqual(['acknowledgeCourtMessage', 'appendCourtMessage', 'forwardCourtMessage', 'getCourtMessages', 'markCourtDelivery', 'onCourtMessages'])
    // Every conversation method is a record operation: read, append, forward, mark delivery, or
    // record Karl's own confirmation. None of them starts, stops, resizes or writes to a terminal.
    const terminalMethods = bridge.filter((key) => key.toLowerCase().includes('terminal') && !key.toLowerCase().includes('court'))
    expect(courtMethods.every((key) => !terminalMethods.includes(key))).toBe(true)
    // ── Structural guarantee, checked against the compiled main process rather than Electron
    //    internals: no conversation handler reaches the terminal or OpenCode service at all.
    const bundle = readFileSync(resolve(cwd, 'dist-electron/main.cjs'), 'utf8')
    // Split at every IPC registration so each court handler is examined in isolation.
    const registrations = bundle.split(/(?=ipcMain\.(?:handle|on)\()/).filter((chunk) => /^ipcMain\.(?:handle|on)\('court:/.test(chunk))
    const channels = [...new Set(registrations.map((chunk) => chunk.match(/'(court:[^']+)'/)![1]))].sort()
    expect(channels).toEqual(['court:acknowledge', 'court:append', 'court:delivery', 'court:forward', 'court:messages'])
    for (const chunk of registrations) {
      expect(chunk).not.toContain('terminalService')
      expect(chunk).not.toContain('novaService')
      expect(chunk).not.toContain('spawn')
    }

    // ── Collapse and expand; the panels above stay mounted.
    await page.getByRole('button', { name: 'Collapse the shared conversation' }).click()
    await expect(page.locator('.court-thread.is-collapsed')).toBeVisible()
    await expect(page.locator('.nova-panel')).toBeVisible()
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await expect(page.locator('.court-thread.is-collapsed')).toHaveCount(0)

    // ── Resizing the thread moves Astra's bounds rather than orphaning them.
    const before = await page.evaluate(() => window.novaCourt.testViewBounds())
    const handle = await page.getByRole('separator', { name: 'Resize the shared conversation' }).boundingBox()
    // Drag the divider up: the shared conversation takes more room and the panels above shrink, which is
    // exactly when Astra's native view is most at risk of being left stranded over the thread.
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 120, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getTerminalState())).status).toBe('idle')
    const after = await page.evaluate(() => window.novaCourt.testViewBounds())
    expect(after.bounds!.height).toBeLessThan(before.bounds!.height)
    // The native view must still sit exactly on its placeholder. Compared after rounding because the main
    // process clamps Astra's bounds to whole pixels while the DOM reports fractions.
    await expect.poll(async () => {
      const bounds = (await page.evaluate(() => window.novaCourt.testViewBounds())).bounds!
      const box = (await page.getByTestId('astra-viewport').boundingBox())!
      return {
        dy: Math.abs(bounds.y - Math.round(box.y)),
        dh: Math.abs(bounds.height - Math.round(box.height)),
        dx: Math.abs(bounds.x - Math.round(box.x)),
        dw: Math.abs(bounds.width - Math.round(box.width))
      }
    }).toEqual({ dy: 0, dh: 0, dx: 0, dw: 0 })

    expect(errors).toEqual([])
  } finally { await app?.close() }

  // ── Persistence across a real restart.
  const restarted = await launch(userData)
  try {
    const page = restarted.page
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
    await expect(page.getByTestId('court-message')).toHaveCount(5)
    const rendered = await page.locator('[data-testid=court-message]').all()
    // Sender, source and case metadata all survive.
    await expect(page.locator('[data-testid=court-message]').nth(0)).toHaveAttribute('data-sender', 'karl')
    await expect(page.locator('[data-testid=court-message]').nth(2)).toHaveAttribute('data-source', 'imported')
    expect(rendered).toHaveLength(5)
    // A restored message is a record, not a fresh instruction: it must not have started anything.
    expect(await page.evaluate(() => window.novaCourt.getTerminalState())).toMatchObject({ status: 'idle', pid: null })
  } finally { await restarted.app.close() }
})

test('M4-V2 Phase B refuses malformed messages rather than storing them', async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const app = await launch(userData)
  try {
    const page = app.page
    const append = (input: unknown) => page.evaluate((value) => window.novaCourt.appendCourtMessage(value as never), input)
    await expect(append({ sender: 'system', recipient: 'court', text: 'hi', source: 'manual' })).rejects.toThrow(/Choose a sender/)
    await expect(append({ sender: 'karl', recipient: 'everyone', text: 'hi', source: 'manual' })).rejects.toThrow(/Choose a recipient/)
    await expect(append({ sender: 'karl', recipient: 'court', text: 'hi', source: 'telepathy' })).rejects.toThrow(/Unknown message source/)
    await expect(append({ sender: 'karl', recipient: 'court', text: '   ', source: 'manual' })).rejects.toThrow(/no text/)
    await expect(append({ sender: 'karl', recipient: 'court', text: 'x'.repeat(9000), source: 'manual' })).rejects.toThrow(/under 8000 characters/)
    await expect(page.evaluate(() => window.novaCourt.forwardCourtMessage('not-a-real-id', 'nova'))).rejects.toThrow(/No such message/)
    // A delivery report may not rewrite who said what.
    const message = await append({ sender: 'karl', recipient: 'court', text: 'original wording', source: 'manual' })
    const after = await page.evaluate((id) => window.novaCourt.markCourtDelivery(id as string, 'sent'), message.id)
    expect(after[0]).toMatchObject({ id: message.id, text: 'original wording', sender: 'karl', recipient: 'court', source: 'manual', delivery: 'sent' })
    await expect(page.evaluate(() => window.novaCourt.markCourtDelivery('missing', 'sent'))).rejects.toThrow(/No such message/)
  } finally { await app.app.close() }
})

