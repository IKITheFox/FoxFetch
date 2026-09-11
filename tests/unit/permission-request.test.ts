import { describe, expect, it, vi } from 'vitest';

import {
  createPermissionIntent,
  hasPermissionIntentAccess,
  permissionOriginsForUrls,
  runPermissionIntent,
} from '../../src/modules/permissions/permission-request';

describe('generic permission request continuation', () => {
  it('starts staging and the native request before yielding, then commits', async () => {
    let settleStage: (() => void) | undefined;
    let settleRequest: ((granted: boolean) => void) | undefined;
    const stage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleStage = resolve;
        }),
    );
    const request = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleRequest = resolve;
        }),
    );
    const intent = createPermissionIntent({ kind: 'download-assets', assetIds: ['one'] });
    const commit = vi.fn(async () => 'started');
    const pending = runPermissionIntent(
      intent,
      { origins: ['https://cdn.example/*'] },
      { stage, commit, cancel: vi.fn(async () => undefined) },
      { permissionsApi: { request } },
    );

    expect(stage).toHaveBeenCalledOnce();
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { origins: ['https://cdn.example/*'] } }),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    settleStage?.();
    settleRequest?.(true);

    await expect(pending).resolves.toBe('started');
    expect(commit).toHaveBeenCalledWith(intent.id);
  });

  it('cancels a staged operation when permission is denied', async () => {
    const cancel = vi.fn(async () => undefined);
    const intent = createPermissionIntent({ kind: 'capture-source' });

    await expect(
      runPermissionIntent(
        intent,
        { origins: ['https://cdn.example/*'] },
        { stage: vi.fn(async () => undefined), commit: vi.fn(), cancel },
        { permissionsApi: { request: vi.fn(async () => false) } },
      ),
    ).rejects.toThrow('未获得所选媒体来源权限');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('waits for staging before cancelling when the native request throws synchronously', async () => {
    let settleStage: (() => void) | undefined;
    const stage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleStage = resolve;
        }),
    );
    const cancel = vi.fn(async () => undefined);
    const intent = createPermissionIntent({ kind: 'download-assets' });

    await expect(
      runPermissionIntent(
        intent,
        { origins: ['https://cdn.example/*'] },
        { stage, commit: vi.fn(), cancel },
        {
          permissionsApi: {
            request: vi.fn(() => {
              throw new Error('user gesture unavailable');
            }),
          },
        },
      ),
    ).rejects.toThrow('user gesture unavailable');
    expect(cancel).not.toHaveBeenCalled();
    settleStage?.();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(intent.id));
  });

  it('deduplicates selected CDN origins and rejects non-network URLs', () => {
    expect(
      permissionOriginsForUrls([
        'https://cdn.example:8443/video?id=1',
        'https://cdn.example/audio?id=2',
        'http://media.example/track',
      ]),
    ).toEqual(['http://media.example/*', 'https://cdn.example/*']);
    expect(() => permissionOriginsForUrls(['blob:https://example.com/id'])).toThrow(
      '只支持 http/https',
    );
  });

  it('restores the exact permission bundle stored with a pending intent', async () => {
    const contains = vi.fn(async () => true);
    const permissions = { origins: ['https://cdn.example/*'] };
    const intent = createPermissionIntent({ kind: 'download-assets' }, permissions);

    await expect(hasPermissionIntentAccess(intent, { contains })).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith(permissions);
    await expect(
      hasPermissionIntentAccess(createPermissionIntent({ kind: 'no-permission' }), { contains }),
    ).resolves.toBe(true);
    expect(contains).toHaveBeenCalledOnce();
  });
});
