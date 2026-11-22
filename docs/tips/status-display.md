# Synchronisation status

LiveSync reports synchronisation status in the status bubble above the active note. The bubble shows a headline, a progress bar, category rows, and the raw live status block. The following sections explain the indicators it reports.

## Status indicators

-   Activity Indicator
    -   📲 A finite remote operation is in progress
    -   🌐N Approximate remote requests currently in progress
-   Status
    -   ⚓ A new replicator has not yet established a connection
    -   ⏹ The replication session is closed
    -   ✅ The current finite replication has completed. Vault file reflection can continue separately.
    -   🌀 Starting synchronisation
    -   ⏩ Comparing CouchDB change history, including entries already held locally
    -   💤 Waiting for changes, or an idle P2P peer
    -   ⚡ Synchronisation in progress
    -   ⚠ An error occurred
-   Statistical Indicators
     -   ↑ Database document revisions sent
     -   ↓ Database document revisions received
-   Progress Indicators
     -   📥 Unprocessed transferred items
     -   📄 Working database operation
     -   💾 Working write storage processes
     -   ⏳ Working read storage processes
     -   🛫 Pending read storage processes
     -   📬 Batched read storage processes
     -   ⚙️ Working or pending storage processes for hidden files
     -   🛄 Pending initial on-demand chunk requests
     -   🔁 Pending chunk retries, including retry delays
     -   🔌 Working customisation items (configuration, snippets, and plug-ins)

For CouchDB and P2P, numbers in parentheses show the remaining sequence distance to the source's sequence at the start of that replication direction. The value counts down to `(0)` when the position reaches or passes that boundary. The parentheses are omitted when the position has not been reported. For P2P, the number after `↑` or `↓` is the transferred document revision count; `‒` means that count has not been reported, while `0` is a measured zero. For example, an active peer at sequence 800 of 900 with two sent revisions shows `⚡ peer-a ↑ 2 (100)`. The P2P peer name identifies the other device.

To prevent file and database corruption, please avoid closing Obsidian until all progress indicators have disappeared as much as possible (although the plug-in will attempt to resume if interrupted). This is especially important if you have deleted or renamed files.

## Configured automatic synchronisation

The live status line in the bubble shows the configured automatic synchronisation for a CouchDB or S3-compatible Object Storage remote, ahead of the transfer status:

| Symbol | Configured triggers |
| --- | --- |
| 🔗 | LiveSync mode |
| ⏰ | Periodic synchronisation |
| ✨ | At least one event trigger: file save, editor save, start-up, file open, or file merge |
| 🛎 | Manual synchronisation only; all ordinary automatic triggers are disabled |

Enabled groups appear together: `⏰ ✨` means periodic and event synchronisation are configured. The badge describes the settings, while the following status items describe current replication activity. A thin, theme-coloured divider separates the status from items before it, such as the mode badge or network activity; the divider is omitted when the status is first. For example, `🔗 │ 💤 ↑ 0 ↓ 0` shows a mode badge, divider, waiting status, and directional totals. The `│` in the example represents a CSS border, not a text character. A configured mode does not establish that the device is connected or that file and database reflection is enabled. Unconfigured Vaults and P2P main remotes do not show this badge; P2P uses its own connection and automatic synchronisation settings.

Fetch and Rebuild deliberately disable automatic synchronisation. Completion does not restore the previous mode, so the badge then shows 🛎. A completed operation can still leave conflicts to review. Please review the resulting Vault and any conflicts before choosing the intended triggers under **Sync Settings** → **Synchronization Method**.

## CouchDB comparison count

When CouchDB change history is being compared, directional counts can appear before any new documents arrive, for example `⏩ (⏩↑ 1200) (⏩↓ 84) ↑ 0 ↓ 0`. The `⏩↑` count is for the push direction, and `⏩↓` is for the pull direction. Each counts candidate changes-feed entries compared during the current replication attempt, including entries which do not need to be transferred and repeated entries on retries. They are feed-entry counts, not counts of Vault files which need to be transferred.

Each directional count has its own display timer. A positive count remains visible for three seconds after its last change, then clears; a count which reaches zero clears immediately. A change in one direction does not extend the other direction's timer. The ⏩ status icon follows comparison activity independently of these timers.

## Category rows

The expanded card keeps six category rows current while it is open, each with a coloured dot:

| Category | Reports |
| --- | --- |
| Initialisation | LiveSync has finished starting up. |
| Replication | The current replication run: completed, running, or errored. |
| Sync | The same overall state as the orb. |
| Config sync | A customisation sweep is in progress. |
| Storage | The storage, database, and chunk queues are empty. |
| Warnings | There is no unresolved file or network warning. |

-   **Green** — ready or idle.
-   **Yellow** — active, starting, or a backlog still draining.
-   **Red** — an error, or a warning that needs attention.

Below the rows, the raw live log shows the current status text followed by the newest eight log lines, newest first, and scrolls within the card.

## Customising the bubble

The bubble and its category rows are styled in `styles.css`. Older releases also drew individual `livesync-stat-*` spans in an editor overlay and in the Obsidian status bar; both are gone, so CSS snippets which targeted those classes no longer match anything. The bubble shows the category rows together with the raw live status block.

See the [documentation index](../README.md) for setup and troubleshooting guides.
