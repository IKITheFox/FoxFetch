/** Observation budget only; this never retries a download or changes fixture timing. */
export function acceptanceWait(value = process.env.FOXFETCH_ACCEPTANCE_WAIT_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 90000 ? Math.min(parsed, 120000) : 90000;
}
export const acceptanceStepMs = acceptanceWait();
export const acceptanceCaseMs = acceptanceStepMs * 3;
