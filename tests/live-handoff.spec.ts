import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Real M4 verification against a genuine local OpenCode server.
 *
 * This test is opt-in because it makes real model requests. It is restricted to a model the app has
 * already verified costs nothing: `OpenCodeService.refreshModels` only ever lists providers whose
 * input AND output cost are exactly zero, and `send()` re-validates that list immediately before
 * prompting. So this run bills nothing — but it does spend real tokens and real wall-clock time, so
 * it stays behind a flag rather than running in the default suite.
 *
 *   $env:NC_V2_REAL_HANDOFF='1'; npx playwright test tests/live-handoff.spec.ts --workers=1
 */
test.skip(process.env.NC_V2_REAL_HANDOFF !== '1', 'Run explicitly with NC_V2_REAL_HANDOFF=1; makes real (zero-cost) model requests')

/**
 * Candidate models, in order. Every one is already filtered to input AND output cost of exactly
 * zero, so trying several of them is still free. The order is only a preference: OpenCode's free
 * list drifts as providers retire entries, so the test walks the list until one actually answers
 * rather than trusting a single hardcoded id.
 *
 * A model that is listed but dead upstream returns an error, which the app reports as an error and
 * never as a Nova reply — so a broken model cannot masquerade as a working handoff.
 */
const UNUSABLE = /exo-free|deprecated|bodybuilder|body-builder/i

test('M4 real Nova handoff delivers a message and records the genuine reply', async () => {
  test.setTimeout(900_000)
  const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const results = resolve(cwd, 'test-results')
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'live-handoff-'))
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  try {
    await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
    const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    // A real server must be running on the configured endpoint, and its model list must have loaded.
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).connection, { timeout: 25_000 }).toBe('connected')
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).models.length, { timeout: 40_000 }).toBeGreaterThan(0)
    const models = (await page.evaluate(() => window.novaCourt.getNovaState())).models
    // Every listed model is free by construction. Assert it rather than trusting the comment.
    expect(models.every((model) => /(-free|:free)$/.test(model.id))).toBe(true)

await page.getByRole('button', { name: 'New Nova session' }).click()
    await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getNovaState())).config.sessionId).toBeTruthy()

    // Karl writes into the shared courtroom and hands it to Nova.
    await page.getByRole('button', { name: 'Expand the shared conversation' }).click()

    // Walk the free list until a model genuinely answers. Each attempt uses a distinct token so the
    // append-only record does not treat a retry as a duplicate of the previous attempt.
    const candidates = models.map((model) => model.id).filter((id) => !UNUSABLE.test(id))
    if (!candidates.length) throw new Error('No usable zero-cost model is available')
    const failures: string[] = []
    let delivered = false

    for (const [attempt, modelId] of candidates.entries()) {
      await page.getByRole('combobox', { name: 'Free Nova model' }).selectOption(modelId)
      const token = `NOVAM4HANDOFF${attempt}`
      await page.locator('select[aria-label="Recipient"]').selectOption('nova')
      await page.locator('textarea[aria-label="Message the court"]').fill(`Reply with exactly ${token} and nothing else. Do not use any tools.`)
      await page.getByRole('button', { name: 'Send to the court' }).click()

      await page.locator('[data-testid=court-message]').filter({ hasText: token }).getByRole('button', { name: /Send to Nova/ }).click()

      // Pending until the service confirms receipt. A model that dies upstream leaves `unconfirmed`,
      // which is the honest outcome — it is still never reported as a delivery.
      await expect(page.getByTestId('handoff-status')).toHaveText(/AWAITING REPLY|PREPARING HANDOFF|ERROR/)
      const pending = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.text.includes(token))!
      expect(['awaiting-send', 'sent', 'unconfirmed']).toContain(pending.delivery)

      // The genuine reply must appear in the transcript, attributed to Nova with its real source.
      // Stop as soon as the outcome is decided: a live reply, or an honest error from a model that
      // is listed as free but has been retired upstream. Waiting out the full budget on a dead model
      // would make the walk over the free list take hours.
      const deadline = Date.now() + 75_000
      while (Date.now() < deadline) {
        const decided = await page.evaluate(async () => {
          if ((await window.novaCourt.getCourtMessages()).some((m) => m.sender === 'nova' && m.source === 'connected')) return 'reply'
          return (await window.novaCourt.getHandoffState()).status === 'error' ? 'error' : ''
        })
        if (decided) break
        await page.waitForTimeout(1000)
      }
      const arrived = (await page.evaluate(() => window.novaCourt.getCourtMessages())).some((m) => m.sender === 'nova' && m.source === 'connected')

      if (arrived) { delivered = true; break }
      // A dead upstream model is an honest error and no reply at all. Move on to the next free model.
      const state = await page.evaluate(() => window.novaCourt.getHandoffState())
      failures.push(`${modelId}: ${state.detail ?? state.status}`)
      expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.sender === 'nova')).toHaveLength(0)
    }

    if (!delivered) throw new Error(`No zero-cost model answered. Attempts:\n${failures.join('\n')}`)

    const reply = (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.sender === 'nova')!
    expect(reply.text).toMatch(/NOVAM4HANDOFF/)
    expect(reply.delivery).toBe('sent')
    expect(reply.externalId).toBeTruthy()

    // Deny-all chat-only safety held: no tool was used.
    const nova = await page.evaluate(() => window.novaCourt.getNovaState())
    expect(nova.messages.flatMap((message) => message.tools)).toEqual([])

    // Re-publishing state must not duplicate the reply.
    const beforeCount = (await page.evaluate(() => window.novaCourt.getCourtMessages())).length
    await page.getByRole('tab', { name: 'Nova Chat' }).click()
    await page.getByRole('tab', { name: 'Nova Chat' }).click()
    await page.waitForTimeout(3000)
    expect((await page.evaluate(() => window.novaCourt.getCourtMessages())).length).toBe(beforeCount)

    await page.screenshot({ path: resolve(results, 'm4-live-nova-handoff.png') })

    // Karl can copy Nova's genuine reply back out to Astra.
    await page.locator(`[data-testid=court-message]`).filter({ hasText: 'NOVAM4HANDOFF' }).last().getByRole('button', { name: /Copy for Astra/ }).click()
    expect(await page.evaluate(() => window.novaCourt.readClipboard())).toContain('NOVAM4HANDOFF')
    expect(errors).toEqual([])
  } finally { await app.close() }
})
