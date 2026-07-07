const DOM_ENVIRONMENTS = new Set(['jsdom', 'happy-dom'])

/** Minimum summed environment setup time before the hint is worth printing. */
const MIN_ENVIRONMENT_TIME = 2_000
/** Minimum share of the project's tracked time spent setting up environments. */
const MIN_ENVIRONMENT_SHARE = 0.25

/**
 * A hint has to be worth acting on: the estimated saving must be noticeable.
 * Run-to-run noise of real suites is commonly a few percent, so anything below
 * ~5% of the wall time cannot even be confirmed by trying the change - except
 * on long runs, where 10 seconds is worth attention regardless of percentage.
 */
export function isSavingWorthHinting(saving: number, executionTime: number): boolean {
  if (saving < 250) {
    return false
  }
  return saving >= executionTime * 0.05 || saving >= 10_000
}

export interface EnvironmentDiagnosticInput {
  name: string
  environment: string
  pool: string
  isolate: boolean
  browser: boolean
  /** The user explicitly configured the pool, so don't suggest changing it. */
  poolProvided: boolean
  /** The user explicitly configured isolation, so don't suggest disabling it. */
  isolateProvided: boolean
  /** Summed time spent creating the environment, across all files. */
  environmentTime: number
  /** Number of files that created an environment. */
  environmentCount: number
  /** Summed time of all tracked phases of this project. */
  trackedTime: number
  /** How many workers the environment setups were spread across. */
  parallelism: number
  /** Wall time of the whole run. */
  executionTime: number
}

export interface EnvironmentDiagnostic {
  name: string
  environment: string
  environmentTime: number
  environmentCount: number
  /** Share of the project's tracked time, 0-1. */
  share: number
  /** Whether suggesting `isolate: false` is appropriate. */
  suggestIsolate: boolean
}

/**
 * Detects projects where re-creating a DOM environment for every test file
 * dominates the run. With an isolating pool the environment is set up once
 * per file; `vmThreads`/`vmForks` set it up once per worker while still
 * giving every file a fresh VM context.
 */
export function getEnvironmentDiagnostics(
  projects: EnvironmentDiagnosticInput[],
): EnvironmentDiagnostic[] {
  return projects
    .filter((project) => {
      if (
        !DOM_ENVIRONMENTS.has(project.environment)
        || (project.pool !== 'forks' && project.pool !== 'threads')
        || !project.isolate
        || project.browser
        || project.poolProvided
        || project.environmentCount <= 1
        || project.environmentTime < MIN_ENVIRONMENT_TIME
        || project.trackedTime <= 0
        || project.environmentTime / project.trackedTime < MIN_ENVIRONMENT_SHARE
      ) {
        return false
      }
      // setups are spread across the worker lanes; a vm pool would still pay
      // one setup per lane, so the reducible wall time is the rest
      const parallelism = Math.max(1, project.parallelism)
      const saving
        = project.environmentTime / parallelism
          - project.environmentTime / project.environmentCount
      return isSavingWorthHinting(saving, project.executionTime)
    })
    .map(project => ({
      name: project.name,
      environment: project.environment,
      environmentTime: project.environmentTime,
      environmentCount: project.environmentCount,
      share: project.environmentTime / project.trackedTime,
      suggestIsolate: !project.isolateProvided,
    }))
}
