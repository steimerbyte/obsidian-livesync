import {
    REPLICATION_PROGRESS_PRESENTATIONS,
    USER_INITIATED_REPLICATION_AUTHORITY,
    type ReplicationOutcome,
    type UserInitiatedOneShotRequest,
} from "@vrtmrz/livesync-commonlib/replication";

/** Structural host so the helper works in commands, ribbons, and settings panes. */
export type ManualReplicationHost = {
    /** Platform API; message display is optional and only implemented by the Obsidian adapter. */
    API: unknown;
    appLifecycle: { isReady?: () => boolean };
    replication: {
        replicateUserInitiated(request: UserInitiatedOneShotRequest): Promise<ReplicationOutcome>;
    };
};

type NoticeCapableAPI = { showNotice?: (message: string, duration?: number) => void };

const NOTICE_TIMEOUT_MS = 8000;

const DEFAULT_REQUEST: UserInitiatedOneShotRequest = {
    trigger: "manual",
    progressPresentation: REPLICATION_PROGRESS_PRESENTATIONS.NOTICE,
    interaction: USER_INITIATED_REPLICATION_AUTHORITY,
};

function notify(host: ManualReplicationHost, message: string): void {
    (host.API as NoticeCapableAPI).showNotice?.(message, NOTICE_TIMEOUT_MS);
}

function describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}

function describeBlockedReplication(reason: string): string {
    switch (reason) {
        case "replication-in-progress":
            return "a sync is already running.";
        case "not-ready":
            return "LiveSync is still preparing (cleanup, version upgrade, or pending changes).";
        case "no-active-replicator":
        case "provider-not-composed":
            return "LiveSync is not fully loaded yet.";
        case "provider-not-configured":
            return "no remote is configured.";
        case "no-targets":
            return "no sync targets are configured.";
        case "rate-limited":
            return "the last sync was too recent; try again shortly.";
        case "interaction-required":
            return "this action needs user interaction.";
        default:
            return "the replication service is not available right now.";
    }
}

/**
 * Run a manual replication and explain every outcome the user would
 * otherwise only find in the log.
 *
 * The common library logs `application-ready` and preparation failures but
 * shows no notice for them, so a fresh start would silently ignore the
 * command. This wrapper covers that gap and also reports blocked and failed
 * outcomes from the shared replication service.
 */
export async function requestUserInitiatedReplication(
    host: ManualReplicationHost,
    request: UserInitiatedOneShotRequest = DEFAULT_REQUEST
): Promise<ReplicationOutcome | undefined> {
    if (host.appLifecycle.isReady?.() === false) {
        notify(host, "Sync not started: LiveSync is still initialising. Try again once startup has completed.");
        return;
    }

    const outcome = await host.replication.replicateUserInitiated(request);

    switch (outcome.status) {
        case "blocked":
            notify(host, `Sync not started: ${describeBlockedReplication(outcome.reason)}`);
            break;
        case "failed":
            notify(host, `Sync failed: ${describeError(outcome.error)}`);
            break;
        case "partial":
            notify(host, "Sync partially completed. Some files could not be synchronised; check the LiveSync log.");
            break;
        case "cancelled":
            notify(host, "Sync cancelled.");
            break;
    }

    return outcome;
}
