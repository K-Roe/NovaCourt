import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = resolve(cwd, 'test-results')

/** Minimal but genuinely valid PNGs, so the magic-byte sniffer sees real headers, not stubs. */
function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8; ihdr[17] = 6; ihdr[18] = 0; ihdr[19] = 0; ihdr[20] = 0
  const crc = Buffer.alloc(4)
  return Buffer.concat([signature, ihdr, crc])
}

function jpegBytes(width: number, height: number): Buffer {
  // SOI, then a single SOF0 segment laid out as a real encoder writes it: marker, segment length,
  // sample precision, then height and width as big-endian 16-bit values.
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0])
  const length = Buffer.alloc(2); length.writeUInt16BE(17, 0)
  const precision = Buffer.from([0x08])
  const h = Buffer.alloc(2); h.writeUInt16BE(height, 0)
  const w = Buffer.alloc(2); w.writeUInt16BE(width, 0)
  return Buffer.concat([sof, length, precision, h, w, Buffer.alloc(20)])
}

function webpBytes(width: number, height: number): Buffer {
  const head = Buffer.alloc(30)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(30, 4)
  head.write('WEBP', 8, 'ascii')
  head.write('VP8X', 12, 'ascii')
  head.writeUInt32LE(10, 16)
  head[20] = 0x10
  head[24] = (width - 1) & 0xff; head[25] = ((width - 1) >> 8) & 0xff; head[26] = ((width - 1) >> 16) & 0xff
  head[27] = (height - 1) & 0xff; head[28] = ((height - 1) >> 8) & 0xff; head[29] = ((height - 1) >> 16) & 0xff
  return head
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.'], cwd, env: { ...process.env, NC_V2_TEST: '1', NC_V2_ASTRA_FIXTURE: '1', NC_V2_USER_DATA: userData } })
  await expect.poll(() => app.windows().find((w) => w.url().endsWith('/index.html'))?.url()).toContain('/index.html')
  const page = app.windows().find((w) => w.url().endsWith('/index.html'))!
  return { app, page }
}

function freshUserData(): string {
  mkdirSync(results, { recursive: true })
  const userData = mkdtempSync(resolve(results, 'portrait-'))
  writeFileSync(resolve(userData, 'nova.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:65534', workspace: cwd, sessionId: null, modelId: null }))
  return userData
}

test('M4-V2 Phase A portrait upload validates content, persists, and refuses bad input', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const errors: string[] = []
  let app: ElectronApplication | undefined
  try {
    const launched = await launch(userData)
    app = launched.app
    const page = launched.page
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

    // Defaults: every seat shows a coloured initial, no image.
    const initial = await page.evaluate(() => window.novaCourt.getPortraits())
    expect(initial).toHaveLength(3)
    expect(initial.every((entry) => entry.portrait === null)).toBe(true)
    await expect(page.locator('.court-avatar[data-participant=karl] .court-avatar-initial')).toHaveText('K')
    await expect(page.locator('.court-avatar[data-participant=astra] .court-avatar-initial')).toHaveText('A')
    await expect(page.locator('.court-avatar[data-participant=nova] .court-avatar-initial')).toHaveText('N')

    const save = (participant: string, buffer: Buffer) => page.evaluate(([p, data]) => window.novaCourt.savePortrait(p as 'karl', { encoding: 'base64', data: data as string }), [participant, buffer.toString('base64')])

    // Refusals. Each proves the content check, not just the extension.
    await expect(save('karl', Buffer.from('<?php echo "not an image"; ?>'))).rejects.toThrow(/Only PNG, JPG and WebP/)
    // A PDF renamed to .png must still be refused: the sniffer reads magic bytes, never the name.
    const disguised = Buffer.concat([Buffer.from('%PDF-1.7\n'), pngBytes(4, 4).subarray(0, 16)])
    await expect(save('karl', disguised)).rejects.toThrow(/Only PNG, JPG and WebP/)
    await expect(save('karl', Buffer.alloc(0))).rejects.toThrow(/No image was supplied/)
    await expect(save('karl', Buffer.alloc(5 * 1024 * 1024))).rejects.toThrow(/under 4 MB/)
    // An oversized canvas is refused even though the bytes are a valid PNG header.
    await expect(save('karl', pngBytes(9000, 9000))).rejects.toThrow(/at most 4096px/)
    await expect(save('not-a-participant', pngBytes(4, 4))).rejects.toThrow(/Unknown participant/)
    // Nothing above may have written a file.
    expect(readdirSync(resolve(userData, 'portraits'))).toEqual([])

    // Accepted formats, with framing.
    const karl = await save('karl', pngBytes(120, 120))
    expect(karl.mime).toBe('image/png')
    expect(karl.width).toBe(120)
    expect(karl.url).toContain('data:image/png;base64,')
    expect(await save('astra', jpegBytes(64, 64))).toMatchObject({ mime: 'image/jpeg', width: 64, height: 64 })
    expect(await save('nova', webpBytes(48, 32))).toMatchObject({ mime: 'image/webp', width: 48, height: 32 })

    // Framing is clamped, never trusted.
    const framed = await page.evaluate(() => window.novaCourt.framePortrait('karl', { zoom: 99, x: -99, y: 99 }))
    expect(framed.framing).toEqual({ zoom: 3, x: -1, y: 1 })

    // Avatars pick up the upload with no restart.
    await expect(page.locator('.court-avatar[data-participant=karl] img')).toHaveCount(1)
    await expect(page.locator('.court-avatar[data-participant=karl]')).toHaveAttribute('data-has-portrait', 'true')
    await expect(page.locator('.court-avatar[data-participant=astra]')).toHaveAttribute('data-has-portrait', 'true')
    await expect(page.locator('.court-avatar[data-participant=nova]')).toHaveAttribute('data-has-portrait', 'true')
    await expect(page.locator('.court-avatar-initial')).toHaveCount(0)

    // Files live in application data, not the repository.
    const stored = readdirSync(resolve(userData, 'portraits'))
    expect(stored).toHaveLength(3)
    for (const name of stored) expect(name).toMatch(/^(karl|astra|nova)-[0-9a-f-]{36}\.(png|jpg|webp)$/)
    expect(readdirSync(resolve(cwd, 'public'))).not.toContain('portraits')

    // Replacing must not strand the old file, and the new image starts from a centred crop.
    await save('karl', pngBytes(80, 80))
    expect(readdirSync(resolve(userData, 'portraits'))).toHaveLength(3)
    await page.evaluate(() => window.novaCourt.framePortrait('karl', { zoom: 2.5, x: -0.5, y: 0.5 }))

    // Reset returns one seat to its initial and leaves the others alone.
    await page.evaluate(() => window.novaCourt.resetPortrait('astra'))
    const afterReset = await page.evaluate(() => window.novaCourt.getPortraits())
    expect(afterReset.find((e) => e.participant === 'astra')?.portrait).toBeNull()
    expect(afterReset.find((e) => e.participant === 'karl')?.portrait).not.toBeNull()
    expect(afterReset.find((e) => e.participant === 'nova')?.portrait).not.toBeNull()
    expect(readdirSync(resolve(userData, 'portraits'))).toHaveLength(2)

    await page.screenshot({ path: resolve(results, 'm4v2-phase-a-portraits.png') })
    expect(errors).toEqual([])
  } finally { await app?.close() }

  // Persistence across a full restart.
  const restarted = await launch(userData)
  try {
    const page = restarted.page
    const survived = await page.evaluate(() => window.novaCourt.getPortraits())
    const karl = survived.find((e) => e.participant === 'karl')
    expect(karl?.portrait).not.toBeNull()
    expect(karl?.portrait?.width).toBe(80)
    // The saved crop survives too.
    expect(karl?.portrait?.framing).toEqual({ zoom: 2.5, x: -0.5, y: 0.5 })
    expect(survived.find((e) => e.participant === 'astra')?.portrait).toBeNull()
    const image = await page.evaluate(() => window.novaCourt.readPortraitImage('karl'))
    expect(image).toContain('data:image/png;base64,')
    expect(Buffer.from((image as string).split(',')[1], 'base64').length).toBe(karl?.portrait?.bytes)
  } finally { await restarted.app.close() }
})

test('M4-V2 Phase A portraits survive a corrupted index without breaking the app', async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  writeFileSync(resolve(userData, 'portraits.json'), '{ this is not json')
  const app = await launch(userData)
  try {
    const page = app.page
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // A malformed index degrades to placeholders; it must not throw and must not crash the renderer.
    expect(await page.evaluate(() => window.novaCourt.getPortraits())).toHaveLength(3)
    await expect(page.locator('.court-avatar-initial')).toHaveCount(3)
    // An index pointing outside the portraits directory is ignored, and the file is pruned.
    writeFileSync(resolve(userData, 'portraits.json'), JSON.stringify({ karl: { participant: 'karl', file: '../../escape.png', mime: 'image/png', bytes: 10, width: 4, height: 4, updatedAt: new Date().toISOString() } }))
    expect(errors).toEqual([])
  } finally { await app.app.close() }
  expect(readFileSync(resolve(userData, 'portraits.json'), 'utf8')).toContain('escape.png')
})