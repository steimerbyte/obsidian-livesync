/**
 * @file startupProgress.ts
 * @description Truthful progress of the plug-in start-up sequence, for the status orb.
 *
 * Commonlib's `prepareDatabaseForUse` owns the start-up order: reset readiness, open the database,
 * `vault.scanVault`, every `onDatabaseInitialised` handler, `commitPendingFileEvents`, `markIsReady`.
 * It cannot be modified from this repository, so this store is fed only from things the fork can
 * observe: database-ready and database-initialised handlers, the OfflineScanner's own processed
 * counter, and the per-item counters of ConfigSync and Hidden File Sync.
 *
 * Reported values never go backwards within one start-up: the percentage is clamped to the highest
 * value reached so far (and to 99 while running), so a late, unknown-cost step stalls the ring
 * instead of rewinding it.
 */
import { reactiveSource, type ReactiveValue } from "octagonal-wheels/dataobject/reactive";

export const STARTUP_PHASES = ["database", "scan", "customisations", "hidden-files", "finalising"] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

/**
 * Share of the overall percentage each phase owns; the weights sum to 100.
 *
 * Derived from the measured 1.0.51 phone start-up (356 s, `diagnostics/phone-1.0.51-startup.log`):
 * database/load ≈ 4 %, vault scan 4 %, ConfigSync 43 %, Hidden File Sync 40 %, finalising 9 %.
 * The scan is floored at 10 because it is the only phase which grows with vault size on other
 * devices and would otherwise finish long before the ring moves; ConfigSync and Hidden File Sync
 * keep their measured share because they are what actually takes the time on a phone.
 */
export const STARTUP_PHASE_WEIGHTS: Readonly<Record<StartupPhase, number>> = {
    database: 5,
    scan: 10,
    customisations: 40,
    "hidden-files": 35,
    finalising: 10,
};

/** Label of the running phase. The UI renders it and appends the numeric percentage itself. */
export const STARTUP_PHASE_LABELS: Readonly<Record<StartupPhase, string>> = {
    database: "Opening database",
    scan: "Scanning vault",
    customisations: "Syncing customisations",
    "hidden-files": "Syncing hidden files",
    finalising: "Finalising",
};

/**
 * Start-up stages in the order `prepareDatabaseForUse` runs them. Customisation and hidden-file
 * sync are independent `onDatabaseInitialised` handlers, so they share a stage: starting one must
 * not report the other as finished.
 */
const STARTUP_STAGES: readonly (readonly StartupPhase[])[] = [
    ["database"],
    ["scan"],
    ["customisations", "hidden-files"],
    ["finalising"],
];

export type StartupProgress = {
    /** Overall progress 0-100. Never 100 while {@link StartupProgress.active}, never decreasing. */
    percent: number;
    /** True from a fresh load until the plug-in reports ready; updates are ignored afterwards. */
    active: boolean;
    /** Phase currently running, or null while no start-up is running. */
    phase: StartupPhase | null;
    /** Label of {@link StartupProgress.phase}, or "" while idle. */
    label: string;
    /** Items completed in the running phase, and its known total (0 while unknown). */
    completed: number;
    total: number;
};

type PhaseState = {
    completed: number;
    total: number;
    done: boolean;
};

type RunState = {
    active: boolean;
    phase: StartupPhase | null;
    percent: number;
    phases: Record<StartupPhase, PhaseState>;
};

function createPhaseStates(): Record<StartupPhase, PhaseState> {
    const states = {} as Record<StartupPhase, PhaseState>;
    for (const phase of STARTUP_PHASES) states[phase] = { completed: 0, total: 0, done: false };
    return states;
}

function createIdleRun(): RunState {
    return { active: false, phase: null, percent: 0, phases: createPhaseStates() };
}

let run = createIdleRun();

function snapshot(): StartupProgress {
    const phase = run.active ? run.phase : null;
    const state = phase ? run.phases[phase] : null;
    return {
        percent: run.percent,
        active: run.active,
        phase,
        label: phase ? STARTUP_PHASE_LABELS[phase] : "",
        completed: state?.completed ?? 0,
        total: state?.total ?? 0,
    };
}

const source = reactiveSource<StartupProgress>(snapshot());

/** Live start-up progress. Read `.value` or subscribe with `onChanged`. */
export const startupProgress: ReactiveValue<StartupProgress> = source;

function phaseFraction(state: PhaseState): number {
    if (state.done) return 1;
    if (state.total <= 0) return 0;
    return Math.min(state.completed, state.total) / state.total;
}

function weightedPercent(): number {
    let total = 0;
    for (const phase of STARTUP_PHASES) {
        total += phaseFraction(run.phases[phase]) * STARTUP_PHASE_WEIGHTS[phase];
    }
    return Math.floor(total);
}

function publish(): void {
    if (run.active) {
        // 100 belongs to the ready signal, so a fully weighted phase set still stops at 99.
        run.percent = Math.max(run.percent, Math.min(99, weightedPercent()));
    }
    source.value = snapshot();
}

/** Begin a new start-up run: resets the percentage and re-arms progress reporting. */
export function resetStartupProgress(): void {
    run = { active: true, phase: null, percent: 0, phases: createPhaseStates() };
    publish();
}

/**
 * Mark a phase as the running one. Every phase in an earlier stage has finished by then, which is
 * what retires `database`/`scan` when a later stage reports and when a phase is skipped entirely.
 * A late boundary from an earlier stage never rewinds the current one.
 */
export function beginStartupPhase(phase: StartupPhase): void {
    if (!run.active || run.phases[phase].done) return;
    const stageIndex = STARTUP_STAGES.findIndex((stage) => stage.includes(phase));
    const current = run.phase;
    const currentStageIndex = current ? STARTUP_STAGES.findIndex((stage) => stage.includes(current)) : -1;
    if (currentStageIndex > stageIndex) return;
    for (const stage of STARTUP_STAGES.slice(0, stageIndex)) {
        for (const finished of stage) run.phases[finished].done = true;
    }
    run.phase = phase;
    publish();
}

/**
 * Report the completed item count of a phase, beginning it when needed.
 * @param phase - Phase the count belongs to.
 * @param completed - Items finished so far; the highest value wins.
 * @param total - Known item count of the phase; omitted keeps the previously known total.
 */
export function reportStartupPhaseProgress(phase: StartupPhase, completed: number, total?: number): void {
    if (!run.active) return;
    const state = run.phases[phase];
    if (state.done) return;
    if (run.phase !== phase) beginStartupPhase(phase);
    if (total !== undefined && total > state.total) state.total = total;
    if (Number.isFinite(completed)) state.completed = Math.max(state.completed, Math.floor(completed));
    publish();
}

/** Finish a phase and count its whole (possibly empty) item set. */
export function completeStartupPhase(phase: StartupPhase): void {
    if (!run.active) return;
    const state = run.phases[phase];
    state.done = true;
    state.completed = state.total;
    publish();
}

/** The plug-in is ready: report 100 and stop accepting updates until the next reset. */
export function finishStartupProgress(): void {
    if (!run.active) return;
    for (const phase of STARTUP_PHASES) run.phases[phase].done = true;
    run.active = false;
    run.phase = null;
    run.percent = 100;
    publish();
}

const OFFLINE_SCANNER_PROGRESS = /\[SF:OfflineScanner\][^\n]*?\bProcessing:\s*(\d+)\s*\/\s*(\d+)/;

/**
 * Feed a service log line to the scanner phase.
 *
 * shortcut: the OfflineScanner has no exported counter or progress event, so its `Processing: x/y`
 * log line (emitted every 25 files by the pinned commonlib) is the only per-file signal available.
 * Revisit if commonlib ever exposes an offline-scan progress event.
 */
export function observeStartupLog(message: unknown): void {
    if (!run.active || typeof message !== "string") return;
    if (!message.includes("OfflineScanner")) return;
    const match = OFFLINE_SCANNER_PROGRESS.exec(message);
    if (!match) return;
    const processed = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(processed) || !Number.isFinite(total) || total <= 0) return;
    reportStartupPhaseProgress("scan", processed, total);
}
