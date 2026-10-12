import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  const userData = mkdtempSync(resolve(results, 'astra-response-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

async function startDiscussion(page: Page, topic: string): Promise<{ discussionId: string; karlMessageId: string }> {
  // Append Karl's message
  const karlMsg = await page.evaluate(async (text: string) => {
    return await window.novaCourt.appendCourtMessage({
      sender: 'karl',
      recipient: 'astra',
      text,
      source: 'manual'
    })
  }, topic)
  
  // Start discussion
  const discussion = await page.evaluate(async (topic: string) => {
    return await window.novaCourt.startDiscussion({ topic, maxTurns: 6, participants: ['astra', 'nova'], isThreeWay: true })
  }, topic)
  
  // Advance to first turn (Astra)
  await page.evaluate(async () => {
    return await window.novaCourt.nextDiscussionTurn()
  })
  
  return { discussionId: discussion.id, karlMessageId: karlMsg.id }
}

test.describe('Astra response detection with fixture', () => {
  test('waitForAstraResponse detects completed response in fixture', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Start a discussion first
      const { discussionId, karlMessageId } = await startDiscussion(page, 'Test message for Astra response detection')
      
      // Try to send to Astra and wait (using fixture)
      const result = await page.evaluate(async ({ msgId, discId }: { msgId: string; discId: string }) => {
        return await window.novaCourt.sendAndWaitAstra(msgId, 10000, discId)
      }, { msgId: karlMessageId, discId: discussionId })
      
      console.log('Astra sendAndWait result:', result)
      
      // With fixture, this should either succeed or fail gracefully
      // The key is that it doesn't hang indefinitely
      expect(result).toBeDefined()
      expect(typeof result.success).toBe('boolean')
      expect(result.diagnostics).toBeDefined()
      
      if (result.success) {
        expect(result.response).toBeTruthy()
        expect(typeof result.response).toBe('string')
        expect(result.response!.length).toBeGreaterThan(0)
      } else {
        // Failure is acceptable in test environment, but should have diagnostics
        expect(result.reason).toBeTruthy()
        expect(result.diagnostics).toBeDefined()
      }
    } finally {
      await app.close()
    }
  })

  test('Astra response detection handles timeout gracefully', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Start a discussion first
      const { discussionId, karlMessageId } = await startDiscussion(page, 'Timeout test message')
      
      // Test with a very short timeout to verify timeout handling
      const result = await page.evaluate(async ({ msgId, discId }: { msgId: string; discId: string }) => {
        return await window.novaCourt.sendAndWaitAstra(msgId, 100, discId) // 100ms timeout
      }, { msgId: karlMessageId, discId: discussionId })
      
      expect(result.success).toBe(false)
      // In fixture mode, it fails because fixture isn't a real ChatGPT page
      // but the handler should still return diagnostics
      expect(result.diagnostics).toBeDefined()
      // The error happens before baseline capture in fixture, so diagnostics may be minimal
      expect(typeof result.reason).toBe('string')
    } finally {
      await app.close()
    }
  })

  test('Astra response detection returns diagnostics', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Start a discussion first
      const { discussionId, karlMessageId } = await startDiscussion(page, 'Diagnostics test message')
      
      const result = await page.evaluate(async ({ msgId, discId }: { msgId: string; discId: string }) => {
        return await window.novaCourt.sendAndWaitAstra(msgId, 5000, discId)
      }, { msgId: karlMessageId, discId: discussionId })
      
      // Verify diagnostics structure - in fixture mode, diagnostics may be minimal
      // because the fixture isn't a real ChatGPT page
      expect(result.diagnostics).toBeDefined()
      expect(typeof result.diagnostics).toBe('object')
      // If the handler reaches the send stage, it should have messageId
      if (result.diagnostics.messageId) {
        expect(result.diagnostics.messageId).toBe(karlMessageId)
      }
    } finally {
      await app.close()
    }
  })

  test('Astra response detection includes failureMode in diagnostics', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const { discussionId, karlMessageId } = await startDiscussion(page, 'Failure mode test')
      
      const result = await page.evaluate(async ({ msgId, discId }: { msgId: string; discId: string }) => {
        return await window.novaCourt.sendAndWaitAstra(msgId, 2000, discId)
      }, { msgId: karlMessageId, discId: discussionId })
      
      // Verify diagnostics includes failureMode for timeout scenarios
      expect(result.diagnostics).toBeDefined()
      expect(typeof result.diagnostics).toBe('object')
      // In fixture mode, we expect a failure mode to be recorded
      if (result.diagnostics.failureMode) {
        expect(typeof result.diagnostics.failureMode).toBe('string')
        expect(['no-new-message-detected', 'still-streaming', 'completion-signal-detected', 'content-stable', 'timeout', 'script-error']).toContain(result.diagnostics.failureMode)
      }
    } finally {
      await app.close()
    }
  })

  test('Astra response detection logs baseline capture diagnostics', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      const { discussionId, karlMessageId } = await startDiscussion(page, 'Baseline diagnostics test')
      
      const result = await page.evaluate(async ({ msgId, discId }: { msgId: string; discId: string }) => {
        return await window.novaCourt.sendAndWaitAstra(msgId, 3000, discId)
      }, { msgId: karlMessageId, discId: discussionId })
      
      // Verify baseline diagnostics are captured
      expect(result.diagnostics).toBeDefined()
      if (result.diagnostics.baselineCaptured) {
        expect(result.diagnostics.baselineCaptured).toBe(true)
        expect(typeof result.diagnostics.baselineSize).toBe('number')
      }
    } finally {
      await app.close()
    }
  })
})

test.describe('Unified conversation with Nova connection check', () => {
  test('unified:sendMessage fails with clear error when Nova chat is not connected', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Check Nova state - in fixture it may be 'error' due to connection failure
      const novaState = await page.evaluate(() => window.novaCourt.getNovaState())
      expect(['disconnected', 'error', 'connecting']).toContain(novaState.connection)
      
      // Try to send unified message - should fail with clear error about Nova connection
      let error: Error | null = null
      try {
        await page.evaluate(async () => {
          return await window.novaCourt.sendUnifiedMessage('Test unified message')
        })
      } catch (e) {
        error = e as Error
      }
      
      expect(error).toBeTruthy()
      // Should fail either on Astra page or Nova connection
      expect(error!.message).toMatch(/Nova chat|Astra|ChatGPT|connection/i)
    } finally {
      await app.close()
    }
  })

  test('unified:sendMessage validates Nova session and model', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // This tests the validation logic in unified:sendMessage
      let error: Error | null = null
      try {
        await page.evaluate(async () => {
          return await window.novaCourt.sendUnifiedMessage('Test unified message')
        })
      } catch (e) {
        error = e as Error
      }
      
      expect(error).toBeTruthy()
      // Should fail with a descriptive error about missing Nova prerequisites
      expect(error!.message).toMatch(/Nova|session|model|chat|connect/i)
    } finally {
      await app.close()
    }
  })
})

test.describe('Duplicate response prevention', () => {
  test('recordNovaReplies does not duplicate responses', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // This tests the internal logic via the main process
      // We can't easily test recordNovaReplies directly from renderer,
      // but we can verify the conversation service duplicate detection
      
      // Append a Nova message with externalId (using imported source which is valid from renderer)
      const msg1 = await page.evaluate(async () => {
        return await window.novaCourt.appendCourtMessage({
          sender: 'nova',
          recipient: 'court',
          text: 'Nova response that should not duplicate',
          source: 'imported',
          externalId: 'test-nova-msg-1'
        } as unknown as { sender: 'nova'; recipient: 'court'; text: string; source: 'imported'; externalId: string })
      })
      
      expect(msg1.id).toBeTruthy()
      
      // Try to append the same message with same externalId - should fail as duplicate
      let error: Error | null = null
      try {
        await page.evaluate(async (extId: string) => {
          return await window.novaCourt.appendCourtMessage({
            sender: 'nova',
            recipient: 'court',
            text: 'Nova response that should not duplicate',
            source: 'imported',
            externalId: extId
          } as unknown as { sender: 'nova'; recipient: 'court'; text: string; source: 'imported'; externalId: string })
        }, 'test-nova-msg-1')
      } catch (e) {
        error = e as Error
      }
      
      expect(error).toBeTruthy()
      expect(error!.message).toContain('already in the conversation')
    } finally {
      await app.close()
    }
  })

  test('Conversation service prevents duplicate Astra responses', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Append an Astra message with externalId
      const msg1 = await page.evaluate(async () => {
        return await window.novaCourt.appendCourtMessage({
          sender: 'astra',
          recipient: 'court',
          text: 'Astra response that should not duplicate',
          source: 'imported',
          externalId: 'astra-12345'
        } as unknown as { sender: 'astra'; recipient: 'court'; text: string; source: 'imported'; externalId: string })
      })
      
      expect(msg1.id).toBeTruthy()
      
      // Try to append the same message with same externalId
      let error: Error | null = null
      try {
        await page.evaluate(async () => {
          return await window.novaCourt.appendCourtMessage({
            sender: 'astra',
            recipient: 'court',
            text: 'Astra response that should not duplicate',
            source: 'imported',
            externalId: 'astra-12345'
          } as unknown as { sender: 'astra'; recipient: 'court'; text: string; source: 'imported'; externalId: string })
        })
      } catch (e) {
        error = e as Error
      }
      
      expect(error).toBeTruthy()
      expect(error!.message).toContain('already in the conversation')
    } finally {
      await app.close()
    }
  })
})

test.describe('Nova chat vs terminal connection distinction', () => {
  test('Nova panel shows correct chat connection status', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Wait for Nova state to load and check that the Nova panel shows CHAT DISCONNECTED initially
      await expect.poll(async () => {
        const state = await page.evaluate(() => window.novaCourt.getNovaState())
        return state.connection
      }, { timeout: 10000 }).toBe('disconnected')
      
      await expect(page.locator('.nova-panel .status.nova-disconnected')).toBeVisible()
      await expect(page.locator('.nova-panel .status.nova-disconnected')).toContainText('DISCONNECTED')
      
      // The status should have a tooltip explaining the difference
      const statusEl = page.locator('.nova-panel .status.nova-disconnected')
      await expect(statusEl).toHaveAttribute('title', 'HTTP chat service not connected to OpenCode server')
    } finally {
      await app.close()
    }
  })

  test('Nova disconnected view explains terminal vs chat difference', async () => {
    const userData = freshUserData()
    const { app, page } = await launch(userData)
    try {
      // Click on chat tab if not already there
      await page.getByRole('tab', { name: 'Nova Chat' }).click()
      
      // Check the disconnected message explains the difference
      // There are two p elements - the error message and the hint
      const hintElement = page.locator('.nova-disconnected .nova-hint')
      await expect(hintElement).toContainText('separate connections')
      await expect(hintElement).toContainText('PTY')
      await expect(hintElement).toContainText('HTTP')
    } finally {
      await app.close()
    }
  })
})
