import { test, expect, _electron as electron, type Page } from '@playwright/test'

/**
 * LIVE three-way conversation against real ChatGPT and a real OpenCode server.
 *
 * Uses the default userData profile — the one holding the signed-in ChatGPT partition and the configured
 * deny-all Nova session. Any temp profile would be signed out and could not answer.
 *
 * Polls the main-process services rather than the DOM, because the shared conversation starts collapsed
 * and its status badge is not rendered until it is opened.
 *
 * This writes to Karl's real transcript. That is the point of a live test.
 *
 * It is also the only test that sends a message to a PAID model, because Nova's default seat is now
 * opencode-go/space-bunny rather than a free one. That makes an ungated run both a network call to
 * ChatGPT and a billable request, so it is opt-in like every other live test here. It was previously
 * ungated by omission and ran in the default suite.
 */
const MESSAGE = 'Live test: please each state your name and your role in this courtroom, in one short sentence.'

test('LIVE: Karl to Astra to Nova to Karl', async () => {
  test.skip(process.env.NC_V2_REAL_THREEWAY !== '1', 'Run explicitly with NC_V2_REAL_THREEWAY=1; makes real ChatGPT and PAID model requests')
  test.setTimeout(900_000)

  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, NC_V2_TEST: '0', NC_V2_ASTRA_FIXTURE: '0' }
  })

  const errors: string[] = []
  try {
    await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url(), { timeout: 60_000 }).toContain('/index.html')
    const page = app.windows().find((w) => w.url().endsWith('/index.html'))! as Page
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text()}`) })

    // A wide window so ChatGPT serves its desktop layout rather than the mobile shell, which the Astra
    // panel at its default ~470px width would otherwise trigger.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(2560, 1400))
    await new Promise((r) => setTimeout(r, 8000))

    const mark = `LIVE-${Date.now()}`
    const topic = `${mark} ${MESSAGE}`

    const before = await page.evaluate(() => window.novaCourt.getCourtMessages())
    console.log('KARL: existing messages =', before.length)

    const astraStatus = await page.evaluate(() => window.novaCourt.readAstraStatus())
    console.log('ASTRA STATUS:', JSON.stringify(astraStatus))
    if (astraStatus.phase === 'sign-in-page') throw new Error('ChatGPT shows a sign-in page; Karl must sign in manually.')

    let nova = await page.evaluate(() => window.novaCourt.getNovaState())
    if (nova.connection !== 'connected') nova = await page.evaluate(() => window.novaCourt.connectNova())
    console.log('NOVA:', nova.connection, 'session=', nova.config.sessionId, 'model=', nova.config.modelId, 'err=', nova.error)
    if (nova.connection !== 'connected') throw new Error(`Nova not connected: ${nova.error}`)
    const activeSession = nova.sessions.find((s) => s.id === nova.config.sessionId)
    if (!activeSession?.safe) throw new Error('Nova session is not a verified chat-only session.')
    console.log('NOVA SESSION SAFE:', activeSession.safe)

    // ---- Karl submits exactly one message ----
    await page.locator('textarea[aria-label="Message the court"]').fill(topic)
    await page.getByRole('button', { name: 'Send to the court' }).click()
    console.log('KARL: submitted at', new Date().toISOString())

    // ---- Wait for the pipeline to reach control-returned-to-Karl ----
    let lastStages = ''
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.novaCourt.getUnifiedTurnState())
      const turn = state.active ?? state.turns[state.turns.length - 1]
      if (!turn) return false
      const summary = Object.entries(turn.stages).map(([k, v]) => `${k}=${(v as any).status}`).join(' ')
      if (summary !== lastStages) {
        lastStages = summary
        console.log(new Date().toISOString(), 'STAGES:', summary)
        for (const m of await page.evaluate(() => window.novaCourt.getCourtMessages())) {
          if (m.delivery !== 'local') console.log('   delivery:', m.sender, m.delivery)
        }
      }
      return turn.stages['returned-to-karl'].status === 'complete'
    }, { timeout: 600_000, intervals: [3000, 5000, 8000, 12000] }).toBe(true).catch(async () => {
      throw new Error(`Never returned to Karl. Last stages: ${lastStages}\nErrors:\n${errors.join('\n')}`)
    })
    console.log('CONTROL RETURNED AT', new Date().toISOString())

    const after = await page.evaluate(() => window.novaCourt.getCourtMessages())
    const fresh = after.filter((m: any) => !before.some((b: any) => b.id === m.id))
    console.log('--- NEW COURT MESSAGES ---')
    for (const m of fresh) {
      console.log(JSON.stringify({ sender: m.sender, recipient: m.recipient, source: m.source, delivery: m.delivery, turnId: m.turnId, text: m.text }, null, 2))
    }
    console.log('Karl messages carrying the live mark:', fresh.filter((m: any) => m.sender === 'karl' && m.text.includes(mark)).length)
    console.log('Astra messages:', fresh.filter((m: any) => m.sender === 'astra').length)
    console.log('Nova messages:', fresh.filter((m: any) => m.sender === 'nova').length)

    const state2 = await page.evaluate(() => window.novaCourt.getUnifiedTurnState())
    console.log('--- FINAL STAGES ---', JSON.stringify(state2.active?.stages ?? null, null, 2))

    const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
    console.log('--- DISCUSSION ---', JSON.stringify({ state: discussion.discussion?.state, turnCount: discussion.discussion?.turnCount, currentTurn: discussion.discussion?.currentTurn }))
    console.log('--- DISCUSSION TURNS ---')
    for (const t of discussion.turns.slice(-4)) console.log(`  turn ${t.turn} speaker=${t.speaker} recipient=${t.recipient} messageId=${t.messageId}`)

    console.log('--- ERRORS ---', errors.length ? errors.join('\n') : '(none)')
  } finally {
    await app.close()
  }
})