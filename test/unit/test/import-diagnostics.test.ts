import { describe, expect, it } from 'vitest'
import { getImportDiagnostics, getTransformDiagnostics } from '../../../packages/vitest/src/node/reporters/diagnostics'

// the barrel-file shape: 20 test files that each re-evaluate the same
// 800-module graph to use a few symbols from it
const barrelProject = {
  name: 'barrel',
  pool: 'forks',
  isolate: true,
  browser: false,
  isolateProvided: false,
  importTime: 15_000,
  trackedTime: 20_000,
  fetchCounts: Array.from({ length: 800 }, () => 20),
  fileCount: 20,
  // duplication: (20 - 8) / 20 = 0.6, estimated saving: 15s * 0.6 / 8 = 1.125s
  parallelism: 8,
  executionTime: 4_000,
}

describe('getImportDiagnostics', () => {
  it('fires when test files repeatedly evaluate a shared module graph', () => {
    expect(getImportDiagnostics([barrelProject])).toEqual([
      {
        name: 'barrel',
        importTime: 15_000,
        share: 15_000 / 20_000,
        totalFetches: 16_000,
        uniqueModules: 800,
        duplication: 0.6,
        estimatedSaving: (15_000 * 0.6) / 8,
      },
    ])
  })

  it('stays quiet for disjoint per-file graphs - reused workers would not help', () => {
    // every module belongs to one or two test files: no fetch count exceeds
    // the parallelism, so nothing is re-evaluated beyond what lanes require
    expect(getImportDiagnostics([{
      ...barrelProject,
      fetchCounts: Array.from({ length: 800 }, (_, i) => (i % 2 === 0 ? 1 : 2)),
    }])).toEqual([])
  })

  it('stays quiet when the tests dominate the run', () => {
    expect(getImportDiagnostics([{
      ...barrelProject,
      importTime: 2_500,
      trackedTime: 30_000,
    }])).toEqual([])
  })

  it('stays quiet when the import time is small in absolute terms', () => {
    expect(getImportDiagnostics([{
      ...barrelProject,
      importTime: 1_500,
      trackedTime: 2_000,
    }])).toEqual([])
  })

  it('does not suggest disabling isolation the user explicitly enabled', () => {
    expect(getImportDiagnostics([{ ...barrelProject, isolateProvided: true }])).toEqual([])
  })

  it('stays quiet without isolation - the graph is already shared', () => {
    expect(getImportDiagnostics([{ ...barrelProject, isolate: false }])).toEqual([])
  })

  it('stays quiet for vm pools - they re-create the graph per context regardless', () => {
    expect(getImportDiagnostics([{ ...barrelProject, pool: 'vmThreads' }])).toEqual([])
  })

  it('stays quiet for browser projects', () => {
    expect(getImportDiagnostics([{ ...barrelProject, browser: true }])).toEqual([])
  })

  it('stays quiet when files do not outnumber the workers', () => {
    expect(getImportDiagnostics([{ ...barrelProject, fileCount: 8 }])).toEqual([])
  })

  it('stays quiet when the saving is negligible relative to a long run', () => {
    // ~1.1s estimated saving is below 5% of a 5-minute run and below 10s absolute
    expect(getImportDiagnostics([{ ...barrelProject, executionTime: 300_000 }])).toEqual([])
  })
})

const coldProject = {
  name: 'cold',
  transformTime: 8_000,
  trackedTime: 20_000,
  fsModuleCache: false,
  fsModuleCacheProvided: false,
  executionTime: 10_000,
}

describe('getTransformDiagnostics', () => {
  it('fires when transforms dominate and nothing persists them', () => {
    expect(getTransformDiagnostics([coldProject])).toEqual([
      {
        name: 'cold',
        transformTime: 8_000,
        share: 8_000 / 20_000,
      },
    ])
  })

  it('stays quiet when the fs module cache is already enabled', () => {
    expect(getTransformDiagnostics([{ ...coldProject, fsModuleCache: true }])).toEqual([])
  })

  it('does not suggest a cache the user explicitly configured away', () => {
    expect(getTransformDiagnostics([{ ...coldProject, fsModuleCacheProvided: true }])).toEqual([])
  })

  it('stays quiet when the transform time is small in absolute terms', () => {
    expect(getTransformDiagnostics([{ ...coldProject, transformTime: 1_500 }])).toEqual([])
  })

  it('stays quiet when the tests dominate the run', () => {
    expect(getTransformDiagnostics([{
      ...coldProject,
      transformTime: 3_000,
      trackedTime: 30_000,
    }])).toEqual([])
  })

  it('stays quiet when the saving is negligible relative to a long run', () => {
    expect(getTransformDiagnostics([{
      ...coldProject,
      transformTime: 2_500,
      trackedTime: 9_000,
      executionTime: 300_000,
    }])).toEqual([])
  })
})
