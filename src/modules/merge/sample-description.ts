/** stsc entries refer to one-based stsd descriptions, not their textual order. */
export function activeSampleDescriptions(entryCount: number, stsc?: Uint8Array): Set<number> {
  if (!Number.isInteger(entryCount) || entryCount <= 0 || entryCount > 1024)
    throw new Error('Invalid stsd entry count.');
  if (!stsc) return new Set(Array.from({ length: entryCount }, (_, index) => index + 1));
  if (stsc.length < 8) throw new Error('Truncated stsc.');
  const view = new DataView(stsc.buffer, stsc.byteOffset, stsc.byteLength);
  const count = view.getUint32(4);
  if (count > 65535 || stsc.length !== 8 + count * 12 || view.getUint32(0) !== 0)
    throw new Error('Invalid stsc table.');
  if (count === 0) return new Set(Array.from({ length: entryCount }, (_, index) => index + 1));
  const result = new Set<number>();
  let previousChunk = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 12;
    const chunk = view.getUint32(offset);
    const samples = view.getUint32(offset + 4);
    const description = view.getUint32(offset + 8);
    if (
      (index === 0 && chunk !== 1) ||
      chunk <= previousChunk ||
      samples === 0 ||
      description === 0 ||
      description > entryCount
    )
      throw new Error('Invalid stsc sample description.');
    result.add(description);
    previousChunk = chunk;
  }
  return result;
}
