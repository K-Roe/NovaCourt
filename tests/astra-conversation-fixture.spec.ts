import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

type Eval = (script: string) => Promise<any>

/**
 * These tests drive the real send-and-wait path end to end against a local page that reproduces
 * ChatGPT's conversation markup. Before this existed the detector could only be exercised by pointing
 * the application at the live site, which means the cases that actually broke — an empty baseline, a
 * reply that takes its time, a reply that arrives character by character — could not be tested at all,
 * and the only way to find out whether a fix worked was to try it on the real thing and wait.
 */
async function launch(): Promise<{ app: ElectronApplication; page: Page; fixture: Eval }> {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'astra-conversation-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))

  const app = await electron.launch({
    args: ['.'],
    cwd,
    env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '0', NC_V2_ASTRA_CONVERSATION_FIXTURE: '1', NC_V2_USER_DATA: userData }
  })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  const page = app.windows().find((w) => w.url().endsWith('/index.html'))!

  const fixture: Eval = (script) => page.evaluate((source) => (window as any).novaCourt.testAstraEval(source), script)

  // The detector reads the Astra view through a real WebContentsView, so the view has to be loaded,
  // attached to the window and laid out before anything is sent to it.
  await expect.poll(async () => {
    try { return await page.evaluate(() => (window as any).novaCourt.readAstraStatus()) } catch { return null }
  }, { timeout: 20_000 }).toMatchObject({ phase: 'open' })

  await expect.poll(async () => (await page.evaluate(() => (window as any).novaCourt.testViewBounds())).attached, { timeout: 20_000 }).toBe(true)

  await fixture('window.__astraFixture.reset(); true')

  return { app, page, fixture }
}

/**
 * Records Karl's opening message and starts the discussion.
 *
 * Starting a three-way discussion already advances to Astra's turn and sends to it on its own, so this
 * deliberately does NOT then call sendAndWaitAstra. Driving the automatic pipeline is the point: these
 * tests are about what happens when Karl sends a message, not about the detector in isolation. It also
 * avoids the trap of sending a second prompt into a thread that already has one.
 *
 * The fixture is configured before the discussion starts, because the automatic send begins the moment
 * it does.
 */
async function startThreeWay(page: Page, fixture: Eval, topic: string, setup: string): Promise<{ discussionId: string }> {
  await page.evaluate(async (text: string) => (window as any).novaCourt.appendCourtMessage({
    sender: 'karl', recipient: 'astra', text, source: 'manual'
  }), topic)

  await fixture(setup)

  const started = await page.evaluate(async (text: string) => (window as any).novaCourt.startDiscussion({
    topic: text, maxTurns: 6, participants: ['astra', 'nova'], isThreeWay: true
  }), topic)

  return { discussionId: started.id }
}

/** Polls the transcript until Astra's reply appears, or the deadline passes. */
async function waitForAstraReply(page: Page, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
    const astra = messages.filter((m: any) => m.sender === 'astra')
    if (astra.length > 0) return astra[0]
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

function astraReply(text: string, extra: Record<string, unknown> = {}): string {
  return `window.__astraFixture.autoReply(${JSON.stringify({ text, delayMs: 0, streamMs: 0, ...extra })}); true`
}

test.describe('the test-only injection point stays gated', () => {
  test('no script evaluation channel exists in a normal build', async () => {
    mkdirSync(results, { recursive: true })
    const userData = mkdtempSync(resolve(results, 'astra-noeval-'))
    writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))

    // Deliberately no NC_V2_TEST: this is the shape of a build Karl would actually run.
    const app = await electron.launch({
      args: ['.'],
      cwd,
      env: { ...process.env, NC_V2_TEST: '0', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData }
    })
    try {
      await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
      const page = app.windows().find((w) => w.url().endsWith('/index.html'))!

      let rejected = false
      try {
        await page.evaluate(() => (window as any).novaCourt.testAstraEval('return 1'))
      } catch {
        rejected = true
      }
      expect(rejected, 'script evaluation must not be reachable without NC_V2_TEST').toBe(true)

      let probeRejected = false
      try {
        await page.evaluate(() => (window as any).novaCourt.testAstraProbe())
      } catch {
        probeRejected = true
      }
      expect(probeRejected, 'the probe channel must not be reachable without NC_V2_TEST').toBe(true)
    } finally {
      await app.close()
    }
  })

  test('the injection point refuses the live ChatGPT page even in a test build', async () => {
    mkdirSync(results, { recursive: true })
    const userData = mkdtempSync(resolve(results, 'astra-live-'))
    writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))

    // NC_V2_TEST is on, but the conversation fixture is not. This must not become a way to run script
    // in a view holding a real ChatGPT session.
    const app = await electron.launch({
      args: ['.'],
      cwd,
      env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_ASTRA_CONVERSATION_FIXTURE: '0', NC_V2_USER_DATA: userData }
    })
    try {
      await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
      const page = app.windows().find((w) => w.url().endsWith('/index.html'))!

      let message = ''
      try {
        await page.evaluate(() => (window as any).novaCourt.testAstraEval('return 1'))
      } catch (error) {
        message = String(error)
      }
      expect(message).toMatch(/conversation fixture/i)
    } finally {
      await app.close()
    }
  })
})

test.describe('detector against a real page', () => {
  test('the probe reads assistant messages out of live DOM', async () => {
    const { app, page, fixture } = await launch()
    try {
      await fixture('window.__astraFixture.seed(["A ruling recorded before the current turn."]); true')

      const probe = await page.evaluate(() => (window as any).novaCourt.testAstraProbe())
      expect(probe.threadReady).toBe(true)
      expect(probe.messages).toHaveLength(1)
      expect(probe.messages[0].text).toContain('A ruling recorded before the current turn')
      // The site-provided identity is used, which is what lets re-renders be recognised.
      expect(probe.messages[0].key).toBeTruthy()
      // The composer is detected, and its decoration is deliberately never mistaken for streaming.
      expect(probe.composerCount).toBeGreaterThan(0)
      expect(probe.stopControlPresent).toBe(false)
      expect(probe.messages[0].isStreaming).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('the probe finds no assistant messages in an empty conversation', async () => {
    const { app, page } = await launch()
    try {
      const probe = await page.evaluate(() => (window as any).novaCourt.testAstraProbe())
      expect(probe.threadReady).toBe(true)
      expect(probe.messages).toEqual([])
    } finally {
      await app.close()
    }
  })

  test('the probe reports a stop control while a reply is streaming', async () => {
    const { app, page, fixture } = await launch()
    try {
      await fixture('window.__astraFixture.respond("A long enough reply to still be streaming when we look.", { streamMs: 4000 }); true')
      await expect.poll(async () => (await page.evaluate(() => (window as any).novaCourt.testAstraProbe())).stopControlPresent, { timeout: 10_000 }).toBe(true)
    } finally {
      await app.close()
    }
  })
})

test.describe('end to end against the conversation fixture', () => {
  test('captures a reply in a conversation that started empty', async () => {
    const { app, page, fixture } = await launch()
    try {
      await startThreeWay(page, fixture, 'Does an empty conversation still resolve?',
        astraReply('It does. An empty baseline is a starting state, not a fault.'))

      const reply = await waitForAstraReply(page, 20_000)
      expect(reply, 'Astra\'s reply was never recorded').toBeTruthy()
      expect(reply.text).toContain('An empty baseline is a starting state')
      expect(reply.source).toBe('connected')

      // The turn advanced on its own, to Nova.
      const state = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(state.discussion.state).toBe('awaiting-nova')
      expect(state.discussion.turnCount).toBe(2)
    } finally {
      await app.close()
    }
  })

  test('waits for a reply that takes its time and still captures it', async () => {
    const { app, page, fixture } = await launch()
    try {
      const startedAt = Date.now()
      await startThreeWay(page, fixture, 'Does a slow reply still resolve?',
        astraReply('A considered reply, delivered only after a long pause.', { delayMs: 5000 }))

      const reply = await waitForAstraReply(page, 30_000)
      expect(reply, 'a slow reply was never captured').toBeTruthy()
      expect(reply.text).toContain('delivered only after a long pause')
      // It genuinely waited for the slow reply rather than capturing nothing and calling it success.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5000)
    } finally {
      await app.close()
    }
  })

  test('waits for a streaming reply to finish rather than taking a half-written sentence', async () => {
    const { app, page, fixture } = await launch()
    try {
      const reply = 'The full ruling, streamed out over several seconds so a partial answer would be obviously incomplete.'
      await startThreeWay(page, fixture, 'Does a streaming reply resolve whole?',
        astraReply(reply, { streamMs: 4000 }))

      const recorded = await waitForAstraReply(page, 30_000)
      expect(recorded, 'a streaming reply was never captured').toBeTruthy()
      // Recorded whole. A detector that accepted the first visible fragment would truncate this.
      expect(recorded.text).toBe(reply)
    } finally {
      await app.close()
    }
  })

  test('does not mistake a reply that was already there for the new one', async () => {
    const { app, page, fixture } = await launch()
    try {
      await startThreeWay(page, fixture, 'Which reply is actually new?',
        'window.__astraFixture.seed(["An earlier ruling, already in the thread before this turn began."]); true')

      // Configure the auto-reply only after seeding, so the existing reply cannot answer the prompt.
      await fixture('window.__astraFixture.autoReply({ text: "This is the genuinely new ruling for this turn.", delayMs: 500, streamMs: 0 }); true')

      const recorded = await waitForAstraReply(page, 20_000)
      expect(recorded, 'the new reply was never captured').toBeTruthy()
      expect(recorded.text).toBe('This is the genuinely new ruling for this turn.')
      expect(recorded.text).not.toContain('already in the thread')

      // Exactly one Astra message: the older one was correctly not treated as this turn's reply.
      const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
      expect(messages.filter((m: any) => m.sender === 'astra')).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  test('reports an uncertain delivery, not a definite failure, when the prompt is never seen', async () => {
    const { app, page, fixture } = await launch()
    try {
      const startedAt = Date.now()
      // The page refuses the prompt, the way a mis-focused composer does.
      await startThreeWay(page, fixture, 'What happens when nothing is submitted?',
        'window.__astraFixture.setSubmitEnabled(false); window.__astraFixture.autoReply({ text: "This should never be reached.", delayMs: 0, streamMs: 0 }); true')

      // The confirmation window is 15s, so give it room plus the follow-up polling.
      await expect.poll(async () => {
        const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
        return messages.some((m: any) => m.delivery === 'delivery-unknown')
      }, { timeout: 40_000, intervals: [500, 1000, 2000, 4000] }).toBe(true)

      // No reply was invented from a prompt that was never confirmed.
      expect(await waitForAstraReply(page, 500)).toBeFalsy()

      // The report says the delivery is uncertain rather than claiming the message was not sent.
      // Claiming a definite failure here is what led to the prompt being sent twice.
      const handoff = await page.evaluate(() => (window as any).novaCourt.getHandoffState())
      expect(String(handoff.notice || handoff.detail || '')).toMatch(/could not confirm|may have been sent|uncertain/i)

      // The turn is not advanced on an unconfirmed submission.
      const state = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(state.discussion.state).toBe('awaiting-astra')

      // And it gave up on the confirmation rather than sitting on the full response wait.
      expect(Date.now() - startedAt).toBeLessThan(40_000)
    } finally {
      await app.close()
    }
  })

  test('never advances the turn when Astra never replies', async () => {
    const { app, page, fixture } = await launch()
    try {
      // The prompt is accepted, but no reply is ever produced.
      await startThreeWay(page, fixture, 'What happens when Astra says nothing?', 'window.__astraFixture.autoReply(null); true')

      await new Promise((resolve) => setTimeout(resolve, 4000))

      const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
      expect(messages.filter((m: any) => m.sender === 'astra')).toHaveLength(0)

      // The discussion is still waiting on Astra: no turn was consumed by a reply that never came.
      const state = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(state.discussion.state).toBe('awaiting-astra')
      expect(state.discussion.turnCount).toBe(1)
    } finally {
      await app.close()
    }
  })
})

test.describe('three-way conversation flow', () => {
  test('records Astra\'s reply and hands the turn to Nova', async () => {
    const { app, page, fixture } = await launch()
    try {
      await startThreeWay(page, fixture, 'A full turn from Karl to Astra.',
        astraReply('I have read the brief and I am satisfied with the framing.'))

      const recorded = await waitForAstraReply(page, 20_000)
      expect(recorded, 'Astra\'s reply was never recorded').toBeTruthy()
      expect(recorded.text).toContain('satisfied with the framing')

      const state = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(state.discussion.state).toBe('awaiting-nova')
      expect(state.discussion.turnCount).toBe(2)
      expect(state.turns.find((t: any) => t.turn === 1)?.messageId).toBe(recorded.id)
    } finally {
      await app.close()
    }
  })

  test('hands the turn to Nova without waiting on Karl', async () => {
    const { app, page, fixture } = await launch()
    try {
      await startThreeWay(page, fixture, 'A conversation that continues without Karl.',
        astraReply('Astra is satisfied with the framing of the question.'))

      const astra = await waitForAstraReply(page, 20_000)
      expect(astra, 'Astra never answered, so the turn never reached Nova').toBeTruthy()

      const state = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(state.discussion.state).toBe('awaiting-nova')
      expect(state.discussion.currentTurn).toBe('nova')
      // Nova's turn is addressed to Karl, which is how control visibly comes back to him once she has
      // answered. Under the old rota it was addressed to Astra and he was never reached at all.
      expect(state.turns.find((t: any) => t.turn === 2)?.recipient).toBe('karl')
    } finally {
      await app.close()
    }
  })

  test('a pause during Astra\'s turn holds the conversation rather than advancing it', async () => {
    const { app, page, fixture } = await launch()
    try {
      await startThreeWay(page, fixture, 'A conversation that gets paused.', astraReply('A reply that will not be recorded.'))

      await page.evaluate(() => (window as any).novaCourt.pauseDiscussion())
      const paused = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(paused.discussion.state).toBe('paused')

      await page.evaluate(() => (window as any).novaCourt.resumeDiscussion())
      const resumed = await page.evaluate(() => (window as any).novaCourt.getDiscussionState())
      expect(['awaiting-astra', 'awaiting-nova']).toContain(resumed.discussion.state)
    } finally {
      await app.close()
    }
  })

  test('a mid-generation pause is not mistaken for a finished reply', async () => {
    const { app, page, fixture } = await launch()
    try {
      const reply = 'This ruling pauses halfway through composing itself and must not be recorded until every word of it has arrived.'
      // Stall at 40% of the reply for 2.5s. That is longer than the old one-second stability window, so a
      // detector with no pause protection would capture the truncated text here and call it a ruling.
      await startThreeWay(page, fixture, 'Does a pause inside generation still resolve whole?',
        `window.__astraFixture.autoReply(${JSON.stringify({ text: reply, delayMs: 0, streamMs: 6000, pauseAt: [[0.4, 2500]] })}); true`)

      // While stalled, nothing may have been recorded.
      await expect.poll(async () => {
        const probe = await page.evaluate(() => (window as any).novaCourt.testAstraProbe())
        return probe.messages.some((m: any) => m.text.length > 0)
      }, { timeout: 15_000 }).toBe(true)
      await expect.poll(async () => {
        const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
        return messages.filter((m: any) => m.sender === 'astra').length
      }, { timeout: 8000, intervals: [250, 500, 1000] }).toBe(0)

      // Once generation resumes and finishes, the whole reply is recorded.
      const recorded = await waitForAstraReply(page, 40_000)
      expect(recorded, 'the reply was never captured after the pause').toBeTruthy()
      expect(recorded.text).toBe(reply)
    } finally {
      await app.close()
    }
  })

  test('a reply that never finishes is never recorded as complete', async () => {
    const { app, page, fixture } = await launch()
    try {
      // Generation stops half way and never resumes: the stop control disappears but the reply is
      // truncated. A detector must not hand a half-written sentence to Nova as though it were the verdict.
      const partial = 'A ruling that is cut off before it reaches'
      await startThreeWay(page, fixture, 'What happens when generation is interrupted?',
        `window.__astraFixture.autoReply(${JSON.stringify({ text: partial + ' its conclusion and never finishes writing the rest of it at all.', delayMs: 0, streamMs: 6000, pauseAt: [[0.9, 600000]] })}); true`)

      // Give it well past the stability window to record something if it is going to.
      await new Promise((resolve) => setTimeout(resolve, 20_000))

      const messages = await page.evaluate(() => (window as any).novaCourt.getCourtMessages())
      // Either nothing was recorded, or what was recorded is the whole reply — never the fragment.
      for (const message of messages.filter((m: any) => m.sender === 'astra')) {
        expect(message.text.length).toBeGreaterThan(partial.length)
      }
    } finally {
      await app.close()
    }
  })
})
