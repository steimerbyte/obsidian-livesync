import { Notice } from "@/deps.ts";

/**
 * Shows a Notice as a compact card: a heading line, then whatever the caller builds beneath it.
 * The content is a DocumentFragment, so Obsidian still owns the Notice element and its lifetime.
 */
export function showNoticeCard(title: string, build: (card: HTMLElement) => void): void {
    const fragment = createFragment((root) => {
        root.createDiv({ cls: "livesync-notice" }, (card) => {
            card.createDiv({ cls: "livesync-notice-title", text: title });
            build(card);
        });
    });
    new Notice(fragment);
}
