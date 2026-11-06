import type { NecessaryServices } from "@vrtmrz/livesync-commonlib/compat/interfaces/ServiceModule";
import { EVENT_APPLICATION_READY } from "@/common/events";
import { beginStartupPhase, finishStartupProgress, resetStartupProgress } from "@/common/startupProgress";

/**
 * Priority which runs the finalising boundary after every other `onDatabaseInitialised` handler.
 * Default handlers use 0; the higher value keeps it last regardless of registration order.
 */
export const STARTUP_PROGRESS_FINALISING_PRIORITY = 1 as const;

/**
 * Report the start-up progress of a plug-in host to the status orb.
 *
 * Only boundaries that exist in the composed service graph are reported here:
 * - the database is ready once the local database finishes opening,
 * - `onDatabaseInitialised` handlers (ConfigSync, Hidden File Sync) run after the vault scan,
 * - `markIsReady` emits `application-ready`.
 * The vault scan and the per-item counts are reported by their owners: the OfflineScanner through
 * `observeStartupLog`, ConfigSync and Hidden File Sync through their own item loops.
 */
export function useStartupProgressFeature(host: NecessaryServices<"databaseEvents" | "context", never>): void {
    const { services } = host;
    // A fresh composition means a fresh start-up; a reload must not inherit the previous run.
    resetStartupProgress();
    services.databaseEvents.onDatabaseHasReady.addHandler(() => {
        beginStartupPhase("scan");
        return Promise.resolve(true);
    });
    services.databaseEvents.onDatabaseInitialised.addHandler(() => {
        // Only `commitPendingFileEvents` and `markIsReady` remain after this point.
        beginStartupPhase("finalising");
        return Promise.resolve(true);
    }, STARTUP_PROGRESS_FINALISING_PRIORITY);
    services.context.events.onEvent(EVENT_APPLICATION_READY, () => finishStartupProgress());
}
