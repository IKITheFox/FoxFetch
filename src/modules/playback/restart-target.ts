import type { MediaElementInfo } from '../../shared/types';

/**
 * Pick the page's main media for a post-reload rewind. Video is preferred to
 * audio, and the largest visible player wins over recency/playing heuristics.
 */
export function selectRestartTarget(
  elements: readonly MediaElementInfo[],
): MediaElementInfo | undefined {
  const videos = elements.filter((element) => element.kind === 'video');
  const candidates = videos.length > 0 ? videos : [...elements];

  return candidates.toSorted((left, right) => {
    const visibleDifference = right.visibleArea - left.visibleArea;
    if (visibleDifference !== 0) return visibleDifference;
    if (left.paused !== right.paused) return left.paused ? 1 : -1;
    return right.lastActiveAt - left.lastActiveAt;
  })[0];
}

export function isRestartTargetReset(
  elements: readonly MediaElementInfo[],
  elementId: string,
  toleranceSeconds = 0.25,
): boolean {
  const target = elements.find((element) => element.elementId === elementId);
  return (
    target != null &&
    target.paused &&
    Number.isFinite(target.currentTime) &&
    target.currentTime <= Math.max(0, toleranceSeconds)
  );
}

/**
 * Determine whether the main media was already at its beginning when capture
 * started. Unlike a forced restart, playback does not need to be paused here.
 */
export function isMainMediaAtBeginning(
  elements: readonly MediaElementInfo[],
  toleranceSeconds = 0.25,
): boolean {
  const target = selectRestartTarget(elements);
  return (
    target != null &&
    Number.isFinite(target.currentTime) &&
    target.currentTime <= Math.max(0, toleranceSeconds)
  );
}

export interface RestartAtBeginningPollingOptions {
  getElements: () => readonly MediaElementInfo[];
  refresh: () => void;
  seek: (elementId: string) => Promise<boolean>;
  onUpdate?: (elements: readonly MediaElementInfo[]) => void;
  /** Called only after the same main player has remained paused near zero. */
  onStableReset?: (elementId: string) => void;
  /** Called once when the bounded stabilization window expires. */
  onTimeout?: () => void;
  isCurrent: () => boolean;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => void;
  retryIntervalMs?: number;
  timeoutMs?: number;
  stableWindowMs?: number;
}

/**
 * Keep the main player paused at zero for a short, bounded stabilization
 * window. Video sites commonly restore watch history after their player has
 * mounted, so the first successful seek is not enough. Polling ends only when
 * the selected player has stayed reset for the full stable window or the hard
 * timeout is reached.
 */
export function pollRestartAtBeginning(options: RestartAtBeginningPollingOptions): void {
  const startedAt = options.now();
  const retryIntervalMs = Math.max(100, options.retryIntervalMs ?? 250);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 12_000);
  const stableWindowMs = Math.max(0, options.stableWindowMs ?? 4_500);
  let selectedElementId: string | undefined;
  let stableSince: number | undefined;
  let finished = false;

  const finishTimeout = (): void => {
    if (finished || !options.isCurrent()) return;
    finished = true;
    options.onTimeout?.();
  };

  const scheduleNext = (attempt: () => Promise<void>): void => {
    if (finished || !options.isCurrent()) return;
    const now = options.now();
    const remainingMs = timeoutMs - (now - startedAt);
    if (remainingMs <= 0) {
      finishTimeout();
      return;
    }
    const stableRemainingMs =
      stableSince == null ? Infinity : Math.max(0, stableWindowMs - (now - stableSince));
    const delayMs = Math.min(retryIntervalMs, remainingMs, stableRemainingMs);
    options.schedule(() => void attempt(), Math.max(0, delayMs));
  };

  const attempt = async (): Promise<void> => {
    if (finished || !options.isCurrent()) return;
    options.refresh();

    let elements = options.getElements();
    const target = selectRestartTarget(elements);
    if (target) {
      if (selectedElementId !== target.elementId) {
        selectedElementId = target.elementId;
        stableSince = undefined;
      }

      if (!isRestartTargetReset(elements, target.elementId)) {
        stableSince = undefined;
        try {
          await options.seek(target.elementId);
        } catch {
          // A player may reject seeks until metadata is ready; retry in-window.
        }
        if (!options.isCurrent()) return;
        options.refresh();
        elements = options.getElements();
        options.onUpdate?.(elements);
      }

      if (isRestartTargetReset(elements, target.elementId)) {
        const now = options.now();
        stableSince ??= now;
        if (now - stableSince >= stableWindowMs) {
          if (options.isCurrent()) {
            finished = true;
            options.onStableReset?.(target.elementId);
          }
          return;
        }
      } else {
        stableSince = undefined;
      }
    } else {
      selectedElementId = undefined;
      stableSince = undefined;
    }

    scheduleNext(attempt);
  };

  void attempt();
}
