# Inline image storage repair

## Confirmed incident

The supplied Chrome measurements show tab snapshots consuming 9,325,658 bytes,
with two tabs responsible for approximately 8.17 MiB. Four image `url` fields
contained inline data with a combined JSON string length of 8,512,576 characters.
Character length is not Chrome's storage byte accounting.

## Implemented

- Inline image bodies are replaced with a page-local random token before DOM and
  performance discoveries enter published resource snapshots. All inline images,
  including small ones, use this path to prevent cumulative small-body growth.
- The content script retains at most 1,000 lightweight identities/digest promises,
  not an unbounded original-image cache. SHA-256 binds an on-demand rescan to the
  original content. Tokens are scoped to the Document and exact page URL.
- Preview uses a maximum 320-pixel edge and a bounded WebP thumbnail. Original
  download reads remain byte-for-byte data-URL reads, not thumbnail downloads.
- References cannot resolve in another document or after a page URL change.
  Removed or changed source images fail explicitly and require a rescan.
- Downloads hydrate the source within the existing bounded batch workers. The
  data URL is passed to Chrome for download, but not written into download history.
  Default-directory and save-as behavior continue through the existing manager.
  No new custom-directory workflow was added or independently accepted here.
- Legacy inline image bodies are removed by per-tab serialized startup migration
  and quota recovery; their entries require rescan. Current audio/video records
  and source-capture references are preserved. Large inline posters are omitted
  from persisted asset metadata as well.
- No new permissions, persistent image-body database, version bump or installation
  package has been introduced. The already-installed extension is not reloaded.

## Verification boundaries

Unit coverage includes a 5.5-million-character image reduced to a snapshot below
1,000 characters, exact on-demand restoration, wrong-document/missing/changed
source rejection, old-data quota recovery, and body-free download history.
Browser fixtures exercise image decoding and thumbnail generation independently
of the user's profile. These do not prove logged-in video download/merge output,
nor recovery of the currently installed extension's live session.

Extension updates/reloads can reset session storage; lower usage immediately after
reload alone is not a migration acceptance test. Re-open the original large-image
pages and measure fresh storage while checking image and video downloads.

Pending-network queue deduplication/periodic cleanup is a separate follow-up; it
was not implemented as part of this image-body repair.
