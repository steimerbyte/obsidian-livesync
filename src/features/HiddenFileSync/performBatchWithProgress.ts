import { createCoalescingNotifier } from "octagonal-wheels/concurrency/coalescingNotifier";
import { run, type GovernorPriority } from "@/common/resourceGovernor.ts";

/** Default peak items per batch; matches the per-file ceiling held by HiddenFileSync.serializedForEvent. */
const BATCH_CONCURRENCY_LIMIT = 10;

interface PerformBatchWithProgressCallbacks<T> {
    /** Runs one item. Its resolved value is ignored. */
    processItem: (item: T) => Promise<unknown>;
    /** Receives the number of successfully completed items. */
    onProgress: (completed: number) => void;
    /** Handles an item or progress callback error. */
    onItemError: (error: unknown, item: T) => void;
    /** Runs once after all per-item promises resolve. */
    onDone: () => void;
    /** Governor priority for each item. Defaults to `"background"`. */
    priority?: GovernorPriority;
    /** Peak number of items running at once. Defaults to `BATCH_CONCURRENCY_LIMIT`. */
    concurrency?: number;
}

/**
 * Runs a batch and coalesces progress notifications by successful item count.
 * @internal
 *
 * @param items - Items to process, at most `concurrency` (default BATCH_CONCURRENCY_LIMIT) at a time.
 * @param eachCount - Number of completed items between progress notifications.
 * @param callbacks - Item processing, progress, error, and completion callbacks.
 * @returns A promise that resolves with no value after the batch and completion callback finish.
 * @throws When notifier configuration is invalid, an error handler throws, or the completion callback throws.
 * @remarks The first completed item triggers progress immediately. Work runs through the resource governor
 * at `priority`, and work and the progress callback share one error boundary; errors are passed to
 * `onItemError`. A rejected item operation does not advance the count. At most `concurrency` items run at
 * once and a failed item is not retried. Pending progress is not flushed when processing ends.
 */
export async function performBatchWithProgress<T>(
    items: readonly T[],
    eachCount: number,
    callbacks: PerformBatchWithProgressCallbacks<T>
): Promise<void> {
    const notifier = createCoalescingNotifier<number>({
        everyCount: eachCount,
        leading: true,
        onNotify: callbacks.onProgress,
    });
    const priority: GovernorPriority = callbacks.priority ?? "background";
    const concurrency = Math.max(1, callbacks.concurrency ?? BATCH_CONCURRENCY_LIMIT);
    let completed = 0;
    let nextIndex = 0;
    // Each worker claims the next index synchronously, so a shared cursor keeps the pool bounded.
    const worker = async () => {
        while (nextIndex < items.length) {
            const item = items[nextIndex++];
            try {
                await run(priority, "hidden-file-batch", () => callbacks.processItem(item));
                notifier.update(++completed);
            } catch (error) {
                callbacks.onItemError(error, item);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    callbacks.onDone();
}
