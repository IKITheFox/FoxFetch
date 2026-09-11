export interface QualitySelectionProduct {
  id: string;
  defaultQualityId?: string;
  qualities: readonly { id: string }[];
}

function sameSelections(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every((key) => left[key] === right[key]);
}

/**
 * Keep a user's stable choice during an in-flight scan, even when an
 * intermediate product snapshot is temporarily incomplete. A committed
 * snapshot validates and prunes the map so selections never leak to a removed
 * product or quality.
 */
export function reconcileProductQualitySelections(
  current: Record<string, string>,
  products: readonly QualitySelectionProduct[],
  preserveTransient: boolean,
): Record<string, string> {
  const next: Record<string, string> = preserveTransient ? { ...current } : {};
  for (const product of products) {
    const previous = current[product.id];
    if (preserveTransient && previous) {
      next[product.id] = previous;
      continue;
    }
    const retained = product.qualities.some((quality) => quality.id === previous)
      ? previous
      : undefined;
    const selected = retained ?? product.defaultQualityId;
    if (selected) next[product.id] = selected;
  }
  return sameSelections(current, next) ? current : next;
}
