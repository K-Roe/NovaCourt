import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const { DiscussionService } = require(resolve(cwd, 'dist-electron', 'discussionService.cjs'))

function newService() {
  mkdirSync(resolve(cwd, 'test-results'), { recursive: true })
  const dataPath = mkdtempSync(resolve(cwd, 'test-results', 'discussion-rotation-'))
  return new DiscussionService(dataPath, () => {})
}

function threeWay(service: any, maxTurns = 6) {
  const started = service.start({ topic: 'A three-way conversation.', maxTurns, participants: ['astra', 'nova'], isThreeWay: true })
  if (!started.ok) throw new Error(started.reason)
  return started.discussion
}

/** Records a message against the current turn and moves the conversation on. */
function answerAndAdvance(service: any, discussionId: string) {
  const recorded = service.recordMessage(discussionId, `00000000-0000-4000-8000-000000000001`)
  if (!recorded.ok) throw new Error(recorded.reason)
  return service.advanceTurnAfterResponse(discussionId)
}

test.describe('three-way turn rotation', () => {
  test('the first turn is Astra\'s', () => {
    const service = newService()
    const discussion = threeWay(service)
    const next = service.nextTurn()
    expect(next.ok).toBe(true)
    expect(next.discussion.state).toBe('awaiting-astra')
    expect(next.turn?.speaker).toBe('astra')
    expect(discussion.id).toBe(next.discussion.id)
  })

  test('Astra answers, then it is Nova\'s turn', () => {
    const service = newService()
    const discussion = threeWay(service)
    service.nextTurn()

    const advanced = answerAndAdvance(service, discussion.id)
    expect(advanced.ok).toBe(true)
    expect(advanced.discussion.turnCount).toBe(2)
    expect(advanced.discussion.state).toBe('awaiting-nova')
    expect(advanced.nextTurn?.speaker).toBe('nova')
  })

  test('Nova answers, then control returns to Karl', () => {
    const service = newService()
    const discussion = threeWay(service)
    service.nextTurn()
    answerAndAdvance(service, discussion.id)

    const advanced = answerAndAdvance(service, discussion.id)
    expect(advanced.ok).toBe(true)
    expect(advanced.discussion.turnCount).toBe(3)
    // This is the behaviour that was missing: without Karl in the cycle the rota was
    // Astra, Nova, Astra, Nova and he was never asked to judge anything.
    expect(advanced.nextTurn?.speaker).toBe('karl')
    expect(advanced.discussion.state).toBe('awaiting-karl')
  })

  test('the full cycle repeats: Astra, Nova, Karl, Astra', () => {
    const service = newService()
    const discussion = threeWay(service, 12)

    const speakers: string[] = []
    service.nextTurn()
    speakers.push(service.getActive()!.currentTurn!)

    for (let i = 0; i < 4; i += 1) {
      answerAndAdvance(service, discussion.id)
      const active = service.getActive()
      if (!active || active.state === 'completed') break
      speakers.push(active.currentTurn!)
    }

    expect(speakers.slice(0, 4)).toEqual(['astra', 'nova', 'karl', 'astra'])
  })

  test('participants still record the agents, not the rota', () => {
    const service = newService()
    const discussion = threeWay(service)
    // Karl's presence in the cycle must not change what "participants" means elsewhere.
    expect(discussion.participants).toEqual(['astra', 'nova'])
  })

  test('a turn is addressed to whoever speaks next', () => {
    const service = newService()
    const discussion = threeWay(service)

    const astraTurn = service.nextTurn()
    expect(astraTurn.turn?.recipient).toBe('nova')

    answerAndAdvance(service, discussion.id)
    const snapshot = service.snapshot()
    const novaTurn = snapshot.turns.find((t: any) => t.turn === 2)
    expect(novaTurn.recipient).toBe('karl')
  })
})

test.describe('turn advancement guards', () => {
  test('a turn cannot be advanced before a reply is recorded', () => {
    const service = newService()
    const discussion = threeWay(service)
    service.nextTurn()

    const advanced = service.advanceTurnAfterResponse(discussion.id)
    expect(advanced.ok).toBe(false)
    expect(advanced.reason).toMatch(/no recorded response/i)
    // Still Astra's turn: an advance without a reply must not skip a speaker.
    expect(service.getActive()?.turnCount).toBe(1)
  })

  test('a discussion completes at its turn limit', () => {
    const service = newService()
    const discussion = threeWay(service, 2)
    service.nextTurn()

    const advanced = answerAndAdvance(service, discussion.id)
    expect(advanced.completed).toBe(true)
    expect(advanced.discussion.state).toBe('completed')
    expect(service.getActive()).toBeNull()
  })

  test('a paused discussion refuses to advance', () => {
    const service = newService()
    const discussion = threeWay(service)
    service.nextTurn()
    service.pause()

    const advanced = service.advanceTurnAfterResponse(discussion.id)
    expect(advanced.ok).toBe(false)
    expect(advanced.reason).toMatch(/paused/i)
  })

  test('resuming returns control to whoever was due to speak', () => {
    const service = newService()
    const discussion = threeWay(service)
    service.nextTurn()
    answerAndAdvance(service, discussion.id)
    service.pause()

    const resumed = service.resume()
    expect(resumed.ok).toBe(true)
    expect(resumed.discussion?.state).toBe('awaiting-nova')
  })
})

test.describe('non-three-way discussions are unchanged', () => {
  test('a manually driven discussion keeps its two-participant rota', () => {
    const service = newService()
    const started = service.start({ topic: 'A manual discussion.', maxTurns: 6, participants: ['astra', 'nova'] })
    expect(started.ok).toBe(true)

    service.nextTurn()
    expect(service.getActive()?.currentTurn).toBe('astra')

    answerAndAdvance(service, started.discussion.id)
    expect(service.getActive()?.currentTurn).toBe('nova')

    answerAndAdvance(service, started.discussion.id)
    // A discussion Karl drives himself does not insert him into the rota.
    expect(service.getActive()?.currentTurn).toBe('astra')
  })
})
