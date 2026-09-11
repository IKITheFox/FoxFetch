export type AutoAdvanceGuardState = 'idle' | 'armed' | 'terminal-lock' | 'released';

export type AutoAdvanceTerminalReason = 'cache-complete' | 'ended';

export interface AutoAdvanceMediaBinding {
  element: HTMLMediaElement;
  elementId: string;
  lifecycleGeneration: number;
}

export interface AutoAdvanceGuardProgress {
  cacheComplete?: boolean | undefined;
}

export interface AutoAdvanceGuardOptions {
  /** Independent from cache-tail seeking and enabled unless explicitly disabled. */
  enabled?: boolean;
}

export interface AutoAdvanceGuardSnapshot {
  state: AutoAdvanceGuardState;
  enabled: boolean;
  elementId: string;
  lifecycleGeneration: number;
  terminalReason?: AutoAdvanceTerminalReason;
}

/**
 * Stops a selected media lifecycle at its terminal boundary so page autoplay
 * cannot advance to another item while FoxFetch is completing cache capture.
 * One instance owns exactly one HTMLMediaElement and lifecycle generation.
 */
export class AutoAdvanceGuard {
  private state: AutoAdvanceGuardState = 'idle';
  private enabled: boolean;
  private terminalReason: AutoAdvanceTerminalReason | undefined;
  private originalAutoplay: boolean | undefined;
  private listenersAttached = false;

  constructor(
    private readonly binding: AutoAdvanceMediaBinding,
    options: AutoAdvanceGuardOptions = {},
  ) {
    if (!binding.elementId || !Number.isSafeInteger(binding.lifecycleGeneration)) {
      throw new TypeError('自动连播保护需要有效的媒体元素与生命周期标识。');
    }
    this.enabled = options.enabled ?? true;
  }

  getSnapshot(): AutoAdvanceGuardSnapshot {
    return {
      state: this.state,
      enabled: this.enabled,
      elementId: this.binding.elementId,
      lifecycleGeneration: this.binding.lifecycleGeneration,
      ...(this.terminalReason ? { terminalReason: this.terminalReason } : {}),
    };
  }

  isBoundTo(binding: AutoAdvanceMediaBinding): boolean {
    return (
      binding.element === this.binding.element &&
      binding.elementId === this.binding.elementId &&
      binding.lifecycleGeneration === this.binding.lifecycleGeneration
    );
  }

  /** Start guarding when cache capture starts. */
  arm(): AutoAdvanceGuardSnapshot {
    if (!this.enabled || this.state === 'released') return this.getSnapshot();
    if (this.state !== 'idle') return this.getSnapshot();
    this.originalAutoplay = this.binding.element.autoplay;
    this.binding.element.autoplay = false;
    this.attachListeners();
    this.state = 'armed';
    return this.getSnapshot();
  }

  /** Cache completeness is authoritative; playback position alone must not truncate capture. */
  observe(progress: AutoAdvanceGuardProgress): AutoAdvanceGuardSnapshot {
    if (this.state !== 'armed') return this.getSnapshot();
    if (progress.cacheComplete === true) return this.lockTerminal('cache-complete');
    return this.getSnapshot();
  }

  lockTerminal(reason: AutoAdvanceTerminalReason): AutoAdvanceGuardSnapshot {
    if (this.state === 'released' || !this.enabled) return this.getSnapshot();
    if (this.state === 'idle') this.arm();
    if (this.state !== 'armed' && this.state !== 'terminal-lock') return this.getSnapshot();
    this.state = 'terminal-lock';
    this.terminalReason ??= reason;
    this.enforceTerminalLock();
    return this.getSnapshot();
  }

  /** Enable/disable this independent policy without releasing its lifecycle binding. */
  setEnabled(enabled: boolean): AutoAdvanceGuardSnapshot {
    if (this.state === 'released' || this.enabled === enabled) return this.getSnapshot();
    this.enabled = enabled;
    if (!enabled) {
      this.detachListeners();
      this.restoreAutoplay();
      this.state = 'idle';
      this.terminalReason = undefined;
    }
    return this.getSnapshot();
  }

  /** Permanently detach this lifecycle. Safe to call repeatedly. */
  release(): AutoAdvanceGuardSnapshot {
    if (this.state === 'released') return this.getSnapshot();
    this.detachListeners();
    this.restoreAutoplay();
    this.state = 'released';
    this.terminalReason = undefined;
    return this.getSnapshot();
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    const target = this.binding.element;
    target.addEventListener('ended', this.onEnded, true);
    target.addEventListener('play', this.onPlaybackAttempt, true);
    target.addEventListener('playing', this.onPlaybackAttempt, true);
    target.addEventListener('timeupdate', this.onMediaProgress, true);
    target.addEventListener('durationchange', this.onMediaProgress, true);
    target.addEventListener('progress', this.onMediaProgress, true);
    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    const target = this.binding.element;
    target.removeEventListener('ended', this.onEnded, true);
    target.removeEventListener('play', this.onPlaybackAttempt, true);
    target.removeEventListener('playing', this.onPlaybackAttempt, true);
    target.removeEventListener('timeupdate', this.onMediaProgress, true);
    target.removeEventListener('durationchange', this.onMediaProgress, true);
    target.removeEventListener('progress', this.onMediaProgress, true);
    this.listenersAttached = false;
  }

  private restoreAutoplay(): void {
    if (this.originalAutoplay == null) return;
    this.binding.element.autoplay = this.originalAutoplay;
    this.originalAutoplay = undefined;
  }

  private enforceTerminalLock(event?: Event): void {
    if (this.state !== 'terminal-lock') return;
    event?.preventDefault();
    event?.stopImmediatePropagation();
    this.binding.element.autoplay = false;
    try {
      this.binding.element.pause();
    } catch {
      // A detached or page-wrapped element can reject controls; event blocking
      // and autoplay suppression still protect the selected lifecycle.
    }
  }

  private readonly onEnded = (event: Event): void => {
    if (this.state === 'armed') {
      this.state = 'terminal-lock';
      this.terminalReason ??= 'ended';
    }
    this.enforceTerminalLock(event);
  };

  private readonly onPlaybackAttempt = (event: Event): void => {
    this.enforceTerminalLock(event);
  };

  private readonly onMediaProgress = (): void => {
    // Sites sometimes restore the autoplay attribute while updating their
    // player. Keep it suppressed, but do not pause from currentTime alone:
    // doing so can prevent the final media segment from ever being requested.
    if (this.state === 'armed') this.binding.element.autoplay = false;
  };
}

export function createAutoAdvanceGuard(
  binding: AutoAdvanceMediaBinding,
  options: AutoAdvanceGuardOptions = {},
): AutoAdvanceGuard {
  return new AutoAdvanceGuard(binding, options);
}
