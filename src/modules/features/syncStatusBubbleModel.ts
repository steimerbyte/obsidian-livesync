export type SyncBubbleTone = "starting" | "ready" | "syncing" | "config" | "error" | "paused" | "offline";

export type SyncBubbleCategoryTone = "ok" | "warn" | "error";

export type SyncBubbleCategoryKey = "initialisation" | "replication" | "sync" | "config" | "storage" | "warnings";

export type SyncBubbleCategory = {
    key: SyncBubbleCategoryKey;
    label: string;
    tone: SyncBubbleCategoryTone;
};

/** Counts still waiting in the storage, database and chunk queues. */
export type SyncBubbleStorageQueues = {
    storage?: number;
    database?: number;
    chunk?: number;
};

export type SyncBubbleSnapshot = {
    ready: boolean;
    syncStatus: string;
    maxPullSeq: number;
    lastSyncPullSeq: number;
    maxPushSeq: number;
    lastSyncPushSeq: number;
    queueText?: string;
    configActive?: boolean;
    statusText?: string;
    warningText?: string;
    storageQueues?: SyncBubbleStorageQueues;
};

export type SyncBubbleState = {
    tone: SyncBubbleTone;
    headline: string;
    detail: string;
    icon: string;
    progress?: number;
    busy: boolean;
};

const ACTIVE_STATUSES: Record<string, true> = {
    STARTED: true,
    CONNECTED: true,
    JOURNAL_SEND: true,
    JOURNAL_RECEIVE: true,
};
const COUNT_FORMAT = new Intl.NumberFormat("en-GB");

function clampFraction(done: number, total: number): number | undefined {
    if (!Number.isFinite(total) || total <= 0) return undefined;
    if (!Number.isFinite(done)) return undefined;
    return Math.max(0, Math.min(1, done / total));
}

function compactText(text: string | undefined, maxLength = 180): string {
    if (!text) return "";
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function describeProgress(snapshot: SyncBubbleSnapshot): { text: string; progress?: number } {
    const pull = clampFraction(snapshot.lastSyncPullSeq, snapshot.maxPullSeq);
    const push = clampFraction(snapshot.lastSyncPushSeq, snapshot.maxPushSeq);
    const parts: string[] = [];
    if (pull !== undefined) {
        parts.push(
            `↓ ${COUNT_FORMAT.format(Math.min(snapshot.lastSyncPullSeq, snapshot.maxPullSeq))}/${COUNT_FORMAT.format(snapshot.maxPullSeq)}`
        );
    }
    if (push !== undefined) {
        parts.push(
            `↑ ${COUNT_FORMAT.format(Math.min(snapshot.lastSyncPushSeq, snapshot.maxPushSeq))}/${COUNT_FORMAT.format(snapshot.maxPushSeq)}`
        );
    }
    const progress = pull === undefined ? push : push === undefined ? pull : Math.min(pull, push);
    return { text: parts.join(" · "), progress };
}

export function deriveSyncBubbleState(snapshot: SyncBubbleSnapshot): SyncBubbleState {
    const statusText = compactText(snapshot.statusText);
    const queueText = compactText(snapshot.queueText, 120);

    if (!snapshot.ready) {
        return {
            tone: "starting",
            headline: "Starting LiveSync",
            detail: "Initialising plugin and database…",
            icon: "hourglass",
            busy: true,
        };
    }

    if (snapshot.syncStatus === "ERRORED") {
        return {
            tone: "error",
            headline: "Sync error",
            detail: statusText || "The last replication failed. Open the log for details.",
            icon: "alert-triangle",
            busy: false,
        };
    }

    if (snapshot.syncStatus === "PAUSED") {
        return {
            tone: "paused",
            headline: "Sync paused",
            detail: statusText || "Replication is paused.",
            icon: "pause",
            busy: false,
        };
    }

    if (snapshot.configActive) {
        return {
            tone: "config",
            headline: "Synchronising settings",
            detail: statusText || "Checking plugins, themes and settings.",
            icon: "settings",
            busy: true,
        };
    }

    if (ACTIVE_STATUSES[snapshot.syncStatus]) {
        const { text, progress } = describeProgress(snapshot);
        const headline =
            snapshot.syncStatus === "JOURNAL_SEND"
                ? "Sending changes"
                : snapshot.syncStatus === "JOURNAL_RECEIVE"
                  ? "Receiving changes"
                  : snapshot.syncStatus === "STARTED"
                    ? "Preparing sync"
                    : "Synchronising";
        return {
            tone: "syncing",
            headline,
            detail: [text, queueText].filter(Boolean).join(" · ") || "Connecting to the remote database…",
            icon: "refresh-cw",
            progress,
            busy: true,
        };
    }

    if (snapshot.syncStatus === "NOT_CONNECTED") {
        return {
            tone: "offline",
            headline: "Offline",
            detail: statusText || "No connection to the remote database.",
            icon: "cloud-off",
            busy: false,
        };
    }

    return {
        tone: "ready",
        headline: "Ready",
        detail: ["Idle · watching for changes", queueText].filter(Boolean).join(" · "),
        icon: "check",
        busy: false,
    };
}

const IDLE_STATUSES: Record<string, true> = {
    COMPLETED: true,
    CLOSED: true,
};

/**
 * Health rows for the expanded card. Each subsystem reports its own state, so a
 * backlog or a warning stays visible while the rest keeps saying it is fine.
 */
export function deriveSyncBubbleCategories(snapshot: SyncBubbleSnapshot): SyncBubbleCategory[] {
    // The Sync row mirrors the orb so the card never says "Sync: ok" next to "Offline".
    const overallTone = deriveSyncBubbleState(snapshot).tone;

    return [
        { key: "initialisation", label: "Initialisation", tone: snapshot.ready ? "ok" : "warn" },
        {
            key: "replication",
            label: "Replication",
            tone:
                snapshot.syncStatus === "ERRORED"
                    ? "error"
                    : // Anything else means replication is running, paused, or not yet connected.
                      IDLE_STATUSES[snapshot.syncStatus]
                      ? "ok"
                      : "warn",
        },
        {
            key: "sync",
            label: "Sync",
            tone: overallTone === "error" ? "error" : overallTone === "ready" ? "ok" : "warn",
        },
        { key: "config", label: "Config sync", tone: snapshot.configActive ? "warn" : "ok" },
        {
            key: "storage",
            label: "Storage",
            tone: Object.values(snapshot.storageQueues ?? {}).some((count) => (count ?? 0) > 0) ? "warn" : "ok",
        },
        { key: "warnings", label: "Warnings", tone: snapshot.warningText?.trim() ? "error" : "ok" },
    ];
}
