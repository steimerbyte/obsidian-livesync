import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUserInitiatedReplication } from "./manualReplication";

const replicateUserInitiated = vi.fn();
const isReady = vi.fn();
const showNotice = vi.fn();

function makeHost() {
    return {
        API: { showNotice },
        appLifecycle: { isReady },
        replication: { replicateUserInitiated },
    };
}

describe("requestUserInitiatedReplication", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        isReady.mockReturnValue(true);
        replicateUserInitiated.mockResolvedValue({ status: "completed" });
    });

    it("explains that LiveSync is still initialising instead of silently doing nothing", async () => {
        isReady.mockReturnValue(false);

        await expect(requestUserInitiatedReplication(makeHost())).resolves.toBeUndefined();

        expect(replicateUserInitiated).not.toHaveBeenCalled();
        expect(showNotice).toHaveBeenCalledWith(
            "Sync not started: LiveSync is still initialising. Try again once startup has completed.",
            8000
        );
    });

    it("uses the notice progress presentation for a manual run", async () => {
        await requestUserInitiatedReplication(makeHost());

        expect(replicateUserInitiated).toHaveBeenCalledWith(
            expect.objectContaining({
                trigger: "manual",
                progressPresentation: "notice",
            })
        );
        expect(showNotice).not.toHaveBeenCalled();
    });

    it("explains that another sync is already running", async () => {
        replicateUserInitiated.mockResolvedValue({
            status: "blocked",
            reason: "replication-in-progress",
        });

        const outcome = await requestUserInitiatedReplication(makeHost());

        expect(outcome).toEqual({ status: "blocked", reason: "replication-in-progress" });
        expect(showNotice).toHaveBeenCalledWith("Sync not started: a sync is already running.", 8000);
    });

    it("explains that LiveSync is still preparing", async () => {
        replicateUserInitiated.mockResolvedValue({ status: "blocked", reason: "not-ready" });

        await requestUserInitiatedReplication(makeHost());

        expect(showNotice).toHaveBeenCalledWith(
            "Sync not started: LiveSync is still preparing (cleanup, version upgrade, or pending changes).",
            8000
        );
    });

    it("explains a failed sync", async () => {
        replicateUserInitiated.mockResolvedValue({
            status: "failed",
            error: new Error("network unreachable"),
        });

        await requestUserInitiatedReplication(makeHost());

        expect(showNotice).toHaveBeenCalledWith("Sync failed: network unreachable", 8000);
    });

    it("reports a partial sync without claiming success", async () => {
        replicateUserInitiated.mockResolvedValue({ status: "partial", detail: {} });

        await requestUserInitiatedReplication(makeHost());

        expect(showNotice).toHaveBeenCalledWith(
            "Sync partially completed. Some files could not be synchronised; check the LiveSync log.",
            8000
        );
    });
});
