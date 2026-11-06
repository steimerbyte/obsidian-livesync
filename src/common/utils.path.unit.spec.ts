import { cancelAllTasks } from "octagonal-wheels/concurrency/task";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    normalizePath: vi.fn((path: string) => `normalised(${path})`),
    path2idBase: vi.fn(async (path: string) => path),
    id2pathBase: vi.fn((path: string) => path),
    expandFilePathPrefix: vi.fn((path: string): [string, string] => {
        if (path.startsWith("i:")) return ["i:", path.substring(2)];
        return ["", path];
    }),
}));

vi.mock("@/deps.ts", () => ({
    normalizePath: mocks.normalizePath,
    Platform: {},
    requestUrl: vi.fn(),
}));

vi.mock("@vrtmrz/livesync-commonlib/compat/string_and_binary/path", () => ({
    path2id_base: mocks.path2idBase,
    id2path_base: mocks.id2pathBase,
    expandFilePathPrefix: mocks.expandFilePathPrefix,
    isValidFilenameInLinux: vi.fn(),
    isValidFilenameInDarwin: vi.fn(),
    isValidFilenameInWidows: vi.fn(),
    isValidFilenameInAndroid: vi.fn(),
    stripAllPrefixes: vi.fn(),
}));

describe("path ID normalisation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ["Folder/Note.md", "", "Folder/Note.md"],
        ["Folder/Poem: Example.md", "", "Folder/Poem: Example.md"],
        ["Folder/Poem: Example: Final Draft.md", "", "Folder/Poem: Example: Final Draft.md"],
        ["i:Folder/Poem: Example.md", "i:", "Folder/Poem: Example.md"],
    ])("normalises the complete path body for %s", async (filename, prefix, body) => {
        const { path2id } = await import("./utils.ts");

        const result = await path2id(filename as never, false, false);

        expect(mocks.normalizePath).toHaveBeenCalledWith(body);
        expect(mocks.path2idBase).toHaveBeenCalledWith(`${prefix}normalised(${body})`, false, false);
        expect(result).toBe(`${prefix}normalised(${body})`);
    });

    it.each([
        ["Folder/Note.md", "", "Folder/Note.md"],
        ["Folder/Poem: Example.md", "", "Folder/Poem: Example.md"],
        ["Folder/Poem: Example: Final Draft.md", "", "Folder/Poem: Example: Final Draft.md"],
        ["i:Folder/Poem: Example.md", "i:", "Folder/Poem: Example.md"],
    ])("preserves the path namespace while normalising %s", async (filename, prefix, body) => {
        mocks.id2pathBase.mockReturnValue(filename);
        const { id2path } = await import("./utils.ts");

        const result = id2path(filename as never);

        expect(mocks.normalizePath).toHaveBeenCalledWith(body);
        expect(result).toBe(`${prefix}normalised(${body})`);
    });
});

describe("same change pair persistence", () => {
    const storage = new Map<string, string>();
    beforeAll(() => {
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => void storage.set(key, value),
            removeItem: (key: string) => void storage.delete(key),
        });
    });
    beforeEach(() => {
        storage.clear();
    });
    afterAll(() => {
        // Pending debounced saves would throw on the removed stub.
        cancelAllTasks();
        vi.unstubAllGlobals();
    });
    // each case calls initializeStores with its own vault name, so a debounced
    // save from a previous case cannot overwrite the next case's fixture.
    // Stores and utils are imported per case so that each case reads the live
    // binding of sameChangePairs after its own initialisation.

    it("keeps at most the configured number of pairs and evicts the oldest", async () => {
        const { initializeStores, MAX_SAME_CHANGE_PAIRS } = await import("./stores.ts");
        const { markChangesAreSame } = await import("./utils.ts");
        initializeStores("same-change-limit");
        const { sameChangePairs } = await import("./stores.ts");

        for (let i = 0; i <= MAX_SAME_CHANGE_PAIRS; i++) {
            markChangesAreSame(`Notes/${i}.md`, i * 10 + 1, i * 10 + 2);
        }

        expect(sameChangePairs._map.size).toBe(MAX_SAME_CHANGE_PAIRS);
        expect(sameChangePairs.get("Notes/0.md")).toBeUndefined();
        expect(sameChangePairs.get(`Notes/${MAX_SAME_CHANGE_PAIRS}.md`)).toEqual([
            MAX_SAME_CHANGE_PAIRS * 10 + 1,
            MAX_SAME_CHANGE_PAIRS * 10 + 2,
        ]);
    });

    it("keeps a pair that is used again while the store is full", async () => {
        const { initializeStores, MAX_SAME_CHANGE_PAIRS } = await import("./stores.ts");
        const { markChangesAreSame } = await import("./utils.ts");
        initializeStores("same-change-reuse");
        const { sameChangePairs } = await import("./stores.ts");

        for (let i = 0; i < MAX_SAME_CHANGE_PAIRS; i++) {
            markChangesAreSame(`Notes/${i}.md`, i * 10 + 1, i * 10 + 2);
        }
        markChangesAreSame("Notes/0.md", 2, 3);
        markChangesAreSame(`Notes/${MAX_SAME_CHANGE_PAIRS}.md`, 1, 2);

        expect(sameChangePairs.get("Notes/0.md")).toEqual([1, 2, 3]);
        expect(sameChangePairs.has("Notes/1.md")).toBe(false);
    });

    it("trims an oversized persisted map on initialisation", async () => {
        const { initializeStores, MAX_SAME_CHANGE_PAIRS } = await import("./stores.ts");
        initializeStores("same-change-upgrade");
        storage.set(
            "ls-persist-same-changes-same-change-upgrade",
            JSON.stringify(Array.from({ length: MAX_SAME_CHANGE_PAIRS + 32 }, (_, i) => [`Notes/${i}.md`, [i, i + 1]]))
        );

        initializeStores("same-change-upgrade");
        const { sameChangePairs } = await import("./stores.ts");

        expect(sameChangePairs._map.size).toBe(MAX_SAME_CHANGE_PAIRS);
        expect(sameChangePairs.has("Notes/0.md")).toBe(false);
        expect(sameChangePairs.has(`Notes/${MAX_SAME_CHANGE_PAIRS + 31}.md`)).toBe(true);
    });
});
