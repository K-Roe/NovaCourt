import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Every spec that reaches real ChatGPT or a real OpenCode server.
 *
 * `live-threeway` was ungated by omission and ran in the default suite. Since Nova's seat is now a paid
 * model, that made an ordinary `npm test` capable of billing Karl and writing to his real transcript.
 */
const LIVE_SPECS = [
  'tests/live-threeway.spec.ts',
  'tests/live-chatgpt.spec.ts',
  'tests/live-handoff.spec.ts',
  'tests/live-opencode.spec.ts',
  'tests/live-terminal.spec.ts'
]

const GATE_VARIABLES = [
  'NC_V2_REAL_THREEWAY',
  'NC_V2_LIVE_SMOKE',
  'NC_V2_REAL_HANDOFF',
  'NC_V2_REAL_OPENCODE_SMOKE',
  'NC_V2_REAL_TERMINAL_SMOKE'
]

/**
 * Runs every live spec in ONE child Playwright process and returns the flattened results.
 *
 * Deliberately a single child process, and deliberately given its own output directory.
 *
 * An earlier version spawned one child per file. Six nested Playwright runs competing with the Electron
 * tests made the suite fail intermittently in unrelated files. Worse, every child inherited the shared
 * `test-results` output directory, and Playwright clears that directory when a run starts — so a child
 * starting mid-suite deleted scratch directories that `open-code-service.spec.ts` and `handoff.spec.ts`
 * were actively using. Isolating the output directory removes the collision entirely.
 */
function runLiveSpecs() {
  const env = { ...process.env }
  for (const variable of GATE_VARIABLES) delete env[variable]

  const scratch = mkdtempSync(resolve(tmpdir(), 'nc-gate-'))
  try {
    const stdout = execFileSync(process.execPath, [
      join(cwd, 'node_modules', 'playwright', 'cli.js'), 'test',
      ...LIVE_SPECS,
      '--reporter=json',
      '--workers=1',
      '--output', join(scratch, 'artifacts')
    ], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const report = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { suites: any[]; stats: { expected: number; unexpected: number; skipped: number } }

    const results: { file: string; title: string; status: string }[] = []
    const walk = (list: any[], file: string) => {
      for (const entry of list ?? []) {
        const filePath = entry.file ?? entry._file ?? file
        for (const spec of entry.specs ?? []) {
          // A skipped spec still reports `ok: true`, so status has to come from the test entries. Reading
          // `ok` here would label every skipped live test as passed, which is the exact failure this guards.
          const statuses = (spec.tests ?? []).map((test: any) => String(test.status))
          results.push({
            file: filePath,
            title: spec.title,
            status: statuses.includes('unexpected') ? 'failed' : statuses[0] ?? 'skipped'
          })
        }
        walk(entry.suites ?? [], filePath)
      }
    }
    walk(report.suites, '')
    return { results, stats: report.stats }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test.describe('live test gating', () => {
  test('no live spec can send a real ChatGPT or paid model request without an explicit opt-in', () => {
    // Runs the live files exactly as a default `npm test` would and checks that every one of them skips.
    const { results, stats } = runLiveSpecs()

    expect(results.length).toBeGreaterThan(0)

    const ran = results.filter((result) => result.status !== 'skipped')
    expect(ran.map((result) => `${result.file} ${result.title}=${result.status}`)).toEqual([])

    expect(stats.unexpected, 'opting out must never be reported as a failure').toBe(0)

    // The three-way test specifically, because it is the one that reaches a PAID model.
    const threeWay = results.filter((result) => result.file.includes('live-threeway'))
    expect(threeWay.length).toBeGreaterThan(0)
    for (const result of threeWay) expect(result.status).toBe('skipped')
  })

  test('the three-way live test declares an opt-in variable rather than running unconditionally', () => {
    // A static backstop: if someone deletes the guard, the runtime check above still catches it, but this
    // names the requirement so the failure explains itself instead of just reporting a status mismatch.
    const source = readFileSync(join(cwd, 'tests', 'live-threeway.spec.ts'), 'utf8')
    expect(source).toContain('NC_V2_REAL_THREEWAY')
    expect(source).toMatch(/test\.skip\(\s*process\.env\.NC_V2_REAL_THREEWAY\s*!==\s*'1'/)
  })
})
