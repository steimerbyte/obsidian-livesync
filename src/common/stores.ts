import { PersistentMap } from "octagonal-wheels/dataobject/PersistentMap";

/** Number of same-change pairs kept; the oldest are evicted first. */
export const MAX_SAME_CHANGE_PAIRS = 4096;

export let sameChangePairs: PersistentMap<number[]>;

function trimSameChangePairs(maxCount: number) {
    let excess = sameChangePairs._map.size - maxCount;
    for (const key of sameChangePairs._map.keys()) {
        if (excess <= 0) return;
        excess--;
        sameChangePairs.delete(key);
    }
}

export function setSameChangePair(key: string, value: number[]) {
    // Deleting first moves a pair that is used again to the end of the eviction order.
    sameChangePairs.delete(key);
    trimSameChangePairs(MAX_SAME_CHANGE_PAIRS - 1);
    sameChangePairs.set(key, value);
}

export function initializeStores(vaultName: string) {
    sameChangePairs = new PersistentMap<number[]>(`ls-persist-same-changes-${vaultName}`);
    trimSameChangePairs(MAX_SAME_CHANGE_PAIRS);
}
