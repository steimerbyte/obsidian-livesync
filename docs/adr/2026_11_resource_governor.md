---
date: 2026-11-06
commonlib-version: "0.3.2"
self-hosted-livesync-version: "1.0.47"
status: accepted
---

# Architectural Decision Record: Client-side Resource Governor

## Status

Accepted on 2026-11-06 for the next release of this fork. Applies to the plugin only; it does not
change the synchronisation protocol, the remote database format or the settings schema.

## Context

Obsidian on Android gives a plugin far less memory than the desktop application, and the platform
kills the process outright instead of letting an allocation fail in a recoverable way. LiveSync
performs work whose cost is proportional to the size of the Vault and of the documents arriving from
remote peers: startup integrity checks, hidden file sweeps, Config Sync scans, database maintenance
and background replication. On a large Vault these phases overlap and compete with the editor for
CPU, which the user experiences as a slow or unresponsive application.

Two failures were observed in practice:

1. A single whole-file read of a very large file exhausts the heap in one operation, so no amount of
   throttling elsewhere helps.
2. Several independent background phases run at the same time after startup, each of them assuming
   it is the only heavy task in the plugin.

The plugin cannot change how Obsidian itself reads a file, and it cannot patch the shared library,
which is external.

## Decision

1. Add a small resource governor (`src/common/resourceGovernor.ts`) driven by a load monitor
   (`src/common/loadMonitor.ts`). It has three priority classes — user, interactive and background —
   and admits work by class: user work always runs, interactive work is throttled to a single slot
   while the device is loaded, and background work waits in a bounded queue. Background work that
   asks for the check is admitted at most once per label, so a phase cannot pile up behind itself.
2. The governor is configured by the plugin at startup, stores its per-device state in
   `localStorage` under `livesync-resource-governor-v1`, and is exposed through two commands: one
   toggles the optimiser, the other reports its current state.
3. Guard whole-file reads in `FileAccessObsidian`. Before delegating to the base class, the size is
   resolved without reading the file (from the indexed `TFile.stat`, then from a metadata stat) and
   compared with a readable limit. The limit is the lower of the configured maximum sync size and a
   device hard cap: 16 MiB on mobile, 64 MiB on desktop. An unknown size is not rejected. A refusal
   is logged once per path at notice level and reported by throwing `FileTooLargeToReadError`.

## Consequences

- Background phases no longer start together. Periodic phases skip a tick under pressure, while
  per-file work waits in the bounded queue; both run later, so background synchronisation can lag
  behind on a loaded device.
- A file above the readable limit can no longer be read by LiveSync, so it is not uploaded, and a
  conflict check that needs its content fails rather than crashing the application. The user must
  move the file out of the synchronised Vault, or exclude it, to synchronise the rest of the Vault
  reliably.
- The governor is transparent when it is disabled: every wrapper degrades to calling the wrapped
  function directly, so the decision can be reverted per device without a code change.
- The threshold is per device, not per Vault, because the memory budget belongs to the device.

## Deliberately not governed

- **Replication and SyncGuard.** Replication already runs as a bounded pipeline with its own
  concurrency limits, and SyncGuard's pause is a user decision about correctness. Routing either
  through the governor would let a load heuristic defer synchronisation or weaken a guard.
- **The shared library (`@vrtmrz/livesync-commonlib`).** The chunk worker pool, the chunk cache and
  `allChunks()` live there. They are not patched in this repository; changes belong upstream and
  arrive through a dependency bump.
- **Obsidian-native reads.** Reads performed by Obsidian itself (opening a note in the editor,
  rendering an embed, indexing the Vault) never pass through the plugin, so they cannot be
  intercepted, delayed or refused. The read guard only covers reads the plugin performs.
