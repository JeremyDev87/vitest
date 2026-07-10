import type { CliOptions } from './cli-api'
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { performance } from 'node:perf_hooks'
import { toArray } from '@vitest/utils/helpers'
import c from 'tinyrainbow'

export interface DoctorProjectSummary {
  name: string
  pool: string
  environment: string
  isolate: boolean
  browser: boolean
  fsModuleCache: boolean
}

export interface DoctorCandidateOptions {
  /** `happy-dom` is resolvable, so the environment candidate can actually run. */
  happyDomAvailable?: boolean
}

export interface DoctorCandidate {
  id: string
  /** Human readable config change, e.g. `pool: 'threads'`. */
  title: string
  /** CLI overrides appended to the spawned `vitest run`. */
  args: string[]
  /** Config entries to show in the recommended snippet, one per line. */
  configLines: string[]
  /** Keeps every test file in its own fresh environment. */
  preservesIsolation: boolean
  /** Run extra shuffled passes to check that tests survive shared state. */
  validateIsolation?: boolean
  /**
   * Untimed runs before the measured ones. Used for candidates whose benefit
   * only shows once a persistent cache is populated.
   */
  primeRuns?: number
}

const DOM_ENVIRONMENTS = new Set(['jsdom', 'happy-dom'])

/**
 * Builds the list of configurations worth measuring for this config. The
 * candidates are pruned by what the config already uses - there is no point
 * in measuring `threads` when the config already runs in `threads`.
 */
export function resolveDoctorCandidates(
  projects: DoctorProjectSummary[],
  options: DoctorCandidateOptions = {},
): DoctorCandidate[] {
  const candidates: DoctorCandidate[] = []
  const testProjects = projects.filter(project => !project.browser)
  if (testProjects.length === 0) {
    return candidates
  }

  const pools = new Set(testProjects.map(project => project.pool))
  const usesVmPool = pools.has('vmThreads') || pools.has('vmForks')
  const runsDom = testProjects.some(project =>
    DOM_ENVIRONMENTS.has(project.environment),
  )
  const isolates = testProjects.some(
    project => project.isolate && project.pool !== 'vmThreads' && project.pool !== 'vmForks',
  )

  if (pools.has('forks')) {
    candidates.push({
      id: 'threads',
      title: `pool: 'threads'`,
      args: ['--pool=threads'],
      configLines: [`pool: 'threads'`],
      preservesIsolation: true,
    })
  }
  if (runsDom && !pools.has('vmThreads')) {
    candidates.push({
      id: 'vmThreads',
      title: `pool: 'vmThreads'`,
      args: ['--pool=vmThreads'],
      configLines: [`pool: 'vmThreads'`],
      preservesIsolation: true,
    })
  }
  // `--environment` overrides every project at once, so the swap is only fair
  // when the whole workspace runs jsdom; jsdom -> happy-dom is the only swap
  // with a speed upside
  if (options.happyDomAvailable && testProjects.every(project => project.environment === 'jsdom')) {
    candidates.push({
      id: 'happy-dom',
      title: `environment: 'happy-dom'`,
      args: ['--environment=happy-dom'],
      configLines: [`environment: 'happy-dom'`],
      preservesIsolation: true,
    })
  }
  if (isolates) {
    candidates.push({
      id: 'no-isolate',
      title: 'isolate: false',
      args: ['--no-isolate'],
      configLines: ['isolate: false'],
      preservesIsolation: false,
      validateIsolation: true,
    })
  }
  if (usesVmPool) {
    // the honest competitor of a vm pool: reused workers with shared state
    candidates.push({
      id: 'threads-no-isolate',
      title: `pool: 'threads' + isolate: false`,
      args: ['--pool=threads', '--no-isolate'],
      configLines: [`pool: 'threads'`, 'isolate: false'],
      preservesIsolation: false,
      validateIsolation: true,
    })
  }
  if (testProjects.every(project => !project.fsModuleCache)) {
    // an untimed priming run populates the cache first: the candidate measures
    // what repeated runs pay, which is what doctor compares everywhere else
    candidates.push({
      id: 'fs-cache',
      title: 'fsModuleCache: true',
      args: ['--experimental.fsModuleCache'],
      configLines: ['experimental: { fsModuleCache: true }'],
      preservesIsolation: true,
      primeRuns: 1,
    })
  }

  return candidates
}

interface MeasuredRun {
  wall: number
  ok: boolean
  stderr: string
}

interface MeasuredCandidate {
  candidate: DoctorCandidate
  wall: number
  ok: boolean
  stderr: string
  isolationVerdict?: 'passed' | 'failed'
}

function log(...args: string[]): void {
  console.log(...args)
}

export async function doctor(cliFilters: string[], options: CliOptions): Promise<void> {
  const { prepareVitest } = await import('./cli-api')

  log()
  log(c.inverse(c.bold(c.blue(' DOCTOR '))), 'resolving the current configuration...')

  const ctx = await prepareVitest(
    { ...options, watch: false, run: true },
    undefined,
    undefined,
    cliFilters,
  )
  const projects: DoctorProjectSummary[] = ctx.projects.map(project => ({
    name: project.name,
    pool: project.config.pool,
    environment: project.config.environment,
    isolate: project.config.isolate,
    browser: project.config.browser.enabled,
    fsModuleCache: project.config.experimental.fsModuleCache === true,
  }))
  const fileCount = (await ctx.getRelevantTestSpecifications(cliFilters)).length
  const configuredMaxWorkers = ctx.config.maxWorkers
  const effectiveMaxWorkers = typeof configuredMaxWorkers === 'number' && configuredMaxWorkers > 0
    ? configuredMaxWorkers
    : Math.max(1, availableParallelism() - 1)
  await ctx.close()

  // the environments import 'happy-dom' relative to the vitest package (it is
  // a peer dependency), so resolving from here mirrors what a run would do
  let happyDomAvailable = false
  try {
    import.meta.resolve('happy-dom')
    happyDomAvailable = true
  }
  catch {}

  const candidates = resolveDoctorCandidates(projects, { happyDomAvailable })

  const testProjects = projects.filter(project => !project.browser)
  const browserProjects = projects.filter(project => project.browser)

  if (testProjects.length === 0) {
    log()
    log('The configuration only runs browser projects - doctor tunes node-side pools and has nothing to measure here.')
    return
  }

  const baselineTitle = `baseline (${describeProjects(testProjects)})`

  const forwarded: string[] = []
  if (options.root) {
    forwarded.push('--root', String(options.root))
  }
  if (options.config) {
    forwarded.push('--config', String(options.config))
  }
  for (const project of toArray(options.project)) {
    forwarded.push('--project', String(project))
  }

  // browser projects are not affected by any candidate: re-running them in
  // every measurement only adds a constant cost that dilutes the deltas
  let browserNote: string | undefined
  if (browserProjects.length > 0 && !toArray(options.project).length) {
    if (testProjects.every(project => project.name)) {
      for (const project of testProjects) {
        forwarded.push('--project', project.name)
      }
      browserNote = `Browser projects (${browserProjects.map(project => project.name).join(', ')}) are excluded from the measurements - doctor only tunes node-side pools.`
    }
    else {
      browserNote = 'The workspace runs browser projects in every measurement; their constant cost dilutes the reported differences.'
    }
  }

  // make sure an interrupted doctor doesn't leave a test suite running
  let activeChild: ReturnType<typeof spawn> | undefined
  const killActiveChild = (): never => {
    activeChild?.kill('SIGKILL')
    process.exit(130)
  }
  process.once('SIGINT', killActiveChild)
  process.once('SIGTERM', killActiveChild)

  const runVitest = (extraArgs: string[], timeoutMs?: number): Promise<MeasuredRun> => {
    return new Promise((resolve) => {
      const start = performance.now()
      const child = spawn(
        process.execPath,
        [process.argv[1], 'run', ...forwarded, ...cliFilters, ...extraArgs],
        {
          env: { ...process.env, NO_COLOR: '1' },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      )
      activeChild = child
      let timedOut = false
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, timeoutMs)
        : undefined
      let stderr = ''
      child.stderr!.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4_000)
      })
      child.on('close', (code) => {
        if (timer) {
          clearTimeout(timer)
        }
        activeChild = undefined
        if (timedOut) {
          stderr += `\n(the run was killed after exceeding ${Math.round((timeoutMs || 0) / 1000)}s - several times the baseline duration)`
        }
        resolve({ wall: performance.now() - start, ok: code === 0 && !timedOut, stderr })
      })
    })
  }

  log()
  if (candidates.length === 0) {
    log('The configuration already uses the fastest setup Vitest knows how to compare - measuring it for reference.')
  }
  else {
    log('Measuring alternative configurations by running the test suite under each of them.')
    log(c.dim('Close other heavy programs - the comparison is only as good as the machine is quiet.'))
  }
  if (browserNote) {
    log(c.dim(browserNote))
  }
  log()

  // The first baseline run also warms up caches for every following run, so
  // candidates are compared in a warm steady state.
  process.stdout.write(c.dim(`  measuring ${baselineTitle}...`))
  const firstRun = await runVitest([])
  if (!firstRun.ok) {
    process.stdout.write('\n')
    log(c.red('The test suite fails with the current configuration. Fix the failures first - doctor needs a green suite to compare configurations.'))
    if (firstRun.stderr.trim()) {
      log(c.dim(firstRun.stderr.trim()))
    }
    process.exitCode = 1
    return
  }

  // scale repetitions to the suite duration: short suites are noisy and can
  // afford more runs, long suites cannot
  const reps = firstRun.wall < 10_000 ? 3 : firstRun.wall < 60_000 ? 2 : 1
  // the first run is cold and mostly warms up caches: always take at least one
  // more baseline run so the reported baseline is a warm one, like the
  // candidates that run after it
  const baselineRuns = Math.max(reps, 2)
  const baselineWalls = [firstRun.wall]
  for (let i = 1; i < baselineRuns; i++) {
    const run = await runVitest([])
    if (!run.ok) {
      process.stdout.write('\n')
      log(c.red(`The test suite passed once but failed on repetition ${i + 1} with the same configuration - doctor needs a stable green suite to compare configurations.`))
      if (run.stderr.trim()) {
        log(c.dim(run.stderr.trim()))
      }
      process.exitCode = 1
      return
    }
    baselineWalls.push(run.wall)
  }
  const baselineWall = Math.min(...baselineWalls)
  process.stdout.write(` ${formatSeconds(baselineWall)}\n`)

  // a candidate that takes several times the baseline is a regression, not a
  // recommendation - don't let it stall doctor indefinitely
  const candidateTimeout = Math.max(60_000, baselineWall * 4)

  const measured: MeasuredCandidate[] = []
  for (const candidate of candidates) {
    process.stdout.write(c.dim(`  measuring ${candidate.title}...`))
    let wall = Number.POSITIVE_INFINITY
    let ok = true
    let stderr = ''
    for (let i = 0; i < (candidate.primeRuns ?? 0) && ok; i++) {
      const run = await runVitest(candidate.args, candidateTimeout)
      ok = run.ok
      stderr = run.stderr
    }
    for (let i = 0; i < reps && ok; i++) {
      const run = await runVitest(candidate.args, candidateTimeout)
      wall = Math.min(wall, run.wall)
      ok = run.ok
      stderr = run.stderr
    }

    let isolationVerdict: MeasuredCandidate['isolationVerdict']
    if (ok && candidate.validateIsolation) {
      // tests can pass under shared state by accident of ordering: shuffle the
      // file order twice to catch the common cross-file couplings; the explicit
      // distinct seeds guarantee two different orders even when the user pinned
      // `sequence.seed` in their config
      isolationVerdict = 'passed'
      for (let i = 0; i < 2; i++) {
        const run = await runVitest(
          [...candidate.args, '--sequence.shuffle.files', `--sequence.seed=${271828 + i}`],
          candidateTimeout,
        )
        if (!run.ok) {
          isolationVerdict = 'failed'
          stderr = run.stderr
          break
        }
      }
    }

    measured.push({ candidate, wall, ok, stderr, isolationVerdict })
    process.stdout.write(ok ? ` ${formatSeconds(wall)}\n` : ` ${c.red('failed')}\n`)
  }

  const viable = measured.filter(result =>
    result.ok
    && result.isolationVerdict !== 'failed'
    && result.wall < baselineWall * 0.9,
  )

  // among candidates close to the fastest, prefer the one that keeps per-file
  // isolation - equal speed with stronger guarantees wins
  const fastest = viable.length > 0
    ? viable.reduce((a, b) => (b.wall < a.wall ? b : a))
    : undefined
  const preferred = fastest
    ? viable
      .filter(result => result.wall <= fastest.wall * 1.05)
      .sort((a, b) => Number(b.candidate.preservesIsolation) - Number(a.candidate.preservesIsolation))[0]
    : undefined

  // Past a certain worker count the single main-thread Vite server becomes the
  // bottleneck, so FEWER workers can be faster. Greedily descend by halving on
  // top of the winning configuration, keeping a step only when it is a real
  // (>= 5%) improvement.
  const workerStack = preferred ? preferred.candidate.args : []
  const workerSuffix = preferred ? ` (with ${preferred.candidate.title})` : ''
  interface WorkerProbe { workers: number; wall: number }
  const workerProbes: WorkerProbe[] = []
  let bestWorkers: WorkerProbe | undefined
  {
    let currentBest = preferred ? preferred.wall : baselineWall
    let probe = Math.floor(effectiveMaxWorkers / 2)
    while (probe >= 2 && probe < fileCount) {
      process.stdout.write(c.dim(`  measuring maxWorkers: ${probe}${workerSuffix}...`))
      let wall = Number.POSITIVE_INFINITY
      let ok = true
      for (let i = 0; i < reps && ok; i++) {
        const run = await runVitest([...workerStack, `--maxWorkers=${probe}`], candidateTimeout)
        wall = Math.min(wall, run.wall)
        ok = run.ok
      }
      process.stdout.write(ok ? ` ${formatSeconds(wall)}\n` : ` ${c.red('failed')}\n`)
      if (!ok) {
        break
      }
      workerProbes.push({ workers: probe, wall })
      if (wall >= currentBest * 0.95) {
        break
      }
      currentBest = wall
      bestWorkers = { workers: probe, wall }
      probe = Math.floor(probe / 2)
    }
  }

  log()
  log(c.bold('Results') + c.dim(` (min of ${reps} run${reps === 1 ? '' : 's'} each)`))
  log()
  const rowTitles = [
    ...measured.map(m => m.candidate.title),
    ...workerProbes.map(p => `maxWorkers: ${p.workers}${workerSuffix}`),
  ]
  const width = Math.max(baselineTitle.length, ...rowTitles.map(title => title.length)) + 2
  log(`  ${baselineTitle.padEnd(width)}${formatSeconds(baselineWall)}`)
  for (const result of measured) {
    const title = result.candidate.title.padEnd(width)
    if (!result.ok) {
      log(`  ${title}${c.red('failed')}`)
    }
    else if (result.isolationVerdict === 'failed') {
      log(`  ${title}${formatSeconds(result.wall)} ${c.red('(fails with a shuffled file order - tests depend on isolation)')}`)
    }
    else {
      log(`  ${title}${formatSeconds(result.wall)} ${formatDelta(result.wall, baselineWall)}`)
    }
  }
  for (const probeResult of workerProbes) {
    const title = `maxWorkers: ${probeResult.workers}${workerSuffix}`.padEnd(width)
    log(`  ${title}${formatSeconds(probeResult.wall)} ${formatDelta(probeResult.wall, baselineWall)}`)
  }

  // failing candidates are as informative as fast ones: show what broke,
  // so "vmThreads is not an option for this suite" comes with the reason
  for (const result of measured) {
    if (!result.ok) {
      logFailureExcerpt(`${result.candidate.title} failed with:`, result.stderr)
    }
    else if (result.isolationVerdict === 'failed') {
      logFailureExcerpt(`${result.candidate.title} failed with a shuffled file order:`, result.stderr)
    }
  }

  log()
  if (!preferred && !bestWorkers) {
    if (candidates.length === 0) {
      log(`${c.bold('Recommendation:')} keep the current configuration (${describeProjects(testProjects)}) - it measured ${c.yellow(formatSeconds(baselineWall))} and Vitest has no faster candidate to suggest for it.`)
    }
    else {
      log(`${c.bold('Recommendation:')} keep the current configuration (${describeProjects(testProjects)}) - no measured candidate was more than 10% faster.`)
    }
    return
  }

  const finalWall = bestWorkers ? bestWorkers.wall : preferred!.wall
  const recommendationTitle = [
    preferred?.candidate.title,
    bestWorkers ? `maxWorkers: ${bestWorkers.workers}` : undefined,
  ].filter(Boolean).join(' + ')
  const configLines = [
    ...(preferred ? preferred.candidate.configLines : []),
    ...(bestWorkers ? [`maxWorkers: ${bestWorkers.workers}`] : []),
  ]

  log(`${c.bold('Recommendation:')} ${c.yellow(recommendationTitle)} ${formatDelta(finalWall, baselineWall)}`)
  log()
  log(c.dim('  // vitest.config.ts'))
  log(c.dim(`  import { defineConfig } from 'vitest/config'`))
  log()
  log(c.dim('  export default defineConfig({'))
  log(c.dim('    test: {'))
  for (const [index, line] of configLines.entries()) {
    const comment = index === configLines.length - 1
      ? c.dim(` // measured ${Math.round(((finalWall - baselineWall) / baselineWall) * 100)}% on this suite`)
      : ''
    log(`      ${line},${comment}`)
  }
  log(c.dim('    },'))
  log(c.dim('  })'))
  log()
  if (preferred) {
    for (const note of candidateNotes(preferred)) {
      log(c.dim(`  ${note}`))
    }
  }
  if (bestWorkers) {
    log(c.dim(`  Fewer workers can be faster because every worker funnels transforms through the`))
    log(c.dim(`  single main-thread Vite server; a lower count also reduces memory pressure.`))
  }
  if (projects.length > 1) {
    log(c.dim('  Doctor overrides options for all projects at once; apply the change per project if they need different settings.'))
  }
  log(c.dim('  Trade-offs of every option: https://vitest.dev/guide/improving-performance'))
}

const FAILURE_EXCERPT_LINES = 15

function logFailureExcerpt(title: string, stderr: string): void {
  log()
  log(`  ${c.red(title)}`)
  if (!stderr.trim()) {
    log(c.dim('    (the run produced no error output - rerun with the same options to inspect it)'))
    return
  }
  const lines = stderr.trim().split('\n')
  const excerpt = lines.slice(-FAILURE_EXCERPT_LINES)
  if (lines.length > excerpt.length) {
    log(c.dim(`    … (last ${excerpt.length} lines)`))
  }
  for (const line of excerpt) {
    log(c.dim(`    ${line}`))
  }
}

function candidateNotes(result: MeasuredCandidate): string[] {
  switch (result.candidate.id) {
    case 'vmThreads':
      return [
        `vm pools keep per-file isolation but run test code in a VM context: cross-realm`,
        `instanceof edge cases and higher memory usage are possible (see vmMemoryLimit).`,
      ]
    case 'no-isolate':
    case 'threads-no-isolate':
      return [
        `The suite passed twice with a shuffled file order under shared state, so it is`,
        `likely - but not guaranteed - that no test depends on isolation.`,
      ]
    case 'happy-dom':
      return [
        `happy-dom implements the DOM differently than jsdom: the suite passed under it,`,
        `but double-check tests that depend on layout, navigation or other DOM edge cases.`,
      ]
    case 'fs-cache':
      return [
        `The experimental fs module cache persists transformed modules on disk: repeated`,
        `runs skip the transforms, the first run after a file change still pays them.`,
      ]
    default:
      return []
  }
}

function describeProjects(projects: DoctorProjectSummary[]): string {
  const pools = [...new Set(projects.map(project => project.pool))].join(', ')
  const isolate = projects.some(project => project.isolate)
  return `pool: ${pools} · isolate: ${isolate}`
}

function formatSeconds(time: number): string {
  return `${(time / 1000).toFixed(2)}s`
}

function formatDelta(wall: number, baseline: number): string {
  const delta = Math.round(((wall - baseline) / baseline) * 100)
  if (delta === 0) {
    return c.dim('(±0%)')
  }
  return delta < 0 ? c.green(`(${delta}%)`) : c.yellow(`(+${delta}%)`)
}
