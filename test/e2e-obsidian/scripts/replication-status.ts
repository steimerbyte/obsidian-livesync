import { discoverObsidianCli, requireObsidianBinary } from "../runner/environment.ts";
import { startObsidianLiveSyncSession, type ObsidianLiveSyncSession } from "../runner/session.ts";
import { withObsidianPage } from "../runner/ui.ts";
import { createTemporaryVault } from "../runner/vault.ts";
import type { Page } from "playwright";
import { setObsidianMobileTestModeBeforePluginStart } from "../runner/mobileUi.ts";

const fixturePath = "replication-status-e2e.md";
const uiTimeoutMs = Number(process.env.E2E_OBSIDIAN_UI_TIMEOUT_MS ?? 10000);
const fastForwardLingerMs = 3000;
const bubbleSelector = ".livesync-bubble";
const liveStatusSelector = ".livesync-bubble .lsb-live-status";

type TestReplicationStatics = {
    sent: number;
    arrived: number;
    maxPullSeq: number;
    maxPushSeq: number;
    lastSyncPullSeq: number;
    lastSyncPushSeq: number;
    syncStatus: "CONNECTED" | "PAUSED" | "ERRORED";
    couchDB: {
        phase: "continuous" | "idle";
        pull: { checkedChanges: number; completedBatches: number; checking: boolean };
        push: { checkedChanges: number; completedBatches: number; checking: boolean };
    };
};

type WritableSource<T> = { value: T };
type StatusPart = { key: string; text: string; value?: number; suffix?: string };
type TestLeaf = {
    containerEl?: HTMLElement;
    view?: { containerEl?: HTMLElement };
    openFile?: (file: unknown) => Promise<void>;
    detach?: () => void;
};
type TestWorkspace = {
    layoutReady?: boolean;
    getLeaf?: (newLeaf?: boolean | "split" | "tab" | "window", direction?: "horizontal" | "vertical") => TestLeaf;
    openPopoutLeaf?: () => TestLeaf;
    setActiveLeaf?: (leaf: TestLeaf, params?: { focus?: boolean }) => void;
    iterateAllLeaves?: (callback: (leaf: TestLeaf) => void) => void;
    getActiveFile?: () => { path?: string } | null;
};
type TestLogModule = {
    statusLog?: WritableSource<string>;
    activeFileStatus?: WritableSource<string>;
    p2pLogCollector?: { p2pReplicationLine: WritableSource<string> };
    statusBarLabels?: WritableSource<{ parts: readonly StatusPart[]; message: string }>;
    __addLog?: (message: unknown, level?: number, key?: string) => void;
};
type TestCore = {
    modules?: unknown[];
    services?: {
        setting?: { currentSettings?: () => Record<string, unknown> };
        replicator?: {
            replicationStatics?: WritableSource<TestReplicationStatics>;
        };
        replication?: {
            replicationResultCount: WritableSource<number>;
            databaseQueueCount: WritableSource<number>;
            storageApplyingCount: WritableSource<number>;
        };
        fileProcessing?: {
            processing: WritableSource<number>;
            totalQueued: WritableSource<number>;
            batched: WritableSource<number>;
        };
        conflict?: { conflictProcessQueueCount: WritableSource<number> };
        API?: {
            requestCount?: WritableSource<number>;
            responseCount?: WritableSource<number>;
        };
    };
};
type TestApp = {
    plugins?: {
        plugins?: { "livesync-efficient"?: { core?: TestCore } };
    };
    vault?: {
        getAbstractFileByPath?: (path: string) => unknown | null;
        create?: (path: string, content: string) => Promise<unknown>;
    };
    workspace?: TestWorkspace;
};
type TestWindow = typeof globalThis & {
    app?: TestApp;
    __livesyncStatusFixtureFile?: unknown;
    __livesyncStatusFirstLeaf?: TestLeaf;
    __livesyncStatusSplitLeaf?: TestLeaf;
    __livesyncStatusPopoutLeaf?: TestLeaf;
    __livesyncBubbleNode?: HTMLElement;
};

function failUnless(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function replicationStats(
    checkedChanges: number,
    sent: number,
    arrived: number,
    pushCheckedChanges = 0
): TestReplicationStatics {
    return {
        sent,
        arrived,
        maxPullSeq: sent + 1,
        maxPushSeq: sent + 1,
        lastSyncPullSeq: 1,
        lastSyncPushSeq: 1,
        syncStatus: "CONNECTED",
        couchDB: {
            phase: "continuous",
            pull: { checkedChanges, completedBatches: 0, checking: true },
            push: { checkedChanges: pushCheckedChanges, completedBatches: 0, checking: pushCheckedChanges > 0 },
        },
    };
}

async function installFixtureFile(page: Page): Promise<void> {
    const result = await page.evaluate(async (path) => {
        const app = (globalThis as TestWindow).app;
        const workspace = app?.workspace;
        const vault = app?.vault;
        if (!workspace?.getLeaf || !workspace.setActiveLeaf || !vault?.create || !vault.getAbstractFileByPath) {
            return { ready: false, reason: "Obsidian workspace APIs are unavailable." };
        }
        let file = vault.getAbstractFileByPath(path);
        if (!file) file = await vault.create(path, "Replication status bubble fixture.\n");
        const leaf = workspace.getLeaf("tab");
        if (!leaf.openFile) return { ready: false, reason: "The active workspace leaf cannot open a file." };
        await leaf.openFile(file);
        workspace.setActiveLeaf(leaf, { focus: true });
        (globalThis as TestWindow).__livesyncStatusFixtureFile = file;
        (globalThis as TestWindow).__livesyncStatusFirstLeaf = leaf;
        return { ready: true };
    }, fixturePath);
    if (!result.ready)
        throw new Error("reason" in result ? result.reason : "Could not initialise the fixture editor leaf.");
}

async function injectReplicationStats(
    page: Page,
    stats: TestReplicationStatics,
    requestCount: number,
    responseCount: number
): Promise<void> {
    const result = await page.evaluate(
        ({ stats, requestCount, responseCount }) => {
            const core = (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core;
            const replicator = core?.services?.replicator;
            const api = core?.services?.API;
            if (!replicator?.replicationStatics || !api?.requestCount || !api.responseCount) {
                return { ready: false, reason: "LiveSync replication status sources are unavailable." };
            }
            replicator.replicationStatics.value = stats;
            api.requestCount.value = requestCount;
            api.responseCount.value = responseCount;
            return { ready: true };
        },
        { stats, requestCount, responseCount }
    );
    if (!result.ready)
        throw new Error("reason" in result ? result.reason : "Could not inject replication status fixtures.");
}

async function appendLiveSyncLog(page: Page, message: string): Promise<void> {
    const result = await page.evaluate((message) => {
        const core = (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core;
        const modules = core?.modules ?? [];
        const moduleLog = modules.find((entry): entry is TestLogModule => {
            if (typeof entry !== "object" || entry === null) return false;
            const candidate = entry as TestLogModule;
            return typeof candidate.__addLog === "function" && candidate.statusLog !== undefined;
        });
        if (!moduleLog?.__addLog) return { ready: false, reason: "LiveSync logging is unavailable." };
        moduleLog.__addLog(message);
        return { ready: true };
    }, message);
    if (!result.ready) throw new Error("reason" in result ? result.reason : "Could not append a LiveSync log entry.");
}

/** The card is collapsed until the orb is clicked; every text assertion happens with it open. */
async function openStatusBubble(page: Page): Promise<void> {
    await page.locator(bubbleSelector).waitFor({ state: "attached", timeout: uiTimeoutMs });
    const open = await page.locator(bubbleSelector).evaluate((element) => element.classList.contains("is-open"));
    if (!open) await page.locator(`${bubbleSelector} .lsb-orb`).click({ timeout: uiTimeoutMs });
    await page.locator(liveStatusSelector).waitFor({ state: "attached", timeout: uiTimeoutMs });
}

async function waitForPartText(page: Page, key: string, expected: string): Promise<void> {
    await openStatusBubble(page);
    await page.waitForFunction(
        ({ key, expected }) => {
            const modules =
                (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core?.modules ?? [];
            const moduleLog = modules.find(
                (entry): entry is TestLogModule =>
                    typeof entry === "object" &&
                    entry !== null &&
                    (entry as TestLogModule).statusBarLabels !== undefined
            );
            const part = moduleLog?.statusBarLabels?.value.parts.find((candidate) => candidate.key === key);
            if (!part || String(part.value ?? "") !== expected) return false;
            const live = document.querySelector<HTMLElement>(".livesync-bubble .lsb-live-status")?.textContent ?? "";
            return live.includes(`${part.text}${part.value ?? ""}${part.suffix ?? ""}`.trim());
        },
        { key, expected },
        { timeout: uiTimeoutMs }
    );
}

async function waitForPartAbsent(page: Page, key: string): Promise<void> {
    await openStatusBubble(page);
    await page.waitForFunction(
        (key) => {
            const modules =
                (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core?.modules ?? [];
            const moduleLog = modules.find(
                (entry): entry is TestLogModule =>
                    typeof entry === "object" &&
                    entry !== null &&
                    (entry as TestLogModule).statusBarLabels !== undefined
            );
            return moduleLog?.statusBarLabels?.value.parts.some((candidate) => candidate.key === key) !== true;
        },
        key,
        { timeout: uiTimeoutMs }
    );
}

async function waitForSyncIcon(page: Page, icon: string): Promise<void> {
    await openStatusBubble(page);
    await page.waitForFunction(
        (expected) =>
            (document.querySelector<HTMLElement>(".livesync-bubble .lsb-live-status")?.textContent ?? "").includes(
                `Sync: ${expected}`
            ),
        icon,
        { timeout: uiTimeoutMs }
    );
}

async function waitForLogMessage(page: Page, expected: string, timeout = uiTimeoutMs): Promise<void> {
    await openStatusBubble(page);
    await page.waitForFunction(
        (message) =>
            (document.querySelector<HTMLElement>(".livesync-bubble .lsb-live-status")?.textContent ?? "").includes(
                message
            ),
        expected,
        { timeout }
    );
}

async function assertSingleBubble(contextPages: Page[], expectedCount = 1): Promise<void> {
    const counts = await Promise.all(
        contextPages.map(
            async (page) =>
                await page
                    .locator(bubbleSelector)
                    .count()
                    .catch(() => 0)
        )
    );
    const actualCount = counts.reduce((total, count) => total + count, 0);
    failUnless(
        actualCount === expectedCount,
        `Expected ${expectedCount} LiveSync status bubble across Obsidian windows, found ${actualCount} (${counts.join(", ")}).`
    );
}

async function getStatusDiagnostics(page: Page): Promise<Record<string, unknown>> {
    return await page.evaluate(() => {
        const app = (globalThis as TestWindow).app;
        const core = app?.plugins?.plugins?.["livesync-efficient"]?.core;
        const moduleLog = (core?.modules ?? []).find(
            (entry): entry is TestLogModule =>
                typeof entry === "object" && entry !== null && (entry as TestLogModule).statusBarLabels !== undefined
        );
        const bubble = document.querySelector<HTMLElement>(".livesync-bubble");
        const orb = bubble?.querySelector<HTMLElement>(".lsb-orb");
        return {
            bubbleCount: document.querySelectorAll(".livesync-bubble").length,
            bubbleClassName: bubble?.className,
            bubbleAriaExpanded: orb?.getAttribute("aria-expanded"),
            liveStatus: bubble?.querySelector<HTMLElement>(".lsb-live-status")?.textContent,
            moduleHasStatusLabels: moduleLog?.statusBarLabels !== undefined,
            workspaceLayoutReady: app?.workspace?.layoutReady,
            activeFile: app?.workspace?.getActiveFile?.()?.path,
        };
    });
}

async function waitForPopoutPage(page: Page, marker: string): Promise<Page> {
    const deadline = Date.now() + uiTimeoutMs;
    const selector = `[data-e2e-status-popout="${marker}"]`;
    while (Date.now() < deadline) {
        for (const candidate of page.context().pages()) {
            if (
                (await candidate
                    .locator(selector)
                    .count()
                    .catch(() => 0)) > 0
            )
                return candidate;
        }
        await page.waitForTimeout(100);
    }
    throw new Error(`Obsidian did not expose the popout renderer containing ${selector}.`);
}

async function createPopoutLeaf(page: Page, marker: string): Promise<void> {
    const result = await page.evaluate(async (marker) => {
        const host = globalThis as TestWindow;
        const app = host.app;
        const workspace = app?.workspace;
        const file = host.__livesyncStatusFixtureFile;
        if (!workspace?.openPopoutLeaf || !workspace.setActiveLeaf || file === undefined) {
            return { ready: false, reason: "Obsidian popout workspace APIs are unavailable." };
        }
        const leaf = workspace.openPopoutLeaf();
        if (!leaf.openFile || !leaf.containerEl) return { ready: false, reason: "The popout leaf is incomplete." };
        leaf.containerEl.dataset.e2eStatusPopout = marker;
        await leaf.openFile(file);
        workspace.setActiveLeaf(leaf, { focus: true });
        host.__livesyncStatusPopoutLeaf = leaf;
        return { ready: true };
    }, marker);
    if (!result.ready) throw new Error("reason" in result ? result.reason : "Could not open an Obsidian popout leaf.");
}

async function switchToLeaf(page: Page, leafName: "first" | "split"): Promise<void> {
    const result = await page.evaluate((leafName) => {
        const host = globalThis as TestWindow;
        const workspace = host.app?.workspace;
        const leaf = leafName === "first" ? host.__livesyncStatusFirstLeaf : host.__livesyncStatusSplitLeaf;
        if (!workspace?.setActiveLeaf || !leaf) return { ready: false };
        workspace.setActiveLeaf(leaf, { focus: true });
        return { ready: true };
    }, leafName);
    failUnless(result.ready, `Could not activate the ${leafName} editor leaf.`);
    await openStatusBubble(page);
}

async function createSplitLeaf(page: Page): Promise<void> {
    const result = await page.evaluate(async () => {
        const host = globalThis as TestWindow;
        const workspace = host.app?.workspace;
        const file = host.__livesyncStatusFixtureFile;
        if (!workspace?.getLeaf || !workspace.setActiveLeaf || file === undefined) {
            return { ready: false, reason: "Obsidian split workspace APIs are unavailable." };
        }
        const leaf = workspace.getLeaf("split", "vertical");
        if (!leaf.openFile) return { ready: false, reason: "The split leaf cannot open a file." };
        await leaf.openFile(file);
        workspace.setActiveLeaf(leaf, { focus: true });
        host.__livesyncStatusSplitLeaf = leaf;
        return { ready: true };
    });
    if (!result.ready) throw new Error("reason" in result ? result.reason : "Could not create a split editor leaf.");
}

async function assertDirectionalComparison(page: Page): Promise<void> {
    const pushOnly = replicationStats(0, 0, 0, 71975);
    pushOnly.couchDB.pull.checking = false;
    await injectReplicationStats(page, pushOnly, 0, 0);
    await waitForPartText(page, "ff-push", "71975");
    await waitForPartAbsent(page, "ff-pull");
    await waitForSyncIcon(page, "⏩");
    await waitForPartText(page, "sent", "0");

    await injectReplicationStats(page, replicationStats(4, 0, 0, 40), 0, 0);
    await waitForPartText(page, "ff-push", "40");
    await waitForPartText(page, "ff-pull", "4");
    for (let update = 1; update <= 3; update++) {
        await page.waitForTimeout(700);
        await injectReplicationStats(page, replicationStats(4, 0, 0, 40 + update), 0, 0);
    }
    await waitForPartText(page, "ff-pull", "43");
    await waitForPartAbsent(page, "ff-push");
    await waitForPartAbsent(page, "ff-pull");
    await injectReplicationStats(page, replicationStats(4, 7, 11, 43), 0, 0);
    await waitForPartText(page, "arrived", "11");
    await waitForPartAbsent(page, "ff-push");
    await waitForPartAbsent(page, "ff-pull");

    const idle = replicationStats(4, 7, 11, 43);
    idle.syncStatus = "PAUSED";
    idle.couchDB.phase = "idle";
    idle.couchDB.push.checking = false;
    idle.couchDB.pull.checking = false;
    await injectReplicationStats(page, idle, 0, 0);
    await waitForSyncIcon(page, "💤");
    await waitForPartAbsent(page, "ff-push");
    await waitForPartAbsent(page, "ff-pull");

    const failed = replicationStats(5, 7, 11, 44);
    failed.syncStatus = "ERRORED";
    await injectReplicationStats(page, failed, 0, 0);
    await waitForPartText(page, "ff-push", "44");
    await waitForPartText(page, "ff-pull", "5");
    await waitForSyncIcon(page, "⚠");

    await injectReplicationStats(page, replicationStats(0, 0, 0), 0, 0);
    await waitForPartAbsent(page, "ff-push");
    await waitForPartAbsent(page, "ff-pull");
    await injectReplicationStats(page, replicationStats(1, 0, 0, 1), 0, 0);
    await waitForPartText(page, "ff-push", "1");
    await waitForPartText(page, "ff-pull", "1");
    await waitForSyncIcon(page, "⏩");
    const labels = await page.evaluate(() => {
        const modules = (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core?.modules ?? [];
        const moduleLog = modules.find(
            (entry): entry is TestLogModule =>
                typeof entry === "object" && entry !== null && (entry as TestLogModule).statusBarLabels !== undefined
        );
        return moduleLog?.statusBarLabels?.value.message;
    });
    failUnless(
        labels?.includes("(⏩↑ 1) (⏩↓ 1) ↑ 0 (LIVE) ↓ 0 (LIVE)"),
        `The plain-text status did not distinguish comparison directions from transfers: ${labels}`
    );
    console.log(
        "Directional comparison passed: push-only, independent expiry, idle/error icons, and fresh-run counts."
    );
}

async function assertLegacyStatusPaths(page: Page): Promise<void> {
    await openStatusBubble(page);
    await page.evaluate(async (timeout) => {
        const core = (globalThis as TestWindow).app?.plugins?.plugins?.["livesync-efficient"]?.core;
        const moduleLog = core?.modules?.find((entry): entry is TestLogModule => {
            if (typeof entry !== "object" || entry === null) return false;
            return (entry as TestLogModule).statusBarLabels !== undefined;
        });
        const services = core?.services;
        const settings = services?.setting?.currentSettings?.();
        if (
            !settings ||
            !services?.replication ||
            !services.fileProcessing ||
            !services.conflict ||
            !moduleLog?.activeFileStatus ||
            !moduleLog.p2pLogCollector ||
            !moduleLog.statusBarLabels
        )
            throw new Error("The legacy status sources are unavailable.");
        const counters = [
            { key: "file-processing", mark: "⏳", source: services.fileProcessing.processing, value: 2 },
            { key: "file-pending", mark: "🛫", source: services.fileProcessing.totalQueued, value: 3 },
            { key: "file-batched", mark: "📬", source: services.fileProcessing.batched, value: 4 },
            { key: "queue-replication", mark: "📥", source: services.replication.replicationResultCount, value: 5 },
            { key: "queue-database", mark: "📄", source: services.replication.databaseQueueCount, value: 6 },
            { key: "queue-storage", mark: "💾", source: services.replication.storageApplyingCount, value: 7 },
            { key: "queue-conflicts", mark: "🔩", source: services.conflict.conflictProcessQueueCount, value: 8 },
        ];
        const warning = moduleLog.activeFileStatus;
        const p2p = moduleLog.p2pLogCollector.p2pReplicationLine;
        const labels = moduleLog.statusBarLabels;
        const previous = {
            counters: counters.map(({ source }) => source.value),
            warning: warning.value,
            p2p: p2p.value,
            hideFileWarningNotice: settings.hideFileWarningNotice,
        };
        const peerLine = "⚡ E2E peer ↑ 11/12 ↓ 13/14";
        const liveText = () =>
            document.querySelector<HTMLElement>(".livesync-bubble .lsb-live-status")?.textContent ?? "";
        const wait = {
            async until(condition: () => boolean, message: string) {
                const deadline = Date.now() + timeout;
                while (!condition()) {
                    if (Date.now() >= deadline) throw new Error(message);
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            },
        };
        try {
            for (const { source, value } of counters) source.value = value;
            p2p.value = peerLine;
            settings.hideFileWarningNotice = false;
            warning.value = "E2E file warning";
            await wait.until(
                () => counters.every(({ mark, value }) => liveText().includes(`${mark}${value}`)),
                "Queue values did not reach the status bubble."
            );
            await wait.until(
                () => liveText().includes(peerLine) && liveText().includes("⚠️ E2E file warning"),
                "The P2P line or file warning was lost from the status bubble."
            );
            const plain = labels.value.message.replace(/\u2007/gu, "");
            if (
                !counters.every(({ mark, value }) => plain.includes(` ${mark}${value}`)) ||
                !plain.endsWith("\n" + peerLine)
            ) {
                throw new Error("The plain-text status lost a queue count or its separate P2P line.");
            }
            settings.hideFileWarningNotice = true;
            warning.value = "E2E file warning as an icon";
            await wait.until(
                () => liveText().includes("⛔ SKIP") && !liveText().includes("E2E file warning"),
                "The file warning did not switch to its existing compact icon."
            );
            p2p.value = "";
            await wait.until(
                () => labels.value.message.endsWith(" ⛔ SKIP"),
                "The single-line status lost the compact file warning."
            );
        } finally {
            counters.forEach(({ source }, index) => {
                source.value = previous.counters[index];
            });
            settings.hideFileWarningNotice = previous.hideFileWarningNotice;
            p2p.value = previous.p2p;
            warning.value = previous.warning;
        }
    }, uiTimeoutMs);
    console.log("Queue counts, P2P text, file warnings, and plain-text status remain available.");
}

async function runStatusScenario(session: ObsidianLiveSyncSession): Promise<void> {
    await withObsidianPage(session.remoteDebuggingPort, async (page) => {
        let popoutMarker: string | undefined;
        let popoutPage: Page | undefined;
        try {
            console.log(`Replication status runtime: ${await page.evaluate(() => navigator.userAgent)}`);
            try {
                await page.locator(bubbleSelector).waitFor({ state: "attached", timeout: uiTimeoutMs });
            } catch (error) {
                const diagnostics = await getStatusDiagnostics(page);
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)}\nLiveSync status setup: ${JSON.stringify(diagnostics)}`
                );
            }
            const setup = await getStatusDiagnostics(page);
            failUnless(
                setup.moduleHasStatusLabels === true,
                `LiveSync status labels are unavailable in the isolated vault: ${JSON.stringify(setup)}`
            );
            await injectReplicationStats(page, replicationStats(0, 0, 0), 0, 0);
            try {
                await openStatusBubble(page);
            } catch (error) {
                const diagnostics = await getStatusDiagnostics(page);
                throw new Error(
                    `${error instanceof Error ? error.message : String(error)}\nLiveSync status setup: ${JSON.stringify(diagnostics)}`
                );
            }
            await page.evaluate(() => {
                const host = globalThis as TestWindow;
                const bubble = document.querySelector<HTMLElement>(".livesync-bubble");
                if (!bubble) throw new Error("LiveSync status bubble was not created.");
                host.__livesyncBubbleNode = bubble;
            });

            const initialStats = replicationStats(1000, 1000, 0);
            const startedAt = Date.now();
            await injectReplicationStats(page, initialStats, 0, 0);
            await waitForPartText(page, "arrived", "0");
            await waitForPartText(page, "ff-pull", "1000");
            await waitForSyncIcon(page, "⏩");

            for (let update = 1; update <= 3; update++) {
                await page.waitForTimeout(700);
                await injectReplicationStats(page, replicationStats(1000, 1000 + update, 0), 0, 0);
            }
            const remainingLinger = Math.max(0, fastForwardLingerMs + 350 - (Date.now() - startedAt));
            if (remainingLinger > 0) await page.waitForTimeout(remainingLinger);
            await waitForPartAbsent(page, "ff-pull");
            await waitForSyncIcon(page, "⏩");

            await injectReplicationStats(page, replicationStats(1001, 1001, 1001, 1001), 1001, 0);
            await waitForPartText(page, "network", "1001");
            await waitForPartText(page, "sent", "1001");
            await waitForPartText(page, "arrived", "1001");
            await injectReplicationStats(page, replicationStats(7, 7, 7, 7), 7, 0);
            await waitForPartText(page, "network", "7");
            await waitForPartText(page, "sent", "7");
            await waitForPartText(page, "arrived", "7");

            await assertDirectionalComparison(page);

            await createSplitLeaf(page);
            await assertSingleBubble(page.context().pages());
            await switchToLeaf(page, "first");
            await assertSingleBubble(page.context().pages());
            await switchToLeaf(page, "split");
            await assertSingleBubble(page.context().pages());
            await switchToLeaf(page, "first");
            await assertSingleBubble(page.context().pages());

            popoutMarker = `livesync-bubble-${process.pid}-${Date.now()}`;
            await createPopoutLeaf(page, popoutMarker);
            popoutPage = await waitForPopoutPage(page, popoutMarker);
            await assertSingleBubble(page.context().pages());
            failUnless(
                (await popoutPage.locator(bubbleSelector).count()) === 0,
                "The status bubble was duplicated into the popout window."
            );

            const popoutLog = `E2E popout log ${Date.now()}`;
            await appendLiveSyncLog(page, popoutLog);
            await waitForLogMessage(page, popoutLog);

            await page.bringToFront();
            await switchToLeaf(page, "first");
            await assertSingleBubble(page.context().pages());
            failUnless(
                await page.evaluate(
                    () => (globalThis as TestWindow).__livesyncBubbleNode === document.querySelector(".livesync-bubble")
                ),
                "The LiveSync status bubble node was replaced while moving between editor windows."
            );
            const returnedLog = `E2E main-window log ${Date.now()}`;
            await appendLiveSyncLog(page, returnedLog);
            await waitForLogMessage(page, returnedLog);
            await assertLegacyStatusPaths(page);
            console.log("Replication status, split-pane ownership, and popout status/log checks passed.");
        } finally {
            await page.bringToFront().catch(() => {});
            if (popoutMarker !== undefined) {
                await page
                    .evaluate((marker) => {
                        const workspace = (globalThis as TestWindow).app?.workspace;
                        workspace?.iterateAllLeaves?.((leaf) => {
                            if (leaf.containerEl?.dataset.e2eStatusPopout === marker) leaf.detach?.();
                        });
                    }, popoutMarker)
                    .catch(() => {});
            }
            if (popoutPage) await popoutPage.close().catch(() => {});
        }
    });
}

async function main(): Promise<void> {
    const binary = requireObsidianBinary();
    const cli = discoverObsidianCli();
    if (!cli.binary) throw new Error(`Could not find obsidian-cli. Checked paths: ${cli.checked.join(", ")}`);
    for (const mobile of [false, true]) {
        const vault = await createTemporaryVault("obsidian-livesync-replication-status-");
        let session: ObsidianLiveSyncSession | undefined;
        try {
            session = await startObsidianLiveSyncSession({
                binary,
                cliBinary: cli.binary,
                vault,
                lifecycle: {
                    beforePluginStart: async ({ remoteDebuggingPort }) => {
                        if (mobile) {
                            await setObsidianMobileTestModeBeforePluginStart(remoteDebuggingPort, true, uiTimeoutMs);
                        }
                        await withObsidianPage(remoteDebuggingPort, installFixtureFile);
                    },
                },
                startupGraceMs: Number(process.env.E2E_OBSIDIAN_STARTUP_GRACE_MS ?? 1000),
                pluginData: {
                    liveSync: false,
                    syncOnStart: false,
                    syncOnSave: false,
                    isConfigured: false,
                    remoteType: "",
                    lessInformationInLog: false,
                    writeLogToTheFile: false,
                },
            });
            failUnless(
                session.readiness.pluginId === "livesync-efficient",
                "The LiveSync plug-in did not become ready."
            );
            if (!mobile) await runStatusScenario(session);
            await withObsidianPage(session.remoteDebuggingPort, async (page) => {
                await installFixtureFile(page);
                try {
                    await page.locator(bubbleSelector).waitFor({ state: "attached", timeout: uiTimeoutMs });
                    await injectReplicationStats(page, replicationStats(0, 0, 0), 0, 0);
                    await openStatusBubble(page);
                } catch (error) {
                    throw new Error(
                        `${String(error)}; bubble setup: ${JSON.stringify(await getStatusDiagnostics(page))}`
                    );
                }
                failUnless(
                    await page.locator(bubbleSelector).evaluate((element) => element.classList.contains("is-mobile")),
                    "The status bubble did not enter its mobile layout."
                );
                if (mobile) await assertDirectionalComparison(page);
            });
        } finally {
            if (session) await session.app.stop();
            await vault.dispose();
        }
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
