import { expect, test } from 'vitest'
import { runVitestCli } from '../../test-utils'

test('doctor measures alternative configurations and reports a table', async () => {
  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: 'fixtures/doctor' } },
    'doctor',
  )

  await waitForClose()

  expect(vitest.stderr).toBe('')
  expect(exitCode).toBe(0)

  const stdout = vitest.stdout
  expect(stdout).toContain('measuring baseline (pool: forks · isolate: true)')
  // node environment on forks: threads and isolate:false are worth measuring
  expect(stdout).toContain(`measuring pool: 'threads'`)
  expect(stdout).toContain('measuring isolate: false')
  // the DOM candidate is not: there is nothing to amortize
  expect(stdout).not.toContain('vmThreads')

  expect(stdout).toContain('Results (min of 3 runs each)')
  expect(stdout).toMatch(/Recommendation: /)
}, 120_000)

test('doctor reports the errors of failing candidates', async () => {
  const { vitest, exitCode, waitForClose } = await runVitestCli(
    { nodeOptions: { cwd: 'fixtures/doctor-failing' } },
    'doctor',
  )

  await waitForClose()

  expect(exitCode).toBe(0)

  const stdout = vitest.stdout
  // the DOM environment makes vmThreads a candidate, and the fixture fails under it
  expect(stdout).toContain(`pool: 'vmThreads' failed with:`)
  expect(stdout).toContain('FAIL  vm-hostile.test.ts > does not run under a vm pool')
  // the failing candidate is never recommended
  expect(stdout).not.toMatch(/Recommendation: pool: 'vmThreads'/)
}, 120_000)
