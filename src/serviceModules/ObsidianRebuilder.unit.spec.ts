import { describe, expect, it, vi } from "vitest";
import { UnsupportedEncryptedDocumentFormatError } from "@vrtmrz/livesync-commonlib/replication";
import { ObsidianRebuilder } from "./ObsidianRebuilder.ts";

function createRebuilder() {
    const askInPopup = vi.fn();
    const confirmWithMessage = vi.fn(
        async (_title: string, _message: string, _buttons: string[], _defaultAction: string) => "Close"
    );
    const services = {
        UI: { confirm: { askInPopup, confirmWithMessage } },
        setting: { suspendAllSync: { addHandler: vi.fn() } },
        database: { onDatabaseReset: { addHandler: vi.fn() } },
    };
    const rebuilder = new ObsidianRebuilder(services as never);
    // The reporter is private; exercise it directly instead of running a real Fetch.
    const reporter = rebuilder as unknown as { reportFetchFailure(fetch: Promise<void>): Promise<void> };
    return { reportFetchFailure: reporter.reportFetchFailure.bind(reporter), askInPopup, confirmWithMessage };
}

describe("ObsidianRebuilder fetch failure reporting", () => {
    it("offers the rebuild guidance for an unsupported E2EE format and keeps the rejection", async () => {
        const { reportFetchFailure, askInPopup, confirmWithMessage } = createRebuilder();

        const failure = new UnsupportedEncryptedDocumentFormatError();
        await expect(reportFetchFailure(Promise.reject(failure))).rejects.toBe(failure);

        expect(askInPopup).toHaveBeenCalledOnce();
        const [, popupText, anchorCallback] = askInPopup.mock.calls[0];
        expect(popupText).toContain("{HERE}");

        const clickHandlers: Array<(event: { preventDefault(): void }) => void> = [];
        const anchor = {
            textContent: "",
            href: "",
            addEventListener: vi.fn((_type: string, handler: (event: { preventDefault(): void }) => void) =>
                clickHandlers.push(handler)
            ),
        };
        anchorCallback(anchor);
        expect(anchor.textContent).toBe("View recovery steps");
        expect(confirmWithMessage).not.toHaveBeenCalled();

        const preventDefault = vi.fn();
        clickHandlers.forEach((handler) => handler({ preventDefault }));
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(confirmWithMessage).toHaveBeenCalledOnce();
        const [title, message] = confirmWithMessage.mock.calls[0];
        expect(title).toBe("Fetch stopped");
        expect(message).toContain("unsupported E2EE format");
        expect(message).toContain("rebuild the remote database");
    });

    it("does not offer the guidance for an unrelated failure and keeps the rejection", async () => {
        const { reportFetchFailure, askInPopup } = createRebuilder();

        const failure = new Error("network down");
        await expect(reportFetchFailure(Promise.reject(failure))).rejects.toBe(failure);
        expect(askInPopup).not.toHaveBeenCalled();
    });

    it("stays silent when the fetch succeeds", async () => {
        const { reportFetchFailure, askInPopup } = createRebuilder();

        await reportFetchFailure(Promise.resolve());
        expect(askInPopup).not.toHaveBeenCalled();
    });
});
