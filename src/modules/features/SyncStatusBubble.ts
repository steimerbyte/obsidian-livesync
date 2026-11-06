import { Platform, setIcon, type App } from "@/deps.ts";
import { openObsidianSettings } from "@/common/obsidianSettings.ts";
import { requestUserInitiatedReplication } from "@/serviceFeatures/manualReplication.ts";
import type { LiveSyncCore } from "@/main.ts";
import { ModuleLog } from "./ModuleLog.ts";
import {
    deriveSyncBubbleCategories,
    deriveSyncBubbleState,
    type SyncBubbleCategoryTone,
    type SyncBubbleSnapshot,
    type SyncBubbleState,
    type SyncBubbleTone,
} from "./syncStatusBubbleModel.ts";

const TONE_CLASSES: SyncBubbleTone[] = ["starting", "ready", "syncing", "config", "error", "paused", "offline"];

const QUEUE_PART_KEYS: Record<string, true> = {
    "file-processing": true,
    "file-pending": true,
    "file-batched": true,
    "queue-replication": true,
    "queue-database": true,
    "queue-storage": true,
    "queue-chunk-initial": true,
    "queue-chunk-retrying": true,
    "queue-plugin-scan": true,
    "queue-hidden-files": true,
    "queue-conflicts": true,
};

const LOG_LINE_LIMIT = 8;

const CATEGORY_TONE_LABELS: Record<SyncBubbleCategoryTone, string> = {
    ok: "OK",
    warn: "Warning",
    error: "Error",
};

type BubbleMessage = {
    title: string;
    body: string;
    /** Epoch milliseconds; 0 keeps the message until the card is dismissed. */
    until: number;
};

type NoticeCapableAPI = {
    setNoticeHandler?: (handler: ((message: string, duration?: number) => void) | null) => void;
};

/**
 * Always-on status surface in the top-right corner. The orb reports the live state;
 * tapping expands it into the status, detail, and the actions that used to live in
 * separate notice cards.
 */
export class SyncStatusBubble {
    private root!: HTMLElement;
    private orb!: HTMLButtonElement;
    private iconEl!: HTMLElement;
    private progressRing!: HTMLElement;
    private card!: HTMLElement;
    private headlineEl!: HTMLElement;
    private detailEl!: HTMLElement;
    private barEl!: HTMLElement;
    private barFill!: HTMLElement;
    private categoriesEl!: HTMLElement;
    private liveStatusEl!: HTMLElement;
    private messageEl!: HTMLElement;
    private messageTitleEl!: HTMLElement;
    private messageBodyEl!: HTMLElement;

    private message?: BubbleMessage;
    private isOpen = false;
    private lastSignature = "";
    private lastIcon = "";
    private lastCategories = "";
    private lastLiveStatus = "";
    private timer?: number;
    private isMounted = false;
    private noticeAPI?: NoticeCapableAPI;

    constructor(
        private readonly core: LiveSyncCore,
        private readonly app: App,
        private readonly pluginId: string
    ) {}

    mount(): void {
        if (this.isMounted) return;
        this.isMounted = true;

        const root = document.body.createDiv({ cls: "livesync-bubble" });
        if (Platform.isMobile) root.addClass("is-mobile");
        this.root = root;

        this.orb = root.createEl("button", {
            cls: "lsb-orb",
            attr: {
                type: "button",
                "aria-label": "LiveSync status",
                "aria-expanded": "false",
                "aria-controls": "livesync-status-bubble-card",
            },
        });
        this.progressRing = this.orb.createSpan({ cls: "lsb-progress-ring is-hidden" });
        this.orb.createSpan({ cls: "lsb-ring" });
        this.iconEl = this.orb.createSpan({ cls: "lsb-icon" });
        this.orb.createSpan({ cls: "lsb-pulse" });

        this.card = root.createDiv({
            cls: "lsb-card",
            attr: {
                id: "livesync-status-bubble-card",
                role: "dialog",
                "aria-label": "LiveSync status and actions",
                "aria-hidden": "true",
                tabindex: "-1",
            },
        });

        const head = this.card.createDiv({ cls: "lsb-head" });
        head.createSpan({ cls: "lsb-state-dot" });
        head.createSpan({ cls: "lsb-brand", text: "LiveSync" });
        const closeButton = head.createEl("button", {
            cls: "lsb-close",
            text: "×",
            attr: { type: "button", "aria-label": "Close LiveSync status", title: "Close" },
        });

        this.headlineEl = this.card.createDiv({ cls: "lsb-headline" });
        this.detailEl = this.card.createDiv({ cls: "lsb-detail" });
        this.barEl = this.card.createDiv({ cls: "lsb-bar" });
        this.barFill = this.barEl.createSpan({ cls: "lsb-bar-fill" });
        this.barEl.hidden = true;

        this.categoriesEl = this.card.createDiv({ cls: "lsb-categories" });
        this.liveStatusEl = this.card.createEl("pre", { cls: "lsb-live-status", attr: { tabindex: "0" } });
        this.liveStatusEl.hidden = true;

        this.messageEl = this.card.createDiv({ cls: "lsb-message" });
        this.messageTitleEl = this.messageEl.createDiv({ cls: "lsb-message-title" });
        this.messageBodyEl = this.messageEl.createDiv({ cls: "lsb-message-body" });
        this.messageEl.hidden = true;

        const actions = this.card.createDiv({ cls: "lsb-actions" });
        const addAction = (label: string, primary: boolean, onClick: () => void) => {
            const button = actions.createEl("button", {
                cls: primary ? "lsb-action is-primary" : "lsb-action",
                text: label,
                attr: { type: "button" },
            });
            button.addEventListener("click", onClick);
        };
        addAction("Sync now", true, () => void this.handleSync());
        addAction("Log", false, () => this.openLog());
        addAction("Settings", false, () => this.openSettings());

        this.orb.addEventListener("click", () => this.toggle());
        closeButton.addEventListener("click", () => this.close());
        this.card.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                this.close();
            }
        });
        document.addEventListener("pointerdown", this.handlePointerDown, true);

        this.noticeAPI = this.core.services.API as unknown as NoticeCapableAPI;
        this.noticeAPI.setNoticeHandler?.((message, duration) =>
            this.showMessage("LiveSync", message, duration ?? 5000)
        );
        this.timer = window.setInterval(() => {
            if (document.visibilityState !== "hidden") this.refresh();
        }, 1000);
        this.position();
        this.refresh();
    }

    destroy(): void {
        if (!this.isMounted) return;
        this.isMounted = false;
        if (this.timer !== undefined) window.clearInterval(this.timer);
        document.removeEventListener("pointerdown", this.handlePointerDown, true);
        this.noticeAPI?.setNoticeHandler?.(null);
        this.root.remove();
    }

    showMessage(title: string, body: string, duration = 8000): void {
        this.message = { title, body, until: duration > 0 ? Date.now() + duration : 0 };
        this.root.classList.toggle("has-message", !this.isOpen);
        this.refresh();
    }

    private logModule(): ModuleLog | undefined {
        try {
            return this.core.getModule(ModuleLog);
        } catch {
            // The bubble mounts before _startUp, so the log module may not exist yet.
            return undefined;
        }
    }

    private buildSnapshot(log: ModuleLog | undefined): SyncBubbleSnapshot {
        const labels = log?.statusBarLabels?.value;
        const parts = labels?.parts ?? [];
        const stats = this.core.services.replicator?.replicationStatics?.value;
        const partValue = (key: string) => parts.find((part) => part.key === key)?.value ?? 0;
        const queueText = parts
            .filter((part) => QUEUE_PART_KEYS[part.key] && (part.value ?? 0) > 0)
            .map((part) => `${part.text.trim()} ${part.value}`)
            .join(" ");
        const configActive =
            partValue("queue-plugin-scan") > 0 ||
            /scanning customi[sz]ations|customi[sz]ation sync/i.test(labels?.status ?? "");

        return {
            ready: this.core.services.appLifecycle.isReady(),
            syncStatus: stats?.syncStatus ?? "",
            maxPullSeq: stats?.maxPullSeq ?? 0,
            lastSyncPullSeq: stats?.lastSyncPullSeq ?? 0,
            maxPushSeq: stats?.maxPushSeq ?? 0,
            lastSyncPushSeq: stats?.lastSyncPushSeq ?? 0,
            queueText,
            configActive,
            statusText: labels?.status ?? "",
            warningText: log?.statusMessages?.value ?? "",
            storageQueues: {
                storage: partValue("queue-storage"),
                database: partValue("queue-database"),
                chunk: partValue("queue-chunk-initial") + partValue("queue-chunk-retrying"),
            },
        };
    }

    /** The text that used to sit in the top-right overlay, deduplicated for the card. */
    private liveStatusText(log: ModuleLog | undefined): string {
        const labels = log?.statusBarLabels?.value;
        const lines: string[] = [];
        const seen = new Set<string>();
        const push = (text: string | undefined) => {
            if (!text) return;
            for (const raw of text.split("\n")) {
                const line = raw.trim();
                if (line === "" || seen.has(line)) continue;
                seen.add(line);
                lines.push(line);
            }
        };

        push((labels?.parts ?? []).map((part) => `${part.text}${part.value ?? ""}${part.suffix ?? ""}`).join(""));
        push(labels?.message);
        push(labels?.status);
        push(log?.statusMessages?.value);
        // slice() copies, so reverse() cannot reorder the log's own array.
        push((log?.logLines ?? []).slice(-LOG_LINE_LIMIT).reverse().join("\n"));
        return lines.join("\n");
    }

    /** Keep the orb at the top-right of the active note, clear of the sidebar toggle and sidebars. */
    private position(): void {
        const view = document.querySelector<HTMLElement>(".workspace-leaf.mod-active .view-content");
        const rect = view?.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const margin = Platform.isMobile ? 12 : 52;
        const top = Platform.isMobile ? Math.max(60, rect.top + 12) : Math.max(12, rect.top + 12);
        this.root.style.left = `${Math.max(8, Math.round(rect.right - this.root.offsetWidth - margin))}px`;
        this.root.style.top = `${Math.round(top)}px`;
        this.root.style.right = "auto";
    }

    private refresh(): void {
        this.position();
        if (this.message && this.message.until > 0 && Date.now() >= this.message.until) {
            this.message = undefined;
            this.root.classList.remove("has-message");
        }
        const log = this.logModule();
        const snapshot = this.buildSnapshot(log);
        this.render(deriveSyncBubbleState(snapshot));
        this.renderLive(snapshot, log);
    }

    private render(state: SyncBubbleState): void {
        const signature = JSON.stringify([
            state.tone,
            state.headline,
            state.detail,
            state.progress,
            this.message?.title,
            this.message?.body,
        ]);
        if (signature === this.lastSignature) return;
        this.lastSignature = signature;

        for (const tone of TONE_CLASSES) this.root.classList.toggle(`is-${tone}`, tone === state.tone);
        this.root.style.setProperty("--lsb-progress", String(Math.round((state.progress ?? 0) * 100)));
        if (state.icon !== this.lastIcon) {
            setIcon(this.iconEl, state.icon);
            this.lastIcon = state.icon;
        }
        this.headlineEl.textContent = state.headline;
        this.detailEl.textContent = state.detail;
        this.orb.setAttr("aria-label", `LiveSync: ${state.headline}. ${state.detail}`);
        this.barEl.hidden = state.progress === undefined || state.tone !== "syncing";
        this.barFill.style.width = `${Math.round((state.progress ?? 0) * 100)}%`;
        this.progressRing.classList.toggle("is-hidden", state.tone !== "syncing" || state.progress === undefined);

        const hasMessage = this.message !== undefined;
        this.messageEl.hidden = !hasMessage;
        if (this.message) {
            this.messageTitleEl.textContent = this.message.title;
            this.messageBodyEl.textContent = this.message.body;
        }
        this.root.classList.toggle("has-message", hasMessage && !this.isOpen);
    }

    /** Categories and the live status text change on every poll, so they skip the orb's signature guard. */
    private renderLive(snapshot: SyncBubbleSnapshot, log: ModuleLog | undefined): void {
        const categories = deriveSyncBubbleCategories(snapshot);
        const signature = categories.map((category) => `${category.key}:${category.tone}`).join("|");
        if (signature !== this.lastCategories) {
            this.lastCategories = signature;
            this.categoriesEl.empty();
            for (const category of categories) {
                const row = this.categoriesEl.createDiv({ cls: `lsb-category is-${category.tone}` });
                row.setAttr("aria-label", `${category.label}: ${CATEGORY_TONE_LABELS[category.tone]}`);
                row.createSpan({ cls: "lsb-category-dot", attr: { "aria-hidden": "true" } });
                row.createSpan({ cls: "lsb-category-label", text: category.label });
            }
        }

        const text = this.liveStatusText(log);
        if (text !== this.lastLiveStatus) {
            this.lastLiveStatus = text;
            this.liveStatusEl.textContent = text;
            this.liveStatusEl.hidden = text === "";
        }
    }

    private toggle(): void {
        if (this.isOpen) this.close();
        else this.open();
    }

    private open(): void {
        this.isOpen = true;
        this.root.classList.add("is-open");
        this.root.classList.remove("has-message");
        this.orb.setAttr("aria-expanded", "true");
        this.card.setAttr("aria-hidden", "false");
        if (this.message && this.message.until > 0) {
            this.message.until = Math.max(this.message.until, Date.now() + 15000);
        }
        this.card.focus({ preventScroll: true });
    }

    private close(): void {
        this.isOpen = false;
        this.root.classList.remove("is-open");
        this.root.classList.toggle("has-message", this.message !== undefined);
        this.orb.setAttr("aria-expanded", "false");
        this.card.setAttr("aria-hidden", "true");
        if (this.card.contains(document.activeElement)) this.orb.focus({ preventScroll: true });
    }

    private async handleSync(): Promise<void> {
        await requestUserInitiatedReplication(this.core.services);
        this.refresh();
    }

    private openLog(): void {
        this.close();
        void this.app.commands.executeCommandById(`${this.pluginId}:view-log`);
    }

    private openSettings(): void {
        this.close();
        try {
            openObsidianSettings(this.app, this.pluginId);
        } catch (error) {
            this.showMessage("LiveSync settings", error instanceof Error ? error.message : String(error));
        }
    }

    private readonly handlePointerDown = (event: PointerEvent): void => {
        if (!this.isOpen) return;
        const target = event.target;
        if (target instanceof Node && this.root.contains(target)) return;
        this.close();
    };
}
