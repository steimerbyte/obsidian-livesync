import {
    startObsidianPluginSession,
    type ObsidianPluginSession,
    type ObsidianPluginSessionLifecycle,
    type ObsidianPluginStartupMode,
} from "@vrtmrz/obsidian-test-session";
import type { TemporaryVault } from "./vault.ts";

export type ObsidianLiveSyncSession = ObsidianPluginSession;

/** This fork's manifest id; its installs and command ids use this prefix. */
export const FORK_PLUGIN_ID = "livesync-efficient";

/** Environment marker that lets injected scripts address the plug-in a session installed. */
const pluginIdEnvironmentKey = "E2E_OBSIDIAN_PLUGIN_ID";

export function pluginIdFromEnvironment(env: NodeJS.ProcessEnv): string {
    return env[pluginIdEnvironmentKey] ?? FORK_PLUGIN_ID;
}

/** Runtime expression resolving the running plug-in, for injected scripts. */
export function liveSyncPluginLookup(env: NodeJS.ProcessEnv): string {
    return `app.plugins.plugins[${JSON.stringify(pluginIdFromEnvironment(env))}]`;
}

export type StartObsidianLiveSyncSessionOptions = {
    binary: string;
    cliBinary: string;
    vault: TemporaryVault;
    pluginId?: string;
    artifactRoot?: string;
    startupGraceMs?: number;
    pluginData?: Record<string, unknown>;
    localStorageEntries?: Readonly<Record<string, string>>;
    pluginStartup?: ObsidianPluginStartupMode;
    lifecycle?: ObsidianPluginSessionLifecycle;
    env?: NodeJS.ProcessEnv;
};

export async function startObsidianLiveSyncSession(
    options: StartObsidianLiveSyncSessionOptions
): Promise<ObsidianLiveSyncSession> {
    const pluginId = options.pluginId ?? FORK_PLUGIN_ID;
    return await startObsidianPluginSession({
        binary: options.binary,
        cliBinary: options.cliBinary,
        vault: options.vault,
        pluginId,
        artifactRoot: options.artifactRoot ?? process.cwd(),
        startupGraceMs: options.startupGraceMs,
        pluginData: options.pluginData,
        localStorageEntries: options.localStorageEntries,
        pluginStartup: options.pluginStartup,
        lifecycle: options.lifecycle,
        env: { ...options.env, [pluginIdEnvironmentKey]: pluginId },
    });
}
