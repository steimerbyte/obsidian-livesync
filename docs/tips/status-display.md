# Synchronisation status

LiveSync reports synchronisation status in the status bubble above the active note. The bubble shows a headline, a progress bar, category rows, and the raw live status block. The following sections explain the indicators it reports.

## Status indicators

-   Activity Indicator
    -   📲 A finite remote operation is in progress
    -   🌐N Approximate remote requests currently in progress
-   Status
    -   ⏹️ Stopped
    -   🌀 Starting synchronisation
    -   ⏩ Comparing CouchDB change history, including entries already held locally
    -   💤 LiveSync enabled. Waiting for changes
    -   ⚡️ Synchronisation in progress
    -   ⚠ An error occurred
-   Statistical Indicators
     -   ↑ Uploaded chunks and metadata
     -   ↓ Downloaded chunks and metadata
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

To prevent file and database corruption, please avoid closing Obsidian until all progress indicators have disappeared as much as possible (although the plug-in will attempt to resume if interrupted). This is especially important if you have deleted or renamed files.

## CouchDB comparison count

When CouchDB change history is being compared, directional counts can appear before any new documents arrive, for example `Sync: ⏩ (⏩↑ 1200) (⏩↓ 84) ↑ 0 ↓ 0`. The `⏩↑` count is for the push direction, and `⏩↓` is for the pull direction. Each counts candidate changes-feed entries compared during the current replication attempt, including entries which do not need to be transferred and repeated entries on retries. They are feed-entry counts, not counts of Vault files which need to be transferred. The final `↑` and `↓` counts continue to show uploaded and downloaded Chunks and Metadata.

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
