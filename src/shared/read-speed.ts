/** Short rolling window. Retries reset the samples; unknown is not zero speed. */
export class ReadSpeedWindow {
  private samples: Array<{ time: number; bytes: number }> = [];
  sample(bytes: number, time = Date.now()): number | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    const last = this.samples.at(-1);
    if (last && (bytes < last.bytes || time < last.time)) this.samples = [];
    if (this.samples.at(-1)?.time !== time) this.samples.push({ time, bytes });
    while (this.samples.length > 2 && this.samples[1]!.time < time - 3000) this.samples.shift();
    const first = this.samples[0]!;
    if (time - first.time < 500) return null;
    return Math.max(0, Math.round(((bytes - first.bytes) * 1000) / (time - first.time)));
  }
}
