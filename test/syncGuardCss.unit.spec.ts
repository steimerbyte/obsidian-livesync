import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("SyncGuard CSS", () => {
    it("closes its bypass rule without swallowing any later rule", () => {
        const bypassStart = stylesheet.indexOf(".sls-sync-guard-bypass {");
        expect(bypassStart).toBeGreaterThanOrEqual(0);
        const bypassEnd = stylesheet.indexOf("}", bypassStart);
        expect(bypassEnd).toBeGreaterThan(bypassStart);
        const bypassRule = stylesheet.slice(bypassStart, bypassEnd + 1);
        expect(bypassRule).toMatch(/min-height:\s*44px;/);
        expect(bypassRule).toMatch(/min-width:\s*44px;/);
        expect(stylesheet.slice(bypassEnd + 1).trim()).toBe("");
    });
});
