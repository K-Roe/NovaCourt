import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface NovaPersonality {
  identity: string
  personality: string
  rules: string
  speakingStyle: string
  safetyAndHonesty: string
  finalPrinciple: string
  fullText: string
}

const requiredSections = [
  '## Identity',
  '## Personality',
  '## Speaking Style',
  '## The NovaCourt Rules',
  '## Personality Continuity',
  '## Safety and Honesty',
  '## Final Principle'
] as const

function findSection(content: string, sectionTitle: string): string | null {
  const lines = content.split('\n')
  let inSection = false
  let sectionLines: string[] = []

  for (const line of lines) {
    if (line.trim() === sectionTitle) {
      if (inSection) break
      inSection = true
      sectionLines = [line]
      continue
    }
    if (inSection) {
      if (line.startsWith('## ') && line.trim() !== sectionTitle) break
      sectionLines.push(line)
    }
  }

  return sectionLines.length > 0 ? sectionLines.join('\n').trim() : null
}

export function loadNovaPersonality(workspace: string): NovaPersonality {
  const agentsPath = resolve(workspace, 'AGENTS.md')

  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found at ${agentsPath}. Nova's personality cannot be loaded.`)
  }

  let content: string
  try {
    content = readFileSync(agentsPath, 'utf8')
  } catch (error) {
    throw new Error(`Failed to read AGENTS.md: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!content.trim()) {
    throw new Error('AGENTS.md is empty. Nova\'s personality cannot be loaded.')
  }

  for (const section of requiredSections) {
    if (!content.includes(section)) {
      throw new Error(`AGENTS.md is missing required section: ${section}`)
    }
  }

  const identity = findSection(content, '## Identity') || ''
  const personality = findSection(content, '## Personality') || ''
  const speakingStyle = findSection(content, '## Speaking Style') || ''
  const rules = findSection(content, '## The NovaCourt Rules') || ''
  const continuity = findSection(content, '## Personality Continuity') || ''
  const safety = findSection(content, '## Safety and Honesty') || ''
  const principle = findSection(content, '## Final Principle') || ''

  const fullText = [
    identity,
    personality,
    speakingStyle,
    rules,
    continuity,
    safety,
    principle
  ].filter(Boolean).join('\n\n')

  return {
    identity,
    personality,
    rules,
    speakingStyle,
    safetyAndHonesty: `${continuity}\n\n${safety}`.trim(),
    finalPrinciple: principle,
    fullText
  }
}

export function buildDiscussionSystem(personality: NovaPersonality): string {
  return [
    personality.identity,
    personality.personality,
    personality.speakingStyle,
    personality.rules,
    personality.safetyAndHonesty,
    personality.finalPrinciple,
    'Discussion only. Answer questions and suggest plans in text. Do not use any tools, execute commands, change files, spawn agents, or access other workspaces.',
    'This is a chat surface, not a build surface. Explaining, reviewing or discussing a change here never authorises implementing it, and never counts as Karl approving work. Say plainly when an idea still needs Karl\'s approval.'
  ].filter(Boolean).join(' ')
}

let cachedPersonality: NovaPersonality | null = null
let cachedWorkspace: string | null = null
let cachedMtime: number = 0

export function getNovaPersonality(workspace: string): NovaPersonality {
  const agentsPath = resolve(workspace, 'AGENTS.md')

  if (!existsSync(agentsPath)) {
    throw new Error(`AGENTS.md not found at ${agentsPath}. Nova's personality cannot be loaded.`)
  }

  const stat = require('node:fs').statSync(agentsPath)
  const mtime = stat.mtimeMs

  if (cachedPersonality && cachedWorkspace === workspace && cachedMtime === mtime) {
    return cachedPersonality
  }

  const personality = loadNovaPersonality(workspace)
  cachedPersonality = personality
  cachedWorkspace = workspace
  cachedMtime = mtime

  return personality
}

export function invalidatePersonalityCache(): void {
  cachedPersonality = null
  cachedWorkspace = null
  cachedMtime = 0
}