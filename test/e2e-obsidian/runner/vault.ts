import {
    createTemporaryVault as createGenericTemporaryVault,
    type TemporaryVault,
} from "@vrtmrz/obsidian-test-session";
import { FORK_PLUGIN_ID } from "./session.ts";

export type { TemporaryVault };

export async function createTemporaryVault(prefix = "obsidian-livesync-e2e-"): Promise<TemporaryVault> {
    return await createGenericTemporaryVault({
        prefix,
        pluginIds: [FORK_PLUGIN_ID],
        idPrefix: "livesync-e2e",
    });
}
