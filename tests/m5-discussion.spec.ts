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

async function compose(page: Page, text: string, to: 'astra' | 'nova' | 'court' | 'both' = 'court', expectedCount = 1) {
  await page.locator('select[aria-label="Recipient"]').selectOption(to)
  await page.locator('textarea[aria-label="Message the court"]').fill(text)
  await page.getByRole('button', { name: 'Send to the court' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.novaCourt.getCourtMessages())).filter((m) => m.text === text).length).toBe(expectedCount)
  return (await page.evaluate(() => window.novaCourt.getCourtMessages())).find((m) => m.text === text)!
}

test.describe('M5 Discussion routing', () => {
  test('Karl → Both creates two messages with correct recipients', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Astra and Nova, please review this.', 'both', 2)
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
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Astra only message.', 'astra')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Astra only message' })).toContainText('TO ASTRA')
    } finally { await app.close() }
  })

  test('Karl → Nova routing shows correct recipient label', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Nova only message.', 'nova')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Nova only message' })).toContainText('TO NOVA')
    } finally { await app.close() }
  })

  test('Karl → Court routing shows correct recipient label', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Court message.', 'court')
      await expect(page.locator('[data-testid=court-message]').filter({ hasText: 'Court message' })).toContainText('TO THE WHOLE COURT')
    } finally { await app.close() }
  })

  test('Forward preserves original and creates copy with new recipient', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Original message for forwarding.', 'astra')
      await page.locator('[data-testid=court-message]').filter({ hasText: 'Original message' }).getByRole('button', { name: /Forward/ }).click()
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const forwarded = messages.find((m: any) => m.forwardedFrom && m.text === 'Original message for forwarding.')
      expect(forwarded).toBeTruthy()
      if (!forwarded) throw new Error('Forwarded message not found')
      expect(forwarded.recipient).toBe('nova')
      expect(forwarded.source).toBe('manual')
      // Original unchanged
      const original = messages.find((m: any) => m.id === forwarded.forwardedFrom)
      expect(original).toBeTruthy()
      if (!original) throw new Error('Original message not found')
      expect(original.recipient).toBe('astra')
    } finally { await app.close() }
  })

  test('Sender attribution is correct for all participants', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Karl composes
      await page.locator('select[aria-label="Sender"]').selectOption('karl')
      await compose(page, 'Karl speaking.', 'court')
      // Astra imported
      await page.locator('select[aria-label="Sender"]').selectOption('astra')
      await page.locator('.court-mode-toggle button').nth(1).click()
      await page.locator('textarea[aria-label="Message the court"]').fill('Astra speaking.')
      await page.getByRole('button', { name: 'Send to the court' }).click()
      // Nova connected (simulated)
      await page.locator('select[aria-label="Sender"]').selectOption('nova')
      await page.locator('.court-mode-toggle button').nth(1).click()
      await page.locator('textarea[aria-label="Message the court"]').fill('Nova speaking.')
      await page.getByRole('button', { name: 'Send to the court' }).click()

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
    } finally { await app.close() }
  })
})

test.describe('M5 Discussion turn management', () => {
  test('Start discussion creates discussion with ready state', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Should we animate the courtroom?')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await expect(page.locator('.discussion-state.is-ready')).toBeVisible()
      await expect(page.locator('.discussion-turn')).toContainText('Turn 0/6')
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      if (!discussion.discussion) throw new Error('Discussion not found')
      expect(discussion.discussion.state).toBe('ready')
      expect(discussion.discussion.maxTurns).toBe(6)
      expect(discussion.discussion.participants).toEqual(['astra', 'nova'])
    } finally { await app.close() }
  })

  test('Next turn advances to Astra first', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Topic for discussion.')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await page.getByRole('button', { name: /Start Discussion/ }).click() // Next turn button
      await expect(page.locator('.discussion-state.is-awaiting-astra')).toBeVisible()
      await expect(page.locator('.discussion-turn')).toContainText('Turn 1/6')
      await expect(page.locator('.discussion-turn strong')).toContainText('Astra')
    } finally { await app.close() }
  })

  test('Discussion pauses and resumes correctly', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Topic.')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await expect(page.locator('.discussion-state.is-awaiting-astra')).toBeVisible()
      await page.locator('button[title="Pause discussion"]').click()
      await expect(page.locator('.discussion-state.is-paused')).toBeVisible()
      await page.locator('button[title="Resume discussion"]').click()
      await expect(page.locator('.discussion-state.is-awaiting-astra')).toBeVisible()
    } finally { await app.close() }
  })

  test('Discussion ends and shows completed state', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Topic.')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      // Verify discussion is active before ending
      let discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      await page.locator('button[title="End discussion"]').click()
      // After ending, there should be no active discussion
      discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeNull()
    } finally { await app.close() }
  })

  test('Discussion turn limit is enforced', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Short discussion.')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      // Advance through all 6 turns using the next turn button
      for (let i = 0; i < 6; i++) {
        await expect.poll(async () => {
          const btn = page.locator('.court-discussion-controls button:not(.end-discussion)').first()
          if (await btn.isVisible().catch(() => false)) {
            await btn.click()
            return true
          }
          return false
        }, { timeout: 5000 }).toBeTruthy()
      }
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeNull() // Completed discussions are filtered out
    } finally { await app.close() }
  })
})

test.describe('M5 Duplicate prevention and turn ordering', () => {
  test('Duplicate message to both is refused', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await compose(page, 'Duplicate test message.', 'both', 2)
      // Try to send the same message again - should be refused
      await page.locator('textarea[aria-label="Message the court"]').fill('Duplicate test message.')
      await page.locator('select[aria-label="Recipient"]').selectOption('both')
      await page.getByRole('button', { name: 'Send to the court' }).click()
      await expect(page.locator('.court-thread-notice')).toContainText('already in the conversation')
      const messages = await page.evaluate(() => window.novaCourt.getCourtMessages())
      const bothMessages = messages.filter((m: any) => m.text === 'Duplicate test message.')
      expect(bothMessages).toHaveLength(2) // Original two messages (one per recipient)
    } finally { await app.close() }
  })

  test('Discussion turns are recorded in order', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Ordered discussion.')
      await page.getByRole('button', { name: /Start Discussion/ }).click() // startDiscussion() -> state=ready
      // First turn: click "Start Discussion" (ready state) -> nextTurn() -> state=awaiting-astra
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      // Now Astra's turn button should be visible - click it for turn 2 (Nova)
      await expect.poll(async () => {
        const btn = page.locator('button[title="Prepare message for Astra (manual clipboard handoff)"]')
        if (await btn.isVisible().catch(() => false)) {
          await btn.click()
          return true
        }
        return false
      }, { timeout: 5000 }).toBeTruthy()
      // Now we should have 2 turns recorded (turn 1: astra, turn 2: nova)
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.turns.length).toBe(2)
      expect(discussion.turns[0].turn).toBe(1)
      expect(discussion.turns[0].speaker).toBe('astra')
      expect(discussion.turns[1].turn).toBe(2)
      expect(discussion.turns[1].speaker).toBe('nova')
    } finally { await app.close() }
  })
})

test.describe('M5 Karl interruption and recipient change', () => {
  test('Karl can interrupt discussion by ending it', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Interruptible discussion.')
      await page.getByRole('button', { name: /Start Discussion/ }).click() // startDiscussion() -> state=ready
      await page.getByRole('button', { name: /Start Discussion/ }).click() // nextTurn() -> state=awaiting-astra
      await expect(page.locator('.discussion-state.is-awaiting-astra')).toBeVisible()
      await page.locator('button[title="End discussion"]').click()
      const discussion = await page.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeNull() // Completed discussions are filtered out
    } finally { await app.close() }
  })

  test('Karl can change recipient mid-composition', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Changing recipient test.')
      await page.locator('select[aria-label="Recipient"]').selectOption('astra')
      await page.getByRole('button', { name: 'Send to the court' }).click()
      await page.locator('textarea[aria-label="Message the court"]').fill('Now to Nova.')
      await page.locator('select[aria-label="Recipient"]').selectOption('nova')
      await page.getByRole('button', { name: 'Send to the court' }).click()
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
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      await page.locator('textarea[aria-label="Message the court"]').fill('Nova: run npm test in the terminal.')
      await page.getByRole('button', { name: 'Send to the court' }).click()
      await expect(page.locator('[data-testid=court-message]')).toHaveCount(1)
      const terminalState = await page.evaluate(() => window.novaCourt.getTerminalState())
      expect(terminalState.status).toBe('idle')
      expect(terminalState.pid).toBeNull()
    } finally { await app.close() }
  })

  test('Discussion service has no access to terminal or Nova services', async () => {
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
      expect(channels).toEqual(['discussion:end', 'discussion:nextTurn', 'discussion:pause', 'discussion:resume', 'discussion:start', 'discussion:state'])
    } finally { await app.close() }
  })

  test('Transcript persists after restart with discussion turns', async () => {
    const userData = freshUserData()
    let { app, page } = await launch(userData)
    try {
      // Send a court message that will persist
      await page.locator('textarea[aria-label="Message the court"]').fill('Persistent discussion message.')
      await page.getByRole('button', { name: 'Send to the court' }).click()
      // Also start a discussion
      await page.locator('textarea[aria-label="Message the court"]').fill('Persistent discussion.')
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await page.getByRole('button', { name: /Start Discussion/ }).click()
      await page.screenshot({ path: resolve(results, 'm5-before-restart.png') })
    } finally { await app.close() }

    // Restart
    let { app: app2, page: page2 } = await launch(userData)
    try {
      // Thread might already be expanded, try to find and click expand button if collapsed
      const expandBtn = page2.getByRole('button', { name: /Expand the shared conversation/ })
      if (await expandBtn.isVisible().catch(() => false)) {
        await expandBtn.click()
      }
      const messages = await page2.evaluate(() => window.novaCourt.getCourtMessages())
      expect(messages.length).toBeGreaterThan(0)
      const discussion = await page2.evaluate(() => window.novaCourt.getDiscussionState())
      expect(discussion.discussion).toBeTruthy()
      if (!discussion.discussion) throw new Error('Discussion not found')
      expect(discussion.discussion.topic).toBe('Persistent discussion.')
      await page2.screenshot({ path: resolve(results, 'm5-after-restart.png') })
    } finally { await app2.close() }
  })
})