# Session storage quota repair

## Scope

The quota error identifies a failed session-state write, not a corrupt video.
The exact largest category on the reporting computer has not been measured.
No permissions or installation-package version were changed in this repair.

## Changes

- All production session-storage writers/default adapters use a shared budget queue.
  Reads of actual Chrome byte usage trigger conservative reclamation above a
  7 MiB projected watermark, targeting 5 MiB where safely reclaimable records exist.
  JSON-based estimates are heuristics, not Chrome's exact quota accounting.
- Quota failures get one retry. Unrelated errors are not retried. Required writes
  still fail explicitly when protected live data exhausts the available quota.
- Reclamation includes pre-existing expired capture/fallback/quarantine records
  and old manifest route groups. Every provider identity in the newest route group
  is retained, including legacy entries with missing document IDs.
- Manifest history has a soft 512 KiB estimate budget; a complete current route
  group is never split to meet it. Pending observations use 512 KiB FIFO budgets
  in addition to existing count limits. Oversized individual observations are
  rejected, not truncated. Signed URLs and request headers are not rewritten.
- Capture observation restore applies the byte bound to older count-only records.
  FIFO observation eviction remains discovery-history retention, not deletion of
  active merge jobs or captured media files.
- Removed the duplicate in-memory manifest store. The tab memory cache is bounded
  to an estimated 4 MiB and uses copies so failed writes cannot be hidden by a
  mutable cached object. Critical writes have no memory-only success fallback.
- Current tab A/V records, merge source contexts, grants, export descriptors and
  active capture dependencies are not quota-eviction candidates. Sensitive data
  remains in session storage, never moved into persistent local storage.
- The resource controller labels storage exhaustion explicitly and does not offer
  cache download as an assumed workaround for that error.
- `sessionStorageUsage()` reports actual byte totals by fixed category only;
  it does not return storage keys, URLs, titles or credentials and sends no telemetry.

## Verification and limits

- Focused quota, concurrency, worker-restart simulation, identity-preservation,
  observation-byte-budget, tab-state and job-store tests pass.
- Full unit suite: 1892 passed, one pre-existing version expectation failed:
  `brand-assets.test.tsx` expects 1.0.0 while package.json is already 1.0.1.
- Built dark/light settings browser fixtures passed (2 tests). These use mocked
  extension APIs and do not establish real-browser quota recovery or logged-in
  download correctness on the affected computer.
- Production build succeeds with the existing large-chunk warning.
- Required next real-device check: reproduce with multiple media tabs, confirm
  recovery after expired/history records can be reclaimed, then verify an active
  audio/video merge finishes with playable output while further discovery occurs.
- This is deliberately not unrestricted cache clearing. If live protected state
  alone fills Chrome's quota, the operation reports storage exhaustion; close
  unused media tabs after active work finishes and retry resource detection.
