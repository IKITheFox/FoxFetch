export type TemporaryTransportDirection = 'forward' | 'backward';

export interface TemporaryTransportResult {
  applied: boolean;
  reason?: string;
}

export interface TemporaryTransportOptions {
  /** Must validate the exact route, DOM node, source and media lifecycle. */
  isCurrent: () => boolean;
  now?: () => number;
  onChange?: () => void;
  onInvalidated?: () => void;
}

const TRANSPORT_RATE = 3;
const FORWARD_TICK_MS = 50;
const REVERSE_TICK_MS = 100;
const END_MARGIN_SECONDS = 0.2;

function containingSeekableRange(media: HTMLMediaElement): [number, number] | undefined {
  try {
    for (let index = 0; index < media.seekable.length; index += 1) {
      const start = media.seekable.start(index);
      const end = media.seekable.end(index);
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end > start &&
        media.currentTime >= start - 0.05 &&
        media.currentTime <= end + 0.05
      ) {
        return [start, end];
      }
    }
  } catch {
    // MSE ranges can disappear while a source is being replaced.
  }
  return undefined;
}

/**
 * An ephemeral transport lease, not a playback preference. All restoration
 * writes happen synchronously at end(); a late play() promise never restores
 * old settings over a newer user operation or a replacement player.
 */
export class TemporaryTransport {
  private active = false;
  private timer: number | undefined;
  private originalRate = 1;
  private originalPaused = true;
  private startedAt = 0;
  private startTime = 0;
  private terminal = false;
  private reverseRange: [number, number] | undefined;
  private lastClock = 0;

  constructor(
    readonly media: HTMLMediaElement,
    readonly direction: TemporaryTransportDirection,
    private readonly options: TemporaryTransportOptions,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  async start(): Promise<TemporaryTransportResult> {
    if (!this.options.isCurrent()) return { applied: false, reason: '当前视频已切换，请重试。' };
    if (this.direction === 'backward') {
      this.reverseRange = containingSeekableRange(this.media);
      if (!this.reverseRange) return { applied: false, reason: '当前视频尚无可回退的可寻址区间。' };
    }
    this.originalRate = this.media.playbackRate;
    this.originalPaused = this.media.paused;
    this.startTime = this.media.currentTime;
    this.startedAt = this.now();
    this.lastClock = this.startedAt;
    this.active = true;
    this.attach();
    try {
      if (this.direction === 'backward') {
        this.media.pause();
      } else {
        // Deliberately do not write defaultPlaybackRate or a desired-rate map.
        this.media.playbackRate = TRANSPORT_RATE;
        if (Math.abs(this.media.playbackRate - TRANSPORT_RATE) > 0.001) {
          throw new Error('Unsupported temporary playback rate');
        }
      }
      this.tick();
      if (this.active && !this.terminal && this.direction === 'forward' && this.media.paused) {
        await this.media.play();
      }
      if (!this.active || !this.options.isCurrent()) {
        this.invalidateIfStale();
        return { applied: false, reason: '临时播放操作已取消或视频已切换。' };
      }
      if (this.direction === 'forward' && !this.terminal && this.media.paused) {
        this.end();
        return { applied: false, reason: '播放器仍处于暂停或播放保护状态，无法开始临时快进。' };
      }
      this.options.onChange?.();
      return { applied: true };
    } catch {
      this.end();
      return { applied: false, reason: '播放器未接受临时播放操作，请先在网页中播放视频。' };
    }
  }

  end(options: { restore?: boolean } = {}): void {
    if (!this.active) return;
    this.active = false;
    this.detach();
    if (options.restore !== false && this.options.isCurrent()) {
      try {
        this.media.playbackRate = this.originalRate;
        // Reaching either terminal boundary remains paused. Resuming there can
        // trigger site autoplay/next-video logic immediately after release.
        if (this.originalPaused || this.terminal) this.media.pause();
        else if (this.media.paused) void this.media.play()?.catch(() => undefined);
      } catch {
        // Site wrappers or a destroyed decoder can reject restoration.
      }
    }
    this.options.onChange?.();
  }

  private now(): number {
    return this.options.now?.() ?? this.media.ownerDocument.defaultView?.performance.now() ?? 0;
  }

  private invalidateIfStale(): boolean {
    if (!this.active) return true;
    if (this.options.isCurrent()) return false;
    this.end({ restore: false });
    this.options.onInvalidated?.();
    return true;
  }

  private readonly tick = (): void => {
    this.timer = undefined;
    if (this.invalidateIfStale()) return;
    try {
      if (!this.terminal && this.direction === 'backward') {
        const currentRange = containingSeekableRange(this.media);
        if (!currentRange || !this.reverseRange) {
          this.reachBoundary();
        } else {
          // Never jump across a seekable gap; an MSE/live-window contraction
          // can only make the originally admitted interval narrower.
          const start = Math.max(this.reverseRange[0], currentRange[0]);
          const end = Math.min(this.reverseRange[1], currentRange[1]);
          if (end <= start) {
            this.reachBoundary();
          } else {
            this.lastClock = Math.max(this.lastClock, this.now());
            const target = Math.max(
              start,
              Math.min(
                end,
                this.startTime - ((this.lastClock - this.startedAt) / 1_000) * TRANSPORT_RATE,
              ),
            );
            // Coalesce a slow pending seek. The next seek uses the current wall
            // clock rather than replaying an ever-growing queue of old targets.
            if (!this.media.seeking && Number.isFinite(target)) {
              this.media.currentTime = target;
              if (target <= start) this.reachBoundary();
            }
          }
        }
      } else if (!this.terminal) {
        const end = this.media.duration;
        if (
          this.media.ended ||
          (Number.isFinite(end) &&
            end > 0 &&
            this.media.currentTime >= Math.max(0, end - END_MARGIN_SECONDS))
        ) {
          this.reachBoundary();
        } else if (Math.abs(this.media.playbackRate - TRANSPORT_RATE) > 0.001) {
          this.media.playbackRate = TRANSPORT_RATE;
        }
      }
      if (this.terminal && !this.media.paused) this.media.pause();
    } catch {
      this.end();
      this.options.onInvalidated?.();
      return;
    }
    if (this.active) {
      this.timer = this.media.ownerDocument.defaultView?.setTimeout(
        this.tick,
        this.direction === 'forward' ? FORWARD_TICK_MS : REVERSE_TICK_MS,
      );
    }
  };

  private reachBoundary(): void {
    this.terminal = true;
    this.media.pause();
    this.options.onChange?.();
  }

  private readonly onEnded = (event: Event): void => {
    if (this.invalidateIfStale()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.reachBoundary();
  };

  private readonly onPlaybackAttempt = (event: Event): void => {
    if (this.invalidateIfStale() || (!this.terminal && this.direction !== 'backward')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.media.pause();
  };

  private readonly onLifecycle = (): void => {
    this.end({ restore: false });
    this.options.onInvalidated?.();
  };

  private readonly onProgress = (): void => {
    if (this.direction === 'backward') {
      // Seeking itself emits timeupdate. Feeding that event back into another
      // reverse seek would bypass the 100 ms throttle and flood the decoder.
      this.invalidateIfStale();
      return;
    }
    if (this.timer != null) this.media.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.tick();
  };

  private attach(): void {
    this.media.addEventListener('ended', this.onEnded, true);
    this.media.addEventListener('play', this.onPlaybackAttempt, true);
    this.media.addEventListener('playing', this.onPlaybackAttempt, true);
    this.media.addEventListener('timeupdate', this.onProgress, true);
    this.media.addEventListener('durationchange', this.onProgress, true);
    this.media.addEventListener('emptied', this.onLifecycle, true);
    this.media.addEventListener('loadstart', this.onLifecycle, true);
  }

  private detach(): void {
    if (this.timer != null) this.media.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.timer = undefined;
    this.media.removeEventListener('ended', this.onEnded, true);
    this.media.removeEventListener('play', this.onPlaybackAttempt, true);
    this.media.removeEventListener('playing', this.onPlaybackAttempt, true);
    this.media.removeEventListener('timeupdate', this.onProgress, true);
    this.media.removeEventListener('durationchange', this.onProgress, true);
    this.media.removeEventListener('emptied', this.onLifecycle, true);
    this.media.removeEventListener('loadstart', this.onLifecycle, true);
  }
}
