# Self-hosted LiveSync Efficient

This is the Efficient fork of [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), maintained by [steimerbyte](https://github.com/steimerbyte). It keeps the upstream synchronisation protocol and adds a load-aware RAM/CPU optimiser, bounded file reads, and the performance work documented under [Performance and Resource Usage](#performance-and-resource-usage).

- Plug-in ID: `livesync-efficient` (deliberately distinct from upstream, so Community Plugins updates cannot overwrite this fork).
- Install with BRAT from `steimerbyte/obsidian-livesync`, or copy the release assets into `.obsidian/plugins/livesync-efficient/`.
- Upstream documentation: [Japanese docs](./README_ja.md) - [Chinese docs](./README_cn.md).

Self-hosted LiveSync is a community-developed synchronisation plug-in available on all Obsidian-compatible platforms. It leverages robust server solutions such as CouchDB or object storage systems (e.g., MinIO, S3, R2, etc.) to ensure reliable data synchronisation.

Additionally, it supports peer-to-peer synchronisation using WebRTC, enabling devices to exchange notes without a central data-storage server. A signalling relay is still required for peer discovery. See [How peer-to-peer synchronisation works](./docs/p2p.md).

Find setup guides, troubleshooting, technical references, design decisions, and historical material in the [documentation index](docs/README.md).

![obsidian_live_sync_demo](https://user-images.githubusercontent.com/45774780/137355323-f57a8b09-abf2-4501-836c-8cb7d2ff24a3.gif)

>[!IMPORTANT]
> This plug-in is not compatible with the official "Obsidian Sync" and cannot synchronise with it.

## Features
- Synchronise vaults efficiently with minimal traffic.
- Handle conflicting modifications effectively.
  - Automatically merge simple conflicts.
- Use open-source solutions for the server.
  - Compatible solutions are supported.
- Support end-to-end encryption.
- Synchronise settings, snippets, themes, and plug-ins via [Customisation Sync (Advanced)](docs/settings.md#6-customisation-sync-advanced) or [Hidden File Sync](docs/tips/hidden-file-sync.md).
- Synchronise peer-to-peer using WebRTC.

This plug-in may be particularly useful for researchers, engineers, and developers who need to keep their notes fully self-hosted for security reasons. It is also suitable for anyone seeking the peace of mind that comes with knowing their notes remain entirely private.

>[!IMPORTANT]
> - Before installing or upgrading this plug-in, please back up your vault.
> - Do not enable this plug-in alongside another synchronisation solution (including iCloud and Obsidian Sync).
> - For backups, we also provide a plug-in called [Differential ZIP Backup](https://github.com/vrtmrz/diffzip).

## How to Use

Self-hosting lets us choose a server we trust and manage it ourselves. Please set up and maintain your own server, and keep it secure.

<a id="setup-workflows"></a>
<a id="what-you-need"></a>

### 1. Choose a synchronisation backend

Choose **CouchDB** or **Object Storage** for central storage, or use **WebRTC Peer-to-Peer (P2P)** without a central storage server. CouchDB and Object Storage are alternatives: choosing Object Storage does not require a CouchDB server. P2P can also run alongside either central backend; its connection is selected independently.

> [!TIP]
> **You can switch backends at any time**: Self-hosted LiveSync supports multiple connection profiles via **Saved connections** in settings. You can begin with a hosted option such as Fly.io or Cloudflare R2, and switch to your own server later without rebuilding your Vault files.

#### Backend comparison and decision guide

| Backend / Environment | LiveSync Mode<br>(Real-time continuous) | Sync while others offline | Mobile support<br>(iOS and Android) | Maintenance effort | Monthly cost example | Recommended for |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **CouchDB (Self-hosted)**<br>*(Own VPS, NAS, Docker, or Raspberry Pi)* | ✅ Full | ✅ Yes | ⚠️ Requires HTTPS (public or private endpoint)[^private-https] | High (manage OS, Docker, and backups) | Free (on existing hardware) | Users with home servers or private infrastructure |
| **CouchDB (Fly.io)**<br>*(Cloud container PaaS)* | ✅ Full | ✅ Yes | ✅ Out of the box (HTTPS included) | Low (scripted setup via notebook) | ~USD 2.34 / mo in Ashburn[^fly-pricing]<br>*(see [cost details](docs/setup_flyio.md#costs-before-deployment))* | Users wanting real-time sync without managing hardware |
| **Object Storage (S3 / R2)**<br>*(Cloudflare R2, AWS S3, or MinIO)* | ❌ Periodic or on-save only | ✅ Yes | Managed services: HTTPS included<br>Self-hosted: configure HTTPS | Managed services: bucket configuration<br>Self-hosted: manage the server and backups | USD 0.00 within R2 free allowances[^r2-pricing]<br>*(see [cost guide](docs/setup_object_storage_costs.md))* | Users who prefer Object Storage without server maintenance |
| **WebRTC Peer-to-Peer**<br>*(Direct device-to-device)* | ✅ Full *(while connected)* | ❌ Both devices must be online | ⚠️ Limited by OS background tasks | None (free public signalling relay) | Free (no server required) | Users who prefer no central storage server |

> [!NOTE]
> **How Object Storage request counts affect costs**:
> Unlike traditional file-synchronisation tools that scan every single file on each sync (generating thousands of `LIST` or `HEAD` operations), LiveSync uses **Journal Sync**. It packages only recent changes into compressed delta journals.
> **Routine checks do not inspect each Vault file**. Whether your Vault contains 100 or 50,000 files, the journal listing step of an idle check uses one LIST request. Synchronisation also checks the bucket and reads or updates synchronisation parameters and device records. Metadata and Chunks travel together in journal packages, so initial and incremental transfer counts depend on those packages. See [Object Storage transfers, request scaling, and service costs](docs/setup_object_storage_costs.md) for a calculation example covering journal listing and transfers, with control requests identified separately.[^r2-pricing]

The figures above are calculation examples. Prices and free allowances may change. Check the linked official pricing pages and recalculate costs for your chosen configuration before deploying.

[^fly-pricing]: November 2026 ([Fly.io resource pricing](https://docs.fly.io/about/pricing)); one `shared-cpu-1x` Machine with 256 MB RAM and a 1 GB persistent volume in Ashburn (`iad`), running continuously for 30 days. Outbound data transfer and optional resources are additional.
[^r2-pricing]: November 2026 ([Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)); Standard storage. Free allowances apply to the account's combined usage.
[^private-https]: A private HTTPS endpoint accessible only to your devices can be provided by services such as [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). See the [Docker stack](docker/README.md#profile-details) for setup options.

<a id="prepare-your-chosen-backend"></a>

### 2. Prepare your chosen backend

Follow the setup guide for your selected method:

- **CouchDB**:
  - **Self-hosted**: deploy using the [Docker stack](docker/README.md) or follow [Your own server](docs/setup_own_server.md).
  - **Fly.io**: follow [Setup CouchDB on Fly.io](docs/setup_flyio.md) for a scripted cloud deployment.
  - **IBM Cloudant**: follow [IBM Cloudant setup](docs/setup_cloudant.md) for managed CouchDB hosting.
- **Object Storage**:
  - Follow [Object Storage Setup](docs/setup_object_storage.md) using Cloudflare R2, Amazon S3, or a self-hosted MinIO bucket.
- **Peer-to-Peer**:
  - Follow [Peer-to-Peer Setup](docs/setup_p2p.md) after reviewing the [P2P communication model](docs/p2p.md). No server provisioning is required when using the public signalling relay.

<a id="3-minute-setup---couchdb-on-flyio"></a>

For the Fly.io video walkthrough, see [automated setup](docs/setup_flyio.md#a-very-automated-setup).

If you would like to test WebRTC connectivity between your devices before setting up P2P, try the experimental [WebPeer browser utility](https://vrtmrz.github.io/obsidian-livesync/webpeer/) ([documentation](src/apps/webpeer/README.md)).

<a id="start-synchronising"></a>

### 3. Connect your devices and verify synchronisation

Regardless of your chosen backend, connecting your devices follows four straightforward steps:

1. **Prepare your backend** using the guide selected in Step 2 (not required for P2P with the public relay).
2. **Set up your first device**: install Self-hosted LiveSync and configure your connection and encryption using the appropriate guide:
   - For CouchDB: follow [Quick Setup](docs/quick_setup.md) to initialise the local and remote databases from your Vault.
   - For Object Storage: follow [Object Storage Setup](docs/setup_object_storage.md) to initialise the local database and upload its journals to your bucket.
   - For Peer-to-Peer: follow [Peer-to-Peer Setup](docs/setup_p2p.md) to initialise the local LiveSync database. P2P has no central remote database.
3. **Connect additional devices using a Setup URI**: on your working first device, run `Copy settings as a new Setup URI` from the command palette. Open that encrypted URI on your second device so it receives the identical encryption and connection profiles.
4. **Verify two-way synchronisation**: create a test note on your first device and confirm that it appears on the second. Then edit the note on the second device and confirm that the change reflects back on the first device. Configure optional features (such as customisation or hidden-file sync) only after this verification succeeds.

<a id="third-party-managed-couchdb-hosting"></a>

### Hosting services proposed by the community

> [!NOTE]
> The services below are operated by third parties. They are not official Self-hosted LiveSync services, and this project neither endorses nor recommends them. The providers proposed the listings in the table.

If you would rather not set up and maintain a server yourself, the following providers offer managed CouchDB servers which this plug-in can be configured to connect to:

| Provider | Offering |
| --- | --- |
| [Zenith Hosting](https://zenith.hosting/host/obsidian-livesync) | Managed CouchDB hosting. |

Your synchronisation data will reside on a server operated by the provider. Consider whether that is acceptable for your Vault, and review the provider's current terms, pricing, and data-handling policies before using the service.

## Information in the Status Bar

Synchronisation status is shown in the status bar and inside the editor by default. The main indicators are:

| Indicator | Meaning |
| --- | --- |
| ⏹️ | Stopped. |
| 🌀 | Starting synchronisation. |
| 💤 | LiveSync mode is waiting for changes. |
| ⚡️ | Synchronisation is in progress. |
| ⏩ | Comparing CouchDB change history, including entries already held locally. |
| ⚠ | An error occurred. |
| ↑ / ↓ | Uploaded / downloaded Chunks and Metadata. |
| 📲 / 🌐N | A finite remote operation is in progress / approximate remote requests in progress. |

<a id="customising-status-items-with-css-snippets"></a>

See the [status display guide](docs/tips/status-display.md) for detailed progress counters and [CSS customisation](docs/tips/status-display.md#customising-status-items-with-css-snippets).

Allow pending file operations to finish before closing Obsidian, especially after deleting or renaming files.

## Performance and Resource Usage

This fork contains client-side work to reduce memory growth and CPU load, particularly on mobile devices where Obsidian has a smaller memory budget. The changes do not alter the synchronisation protocol, the remote database format, or the settings schema, and add no dependencies.

Measured on a local production build (`npm run build`, `gzip -6 main.js`):

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| `main.js` | 4,089,451 B | 4,023,006 B | −1.62 % |
| `main.js` (gzip) | 1,161,862 B | 1,146,295 B | −1.34 % |
| Unit tests | 2,041 passed | 2,069 passed | — |

### Memory

- The on-editor log history is only collected while "Show longer log" is enabled, and is capped at 200 entries. Previously it grew for the whole session even when the history was not displayed.
- The replication result queue is keyed by document id in a `Map`, so re-queuing and removal are constant-time instead of scanning an array. Recovery snapshots are written at most once per second and are skipped when the queue is empty.
- The startup integrity check skips documents that are already deleted, reuses the blob it has built instead of reading the same content twice, and yields to the event loop every 128 documents.
- The same-change pair cache is capped at 4,096 entries with oldest-first eviction, which bounds the whole-map local storage write.
- Local database maintenance reads and deletes chunk documents in batches of 100; the database-wide garbage collection holds a lock for its whole run, and local PouchDB compaction runs once after the user-confirmed collection.

### Synchronisation and background work

- Hidden File Sync and Config Sync sweeps pause while the application is suspended, and resume with the existing on-resume scan.
- Hidden File Sync caps concurrent stat calls and batch items at 10, and merges untracked-file sets with a `Set` instead of repeated `indexOf` scans.
- Database file enumeration reads the metadata range in pages of 1,000 rows rather than one response containing the whole vault.
- Config Sync reads its legacy (V1) range as a stream instead of materialising every document body.
- Conflict checking runs at most two checks concurrently. Each check can hold several full note bodies, so this is a memory bound rather than a throughput setting.
- Conflict state is only refreshed for the active file or a postponed conflict. Other checked files no longer trigger a metadata read and a global status event each.

### CPU and rendering

- The in-editor status overlay re-renders at most every 250 ms on mobile (20 ms on desktop) instead of 50 times per second.
- Document History debounces revision slider input by 275 ms, so dragging produces one diff instead of one per input event.
- The status overlay no longer applies a grayscale filter, the sticky settings header uses an opaque background instead of a backdrop blur, and the warning band no longer runs an infinite background animation.

### Build

- Production compression runs two Terser passes. Class and function names, property names, and top-level bindings remain unmangled because the plug-in uses `constructor.name` for add-on discovery and diagnostic labels.

### RAM/CPU optimiser

A small resource governor admits work by priority class instead of letting every phase start at the same time. It is enabled by default and adds no dependency.

| Setting | Desktop | Mobile |
| --- | ---: | ---: |
| Default state | enabled | enabled |
| Concurrent tasks: user / interactive / background | 4 / 2 / 2 | 2 / 2 / 1 |
| Concurrent tasks under pressure: user / interactive / background | 1 / 1 / 0 | 1 / 1 / 0 |
| Background queue | 32 | 32 |
| High-pressure threshold → release | 55 % → 45 % | 55 % → 45 % |

Priority classes:

- **user** — a command or UI action the user is waiting for. Always admitted.
- **interactive** — work started by the user's current activity. Admitted unless the device is loaded.
- **background** — sweeps, scans and maintenance. Per-file work queues until a slot is free; periodic phases skip their tick instead. A phase that asks for the duplicate check is not queued again while it is already queued or running.

The governor switches to the high-pressure limits at a pressure of 55 % and returns to the normal limits at 45 %. Pressure combines the smoothed event-loop lag, long-task duration and, where the browser still reports it, the heap ratio. It is sampled every 500 ms and not at all while the application is hidden. After a user or interactive task runs for two seconds or longer, background work is held back for a few seconds so that the interaction finishes first. A background limit of 0 pauses background work rather than rejecting it.

Commands:

- **Toggle RAM/CPU optimiser** — switches the governor on or off for this device. A disabled governor passes every call straight through.
- **Show RAM/CPU optimiser status** — reports the state, level, pressure, in-flight and queued work, and the effective limits.

The state is kept per device in `localStorage` under `livesync-resource-governor-v1`. It is not part of the settings file and is not synchronised, because the memory budget belongs to the device.

#### Read size guard

Every read the plug-in performs is checked against the file size first. The limit is 16 MiB on mobile and 64 MiB on desktop, and a non-zero **Maximum file size** setting lowers it further; its default of 50 MB therefore lowers the desktop limit to 50 MB, while the mobile limit stays at 16 MiB. A larger file is not read: the refusal is logged once per path at notice level and the read fails. Writes, listings and metadata reads are not affected.

Reads performed by Obsidian itself — opening a note, rendering an embed, indexing the Vault — do not pass through the plug-in and cannot be intercepted, delayed or refused. A file that crashes Obsidian natively is therefore fixed by excluding it with an ignore file or moving it out of the Vault, not by the guard.

The reasoning and the deliberate exclusions are recorded in the [resource governor ADR](docs/adr/2026_11_resource_governor.md).

### Remaining upstream work

The following costs live in `@vrtmrz/livesync-commonlib` and are not changed by this fork:

- The chunk cache performs a linear content scan per chunk unless an independent encryption key is configured.
- `allChunks()` materialises every chunk body at once during local garbage collection.
- The chunk worker pool starts `floor(hardwareConcurrency / 2)` workers when the plug-in loads.
- Content comparisons materialise both sides as whole-file `ArrayBuffer` copies.
- The target-file filter cache is invalidated by every storage event.

## Tips and Troubleshooting
- If you want a faster and simpler initial replication when setting up subsequent devices, see the [Fast Setup Guide](docs/tips/fast-setup.md).
- Configure [Hidden File Sync](docs/tips/hidden-file-sync.md) only after ordinary note synchronisation works.
- If Obsidian or LiveSync cannot start normally, use [Recovery and flag files](docs/recovery.md) before changing or resetting a remote database.
- Self-hosted LiveSync 1.0 requires Obsidian 1.7.2 or later. This fork is distributed through GitHub releases and BRAT, not the Community Plugins store; if you need an older Obsidian version, [open an issue](https://github.com/steimerbyte/obsidian-livesync/issues/new) with your version and platform.
- If you are having problems getting the plug-in working, see [Tips and Troubleshooting](docs/troubleshooting.md).

## Acknowledgements
The project has been in continual progress and harmony thanks to the following:  
- Many [Contributors](https://github.com/vrtmrz/obsidian-livesync/graphs/contributors).  
- Many [GitHub Sponsors](https://github.com/sponsors/vrtmrz#sponsors).  
- JetBrains Community Programs / Support for Open-Source Projects. <img src="https://resources.jetbrains.com/storage/products/company/brand/logos/jetbrains.png" alt="JetBrains logo" height="24">  

May those who have contributed be honoured and remembered for their kindness and generosity.

## Development Guide
Please refer to the [Development Guide](devs.md) for development setup, testing infrastructure, code conventions, and more.

## License

Licensed under the MIT License.
