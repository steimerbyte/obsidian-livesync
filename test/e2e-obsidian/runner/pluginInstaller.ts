import {
    installBuiltPlugin as installGenericBuiltPlugin,
    type PluginInstallResult,
} from "@vrtmrz/obsidian-test-session";
import { FORK_PLUGIN_ID } from "./session.ts";

export type { PluginInstallResult };

export async function installBuiltPlugin(vaultPath: string, rootDir = process.cwd()): Promise<PluginInstallResult> {
    return await installGenericBuiltPlugin(vaultPath, {
        pluginId: FORK_PLUGIN_ID,
        artifactRoot: rootDir,
    });
}
