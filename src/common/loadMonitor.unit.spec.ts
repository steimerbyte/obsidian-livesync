import { describe, expect, it } from "vitest";
import { createLoadMonitor } from "./loadMonitor";
import type { LoadMonitorOptions, LoadNavigator, LoadPerformance } from "./loadMonitor";

type FakeTimer = { dueAt: number; callback: () => void };

function createClock() {
    let time = 0;
    let nextId = 1;
    const timers = new Map<number, FakeTimer>();
    const delays: number[] = [];
    const state = { hidden: false, mobile: false };

    const setTimeout = (callback: () => void, delay: number) => {
        const id = nextId++;
        timers.set(id, { dueAt: time + delay, callback });
        delays.push(delay);
        return () => {
            timers.delete(id);
        };
    };

    /** Moves the clock by `ms` and then runs everything that became due, so late callbacks see the delay. */
    const elapse = (ms: number) => {
        time += ms;
        let fired = true;
        while (fired) {
            fired = false;
            for (const [id, timer] of [...timers]) {
                if (timer.dueAt <= time) {
                    timers.delete(id);
                    timer.callback();
                    fired = true;
                }
            }
        }
    };

    return { now: () => time, setTimeout, elapse, delays, state, pending: () => timers.size };
}

function createObserverHarness() {
    let callback: ((list: { getEntries: () => PerformanceEntry[] }) => void) | undefined;
    let observed: PerformanceObserverInit | undefined;
    let disconnects = 0;

    class FakePerformanceObserver {
        constructor(observerCallback: (list: { getEntries: () => PerformanceEntry[] }) => void) {
            callback = observerCallback;
        }
        observe(options: PerformanceObserverInit) {
            observed = options;
        }
        disconnect() {
            disconnects += 1;
        }
        takeRecords(): PerformanceEntry[] {
            return [];
        }
    }

    return {
        ctor: FakePerformanceObserver as unknown as typeof PerformanceObserver,
        emit: (durations: number[]) => {
            callback?.({ getEntries: () => durations.map((duration) => ({ duration }) as PerformanceEntry) });
        },
        observed: () => observed,
        disconnects: () => disconnects,
    };
}

function createHarness(overrides: Partial<LoadMonitorOptions> = {}) {
    const clock = createClock();
    const observer = createObserverHarness();
    const performance: LoadPerformance = { now: clock.now };
    const navigator: LoadNavigator = { hardwareConcurrency: 8, deviceMemory: 4 };
    const options: LoadMonitorOptions = {
        now: clock.now,
        setTimeout: clock.setTimeout,
        performance,
        navigator,
        PerformanceObserver: observer.ctor,
        isHidden: () => clock.state.hidden,
        isMobile: () => clock.state.mobile,
        ...overrides,
    };
    return { monitor: createLoadMonitor(options), clock, observer, performance };
}

describe("createLoadMonitor", () => {
    it("publishes an inert, frozen snapshot before the first tick", () => {
        const { monitor, clock } = createHarness();

        const snapshot = monitor.snapshot();

        expect(snapshot.sampledAt).toBe(0);
        expect(snapshot.pressure).toBe(0);
        expect(snapshot.eventLoopLagMs).toBe(0);
        expect(snapshot.longTaskCount).toBe(0);
        expect(snapshot.longTaskMs).toBe(0);
        expect(snapshot.cores).toBe(8);
        expect(snapshot.deviceMemoryGB).toBe(4);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(monitor.snapshot()).toBe(snapshot);
        expect(clock.delays).toHaveLength(0);
    });

    it("starts once and observes long tasks without replaying the buffer", () => {
        const { monitor, clock, observer } = createHarness();

        monitor.start();
        monitor.start();

        expect(clock.delays).toEqual([500]);
        expect(clock.pending()).toBe(1);
        expect(observer.observed()).toEqual({ type: "longtask", buffered: false });
    });

    it("derives pressure from lag alone when heap metrics are absent", () => {
        const { monitor, clock } = createHarness();
        monitor.start();

        clock.elapse(500 + 150);

        const snapshot = monitor.snapshot();
        expect(snapshot.eventLoopLagMs).toBe(150);
        expect(snapshot.heapUsed).toBeUndefined();
        expect(snapshot.heapLimit).toBeUndefined();
        // lag term 0.5 of its band at weight 0.3, renormalised over the remaining 0.5 of weight.
        expect(snapshot.pressure).toBeCloseTo(0.3);
        expect(snapshot.sampledAt).toBe(650);
    });

    it("folds a readable heap into the sample and reports its figures", () => {
        const { monitor, clock, performance } = createHarness();
        performance.memory = { usedJSHeapSize: 900, jsHeapSizeLimit: 1000 };
        monitor.start();

        clock.elapse(500);

        const snapshot = monitor.snapshot();
        expect(snapshot.pressure).toBeCloseTo(0.5);
        expect(snapshot.heapUsed).toBe(900);
        expect(snapshot.heapLimit).toBe(1000);
    });

    const rejectedHeapMetrics: Array<[string, LoadPerformance["memory"]]> = [
        ["missing", undefined],
        ["malformed", { usedJSHeapSize: "many", jsHeapSizeLimit: 1000 }],
        ["negative", { usedJSHeapSize: -1, jsHeapSizeLimit: 1000 }],
        ["zero limit", { usedJSHeapSize: 1, jsHeapSizeLimit: 0 }],
        ["infinite", { usedJSHeapSize: 1, jsHeapSizeLimit: Number.POSITIVE_INFINITY }],
    ];
    it.each(rejectedHeapMetrics)("drops the heap term when it is %s", (_label, memory) => {
        const { monitor, clock, performance } = createHarness();
        performance.memory = memory;
        monitor.start();

        clock.elapse(500 + 150);

        const snapshot = monitor.snapshot();
        expect(snapshot.heapUsed).toBeUndefined();
        expect(snapshot.pressure).toBeCloseTo(0.3);
    });

    it("survives a heap getter that throws", () => {
        const clock = createClock();
        const performance: LoadPerformance = { now: clock.now };
        Object.defineProperty(performance, "memory", {
            get() {
                throw new Error("heap access denied");
            },
        });
        const { monitor } = createHarness({ performance, now: clock.now, setTimeout: clock.setTimeout });
        monitor.start();

        clock.elapse(500 + 150);

        expect(monitor.snapshot().heapUsed).toBeUndefined();
        expect(monitor.snapshot().pressure).toBeCloseTo(0.3);
    });

    it("accumulates long tasks per window and resets them on the next tick", () => {
        const { monitor, clock, observer } = createHarness();
        monitor.start();

        observer.emit([100, 200]);
        clock.elapse(500);
        expect(monitor.snapshot().longTaskCount).toBe(2);
        expect(monitor.snapshot().longTaskMs).toBe(300);
        expect(monitor.snapshot().pressure).toBeCloseTo(0.4);

        clock.elapse(500);
        expect(monitor.snapshot().longTaskCount).toBe(0);
        expect(monitor.snapshot().longTaskMs).toBe(0);
    });

    it("skips the sample while hidden and restarts the expected tick time", () => {
        const { monitor, clock } = createHarness();
        monitor.start();

        clock.state.hidden = true;
        clock.elapse(5000);
        expect(monitor.snapshot().sampledAt).toBe(0);

        clock.state.hidden = false;
        clock.elapse(500);
        expect(monitor.snapshot().sampledAt).toBe(5500);
        expect(monitor.snapshot().eventLoopLagMs).toBe(0);
    });

    it("clamps an absurd lag sample", () => {
        const { monitor, clock } = createHarness();
        monitor.start();

        clock.elapse(5000);

        expect(monitor.snapshot().eventLoopLagMs).toBe(2000);
        expect(monitor.snapshot().pressure).toBeCloseTo(0.6);
    });

    it("smooths harder on mobile than on the desktop", () => {
        const desktop = createHarness();
        desktop.monitor.start();
        desktop.clock.elapse(500 + 250);
        expect(desktop.monitor.snapshot().pressure).toBeCloseTo(0.6);
        desktop.clock.elapse(500);
        expect(desktop.monitor.snapshot().pressure).toBeCloseTo(0.42);

        const mobile = createHarness();
        mobile.clock.state.mobile = true;
        mobile.monitor.start();
        mobile.clock.elapse(500 + 250);
        expect(mobile.monitor.snapshot().pressure).toBeCloseTo(0.6);
        mobile.clock.elapse(500);
        expect(mobile.monitor.snapshot().pressure).toBeCloseTo(0.3);
    });

    it("stops the timer and the observer while keeping the last sample", () => {
        const { monitor, clock, observer } = createHarness();
        monitor.start();
        clock.elapse(500 + 150);
        const last = monitor.snapshot();

        monitor.stop();

        expect(observer.disconnects()).toBe(1);
        expect(clock.pending()).toBe(0);
        clock.elapse(5000);
        expect(monitor.snapshot()).toBe(last);
    });

    it("runs without a long-task observer", () => {
        const { monitor, clock } = createHarness({ PerformanceObserver: null });
        monitor.start();

        clock.elapse(500 + 150);

        expect(monitor.snapshot().pressure).toBeCloseTo(0.3);
        expect(monitor.snapshot().longTaskCount).toBe(0);
    });

    it("survives an observer that refuses to start", () => {
        class BrokenObserver {
            constructor() {
                throw new Error("longtask unsupported");
            }
        }
        const { monitor, clock } = createHarness({
            PerformanceObserver: BrokenObserver as unknown as typeof PerformanceObserver,
        });
        monitor.start();

        clock.elapse(500 + 150);

        expect(monitor.snapshot().pressure).toBeCloseTo(0.3);
    });
});
