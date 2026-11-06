import { arrayToChunkedArray } from "octagonal-wheels/collection";
import type { DocumentID, EntryDoc } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { LiveSyncLocalDB } from "@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB";
import { ICXHeader } from "@/common/types.ts";

const DELETE_BATCH_SIZE = 100;

export type CustomisationSyncCleanupDatabase = Pick<LiveSyncLocalDB, "findEntryNames" | "allDocsRaw" | "bulkDocsRaw">;

/**
 * Permanently deletes every customisation sync document in bounded batches.
 *
 * @param database Local database to clean.
 * @returns The number of documents submitted for deletion.
 */
export async function deleteAllCustomisationSyncData(database: CustomisationSyncCleanupDatabase): Promise<number> {
    const ids: DocumentID[] = [];
    for await (const id of database.findEntryNames(ICXHeader, `${ICXHeader}\u{10ffff}`, {})) {
        ids.push(id as DocumentID);
    }
    let removed = 0;
    for (const idBatch of arrayToChunkedArray(ids, DELETE_BATCH_SIZE)) {
        const entriesToDelete = await database.allDocsRaw<EntryDoc>({
            keys: idBatch,
            include_docs: true,
        });
        const newData = entriesToDelete.rows.map((e) => ({
            ...e.doc,
            _deleted: true,
        })) as EntryDoc[];
        const result = await database.bulkDocsRaw(newData);
        removed += result.length;
    }
    return removed;
}
