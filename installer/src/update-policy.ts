export const UPDATE_RECHECK_INTERVAL_MS = 15 * 60 * 1_000;
export const CONTENT_RECHECK_INTERVAL_MS = 15 * 60 * 1_000;

export function shouldCheckForUpdates(
  lastCheckedAt: number | null,
  now: number,
): boolean {
  if (lastCheckedAt === null || now < lastCheckedAt) return true;
  return now - lastCheckedAt >= UPDATE_RECHECK_INTERVAL_MS;
}

export function shouldCheckForContentUpdates(
  lastCheckedAt: number | null,
  now: number,
): boolean {
  if (lastCheckedAt === null || now < lastCheckedAt) return true;
  return now - lastCheckedAt >= CONTENT_RECHECK_INTERVAL_MS;
}
