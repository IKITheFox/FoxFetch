import type { MergeDockView } from './types';

/** A late update may refresh capabilities, but cannot resurrect an older task. */
export function shouldAcceptMergeDockView(
  previous: MergeDockView | undefined,
  incoming: MergeDockView,
  options: { allowTaskChange?: boolean } = {},
): boolean {
  const current = previous?.snapshot;
  const next = incoming.snapshot;
  if (!current) return true;
  if (!next) return false;
  if (next.mediaEpoch < current.mediaEpoch) return false;
  if (next.taskKey !== current.taskKey) return options.allowTaskChange === true;
  return next.mediaEpoch === current.mediaEpoch && next.revision >= current.revision;
}
