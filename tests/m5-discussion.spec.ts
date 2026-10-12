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
  await page.getByRole('button', { name: 'Expand the shared conversation' }).click()
  return { app, page }
}

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'm5-discussion-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

/**
 * Records a court message through the preload bridge.
 *
 * The unified-chat renderer replaced the per-sender, per-recipient composer with a single composer for
 * the whole court, so the routing cases this file covers are driven through the same bridge the
 * renderer calls. The behaviour under test — who a message is addressed to, and whether a repeat is
 * refused — lives entirely in the conversation service, so nothing is lost by not going through the
 * removed controls. Assertions are unchanged.
 */
async function compose(page: Page, text: string, to: 'astra' | 'nova' | 'court' | 'both' = 'court', sender: 'karl' | 'astra' | 'nova' = 'karl', source: 'manual' | 'imported' = 'manual') {
  const message = await page.evaluate(
    ({ body, recipient, from, kind }) => window.novaCourt.appendCourtMessage({ sender: from, recipient, text: body, source: kind }),
    { body: text, recipient: to, from: sender, kind: source }
  )
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text === text).length).toBe(expectedCount(to))
  return message
}

function expectedCount(to: string): number {
  return to === 'both' ? 2 : 1
}

/** Starts a two-participant discussion. Not three-way, so no automatic send is attempted. */
async function startDiscussion(page: Page, topic: string) {
  return page.evaluate((value) => window.novaCourt.startDiscussion({ topic: value, maxTurns: 6, participants: ['astra', 'nova'] }), topic)
}

async function nextTurn(page: Page) {
  return page.evaluate(() => window.novaCourt.nextDiscussionTurn())
}

test.describe('M5 Discussion routing', () => {
  test('Karl → Both creates two messages with correct recipients', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Astra and Nova, please review this.', 'both')
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const bothMessages = messages.filter((m: any) => m.text === 'Astra and Nova, please review this.')
      expect(bothMessages).toHaveLength(2)
      const recipients = bothMessages.map((m: any) => m.recipient).sort()
      expect(recipients).toEqual(['astra', 'nova'])
      expect(bothMessages[0].sender).toBe('karl')
      expect(bothMessages[0].source).toBe('manual')
    } finally { await app.close() }
  })

  test('Karl → Astra routing shows correct recipient label', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Astra only message.', 'astra')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Astra only message' })).toContainText('TO ASTRA')
    } finally { await app.close() }
  })

  test('Karl → Nova routing shows correct recipient label', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Nova only message.', 'nova')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Nova only message' })).toContainText('TO NOVA')
    } finally { await app.close() }
  })

  test('Karl → Court routing shows correct recipient label', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Court message.', 'court')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Court message' })).toContainText('TO THE WHOLE COURT')
    } finally { await app.close() }
  })

  test('Forward preserves original and creates copy with new recipient', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const original = await compose(page, 'Original message for forwarding.', 'astra')
      await page.evaluate((id) => window.novaCourt.forwardCourtMessage(id, 'nova'), original.id)
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const forwarded = messages.find((m: any) => m.forwardedFrom && m.text === 'Original message for forwarding.')
      expect(forwarded).toBeTruthy()
      if (!forwarded) throw new Error('Forwarded message not found')
      expect(forwarded.recipient).toBe('nova')
      expect(forwarded.source).toBe('manual')
      // The original is never modified; the copy points back at it.
      const source = messages.find((m: any) => m.id === forwarded.forwardedFrom)
      expect(source).toBeTruthy()
      if (!source) throw new Error('Original message not found')
      expect(source.recipient).toBe('astra')
      await expect(page.locator('.tag-forward')).toHaveCount(1)
    } finally { await app.close() }
  })

  test('Sender attribution is correct for all participants', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Karl speaking.', 'court')
      await compose(page, 'Astra speaking.', 'court', 'astra', 'imported')
      await compose(page, 'Nova speaking.', 'court', 'nova', 'imported')

      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const karlMsg = messages.find((m: any) => m.text === 'Karl speaking.')
      const astraMsg = messages.find((m: any) => m.text === 'Astra speaking.')
      const novaMsg = messages.find((m: any) => m.text === 'Nova speaking.')
      expect(karlMsg).toBeTruthy()
      expect(astraMsg).toBeTruthy()
      expect(novaMsg).toBeTruthy()
      if (!karlMsg || !astraMsg || !novaMsg) throw new Error('Message not found')
      expect(karlMsg.sender).toBe('karl')
      expect(karlMsg.source).toBe('manual')
      expect(astraMsg.sender).toBe('astra')
      expect(astraMsg.source).toBe('imported')
      expect(novaMsg.sender).toBe('nova')
      expect(novaMsg.source).toBe('imported')

      // Attribution is visible, not merely recorded.
      await expect(page.locator('[data-testid=court-message][data-sender=astra]').filter({ hasText: 'Astra speaking.' })).toHaveCount(1)
      await expect(page.locator('[data-testid=court-message][data-sender=nova]').filter({ hasText: 'Nova speaking.' })).toHaveCount(1)
      // And the source filter separates composed from imported.
      await page.locator('select[aria-label="Filter by source"]').selectOption('imported')
      await expect(page.getByTestId('court-message')).toHaveCount(2)
      const importedText = (await page.locator('[data-testid=court-message] .court-message-text').allTextContents()).join(' ')
      expect(importedText).toContain('Astra speaking.')
      expect(importedText).toContain('Nova speaking.')
      expect(importedText).not.toContain('Karl speaking.')
      await page.locator('select[aria-label="Filter by source"]').selectOption('all')
      await expect(page.getByTestId('court-message')).toHaveCount(3)
    } finally { await app.close() }
  })
})

test.describe('M5 Discussion turn management', () => {
  test('Start discussion creates discussion with ready state', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Should we animate the courtroom?')
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      if (!discussion.discussion) throw new Error('Discussion not found')
      expect(discussion.discussion.state).toBe('ready')
      expect(discussion.discussion.topic).toBe('Should we animate the courtroom?')
      expect(discussion.discussion.maxTurns).toBe(6)
      expect(discussion.discussion.participants).toEqual(['astra', 'nova'])
    } finally { await app.close() }
  })

  test('Next turn advances to Astra first', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Topic for discussion.')
      await nextTurn(page)
      const { discussion, turns } = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion!.state).toBe('awaiting-astra')
      expect(turns).toHaveLength(1)
      expect(turns[0]!.turn).toBe(1)
      expect(turns[0]!.speaker).toBe('astra')
      // Astra's answer is addressed to whoever speaks next.
      expect(turns[0]!.recipient).toBe('nova')
    } finally { await app.close() }
  })

  test('Discussion pauses and resumes correctly', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Topic.')
      await nextTurn(page)
      expect((await page.evaluate(() => window.novaCourt.getDiscussionState())).discussion!.state).toBe('awaiting-astra')

      await page.evaluate(() => window.novaCourt.pauseDiscussion())
      expect((await page.evaluate(() => window.novaCourt.getDiscussionState())).discussion!.state).toBe('paused')
      // A paused discussion refuses to advance rather than silently skipping a turn.
      await expect(page.evaluate(() => window.novaCourt.nextDiscussionTurn())).rejects.toThrow(/paused/i)

      await page.evaluate(() => window.novaCourt.resumeDiscussion())
      const resumed = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(resumed.discussion!.state).toBe('awaiting-astra')
      // Resuming returns control to whoever was due to speak, not to the start.
      expect(resumed.discussion!.currentTurn).toBe('astra')
      expect(resumed.discussion!.turnCount).toBe(1)
    } finally { await app.close() }
  })

  test('Discussion ends and shows completed state', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Topic.')
      let discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      await page.evaluate(() => window.novaCourt.endDiscussion())
      // After ending, there should be no active discussion.
      discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeNull()
    } finally { await app.close() }
  })

  test('Discussion turn limit is enforced', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Short discussion.')
      for (let i = 0; i < 6; i += 1) await nextTurn(page)
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      // Completed discussions are filtered out of the active view.
      expect(discussion.discussion).toBeNull()
      // The turn limit is recorded rather than silently dropped.
      const turns = discussion.turns.filter((t: any) => t.discussionId === discussion.turns[discussion.turns.length - 1].discussionId)
      expect(turns.length).toBeLessThanOrEqual(6)
    } finally { await app.close() }
  })
})

test.describe('M5 Duplicate prevention and turn ordering', () => {
  test('Duplicate message to both is refused', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Duplicate test message.', 'both')
      // Try to record the same message again - should be refused.
      const duplicate = await page.evaluate(
        () => window.novaCourt.appendCourtMessage({ sender: 'karl', recipient: 'both', text: 'Duplicate test message.', source: 'manual' })
          .then(() => 'accepted', (e: Error) => e.message)
      )
      expect(duplicate).toMatch(/already in the conversation/)
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const bothMessages = messages.filter((m: any) => m.text === 'Duplicate test message.')
      expect(bothMessages).toHaveLength(2) // Original two messages (one per recipient)
    } finally { await app.close() }
  })

  test('Discussion turns are recorded in order', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Ordered discussion.')
      await nextTurn(page) // turn 1 -> astra
      await nextTurn(page) // turn 2 -> nova
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.turns.length).toBe(2)
      expect(discussion.turns[0].turn).toBe(1)
      expect(discussion.turns[0].speaker).toBe('astra')
      expect(discussion.turns[1].turn).toBe(2)
      expect(discussion.turns[1].speaker).toBe('nova')
      // Turns are stored in chronological order, not merely present.
      const times = discussion.turns.map((t: any) => t.createdAt)
      expect([...times].sort()).toEqual(times)
    } finally { await app.close() }
  })
})

test.describe('M5 Karl interruption and recipient change', () => {
  test('Karl can interrupt discussion by ending it', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await startDiscussion(page, 'Interruptible discussion.')
      await nextTurn(page)
      expect((await page.evaluate(() => window.novaCourt.getDiscussionState())).discussion!.state).toBe('awaiting-astra')
      await page.evaluate(() => window.novaCourt.endDiscussion())
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeNull() // Completed discussions are filtered out
    } finally { await app.close() }
  })

  test('Karl can address each agent separately in the same conversation', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // What the removed recipient control provided — a message aimed at one seat — is still a valid
      // record and is still addressable per seat.
      await compose(page, 'Changing recipient test.', 'astra')
      await compose(page, 'Now to Nova.', 'nova')
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const astraMsg = messages.find((m: any) => m.text === 'Changing recipient test.')
      const novaMsg = messages.find((m: any) => m.text === 'Now to Nova.')
      expect(astraMsg).toBeTruthy()
      expect(novaMsg).toBeTruthy()
      if (!astraMsg || !novaMsg) throw new Error('Message not found')
      expect(astraMsg.recipient).toBe('astra')
      expect(novaMsg.recipient).toBe('nova')
    } finally { await app.close() }
  })
})

test.describe('M5 Security - discussion messages do not authorize execution', () => {
  test('Discussion message mentioning commands does not trigger terminal', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Nova: run npm test in the terminal.', 'nova')
      await expect(page.locator('[data-testid=court-message]')).toHaveCount(1)
      const terminalState = await page.evaluate(() => window.novaCourt.getTerminalState())
      expect(terminalState.status).toBe('idle')
      expect(terminalState.pid).toBeNull()
    } finally { await app.close() }
  })

  test('Discussion service has no access to terminal or Nova services', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app } = await launch(userData)
    try {
      // Check main process for discussion handlers
      const bundle = readFileSync(resolve(cwd, 'dist-electron/main.cjs'), 'utf8')
      const discussionRegistrations = bundle.split(/(?=ipcMain\.(?:handle|on)\()/).filter((chunk) => /^ipcMain\.(?:handle|on)\('discussion:/.test(chunk))
      for (const chunk of discussionRegistrations) {
        expect(chunk).not.toContain('terminalService')
        expect(chunk).not.toContain('novaService')
        expect(chunk).not.toContain('spawn')
      }
      const channels = [...new Set(discussionRegistrations.map((chunk) => chunk.match(/'(discussion:[^']+)'/)![1]))].sort()
      expect(channels).toEqual(['discussion:advanceTurn', 'discussion:end', 'discussion:nextTurn', 'discussion:pause', 'discussion:resume', 'discussion:start', 'discussion:state'])
    } finally { await app.close() }
  })

  test('Transcript persists after restart with discussion turns', async () => {
    test.setTimeout(180_000)
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Send a court message that will persist
      await compose(page, 'Persistent discussion message.', 'court')
      // Also start a discussion
      await startDiscussion(page, 'Persistent discussion.')
      await nextTurn(page)
      await page.screenshot({ path: resolve(results, 'm5-before-restart.png') })
    } finally { await app.close() }

    // Restart
    const { app: app2, page: page2 } = await launch(userData)
    try {
      // Thread might already be expanded, try to find and click expand button if collapsed
      const expandBtn = page2.getByRole('button', { name: /Expand the shared conversation/ })
      if (await expandBtn.isVisible().catch(() => false)) {
        await expandBtn.click()
      }
      const messages = await page2.evaluate(() => window.novaCourt.getCourtMessages())
      expect(messages.length).toBeGreaterThan(0)
      expect(messages.some((m: any) => m.text === 'Persistent discussion message.')).toBe(true)
      const discussion = await page2.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      if (!discussion.discussion) throw new Error('Discussion not found')
      expect(discussion.discussion.topic).toBe('Persistent discussion.')
      // The turn that was already spoken for is still recorded, not restarted.
      expect(discussion.discussion.turnCount).toBe(1)
      await page2.screenshot({ path: resolve(results, 'm5-after-restart.png') })
    } finally { await app2.close() }
  })
})