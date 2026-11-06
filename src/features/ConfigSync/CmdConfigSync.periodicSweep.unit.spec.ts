import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/deps.ts", () => ({
    addIcon: vi.fn(),
    diff_match_patch: class DiffMatchPatch {},
    normalizePath: (path: string) => path,
    parseYaml: vi.fn(),
    Platform: {},
}));
vi.mock("./PluginDialogModal.ts", () => ({ PluginDialogModal: class PluginDialogModal {} }));
vi.mock("@/features/HiddenFileCommon/JsonResolveModal.ts", () => ({ JsonResolveModal: class JsonResolveModal {} }));
vi.mock("@/modules/features/InteractiveConflictResolving/ConflictResolveModal.ts", () => ({
    ConflictResolveModal: class ConflictResolveModal {},
}));
vi.mock("@/modules/features/ModuleLog.ts", () => ({ MARK_DONE: "" }));
vi.mock("@/common/utils.ts", () => ({
    cancelTask: vi.fn(),
    EVEN: Symbol("even"),
    isCustomisationSyncMetadata: vi.fn(),
    isPluginMetadata: vi.fn(),
    scheduleTask: vi.fn(),
}));
vi.mock("@/common/events.ts", () => ({
    EVENT_PLUGIN_UNLOADED: "plugin-unloaded",
    EVENT_REQUEST_OPEN_PLUGIN_SYNC_DIALOG: "open-plugin-sync",
    eventHub: { onEvent: vi.fn(), onceEvent: vi.fn() },
}));
vi.mock("@/common/translation", () => ({ $msg: (message: string) => message }));
vi.mock("@/common/obsidianCommunityPlugins.ts", () => ({ getObsidianCommunityPluginManager: vi.fn() }));

import { DEFAULT_SETTINGS } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { ConfigSync } from "./CmdConfigSync";

const sweepOwners: ConfigSync[] = [];

function createSweepConfigSync(isSuspended: () => boolean) {
    vi.spyOn(ConfigSync.prototype, "onBindFunction").mockImplementation(() => {});
    const configSync = new ConfigSync({
        settings: { ...DEFAULT_SETTINGS, usePluginSync: true },
        localDatabase: {},
        services: {
            API: { addLog: vi.fn(), addRibbonIcon: vi.fn() },
            appLifecycle: { isSuspended },
        },
    } as unknown as ConstructorParameters<typeof ConfigSync>[0]);
    sweepOwners.push(configSync);
    return configSync;
}

afterEach(async () => {
    for (const configSync of sweepOwners.splice(0)) {
        await configSync.pluginScanProcessor.stop();
    }
    vi.restoreAllMocks();
});

describe("ConfigSync periodic customisation sweep", () => {
    it("does not scan customisation files while the main process is suspended", async () => {
        const configSync = createSweepConfigSync(() => true);
        const scanAllConfigFiles = vi.fn(async (_showMessage: boolean) => {});
        configSync.scanAllConfigFiles = scanAllConfigFiles;

        await configSync.periodicPluginSweepProcessor.process();

        expect(scanAllConfigFiles).not.toHaveBeenCalled();
    });

    it("scans customisation files again once the main process is resumed", async () => {
        let suspended = true;
        const configSync = createSweepConfigSync(() => suspended);
        const scanAllConfigFiles = vi.fn(async (_showMessage: boolean) => {});
        configSync.scanAllConfigFiles = scanAllConfigFiles;

        await configSync.periodicPluginSweepProcessor.process();
        suspended = false;
        await configSync.periodicPluginSweepProcessor.process();

        expect(scanAllConfigFiles).toHaveBeenCalledExactlyOnceWith(false);
    });
});
