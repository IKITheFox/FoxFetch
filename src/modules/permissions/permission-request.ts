import type { PermissionIntent } from './pending-intents';

export interface PermissionIntentClient<TIntent extends PermissionIntent, TResult> {
  stage(intent: TIntent): Promise<unknown>;
  commit(intentId: string): Promise<TResult>;
  cancel(intentId: string): Promise<void>;
}

export interface PermissionRequestApi {
  request(permissions: chrome.permissions.Permissions): Promise<boolean>;
  contains?(permissions: chrome.permissions.Permissions): Promise<boolean>;
}

export interface RunPermissionIntentOptions {
  deniedMessage?: string;
  permissionsApi?: PermissionRequestApi;
}

export function createPermissionIntent<TAction>(
  action: TAction,
  permissions?: chrome.permissions.Permissions,
): PermissionIntent<TAction> {
  return {
    id:
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `permission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    action,
    createdAt: Date.now(),
    ...(permissions ? { permissions } : {}),
  };
}

/** Convert selected media URLs to the narrowest runtime host match patterns. */
export function permissionOriginsForUrls(urls: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('媒体来源权限只支持 http/https URL');
    }
    origins.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...origins].sort();
}

export async function hasPermissionIntentAccess(
  intent: PermissionIntent,
  permissionsApi: Pick<PermissionRequestApi, 'contains'> = chrome.permissions,
): Promise<boolean> {
  if (!intent.permissions) return true;
  if (!permissionsApi.contains) return false;
  return permissionsApi.contains(intent.permissions).catch(() => false);
}

/**
 * Stage an operation and begin Chrome's prompt in the same synchronous click
 * turn. Calling code must not await a contains() check before this function.
 */
export async function runPermissionIntent<TIntent extends PermissionIntent, TResult>(
  intent: TIntent,
  permissions: chrome.permissions.Permissions,
  client: PermissionIntentClient<TIntent, TResult>,
  options: RunPermissionIntentOptions = {},
): Promise<TResult> {
  const api = options.permissionsApi ?? chrome.permissions;
  const persistedIntent = { ...intent, permissions } as TIntent;
  const staged = client.stage(persistedIntent);
  let requested: Promise<boolean>;
  try {
    requested = api.request(permissions);
  } catch (error) {
    void staged.then(
      () => client.cancel(intent.id).catch(() => undefined),
      () => undefined,
    );
    throw error;
  }

  let permissionGranted = false;
  try {
    const [, granted] = await Promise.all([staged, requested]);
    if (!granted) {
      throw new Error(options.deniedMessage ?? '未获得所选媒体来源权限，无法开始下载');
    }
    permissionGranted = true;
    return await client.commit(intent.id);
  } catch (error) {
    void requested.catch(() => undefined);
    // A granted operation may already have completed through permissions.onAdded.
    // Do not turn its persisted completed/failed result into a cancellation.
    if (!permissionGranted) await client.cancel(intent.id).catch(() => undefined);
    throw error;
  }
}
