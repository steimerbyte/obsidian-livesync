/**
 * @file resourceGovernor.ts
 * @description Serialises background work against a per-priority concurrency budget so that user actions keep
 *              running when the device is under load. One singleton for the plugin, plus a factory for tests.
 *
 * There is deliberately no shared bulk limit: replication and SyncGuard are not governed, and a global pool
 * would let a background scan starve them. Every priority therefore has its own queue and its own budget.
 */
import { compatGlobal, type CompatTimeoutHandle } from "@vrtmrz/livesync-commonlib/compat/common/coreEnvFunctions";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import { LOG_LEVEL_INFO, LOG_LEVEL_VERBOSE } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { LOG_LEVEL } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { createLoadMonitor } from "./loadMonitor";
import type { LoadMonitor } from "./loadMonitor";

export type GovernorPriority = "user" | "interactive" | "background";
export type GovernorLevel = "normal" | "high";
export type GovernorErrorCode = "skipped" | "queue-full" | "disposed";
export type GovernorLimits = Record<GovernorPriority, number>;

export type GovernorConfig = {
    enabled: boolean;
    limits: GovernorLimits;
    pressureLimits: GovernorLimits;
    backgroundQueueLimit: number;
    pressureHigh: number;
    pressureRelease: number;
    cooldownMs: number;
    starvationInterval: number;
};

/** A patch whose per-class limits may be supplied one at a time. */
export type GovernorConfigPatch = Partial<Omit<GovernorConfig, "limits" | "pressureLimits">> & {
    limits?: Partial<GovernorLimits>;
    pressureLimits?: Partial<GovernorLimits>;
};

export type GovernorSnapshot = {
    configured: boolean;
    enabled: boolean;
    level: GovernorLevel;
    pressure: number;
    limits: GovernorLimits;
    inFlight: GovernorLimits;
    queued: GovernorLimits;
    dispatches: number;
    dropped: number;
    dispatchedLongTasks: number;
};

export type GovernorOptions = {
    isMobile?: () => boolean;
    log?: (message: string, level?: LOG_LEVEL) => void;
    pressure?: () => number;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    now?: () => number;
};

type QueueEntry = {
    priority: GovernorPriority;
    label: string;
    start: () => void;
    cancel: (error: unknown) => void;
};

const PRIORITY_ORDER: readonly GovernorPriority[] = ["user", "interactive", "background"];
const REVERSE_PRIORITY_ORDER: readonly GovernorPriority[] = ["background", "interactive", "user"];

const CONFIG_STORAGE_KEY = "livesync-resource-governor-v1";
const CONFIG_VERSION = 1;

const DESKTOP_LIMITS: GovernorLimits = { user: 4, interactive: 2, background: 2 };
const MOBILE_LIMITS: GovernorLimits = { user: 2, interactive: 2, background: 1 };
const PRESSURE_LIMITS: GovernorLimits = { user: 1, interactive: 1, background: 0 };

const DEFAULT_BACKGROUND_QUEUE_LIMIT = 32;
const DEFAULT_PRESSURE_HIGH = 0.55;
const DEFAULT_PRESSURE_RELEASE = 0.45;
const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_STARVATION_INTERVAL = 16;

/** Pressure is re-read on this interval while any queue is waiting, so a drop in pressure releases work. */
const PRESSURE_POLL_MS = 1000;
const HEARTBEAT_MS = 30_000;
/** A user or interactive task running this long throttles background work afterwards. */
const LONG_TASK_MS = 2000;

export class GovernorError extends Error {
    readonly code: GovernorErrorCode;

    constructor(code: GovernorErrorCode, message: string) {
        super(message);
        this.name = "GovernorError";
        this.code = code;
    }
}

export function isGovernorError(error: unknown, code?: GovernorErrorCode): error is GovernorError {
    return error instanceof GovernorError && (code === undefined || error.code === code);
}

function readNumber(value: unknown, fallback: number, lowest: number, highest: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= lowest && value <= highest
        ? value
        : fallback;
}

/** Unknown JSON becomes an empty record so every field falls back individually. */
function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readLimits(value: unknown, fallback: GovernorLimits): GovernorLimits {
    const record = asRecord(value);
    return {
        user: Math.round(readNumber(record.user, fallback.user, 0, 64)),
        interactive: Math.round(readNumber(record.interactive, fallback.interactive, 0, 64)),
        background: Math.round(readNumber(record.background, fallback.background, 0, 64)),
    };
}

export function createDefaultGovernorConfig(isMobile: boolean): GovernorConfig {
    return {
        enabled: true,
        limits: { ...(isMobile ? MOBILE_LIMITS : DESKTOP_LIMITS) },
        pressureLimits: { ...PRESSURE_LIMITS },
        backgroundQueueLimit: DEFAULT_BACKGROUND_QUEUE_LIMIT,
        pressureHigh: DEFAULT_PRESSURE_HIGH,
        pressureRelease: DEFAULT_PRESSURE_RELEASE,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        starvationInterval: DEFAULT_STARVATION_INTERVAL,
    };
}

function normaliseGovernorConfig(input: unknown, defaults: GovernorConfig): GovernorConfig {
    const record = asRecord(input);
    const pressureHigh = readNumber(record.pressureHigh, defaults.pressureHigh, 0.05, 0.95);
    const pressureRelease = readNumber(record.pressureRelease, defaults.pressureRelease, 0, 0.95);
    const releaseIsUsable = pressureRelease < pressureHigh;
    return {
        enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
        limits: readLimits(record.limits, defaults.limits),
        pressureLimits: readLimits(record.pressureLimits, defaults.pressureLimits),
        backgroundQueueLimit: Math.round(
            readNumber(record.backgroundQueueLimit, defaults.backgroundQueueLimit, 1, 1024)
        ),
        pressureHigh: releaseIsUsable ? pressureHigh : defaults.pressureHigh,
        pressureRelease: releaseIsUsable ? pressureRelease : defaults.pressureRelease,
        cooldownMs: Math.round(readNumber(record.cooldownMs, defaults.cooldownMs, 0, 600_000)),
        starvationInterval: Math.round(
            readNumber(record.starvationInterval, defaults.starvationInterval, 0, 1024)
        ),
    };
}

function cloneConfig(config: GovernorConfig): GovernorConfig {
    return { ...config, limits: { ...config.limits }, pressureLimits: { ...config.pressureLimits } };
}

function readStoredConfig(
    storage: Pick<Storage, "getItem" | "setItem"> | null,
    defaults: GovernorConfig
): GovernorConfig {
    if (storage === null) return defaults;
    try {
        const raw = storage.getItem(CONFIG_STORAGE_KEY);
        if (raw === null) return defaults;
        const record = asRecord(JSON.parse(raw));
        if (record.version !== CONFIG_VERSION) return defaults;
        return normaliseGovernorConfig(record, defaults);
    } catch {
        // Unreadable or malformed storage is a fresh start, never a failure.
        return defaults;
    }
}

function writeStoredConfig(storage: Pick<Storage, "getItem" | "setItem"> | null, config: GovernorConfig): void {
    if (storage === null) return;
    try {
        storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ version: CONFIG_VERSION, ...config }));
    } catch {
        // Private mode or a full quota must not break scheduling.
    }
}

export class ResourceGovernor {
    private options: GovernorOptions = {};
    private config: GovernorConfig = createDefaultGovernorConfig(false);
    private configured = false;
    private disposed = false;
    /** Hysteresis state: only the thresholds move it, the cooldown can force `high` on top. */
    private limitLevel: GovernorLevel = "normal";
    private reportedLevel: GovernorLevel = "normal";
    private pressure = 0;
    private cooldownUntil = 0;
    private nextHeartbeatAt = 0;
    private timer: CompatTimeoutHandle | undefined;
    private timerDueAt = 0;
    private monitor: LoadMonitor | undefined;
    private pressureSource: (() => number) | undefined;
    private readonly queues: Record<GovernorPriority, QueueEntry[]> = { user: [], interactive: [], background: [] };
    private readonly inFlight: GovernorLimits = { user: 0, interactive: 0, background: 0 };
    private readonly activeLabels = new Set<string>();
    private dispatches = 0;
    private dropped = 0;
    private dispatchedLongTasks = 0;

    configure(options: GovernorOptions = {}): void {
        this.stopMonitoring();
        this.clearTimer();
        this.options = { ...options };
        this.disposed = false;
        const defaults = createDefaultGovernorConfig(this.isMobileDevice());
        this.config = readStoredConfig(this.resolveStorage(), defaults);
        this.configured = true;
        this.limitLevel = "normal";
        this.reportedLevel = "normal";
        this.pressure = 0;
        this.cooldownUntil = 0;
        this.dispatches = 0;
        this.dropped = 0;
        this.dispatchedLongTasks = 0;
        this.nextHeartbeatAt = options.log === undefined ? 0 : this.nowMs() + HEARTBEAT_MS;
        this.pressureSource = options.pressure;
        if (options.pressure === undefined) {
            const monitor = createLoadMonitor({ isMobile: () => this.isMobileDevice() });
            monitor.start();
            this.monitor = monitor;
            this.pressureSource = () => monitor.snapshot().pressure;
        }
        this.updateLevel();
        this.dispatch();
        this.scheduleWake();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.clearTimer();
        this.stopMonitoring();
        const error = new GovernorError("disposed", "The resource governor has been disposed");
        for (const priority of PRIORITY_ORDER) {
            const queue = this.queues[priority];
            while (queue.length > 0) {
                queue.shift()?.cancel(error);
            }
        }
        this.activeLabels.clear();
    }

    run<T>(priority: GovernorPriority, label: string, task: () => Promise<T>): Promise<T> {
        if (!this.isGoverning()) return Promise.resolve().then(task);
        const { promise, resolve, reject } = promiseWithResolvers<T>();
        this.enqueue({
            priority,
            label,
            start: () => this.startEntry(priority, label, task, resolve, reject),
            cancel: (error) => reject(error),
        });
        return promise;
    }

    async tryRunBackground(label: string, task: () => Promise<unknown>): Promise<boolean> {
        if (this.isUnderPressure()) return false;
        if (this.activeLabels.has(label)) return false;
        this.activeLabels.add(label);
        try {
            await this.run("background", label, task);
            return true;
        } catch (error) {
            if (isGovernorError(error, "queue-full")) return false;
            throw error;
        } finally {
            this.activeLabels.delete(label);
        }
    }

    /**
     * Holds a slot until the returned releaser is called; the releaser is idempotent. Resolves once the slot is
     * granted, so callers can wrap a stream of short operations without queueing each one.
     */
    async acquire(priority: GovernorPriority, label = "acquire"): Promise<() => void> {
        const granted = promiseWithResolvers<() => void>();
        const hold = () => {
            const slot = promiseWithResolvers<void>();
            let released = false;
            granted.resolve(() => {
                if (released) return;
                released = true;
                slot.resolve();
            });
            return slot.promise;
        };
        void this.run(priority, label, hold).catch(granted.reject);
        return await granted.promise;
    }

    isUnderPressure(): boolean {
        if (!this.isGoverning()) return false;
        this.updateLevel();
        return this.effectiveLevel() === "high";
    }

    getConfig(): GovernorConfig {
        return cloneConfig(this.config);
    }

    setConfig(patch: GovernorConfigPatch): GovernorConfig {
        const merged: GovernorConfig = {
            ...this.config,
            ...patch,
            limits: { ...this.config.limits, ...patch.limits },
            pressureLimits: { ...this.config.pressureLimits, ...patch.pressureLimits },
        };
        this.config = normaliseGovernorConfig(merged, this.config);
        this.nextHeartbeatAt = this.options.log === undefined ? 0 : this.nowMs() + HEARTBEAT_MS;
        writeStoredConfig(this.resolveStorage(), this.config);
        this.updateLevel();
        this.dispatch();
        this.scheduleWake();
        return cloneConfig(this.config);
    }

    getSnapshot(): GovernorSnapshot {
        this.updateLevel();
        return {
            configured: this.configured,
            enabled: this.config.enabled,
            level: this.effectiveLevel(),
            pressure: this.pressure,
            limits: { ...this.limitsForLevel() },
            inFlight: { ...this.inFlight },
            queued: {
                user: this.queues.user.length,
                interactive: this.queues.interactive.length,
                background: this.queues.background.length,
            },
            dispatches: this.dispatches,
            dropped: this.dropped,
            dispatchedLongTasks: this.dispatchedLongTasks,
        };
    }

    private isGoverning(): boolean {
        return this.configured && this.config.enabled && !this.disposed;
    }

    private isMobileDevice(): boolean {
        const probe = this.options.isMobile ?? (() => false);
        try {
            return probe();
        } catch {
            return false;
        }
    }

    private resolveStorage(): Pick<Storage, "getItem" | "setItem"> | null {
        if (this.options.storage !== undefined) return this.options.storage;
        try {
            return typeof compatGlobal.localStorage === "object" && compatGlobal.localStorage !== null
                ? compatGlobal.localStorage
                : null;
        } catch {
            return null;
        }
    }

    private nowMs(): number {
        try {
            const injected = this.options.now?.();
            if (typeof injected === "number" && Number.isFinite(injected)) return injected;
        } catch {
            // A broken clock falls through to the monotonic default.
        }
        try {
            const value = compatGlobal.performance?.now();
            return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
        } catch {
            return Date.now();
        }
    }

    private log(message: string, level: LOG_LEVEL): void {
        const logger = this.options.log;
        if (logger === undefined) return;
        try {
            logger(message, level);
        } catch {
            // The host logger may not be ready yet; scheduling must never depend on it.
        }
    }

    private stopMonitoring(): void {
        this.monitor?.stop();
        this.monitor = undefined;
        this.pressureSource = undefined;
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            compatGlobal.clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private enqueue(entry: QueueEntry): void {
        const queue = this.queues[entry.priority];
        if (entry.priority === "background" && queue.length >= this.config.backgroundQueueLimit) {
            const evicted = queue.shift();
            if (evicted !== undefined) {
                this.dropped += 1;
                evicted.cancel(
                    new GovernorError("queue-full", `Background queue is full, dropping "${evicted.label}"`)
                );
            }
        }
        queue.push(entry);
        this.dispatch();
    }

    private startEntry<T>(
        priority: GovernorPriority,
        label: string,
        task: () => Promise<T>,
        resolve: (value: T) => void,
        reject: (error: unknown) => void
    ): void {
        const startedAt = this.nowMs();
        this.inFlight[priority] += 1;
        this.dispatches += 1;
        void (async () => {
            try {
                resolve(await task());
            } catch (error) {
                reject(error);
            } finally {
                this.inFlight[priority] -= 1;
                if (this.nowMs() - startedAt >= LONG_TASK_MS) {
                    this.dispatchedLongTasks += 1;
                    // Only user-facing work self-throttles; background work must not extend its own penalty.
                    if (priority !== "background") this.startCooldown();
                }
                this.dispatch();
            }
        })();
    }

    /**
     * Fills every class up to its own budget. On each `starvationInterval`-th start the scan runs in reverse
     * order once, so lower classes are not pushed behind a continuous stream of higher-priority work.
     */
    private dispatch(): void {
        if (!this.configured || this.disposed) return;
        if (!this.config.enabled) {
            this.releaseQueuedAsPassThrough();
            return;
        }
        this.updateLevel();
        const limits = this.limitsForLevel();
        const order = this.shouldLiftStarvation() ? REVERSE_PRIORITY_ORDER : PRIORITY_ORDER;
        let started = false;
        for (const priority of order) {
            const queue = this.queues[priority];
            while (queue.length > 0 && this.inFlight[priority] < limits[priority]) {
                const entry = queue.shift();
                if (entry === undefined) break;
                entry.start();
                started = true;
            }
        }
        if (started || this.hasQueuedWork()) this.scheduleWake();
    }

    private shouldLiftStarvation(): boolean {
        const interval = this.config.starvationInterval;
        return interval > 0 && this.dispatches > 0 && this.dispatches % interval === 0;
    }

    private releaseQueuedAsPassThrough(): void {
        for (const priority of PRIORITY_ORDER) {
            const queue = this.queues[priority];
            while (queue.length > 0) {
                queue.shift()?.start();
            }
        }
    }

    private hasQueuedWork(): boolean {
        return PRIORITY_ORDER.some((priority) => this.queues[priority].length > 0);
    }

    private limitsForLevel(): GovernorLimits {
        return this.effectiveLevel() === "high" ? this.config.pressureLimits : this.config.limits;
    }

    /** Effective level: the hysteresis state, forced high until any cooldown expires. */
    private effectiveLevel(): GovernorLevel {
        return this.limitLevel === "high" || this.nowMs() < this.cooldownUntil ? "high" : "normal";
    }

    private updateLevel(): void {
        const pressure = this.samplePressure();
        if (pressure !== undefined) {
            this.pressure = pressure;
            if (pressure >= this.config.pressureHigh) this.limitLevel = "high";
            else if (pressure <= this.config.pressureRelease) this.limitLevel = "normal";
        }
        const level = this.effectiveLevel();
        if (level !== this.reportedLevel) {
            this.reportedLevel = level;
            this.log(
                `Resource pressure is now ${level} (sample ${this.pressure.toFixed(2)}, limits ${JSON.stringify(
                    this.limitsForLevel()
                )})`,
                LOG_LEVEL_INFO
            );
        }
    }

    private samplePressure(): number | undefined {
        const source = this.pressureSource;
        if (source === undefined) return undefined;
        try {
            const value = source();
            return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : undefined;
        } catch {
            // A broken sensor keeps the previous level; user work must never be blocked by it.
            return undefined;
        }
    }

    private startCooldown(): void {
        const until = this.nowMs() + this.config.cooldownMs;
        if (until > this.cooldownUntil) this.cooldownUntil = until;
        this.scheduleWake();
    }

    private scheduleWake(): void {
        if (this.disposed) return;
        const nowMs = this.nowMs();
        let dueAt = Number.POSITIVE_INFINITY;
        if (this.cooldownUntil > nowMs) dueAt = this.cooldownUntil;
        if (this.nextHeartbeatAt > nowMs) dueAt = Math.min(dueAt, this.nextHeartbeatAt);
        if (this.hasQueuedWork()) dueAt = Math.min(dueAt, nowMs + PRESSURE_POLL_MS);
        if (dueAt === Number.POSITIVE_INFINITY) {
            this.clearTimer();
            return;
        }
        if (this.timer !== undefined && this.timerDueAt <= dueAt) return;
        this.clearTimer();
        this.timerDueAt = dueAt;
        this.timer = compatGlobal.setTimeout(() => this.handleWake(), Math.max(0, dueAt - nowMs));
    }

    private handleWake(): void {
        this.timer = undefined;
        if (this.disposed) return;
        this.updateLevel();
        this.dispatch();
        this.logHeartbeat();
        this.scheduleWake();
    }

    private logHeartbeat(): void {
        if (this.nextHeartbeatAt === 0) return;
        const nowMs = this.nowMs();
        if (nowMs < this.nextHeartbeatAt) return;
        this.nextHeartbeatAt = nowMs + HEARTBEAT_MS;
        const snapshot = this.getSnapshot();
        this.log(
            `Resource governor: level ${snapshot.level}, pressure ${snapshot.pressure.toFixed(2)}, ` +
                `in flight ${JSON.stringify(snapshot.inFlight)}, queued ${JSON.stringify(snapshot.queued)}, ` +
                `${snapshot.dispatches} dispatched, ${snapshot.dropped} dropped`,
            LOG_LEVEL_VERBOSE
        );
    }
}

export function createResourceGovernor(options?: GovernorOptions): ResourceGovernor {
    const governor = new ResourceGovernor();
    if (options !== undefined) governor.configure(options);
    return governor;
}

const defaultGovernor = new ResourceGovernor();

export function configureGovernor(options: GovernorOptions = {}): void {
    defaultGovernor.configure(options);
}

export function disposeGovernor(): void {
    defaultGovernor.dispose();
}

export function run<T>(priority: GovernorPriority, label: string, task: () => Promise<T>): Promise<T> {
    return defaultGovernor.run(priority, label, task);
}

export function tryRunBackground(label: string, task: () => Promise<unknown>): Promise<boolean> {
    return defaultGovernor.tryRunBackground(label, task);
}

export function acquire(priority: GovernorPriority, label?: string): Promise<() => void> {
    return defaultGovernor.acquire(priority, label);
}

export function isUnderPressure(): boolean {
    return defaultGovernor.isUnderPressure();
}

export function getGovernorConfig(): GovernorConfig {
    return defaultGovernor.getConfig();
}

export function setGovernorConfig(patch: GovernorConfigPatch): GovernorConfig {
    return defaultGovernor.setConfig(patch);
}

export function getGovernorSnapshot(): GovernorSnapshot {
    return defaultGovernor.getSnapshot();
}
