export interface YouTubeSelectionDraft {
  preference?: 'compatibility' | 'quality' | 'size';
  videoId: string;
  quality: string;
  codec: string;
  videoPreference?: string;
  audio: string;
  container: 'auto' | 'mp4' | 'webm';
  mode: 'merge' | 'separate';
}

/** Preferences are not a download plan or a grant to acquire a source. */
export function readYouTubeDraft(value: unknown): YouTubeSelectionDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.videoId !== 'string' ||
    !/^[\w-]{11}$/u.test(draft.videoId) ||
    typeof draft.quality !== 'string' ||
    draft.quality.length > 80 ||
    (draft.quality !== '' && !/^[\d?]+×[\d?]+ · [\d.?]+ fps$/u.test(draft.quality)) ||
    typeof draft.codec !== 'string' ||
    draft.codec.length > 1024 ||
    !/^[\w:.%~!()*'-]*$/u.test(draft.codec) ||
    (draft.videoPreference !== undefined &&
      (typeof draft.videoPreference !== 'string' || draft.videoPreference.length > 2048)) ||
    typeof draft.audio !== 'string' ||
    draft.audio.length > 1024 ||
    !/^[\w:.%~!()*'-]*$/u.test(draft.audio) ||
    typeof draft.container !== 'string' ||
    !['auto', 'mp4', 'webm'].includes(draft.container) ||
    typeof draft.mode !== 'string' ||
    !['merge', 'separate'].includes(draft.mode)
  )
    return null;
  return {
    ...(draft.preference === 'compatibility' || draft.preference === 'quality' || draft.preference === 'size' ? { preference: draft.preference } : {}),
    videoId: draft.videoId,
    quality: draft.quality,
    codec: draft.codec,
    ...(typeof draft.videoPreference === 'string'
      ? { videoPreference: draft.videoPreference }
      : {}),
    audio: draft.audio,
    container: draft.container as YouTubeSelectionDraft['container'],
    mode: draft.mode as YouTubeSelectionDraft['mode'],
  };
}

/** Session-only, bounded preferences, isolated by tab and video (not document).
 * Reloading the same video can restore a draft; a changed source remains unavailable
 * in the selection UI instead of choosing a different track automatically.
 */
export class YouTubeSelectionPreferences {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: {
      read: () => Promise<unknown>;
      write: (value: unknown) => Promise<void>;
    },
  ) {}

  access(tabId: number, videoId: string, value?: unknown): Promise<YouTubeSelectionDraft | null> {
    const action = this.queue.then(async () => {
      if (!Number.isSafeInteger(tabId) || tabId < 0 || !/^[\w-]{11}$/u.test(videoId))
        throw new Error('SELECTION_SCOPE_INVALID');
      const incoming = value === undefined ? undefined : readYouTubeDraft(value);
      if (value !== undefined && (!incoming || incoming.videoId !== videoId))
        throw new Error('SELECTION_DRAFT_INVALID');
      const raw = await this.storage.read();
      const entries: Array<{ tabId: number; draft: YouTubeSelectionDraft }> = [];
      if (Array.isArray(raw))
        for (const entry of raw.slice(-64)) {
          const draft = readYouTubeDraft(entry?.draft);
          if (draft && Number.isSafeInteger(entry?.tabId) && entry.tabId >= 0)
            entries.push({ tabId: entry.tabId, draft });
        }
      if (!incoming)
        return (
          entries.findLast((e) => e.tabId === tabId && e.draft.videoId === videoId)?.draft ?? null
        );
      const kept = entries.filter((e) => e.tabId !== tabId || e.draft.videoId !== videoId);
      kept.push({ tabId, draft: incoming });
      await this.storage.write(kept.slice(-64));
      return incoming;
    });
    this.queue = action.catch(() => undefined);
    return action;
  }
}
