import type { DoctorProjectSummary } from '../../../packages/vitest/src/node/cli/doctor'
import { describe, expect, it } from 'vitest'
import { resolveDoctorCandidates } from '../../../packages/vitest/src/node/cli/doctor'

function project(overrides: Partial<DoctorProjectSummary>): DoctorProjectSummary {
  return {
    name: '',
    pool: 'forks',
    environment: 'node',
    isolate: true,
    browser: false,
    ...overrides,
  }
}

function candidateIds(projects: DoctorProjectSummary[]): string[] {
  return resolveDoctorCandidates(projects).map(candidate => candidate.id)
}

describe('resolveDoctorCandidates', () => {
  it('suggests threads and no-isolate for the default configuration', () => {
    expect(candidateIds([project({})])).toEqual(['threads', 'no-isolate'])
  })

  it('adds vmThreads for DOM environments', () => {
    expect(candidateIds([project({ environment: 'jsdom' })]))
      .toEqual(['threads', 'vmThreads', 'no-isolate'])
  })

  it('does not repeat what the config already uses', () => {
    expect(candidateIds([project({ pool: 'threads', isolate: false })])).toEqual([])
  })

  it('compares vm pools against reused workers with shared state', () => {
    expect(candidateIds([project({ pool: 'vmThreads', environment: 'jsdom', isolate: false })]))
      .toEqual(['threads-no-isolate'])
  })

  it('ignores browser projects', () => {
    expect(candidateIds([project({ browser: true, environment: 'jsdom' })])).toEqual([])
  })

  it('considers every project of a workspace', () => {
    expect(candidateIds([
      project({ pool: 'threads', isolate: false }),
      project({ environment: 'happy-dom' }),
    ])).toEqual(['threads', 'vmThreads', 'no-isolate'])
  })
})
