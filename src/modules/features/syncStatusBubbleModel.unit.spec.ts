import { describe, expect, it } from "vitest";

import {
    deriveSyncBubbleCategories,
    deriveSyncBubbleState,
    type SyncBubbleCategoryTone,
    type SyncBubbleSnapshot,
} from "./syncStatusBubbleModel.ts";

function snapshot(overrides: Partial<SyncBubbleSnapshot> = {}): SyncBubbleSnapshot {
    return {
        ready: true,
        syncStatus: "COMPLETED",
        maxPullSeq: 0,
        lastSyncPullSeq: 0,
        maxPushSeq: 0,
        lastSyncPushSeq: 0,
        ...overrides,
    };
}

function categoryTones(input: SyncBubbleSnapshot): Record<string, SyncBubbleCategoryTone> {
    return Object.fromEntries(deriveSyncBubbleCategories(input).map((category) => [category.key, category.tone]));
}

describe("deriveSyncBubbleState", () => {
    it("reports initialisation while the app is not ready", () => {
        const state = deriveSyncBubbleState(snapshot({ ready: false }));

        expect(state.tone).toBe("starting");
        expect(state.busy).toBe(true);
        expect(state.headline).toBe("Starting LiveSync");
        expect(state.progress).toBeUndefined();
    });

    it("reports an error and keeps the latest status text", () => {
        const state = deriveSyncBubbleState(
            snapshot({ syncStatus: "ERRORED", statusText: "Failed to connect to the remote database" })
        );

        expect(state.tone).toBe("error");
        expect(state.detail).toBe("Failed to connect to the remote database");
        expect(state.icon).toBe("alert-triangle");
    });

    it("reports paused replication", () => {
        const state = deriveSyncBubbleState(snapshot({ syncStatus: "PAUSED" }));

        expect(state.tone).toBe("paused");
        expect(state.headline).toBe("Sync paused");
    });

    it("reports an active customization sync", () => {
        const state = deriveSyncBubbleState(snapshot({ configActive: true, statusText: "Scanning customizations..." }));

        expect(state.tone).toBe("config");
        expect(state.headline).toBe("Synchronising settings");
        expect(state.busy).toBe(true);
    });

    it("reports replication progress from both directions", () => {
        const state = deriveSyncBubbleState(
            snapshot({
                syncStatus: "CONNECTED",
                maxPullSeq: 1000,
                lastSyncPullSeq: 420,
                maxPushSeq: 2000,
                lastSyncPushSeq: 1000,
                queueText: "📥 3",
            })
        );

        expect(state.tone).toBe("syncing");
        expect(state.headline).toBe("Synchronising");
        expect(state.detail).toContain("↓ 420/1,000");
        expect(state.detail).toContain("↑ 1,000/2,000");
        expect(state.detail).toContain("📥 3");
        expect(state.progress).toBeCloseTo(0.42);
    });

    it("falls back to the only direction that reports progress", () => {
        const state = deriveSyncBubbleState(
            snapshot({ syncStatus: "JOURNAL_RECEIVE", maxPushSeq: 200, lastSyncPushSeq: 50 })
        );

        expect(state.headline).toBe("Receiving changes");
        expect(state.detail).toBe("↑ 50/200");
        expect(state.progress).toBeCloseTo(0.25);
    });

    it("reports an indeterminate running sync without sequence totals", () => {
        const state = deriveSyncBubbleState(snapshot({ syncStatus: "STARTED" }));

        expect(state.headline).toBe("Preparing sync");
        expect(state.detail).toBe("Connecting to the remote database…");
        expect(state.progress).toBeUndefined();
    });

    it("reports offline while the remote is unreachable", () => {
        const state = deriveSyncBubbleState(snapshot({ syncStatus: "NOT_CONNECTED" }));

        expect(state.tone).toBe("offline");
        expect(state.icon).toBe("cloud-off");
    });

    it("reports ready when replication is completed", () => {
        const state = deriveSyncBubbleState(snapshot({ syncStatus: "COMPLETED", queueText: "📄 2" }));

        expect(state.tone).toBe("ready");
        expect(state.headline).toBe("Ready");
        expect(state.detail).toContain("📄 2");
        expect(state.busy).toBe(false);
    });

    it("keeps errors above a stale configuration-sync flag", () => {
        const state = deriveSyncBubbleState(snapshot({ syncStatus: "ERRORED", configActive: true }));

        expect(state.tone).toBe("error");
    });
});

describe("deriveSyncBubbleCategories", () => {
    it("reports every category green once LiveSync is idle and ready", () => {
        const categories = deriveSyncBubbleCategories(snapshot({ syncStatus: "COMPLETED" }));

        expect(categories.map((category) => category.key)).toEqual([
            "initialisation",
            "replication",
            "sync",
            "config",
            "storage",
            "warnings",
        ]);
        expect(categories.map((category) => category.label)).toEqual([
            "Initialisation",
            "Replication",
            "Sync",
            "Config sync",
            "Storage",
            "Warnings",
        ]);
        expect(categories.every((category) => category.tone === "ok")).toBe(true);
    });

    it("warns about initialisation and sync while the app is starting", () => {
        const tones = categoryTones(snapshot({ ready: false, syncStatus: "STARTED" }));

        expect(tones.initialisation).toBe("warn");
        expect(tones.sync).toBe("warn");
        expect(tones.replication).toBe("warn");
    });

    it("warns while replication is running or paused", () => {
        expect(categoryTones(snapshot({ syncStatus: "JOURNAL_SEND" })).replication).toBe("warn");
        expect(categoryTones(snapshot({ syncStatus: "CONNECTED" })).replication).toBe("warn");
        expect(categoryTones(snapshot({ syncStatus: "PAUSED" })).replication).toBe("warn");
    });

    it("warns while configuration sync is active", () => {
        const tones = categoryTones(snapshot({ configActive: true }));

        expect(tones.config).toBe("warn");
        expect(tones.sync).toBe("warn");
    });

    it("keeps the sync row out of green while offline, paused, or replicating", () => {
        expect(categoryTones(snapshot({ syncStatus: "NOT_CONNECTED" })).sync).toBe("warn");
        expect(categoryTones(snapshot({ syncStatus: "PAUSED" })).sync).toBe("warn");
        expect(categoryTones(snapshot({ syncStatus: "JOURNAL_SEND" })).sync).toBe("warn");
        expect(categoryTones(snapshot({ syncStatus: "COMPLETED" })).sync).toBe("ok");
        expect(categoryTones(snapshot({ syncStatus: "ERRORED" })).sync).toBe("error");
    });

    it("reports replication and sync errors", () => {
        const tones = categoryTones(snapshot({ syncStatus: "ERRORED" }));

        expect(tones.replication).toBe("error");
        expect(tones.sync).toBe("error");
        expect(tones.initialisation).toBe("ok");
        expect(tones.storage).toBe("ok");
    });

    it("reports warnings as errors", () => {
        expect(categoryTones(snapshot({ warningText: "⚠️ Network unreachable" })).warnings).toBe("error");
        expect(categoryTones(snapshot({ warningText: "   " })).warnings).toBe("ok");
        expect(categoryTones(snapshot({ warningText: undefined })).warnings).toBe("ok");
    });

    it("warns while storage, database, or chunk queues hold work", () => {
        expect(categoryTones(snapshot({ storageQueues: { storage: 2 } })).storage).toBe("warn");
        expect(categoryTones(snapshot({ storageQueues: { database: 1 } })).storage).toBe("warn");
        expect(categoryTones(snapshot({ storageQueues: { chunk: 1 } })).storage).toBe("warn");
    });

    it("keeps storage green when every queue is empty", () => {
        const tones = categoryTones(snapshot({ storageQueues: { storage: 0, database: 0, chunk: 0 } }));

        expect(tones.storage).toBe("ok");
    });
});
