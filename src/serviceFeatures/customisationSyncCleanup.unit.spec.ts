import { describe, expect, it, vi } from "vitest";
import { deleteAllCustomisationSyncData } from "./customisationSyncCleanup";

function createDatabase(ids: string[]) {
    const findEntryNames = vi.fn(async function* () {
        yield* ids;
    });
    const allDocsRaw = vi.fn(async ({ keys }: { keys: string[] }) => ({
        rows: keys.map((key) => ({
            id: key,
            key,
            doc: { _id: key, _rev: "1-customisation" },
        })),
    }));
    const bulkDocsRaw = vi.fn(async (docs: Array<{ _id?: string; _deleted?: boolean }>) =>
        docs.map(({ _id }) => ({ ok: true, id: _id }))
    );
    return { findEntryNames, allDocsRaw, bulkDocsRaw };
}

describe("deleteAllCustomisationSyncData", () => {
    it("deletes all customisation sync documents in batches of at most 100", async () => {
        const ids = Array.from({ length: 250 }, (_, index) => `ix:device/plugin/${index}`);
        const database = createDatabase(ids);

        const removed = await deleteAllCustomisationSyncData(database as never);

        expect(database.findEntryNames).toHaveBeenCalledWith("ix:", "ix:\u{10ffff}", {});
        expect(removed).toBe(250);
        expect(database.allDocsRaw).toHaveBeenCalledTimes(3);
        expect(database.allDocsRaw.mock.calls.map(([options]) => options.keys.length)).toEqual([100, 100, 50]);
        expect(database.bulkDocsRaw).toHaveBeenCalledTimes(3);
        expect(database.bulkDocsRaw.mock.calls.map(([docs]) => docs.length)).toEqual([100, 100, 50]);
        const submitted = database.bulkDocsRaw.mock.calls.flatMap(([docs]) => docs);
        expect(submitted).toHaveLength(250);
        for (const doc of submitted) {
            expect(doc._deleted).toBe(true);
        }
    });

    it("returns zero without writing when there is no customisation sync data", async () => {
        const database = createDatabase([]);

        const removed = await deleteAllCustomisationSyncData(database as never);

        expect(removed).toBe(0);
        expect(database.allDocsRaw).not.toHaveBeenCalled();
        expect(database.bulkDocsRaw).not.toHaveBeenCalled();
    });
});
