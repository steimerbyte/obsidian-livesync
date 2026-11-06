/**
 * @file loadMonitor.ts
 * @description Samples event-loop lag, long tasks and, where the browser still exposes it, heap usage into a
 *              single 0..1 pressure figure. Deliberately a plain factory: no service module, no events and no
 *              timers until `start()` is called. Nothing here logs; the resource governor reports transitions.
 */
import { compatGlobal } from "@vrtmrz/livesync-commonlib/compat/common/coreEnvFunctions";

export type LoadSnapshot = {
    pressure: number;
    heapUsed?: number;
    heapLimit?: number;
    eventLoopLagMs: number;
    longTaskCount: number;
    longTaskMs: number;
    cores: number;
    deviceMemoryGB?: number;
    sampledAt: number;
};

export type LoadMonitor = {
    start(): void;
    stop(): void;
    snapshot(): LoadSnapshot;
};

/** Only the parts of `performance` this monitor uses; `memory` is non-standard and frequently absent. */
export type LoadPerformance = {
    now?(): number;
    memory?: {
        usedJSHeapSize?: unknown;
        jsHeapSizeLimit?: unknown;
    };
};

/** Only the parts of `navigator` this monitor uses. */
export type LoadNavigator = {
    hardwareConcurrency?: number;
    deviceMemory?: number;
    userAgent?: string;
    userAgentData?: { mobile?: boolean };
};

/** Schedules a callback and returns its cancellation; injected for deterministic tests. */
export type LoadTimeout = (callback: () => void, intervalMs: number) => () => void;

export type LoadMonitorOptions = {
    now?: () => number;
    setTimeout?: LoadTimeout;
    performance?: LoadPerformance | null;
    navigator?: LoadNavigator | null;
    PerformanceObserver?: typeof PerformanceObserver | null;
    isHidden?: () => boolean;
    isMobile?: () => boolean;
};

type HeapUsage = {
    used: number;
    limit: number;
};

const SAMPLE_INTERVAL_MS = 500;
const MAX_LAG_MS = 2000;
/** Long-task duration that saturates its term: 500 ms of tasks is the normalised window, 0.5 its full band. */
const LONG_TASK_FULL_MS = 500 * 0.5;

const HEAP_WEIGHT = 0.5;
const LAG_WEIGHT = 0.3;
const TASK_WEIGHT = 0.2;

const HEAP_RATIO_LOW = 0.55;
const HEAP_RATIO_HIGH = 0.9;
const LAG_BAND_LOW_MS = 50;
const LAG_BAND_HIGH_MS = 250;

const DESKTOP_SMOOTHING = 0.3;
const MOBILE_SMOOTHING = 0.5;

function clamp(value: number, lowest: number, highest: number): number {
    return Math.min(Math.max(value, lowest), highest);
}

/** Maps `value` from the band `lowest..highest` onto 0..1. */
function scale(value: number, lowest: number, highest: number): number {
    return clamp((value - lowest) / (highest - lowest), 0, 1);
}

function globalPerformance(): LoadPerformance | null {
    try {
        return typeof compatGlobal.performance === "object" && compatGlobal.performance !== null
            ? compatGlobal.performance
            : null;
    } catch {
        return null;
    }
}

function globalNavigator(): LoadNavigator | null {
    try {
        return typeof compatGlobal.navigator === "object" && compatGlobal.navigator !== null
            ? compatGlobal.navigator
            : null;
    } catch {
        return null;
    }
}

function globalPerformanceObserver(): typeof PerformanceObserver | null {
    try {
        return typeof compatGlobal.PerformanceObserver === "function" ? compatGlobal.PerformanceObserver : null;
    } catch {
        return null;
    }
}

function defaultTimeout(): LoadTimeout {
    return (callback, intervalMs) => {
        const handle = compatGlobal.setTimeout(callback, intervalMs);
        return () => compatGlobal.clearTimeout(handle);
    };
}

function readCores(navigator: LoadNavigator | null): number {
    try {
        const cores = Number(navigator?.hardwareConcurrency);
        return Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 1;
    } catch {
        return 1;
    }
}

function readDeviceMemory(navigator: LoadNavigator | null): number | undefined {
    try {
        const memory = Number(navigator?.deviceMemory);
        return Number.isFinite(memory) && memory > 0 ? memory : undefined;
    } catch {
        return undefined;
    }
}

export function createLoadMonitor(options: LoadMonitorOptions = {}): LoadMonitor {
    const performanceSource = options.performance !== undefined ? options.performance : globalPerformance();
    const navigatorSource = options.navigator !== undefined ? options.navigator : globalNavigator();
    const schedule = options.setTimeout ?? defaultTimeout();
    // The Obsidian plugin injects Platform.isMobile; other hosts default to the desktop policy.
    const isMobile = options.isMobile ?? (() => false);
    const isHidden =
        options.isHidden ??
        (() => {
            try {
                return compatGlobal.document?.hidden === true;
            } catch {
                return false;
            }
        });
    const readNow =
        options.now ??
        (() => {
            try {
                const value = performanceSource?.now?.();
                return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
            } catch {
                return Date.now();
            }
        });

    const cores = readCores(navigatorSource);
    const deviceMemoryGB = readDeviceMemory(navigatorSource);

    let running = false;
    let cancelTimer: (() => void) | undefined;
    let observer: PerformanceObserver | undefined;
    let tickStartedAt = 0;
    // Per-window accumulation from the long-task observer, consumed and reset by every tick.
    let windowTaskCount = 0;
    let windowTaskMs = 0;

    let pressure = 0;
    let eventLoopLagMs = 0;
    let longTaskCount = 0;
    let longTaskMs = 0;
    let sampledAt = 0;
    let snapshot: LoadSnapshot = Object.freeze({
        pressure: 0,
        eventLoopLagMs: 0,
        longTaskCount: 0,
        longTaskMs: 0,
        cores,
        sampledAt: 0,
        ...(deviceMemoryGB === undefined ? {} : { deviceMemoryGB }),
    });

    function isMobileSafely(): boolean {
        try {
            return isMobile();
        } catch {
            return false;
        }
    }

    function isHiddenSafely(): boolean {
        try {
            return isHidden();
        } catch {
            return false;
        }
    }

    /**
     * `performance.memory` is non-standard and has been removed or disabled in current Chromium builds, so it is
     * only ever an optional term: anything missing, malformed or unreadable drops the term and renormalises.
     */
    function readHeap(): HeapUsage | null {
        try {
            const memory = performanceSource?.memory;
            if (memory === undefined || memory === null) return null;
            const used = Number(memory.usedJSHeapSize);
            const limit = Number(memory.jsHeapSizeLimit);
            if (!Number.isFinite(used) || used < 0) return null;
            if (!Number.isFinite(limit) || limit <= 0) return null;
            return { used, limit };
        } catch {
            return null;
        }
    }

    function computePressure(lagMs: number, taskMs: number, heap: HeapUsage | null): number {
        const terms: Array<{ weight: number; value: number }> = [];
        if (heap !== null) {
            terms.push({ weight: HEAP_WEIGHT, value: scale(heap.used / heap.limit, HEAP_RATIO_LOW, HEAP_RATIO_HIGH) });
        }
        terms.push({ weight: LAG_WEIGHT, value: scale(lagMs, LAG_BAND_LOW_MS, LAG_BAND_HIGH_MS) });
        terms.push({ weight: TASK_WEIGHT, value: clamp(taskMs / LONG_TASK_FULL_MS, 0, 1) });
        const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
        return terms.reduce((sum, term) => sum + term.weight * term.value, 0) / totalWeight;
    }

    function startObserver(): void {
        stopObserver();
        const Observer =
            options.PerformanceObserver !== undefined ? options.PerformanceObserver : globalPerformanceObserver();
        if (Observer === null) return;
        try {
            const created = new Observer((entries) => {
                for (const entry of entries.getEntries()) {
                    windowTaskCount += 1;
                    windowTaskMs += entry.duration;
                }
            });
            created.observe({ type: "longtask", buffered: false });
            observer = created;
        } catch {
            // No `longtask` support (Node, older browsers, some embedded webviews): lag alone carries the sample.
            observer = undefined;
        }
    }

    function stopObserver(): void {
        try {
            observer?.disconnect();
        } catch {
            // A disconnected or foreign observer is not a reason to fail.
        }
        observer = undefined;
    }

    function scheduleNext(): void {
        if (!running) return;
        tickStartedAt = readNow();
        cancelTimer = schedule(tick, SAMPLE_INTERVAL_MS);
    }

    function tick(): void {
        cancelTimer = undefined;
        if (!running) return;
        const nowMs = readNow();
        const lag = clamp(nowMs - tickStartedAt - SAMPLE_INTERVAL_MS, 0, MAX_LAG_MS);
        const taskCount = windowTaskCount;
        const taskMs = windowTaskMs;
        windowTaskCount = 0;
        windowTaskMs = 0;
        if (!isHiddenSafely()) {
            const heap = readHeap();
            const sample = computePressure(lag, taskMs, heap);
            const smoothing = isMobileSafely() ? MOBILE_SMOOTHING : DESKTOP_SMOOTHING;
            pressure = sampledAt === 0 ? sample : pressure + smoothing * (sample - pressure);
            eventLoopLagMs = lag;
            longTaskCount = taskCount;
            longTaskMs = taskMs;
            sampledAt = nowMs;
            snapshot = Object.freeze({
                pressure,
                eventLoopLagMs,
                longTaskCount,
                longTaskMs,
                cores,
                sampledAt,
                ...(deviceMemoryGB === undefined ? {} : { deviceMemoryGB }),
                ...(heap === null ? {} : { heapUsed: heap.used, heapLimit: heap.limit }),
            });
        }
        scheduleNext();
    }

    function start(): void {
        if (running) return;
        running = true;
        startObserver();
        scheduleNext();
    }

    function stop(): void {
        running = false;
        if (cancelTimer !== undefined) {
            cancelTimer();
            cancelTimer = undefined;
        }
        stopObserver();
    }

    return {
        start,
        stop,
        snapshot: () => snapshot,
    };
}
