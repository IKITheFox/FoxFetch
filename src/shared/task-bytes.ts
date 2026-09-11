/** Display only; diagnostic payloads keep their original integer byte counts. */
export function formatTaskBytes(bytes: number | undefined): string {
  if (!Number.isSafeInteger(bytes) || bytes! < 0) return '大小未知';
  let value = bytes!;
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${Number(value.toFixed(index === 0 ? 0 : 1))} ${units[index]}`;
}

export function reliableTaskTotal(read: number, total: number | null | undefined): number | null {
  return Number.isSafeInteger(read) &&
    read >= 0 &&
    Number.isSafeInteger(total) &&
    total! > 0 &&
    read <= total!
    ? total!
    : null;
}
