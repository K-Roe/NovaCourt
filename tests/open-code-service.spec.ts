import { test, expect } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const { OpenCodeService } = require(resolve(cwd, 'dist-electron', 'openCodeService.cjs'))

test('OpenCode protocol: unavailable, connected, chat-only permissions, history and abort', async () => {
  mkdirSync(resolve(cwd, 'test-results'), { recursive: true })
  const dataPath = mkdtempSync(resolve(cwd, 'test-results', 'mock-user-'))
  const streams = new Set<ServerResponse>()
  const messages: unknown[] = []
  let promptBody: any = null
  let createdBody: any = null
  let promptCount = 0
  let aborted = false
  let freeCost = 0
  const safe = { id: 'ses_safe', title: 'Safe discussion', directory: cwd, time: { updated: Date.now() }, permission: [{ permission: '*', pattern: '*', action: 'deny' }] }
  const unsafe = { id: 'ses_unsafe', title: 'Older session', directory: cwd, time: { updated: Date.now() - 1 }, permission: [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: '*.sh', action: 'allow' }] }
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/global/health') return json(res, { healthy: true, version: '1.18.35' })
    if (url.pathname === '/doc') return json(res, { paths: { '/session': { post: { requestBody: { content: { 'application/json': { schema: { properties: { permission: {} } } } } } } }, '/session/{sessionID}/prompt_async': { post: { requestBody: { content: { 'application/json': { schema: { properties: { tools: {} } } } } } } }, '/session/{sessionID}/abort': { post: {} }, '/event': { get: {} } } })
    if (url.pathname === '/provider') return json(res, { connected: ['opencode'], all: [{ id: 'opencode', models: { 'ling-3.1-flash-free': { id: 'ling-3.1-flash-free', name: 'Ling Free', cost: { input: freeCost, output: freeCost } }, paid: { id: 'paid', name: 'Paid', cost: { input: 1, output: 1 } } } }] })
    if (url.pathname === '/session' && req.method === 'GET') return json(res, [safe, unsafe])
    if (url.pathname === '/session' && req.method === 'POST') { let body = ''; req.on('data', (chunk) => body += chunk); req.on('end', () => { createdBody = JSON.parse(body); json(res, safe) }); return }
    if (url.pathname === '/session/status') return json(res, {})
    if (url.pathname === '/session/ses_safe') return json(res, safe)
    if (url.pathname === '/session/ses_unsafe') return json(res, unsafe)
    if (url.pathname === '/session/ses_safe/message' || url.pathname === '/session/ses_unsafe/message') return json(res, messages)
    if (url.pathname === '/experimental/tool/ids') return json(res, ['bash', 'edit', 'read', 'task'])
    if (url.pathname === '/session/ses_safe/prompt_async' && req.method === 'POST') { let body = ''; req.on('data', (chunk) => body += chunk); req.on('end', () => { promptCount++; promptBody = JSON.parse(body); messages.push({ info: { id: 'msg_user', role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text: promptBody.parts[0].text }] }); messages.push({ info: { id: 'msg_assistant', role: 'assistant', time: { created: Date.now() } }, parts: [{ type: 'text', text: 'Mock protocol reply' }] }); res.writeHead(204); res.end() }); return }
    if (url.pathname === '/session/ses_safe/abort') { aborted = true; return json(res, true) }
    if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' }); res.write('data: {"type":"server.connected"}\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return }
    json(res, { error: 'Missing mock route' }, 404)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing mock address')
  const service = new OpenCodeService(dataPath, () => {})
  try {
    service.configure({ endpoint: `http://127.0.0.1:${address.port}`, executablePath: 'C:\\missing\\opencode.exe', workspace: cwd })
    const connected = await service.connect()
    expect(connected.connection).toBe('connected')
    expect(connected.models).toEqual([{ id: 'opencode:ling-3.1-flash-free', name: 'opencode · Ling Free', providerID: 'opencode', modelID: 'ling-3.1-flash-free' }])
    await service.createSession()
    expect(createdBody.permission).toEqual([{ permission: '*', pattern: '*', action: 'deny' }])
    await service.send('Discuss this safely')
    expect(promptCount).toBe(1)
    expect(promptBody.model).toEqual({ providerID: 'opencode', modelID: 'ling-3.1-flash-free' })
    expect(promptBody.tools).toEqual({ bash: false, edit: false, read: false, task: false })
    expect(service.snapshot().messages.some((message: any) => message.text === 'Mock protocol reply')).toBe(true)
    messages[1] = { info: { id: 'msg_assistant', role: 'assistant', time: { created: Date.now() } }, parts: [{ type: 'text', text: 'Mock protocol reply, streamed update' }] }
    for (const stream of streams) stream.write('data: {"type":"message.part.updated","properties":{"sessionID":"ses_safe"}}\n\n')
    await expect.poll(() => service.snapshot().messages.find((message: any) => message.role === 'assistant')?.text).toBe('Mock protocol reply, streamed update')
    await service.stop()
    expect(aborted).toBe(true)
    freeCost = 1
    await expect(service.send('Do not send to a now-paid model')).rejects.toThrow('listed Nova model')
    expect(promptCount).toBe(1)
    freeCost = 0
    await service.selectSession('ses_unsafe')
    await expect(service.send('Should not send')).rejects.toThrow('chat-only tool denial')
    expect(promptCount).toBe(1)
  } finally {
    service.close()
    for (const stream of streams) stream.end()
    await new Promise<void>((done) => server.close(() => done()))
  }

  const unavailable = new OpenCodeService(mkdtempSync(resolve(cwd, 'test-results', 'mock-unavailable-')), () => {})
  try {
    unavailable.configure({ endpoint: `http://127.0.0.1:${address.port}`, executablePath: 'C:\\missing\\opencode.exe', workspace: cwd })
    const state = await unavailable.connect()
    expect(state.connection).toBe('error')
    expect(state.error).toBeTruthy()
  } finally { unavailable.close() }
})

test('Nova defaults to opencode-go/space-bunny while the free-only guard still holds', async () => {
  const dataPath = mkdtempSync(resolve(cwd, 'test-results', 'mock-spacebunny-'))
  let promptBody: any = null
  const safe = { id: 'ses_safe', title: 'Safe discussion', directory: cwd, time: { updated: Date.now() }, permission: [{ permission: '*', pattern: '*', action: 'deny' }] }
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/global/health') return json(res, { healthy: true, version: '1.18.35' })
    if (url.pathname === '/doc') return json(res, { paths: { '/session': { post: { requestBody: { content: { 'application/json': { schema: { properties: { permission: {} } } } } } } }, '/session/{sessionID}/prompt_async': { post: { requestBody: { content: { 'application/json': { schema: { properties: { tools: {} } } } } } } }, '/session/{sessionID}/abort': { post: {} }, '/event': { get: {} } } })
    if (url.pathname === '/provider') return json(res, { connected: ['opencode-go'], all: [{ id: 'opencode-go', name: 'opencode-go', models: { 'space-bunny': { id: 'space-bunny', name: 'Space Bunny', cost: { input: 3, output: 15 } }, 'other-paid': { id: 'other-paid', name: 'Other Paid', cost: { input: 2, output: 9 } } } }] })
    if (url.pathname === '/session' && req.method === 'GET') return json(res, [safe])
    if (url.pathname === '/session' && req.method === 'POST') return json(res, safe)
    if (url.pathname === '/session/status') return json(res, {})
    if (url.pathname === '/session/ses_safe') return json(res, safe)
    if (url.pathname === '/session/ses_safe/message') return json(res, [])
    if (url.pathname === '/experimental/tool/ids') return json(res, ['bash', 'edit', 'read', 'task'])
    if (url.pathname === '/session/ses_safe/prompt_async' && req.method === 'POST') { let body = ''; req.on('data', (chunk) => body += chunk); req.on('end', () => { promptBody = JSON.parse(body); res.writeHead(204); res.end() }); return }
    if (url.pathname === '/session/ses_safe/abort') return json(res, true)
    if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' }); res.write('data: {"type":"server.connected"}\n\n'); req.on('close', () => res.end()); return }
    json(res, { error: 'Missing mock route' }, 404)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing mock address')
  const service = new OpenCodeService(dataPath, () => {})
  try {
    service.configure({ endpoint: `http://127.0.0.1:${address.port}`, executablePath: 'C:\\missing\\opencode.exe', workspace: cwd })
    const connected = await service.connect()
    // Space Bunny is admitted despite costing money; the sibling paid model is still refused.
    expect(connected.models).toEqual([{ id: 'opencode-go:space-bunny', name: 'opencode-go · Space Bunny', providerID: 'opencode-go', modelID: 'space-bunny' }])
    expect(connected.config.modelId).toBe('opencode-go:space-bunny')
    await service.createSession()
    await service.send('Hello Nova')
    expect(promptBody.model).toEqual({ providerID: 'opencode-go', modelID: 'space-bunny' })
    expect(promptBody.agent).toBe('plan')
    expect(promptBody.tools).toEqual({ bash: false, edit: false, read: false, task: false })
    await expect(service.chooseModel('opencode-go:other-paid')).rejects.toThrow('listed Nova model')
  } finally {
    service.close()
    await new Promise<void>((done) => server.close(() => done()))
  }

  // A deliberate later choice must survive reconnect; the override is one-time only.
  const second = new OpenCodeService(dataPath, () => {})
  try {
    second.configure({ endpoint: `http://127.0.0.1:${address.port}`, executablePath: 'C:\\missing\\opencode.exe', workspace: cwd })
    expect(second.snapshot().config.modelId).toBe('opencode-go:space-bunny')
  } finally {
    second.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

test('a previously saved free model is replaced by Space Bunny, not preserved', async () => {
  const dataPath = mkdtempSync(resolve(cwd, 'test-results', 'mock-migrate-'))
  const safe = { id: 'ses_safe', title: 'Safe discussion', directory: cwd, time: { updated: Date.now() }, permission: [{ permission: '*', pattern: '*', action: 'deny' }] }
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/global/health') return json(res, { healthy: true, version: '1.18.35' })
    if (url.pathname === '/doc') return json(res, { paths: { '/session': { post: { requestBody: { content: { 'application/json': { schema: { properties: { permission: {} } } } } } } }, '/session/{sessionID}/prompt_async': { post: { requestBody: { content: { 'application/json': { schema: { properties: { tools: {} } } } } } } }, '/session/{sessionID}/abort': { post: {} }, '/event': { get: {} } } })
    if (url.pathname === '/provider') return json(res, { connected: ['opencode-go', 'openrouter'], all: [{ id: 'opencode-go', name: 'opencode-go', models: { 'space-bunny': { id: 'space-bunny', name: 'Space Bunny', cost: { input: 3, output: 15 } } } }, { id: 'openrouter', name: 'OpenRouter', models: { 'poolside/laguna-s-2.1:free': { id: 'poolside/laguna-s-2.1:free', name: 'Laguna', cost: { input: 0, output: 0 } } } }] })
    if (url.pathname === '/session' && req.method === 'GET') return json(res, [safe])
    if (url.pathname === '/session' && req.method === 'POST') return json(res, safe)
    if (url.pathname === '/session/status') return json(res, {})
    if (url.pathname === '/session/ses_safe') return json(res, safe)
    if (url.pathname === '/session/ses_safe/message') return json(res, [])
    if (url.pathname === '/experimental/tool/ids') return json(res, ['bash'])
    if (url.pathname === '/session/ses_safe/abort') return json(res, true)
    if (url.pathname === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' }); res.write('data: {"type":"server.connected"}\n\n'); req.on('close', () => res.end()); return }
    json(res, { error: 'Missing mock route' }, 404)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing mock address')
  writeFileSync(resolve(dataPath, 'nova.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${address.port}`, workspace: cwd, sessionId: null, modelId: 'openrouter:poolside/laguna-s-2.1:free' }))
  const service = new OpenCodeService(dataPath, () => {})
  try {
    const connected = await service.connect()
    // The old free default is still a legitimate *choice*, but it is not grandfathered in.
    expect(connected.models.map((model: any) => model.id).sort()).toEqual(['opencode-go:space-bunny', 'openrouter:poolside/laguna-s-2.1:free'])
    expect(connected.config.modelId).toBe('opencode-go:space-bunny')
  } finally {
    service.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
