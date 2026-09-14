import { budgetedSessionStorage } from '../storage/session-budget';
import { BlobCaptureSessionRegistry, type BlobCaptureSession } from './capture-session';

const CAPTURE_SESSIONS_KEY = 'foxfetch:source-capture-sessions';

let registryPromise: Promise<BlobCaptureSessionRegistry> | undefined;
let mutationTail: Promise<void> = Promise.resolve();

async function loadRegistry(): Promise<BlobCaptureSessionRegistry> {
  const registry = new BlobCaptureSessionRegistry();
  const stored = await budgetedSessionStorage.get(CAPTURE_SESSIONS_KEY);
  const snapshots = stored[CAPTURE_SESSIONS_KEY];
  if (!Array.isArray(snapshots)) return registry;

  for (const snapshot of snapshots) {
    try {
      registry.restore(snapshot as BlobCaptureSession);
    } catch {
      // Ignore damaged or obsolete session snapshots. They never leave this device.
    }
  }
  registry.pruneExpired();
  return registry;
}

async function registry(): Promise<BlobCaptureSessionRegistry> {
  registryPromise ??= loadRegistry().catch((error) => {
    registryPromise = undefined;
    throw error;
  });
  return registryPromise;
}

async function persist(value: BlobCaptureSessionRegistry): Promise<void> {
  await budgetedSessionStorage.set({ [CAPTURE_SESSIONS_KEY]: value.list() });
}

export async function readCaptureSessions(): Promise<BlobCaptureSession[]> {
  const value = await registry();
  value.pruneExpired();
  return value.list();
}

export async function readCaptureSessionForTab(
  tabId: number,
): Promise<BlobCaptureSession | undefined> {
  const sessions = await readCaptureSessions();
  return sessions.find((session) => session.binding.tabId === tabId);
}

export function mutateCaptureSessions<T>(
  operation: (value: BlobCaptureSessionRegistry) => T | Promise<T>,
): Promise<T> {
  const result = mutationTail.then(async () => {
    const value = await registry();
    value.pruneExpired();
    const output = await operation(value);
    try {
      await persist(value);
    } catch (error) {
      // Discard uncommitted mutations; reload the last durable state on retry.
      registryPromise = undefined;
      throw error;
    }
    return output;
  });
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function removeCaptureSessionsForTab(tabId: number): Promise<void> {
  await mutateCaptureSessions((value) => {
    for (const session of value.list()) {
      if (session.binding.tabId === tabId) value.remove(session.id);
    }
  });
}
