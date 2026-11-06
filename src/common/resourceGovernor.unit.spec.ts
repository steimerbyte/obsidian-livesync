import { afterEach, describe, expect, it, vi } from "vitest";
import { LOG_LEVEL_INFO } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { promiseWithResolvers } from "octagonal-wheels/promises";
import {
    createDefaultGovernorConfig,
    createResourceGovernor,
    isGovernorError,
} from "./resourceGovernor";
import type { GovernorOptions, ResourceGovernor } from "./resourceGovernor";

const CONFIG_KEY = "livesync-resource-governor-v1";

function createStorage(initial?: string) {
    const map = new Map<string, string>();
    if (initial !== undefined) map.set(CONFIG_KEY, initial);
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => {
            map.set(key, value);
        },
        raw: () => map.get(CONFIG_KEY),
    };
}

function createClock(start = 0) {
    let time = start;
    return {
        now: () => time,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

function createGate() {
    const { promise, resolve } = promiseWithResolvers<void>();
    return { promise, open: resolve };
}

const governors: ResourceGovernor[] = [];

function createGovernor(options: Partial<GovernorOptions> = {}) {
    const clock = createClock();
    const storage = createStorage();
    const governor = createResourceGovernor();
    governor.configure({ pressure: () => 0, storage, log: () => undefined, now: clock.now, ...options });
    governors.push(governor);
    return { governor, clock, storage };
}

/** Starts `label`, records the start order and holds the slot until its gate is opened. */
function createBlocker(started: string[]) {
    const gates = new Map<string, () => void>();
    return {
        started,
        start(label: string) {
            const gate = createGate();
            gates.set(label, gate.open);
            return async () => {
                started.push(label);
                await gate.promise;
            };
        },
        release(label: string) {
            gates.get(label)?.();
        },
    };
}

afterEach(() => {
    for (const governor of governors) governor.dispose();
    governors.length = 0;
    vi.useRealTimers();
});

describe("resource governor pass-through", () => {
    it("runs work directly before it is configured", async () => {
        const governor = createResourceGovernor();

        await expect(governor.run("user", "save", async () => 42)).resolves.toBe(42);

        expect(governor.getSnapshot()).toMatchObject({ configured: false, dispatches: 0 });
    });

    it("runs work directly while disabled", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ enabled: false });

        await expect(governor.run("user", "save", async () => 7)).resolves.toBe(7);

        expect(governor.getSnapshot().dispatches).toBe(0);
        expect(governor.getSnapshot().enabled).toBe(false);
    });
});

describe("resource governor scheduling", () => {
    it("starts queued work in user, interactive, background order", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ limits: { user: 0, interactive: 0, background: 0 } });
        const gate = createGate();
        const started: string[] = [];
        const task = (label: string) => async () => {
            started.push(label);
            await gate.promise;
        };
        const user = governor.run("user", "u", task("u"));
        const interactive = governor.run("interactive", "i", task("i"));
        const background = governor.run("background", "b", task("b"));
        expect(started).toEqual([]);

        governor.setConfig({ limits: { user: 1, interactive: 1, background: 1 } });
        expect(started).toEqual(["u", "i", "b"]);

        gate.open();
        await Promise.all([user, interactive, background]);
    });

    it("keeps concurrency to the budget of each class", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ limits: { user: 2, interactive: 1, background: 2 } });
        const gate = createGate();
        const task = async () => {
            await gate.promise;
        };
        const user = [0, 1, 2, 3, 4].map((index) => governor.run("user", `u${index}`, task));
        const background = [0, 1, 2].map((index) => governor.run("background", `b${index}`, task));
        const interactive = governor.run("interactive", "i", task);

        expect(governor.getSnapshot().inFlight).toEqual({ user: 2, interactive: 1, background: 2 });
        expect(governor.getSnapshot().queued).toEqual({ user: 3, interactive: 0, background: 1 });

        gate.open();
        await Promise.all([...user, ...background, interactive]);
        expect(governor.getSnapshot().inFlight).toEqual({ user: 0, interactive: 0, background: 0 });
    });

    it("drops the oldest background request when the queue is full", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ limits: { user: 4, interactive: 2, background: 1 }, backgroundQueueLimit: 1 });
        const blocker = createBlocker([]);
        const running = governor.run("background", "b1", blocker.start("b1"));
        const queueGate = createGate();
        const task = async () => {
            await queueGate.promise;
        };
        const dropped = governor.run("background", "b2", task);
        let lateRan = false;
        const late = governor.tryRunBackground("late", async () => {
            lateRan = true;
        });

        await expect(dropped).rejects.toSatisfy((error) => isGovernorError(error, "queue-full"));
        expect(governor.getSnapshot().dropped).toBe(1);
        expect(governor.getSnapshot().queued.background).toBe(1);

        const promoted = governor.run("background", "b3", task);
        await expect(late).resolves.toBe(false);
        expect(lateRan).toBe(false);
        expect(governor.getSnapshot().dropped).toBe(2);

        blocker.release("b1");
        await running;
        queueGate.open();
        await Promise.all([promoted]);
    });

    it("lifts the lowest class every starvation interval", async () => {
        let pressure = 0.7;
        const { governor } = createGovernor({ pressure: () => pressure });
        governor.setConfig({ limits: { user: 1, interactive: 1, background: 1 }, starvationInterval: 1 });
        const blockers = createBlocker([]);

        const u1 = governor.run("user", "u1", blockers.start("u1"));
        const u2 = governor.run("user", "u2", blockers.start("u2"));
        const b1 = governor.run("background", "b1", blockers.start("b1"));
        expect(blockers.started).toEqual(["u1"]);

        // The background budget is zero under pressure. Once it is released, a single dispatch sees both
        // a free user slot and a free background slot; the lift makes that pass scan background first.
        pressure = 0;
        blockers.release("u1");
        await u1;
        await Promise.resolve();

        expect(blockers.started).toEqual(["u1", "b1", "u2"]);

        blockers.release("u2");
        blockers.release("b1");
        await Promise.all([u2, b1]);
    });

    it("keeps strict priority order when the lift is disabled", async () => {
        let pressure = 0.7;
        const { governor } = createGovernor({ pressure: () => pressure });
        governor.setConfig({ limits: { user: 1, interactive: 1, background: 1 }, starvationInterval: 0 });
        const blockers = createBlocker([]);

        const u1 = governor.run("user", "u1", blockers.start("u1"));
        const u2 = governor.run("user", "u2", blockers.start("u2"));
        const b1 = governor.run("background", "b1", blockers.start("b1"));
        expect(blockers.started).toEqual(["u1"]);

        pressure = 0;
        blockers.release("u1");
        await u1;
        await Promise.resolve();

        expect(blockers.started).toEqual(["u1", "u2", "b1"]);

        blockers.release("u2");
        blockers.release("b1");
        await Promise.all([u2, b1]);
    });
});

describe("resource governor background admission", () => {
    it("queues background work under pressure instead of rejecting it", async () => {
        vi.useFakeTimers();
        let pressure = 0.7;
        const { governor } = createGovernor({ pressure: () => pressure });
        let ran = false;

        const queued = governor.run("background", "scan", async () => {
            ran = true;
        });
        await Promise.resolve();
        expect(ran).toBe(false);
        expect(governor.getSnapshot().queued.background).toBe(1);

        pressure = 0.4;
        await vi.advanceTimersByTimeAsync(1000);

        await queued;
        expect(ran).toBe(true);
        expect(governor.getSnapshot().queued.background).toBe(0);
    });

    it("skips background work under pressure and coalesces an active label", async () => {
        let pressure = 0.7;
        const { governor } = createGovernor({ pressure: () => pressure });

        await expect(governor.tryRunBackground("scan", async () => undefined)).resolves.toBe(false);

        pressure = 0;
        const gate = createGate();
        const running = governor.tryRunBackground("scan", async () => {
            await gate.promise;
        });
        await Promise.resolve();
        await expect(governor.tryRunBackground("scan", async () => undefined)).resolves.toBe(false);

        gate.open();
        await expect(running).resolves.toBe(true);
        await expect(governor.tryRunBackground("scan", async () => undefined)).resolves.toBe(true);
    });
});

describe("resource governor hysteresis and cooldown", () => {
    it("moves between bands only on the thresholds", () => {
        let pressure = 0.5;
        const { governor } = createGovernor({ pressure: () => pressure });

        expect(governor.getSnapshot().level).toBe("normal");

        pressure = 0.6;
        expect(governor.getSnapshot().level).toBe("high");
        expect(governor.getSnapshot().limits).toEqual({ user: 1, interactive: 1, background: 0 });

        pressure = 0.5;
        expect(governor.getSnapshot().level).toBe("high");

        pressure = 0.4;
        expect(governor.getSnapshot().level).toBe("normal");
        expect(governor.getSnapshot().limits).toEqual({ user: 4, interactive: 2, background: 2 });
    });

    it("throttles background work after a long user task until the cooldown expires", async () => {
        vi.useFakeTimers();
        const { governor, clock } = createGovernor({ pressure: () => 0.5 });

        await governor.run("user", "save", async () => {
            clock.advance(2500);
        });
        expect(governor.getSnapshot().level).toBe("high");
        expect(governor.getSnapshot().dispatchedLongTasks).toBe(1);

        let ran = false;
        const background = governor.run("background", "scan", async () => {
            ran = true;
        });
        await Promise.resolve();
        expect(ran).toBe(false);
        expect(governor.getSnapshot().queued.background).toBe(1);

        clock.advance(6000);
        await vi.advanceTimersByTimeAsync(5000);

        await background;
        expect(ran).toBe(true);
        expect(governor.getSnapshot().level).toBe("normal");
    });
});

describe("resource governor disposal", () => {
    it("rejects queued work, leaves in-flight work alone and is idempotent", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ limits: { user: 4, interactive: 2, background: 1 } });
        const gate = createGate();
        const running = governor.run("background", "b1", async () => {
            await gate.promise;
        });
        const queued = governor.run("background", "b2", async () => undefined);

        governor.dispose();
        governor.dispose();

        await expect(queued).rejects.toSatisfy((error) => isGovernorError(error, "disposed"));
        expect(governor.getSnapshot().queued).toEqual({ user: 0, interactive: 0, background: 0 });

        gate.open();
        await running;
        await expect(governor.run("user", "after", async () => 5)).resolves.toBe(5);
    });

    it("releases an acquired slot idempotently", async () => {
        const { governor } = createGovernor();
        governor.setConfig({ limits: { user: 4, interactive: 2, background: 1 } });

        const firstRelease = await governor.acquire("background", "hold");
        let secondGranted = false;
        const second = governor.acquire("background", "wait").then((release) => {
            secondGranted = true;
            return release;
        });
        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(governor.getSnapshot().inFlight.background).toBe(1);

        firstRelease();
        firstRelease();
        const secondRelease = await second;
        expect(secondGranted).toBe(true);

        secondRelease();
        await Promise.resolve();
        expect(governor.getSnapshot().inFlight.background).toBe(0);
    });
});

describe("resource governor configuration", () => {
    it("uses the desktop defaults when nothing is stored", () => {
        const { governor } = createGovernor();

        expect(governor.getConfig()).toEqual(createDefaultGovernorConfig(false));
    });

    it("uses mobile defaults when the device reports mobile", () => {
        const { governor } = createGovernor({ isMobile: () => true });

        expect(governor.getConfig()).toEqual(createDefaultGovernorConfig(true));
    });

    const invalidStoredConfigs: Array<[string, string]> = [
        ["malformed", "not json"],
        ["a foreign version", JSON.stringify({ version: 99, backgroundQueueLimit: 5 })],
        ["a non-object", JSON.stringify([1, 2, 3])],
        [
            "out-of-range values",
            JSON.stringify({
                version: 1,
                limits: { user: 99 },
                pressureLimits: { background: -1 },
                backgroundQueueLimit: -3,
                pressureHigh: 2,
                pressureRelease: 0.9,
                cooldownMs: -1,
                starvationInterval: 90_000,
            }),
        ],
    ];
    it.each(invalidStoredConfigs)("falls back to defaults for %s", (_label, raw) => {
        const storage = createStorage(raw);
        const governor = createResourceGovernor({ pressure: () => 0, storage, log: () => undefined });
        governors.push(governor);

        expect(governor.getConfig()).toEqual(createDefaultGovernorConfig(false));
    });

    it("persists a patch and hands out copies", () => {
        const { governor, storage } = createGovernor();

        const updated = governor.setConfig({ backgroundQueueLimit: 8, limits: { background: 1 } });
        expect(updated.backgroundQueueLimit).toBe(8);
        expect(updated.limits).toEqual({ user: 4, interactive: 2, background: 1 });
        expect(JSON.parse(storage.raw() ?? "")).toMatchObject({ version: 1, backgroundQueueLimit: 8 });

        updated.limits.user = 99;
        expect(governor.getConfig().limits.user).toBe(4);
    });
});

describe("resource governor resilience", () => {
    it("keeps user work running when the pressure source throws", async () => {
        const { governor } = createGovernor({
            pressure: () => {
                throw new Error("sensor offline");
            },
        });

        await expect(governor.run("user", "save", async () => 1)).resolves.toBe(1);

        expect(governor.getSnapshot().pressure).toBe(0);
        expect(governor.isUnderPressure()).toBe(false);
    });

    it("keeps scheduling when the logger throws", async () => {
        let pressure = 0;
        const { governor } = createGovernor({
            pressure: () => pressure,
            log: () => {
                throw new Error("logger not ready");
            },
        });

        pressure = 0.6;
        await expect(governor.run("user", "save", async () => 2)).resolves.toBe(2);
        expect(governor.getSnapshot().level).toBe("high");
    });

    it("reports band transitions at info level", () => {
        let pressure = 0;
        const log = vi.fn();
        const { governor } = createGovernor({ pressure: () => pressure, log });

        pressure = 0.6;
        governor.getSnapshot();

        expect(log).toHaveBeenCalledWith(expect.stringContaining("high"), LOG_LEVEL_INFO);
    });
});
