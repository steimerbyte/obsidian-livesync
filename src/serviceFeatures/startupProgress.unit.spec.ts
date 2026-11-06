import { describe, expect, it } from "vitest";
import { EVENT_APPLICATION_READY } from "@/common/events";
import { startupProgress } from "@/common/startupProgress";
import { STARTUP_PROGRESS_FINALISING_PRIORITY, useStartupProgressFeature } from "./startupProgress";

type Handler = () => Promise<boolean>;

function createHost() {
    const ready: Handler[] = [];
    const initialised: { handler: Handler; priority: number | undefined }[] = [];
    const events = new Map<string, (() => unknown)[]>();
    const host = {
        services: {
            databaseEvents: {
                onDatabaseHasReady: { addHandler: (handler: Handler) => ready.push(handler) },
                onDatabaseInitialised: {
                    addHandler: (handler: Handler, priority?: number) =>
                        initialised.push({ handler, priority }) as unknown as () => void,
                },
            },
            context: {
                events: {
                    onEvent: (name: string, handler: () => unknown) => {
                        events.set(name, [...(events.get(name) ?? []), handler]);
                    },
                },
            },
        },
        serviceModules: {},
    };
    return { host, ready, initialised, events };
}

describe("useStartupProgressFeature", () => {
    it("drives the phases from the real start-up boundaries", async () => {
        const { host, ready, initialised, events } = createHost();
        useStartupProgressFeature(host as never);
        expect(startupProgress.value).toMatchObject({ active: true, percent: 0, phase: null });

        for (const handler of ready) expect(await handler()).toBe(true);
        expect(startupProgress.value.phase).toBe("scan");

        for (const { handler } of initialised) expect(await handler()).toBe(true);
        expect(startupProgress.value.phase).toBe("finalising");

        for (const handler of events.get(EVENT_APPLICATION_READY) ?? []) handler();
        expect(startupProgress.value).toMatchObject({ active: false, percent: 100, phase: null });
    });

    it("runs the finalising boundary after the default-priority initialisation handlers", () => {
        const { host, initialised } = createHost();
        useStartupProgressFeature(host as never);
        expect(initialised).toHaveLength(1);
        expect(initialised[0].priority).toBe(STARTUP_PROGRESS_FINALISING_PRIORITY);
        expect(STARTUP_PROGRESS_FINALISING_PRIORITY).toBeGreaterThan(0);
    });
});
