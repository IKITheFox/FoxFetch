/** Presentation only: retain representation identity/metadata, omit repeated quality badges. */
export function compactQualityLabel(...labels: Array<string | undefined>): string {
  const parts = labels
    .flatMap((label) => (label ?? '').split(/\s*·\s*/u))
    .map((part) => part.trim())
    .filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    const key = part.replace(/\s+/gu, '').toLowerCase();
    if (result.some((existing) => existing.replace(/\s+/gu, '').toLowerCase() === key)) continue;
    if (
      /^(?:高码率|高帧率|\d+帧)$/u.test(part) &&
      result.some((existing) => existing.includes(part))
    )
      continue;
    // Also normalize legacy labels with the badge placed before the full quality name.
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const previous = result[index]!;
      if (/^(?:高码率|高帧率|\d+帧)$/u.test(previous) && part.includes(previous))
        result.splice(index, 1);
    }
    result.push(part);
  }
  return result.join(' · ');
}
