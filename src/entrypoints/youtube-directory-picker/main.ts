import { t as uiText } from '../../shared/i18n';
import '../../styles/scrollbars.css';
import {
  ExtensionDirectoryHandleStore,
  verifyDirectoryPermission,
  type FileSystemDirectoryHandleLike,
} from '../../modules/downloads/directory-handle-store';
import { startDirectoryPickerTheme } from '../directory-picker/theme';
import type { ApiResponse } from '../../shared/types';
import { getLastVideoDirectory } from '../../modules/jobs/path-policy';

void startDirectoryPickerTheme().then((dispose) =>
  window.addEventListener('pagehide', dispose, { once: true }),
);
const nonce = new URLSearchParams(location.search).get('nonce') ?? '';
const choose = document.getElementById('choose') as HTMLButtonElement;
const status = document.getElementById('status')!;
const store = new ExtensionDirectoryHandleStore();
window.addEventListener(
  'pagehide',
  () => {
    void store.close();
  },
  { once: true },
);
let context: { sessionId: string; handleId: string } | undefined;
let pending = false;
let previousHandle: FileSystemDirectoryHandleLike | undefined;
async function send<T>(type: string): Promise<T> {
  const response = (await chrome.runtime.sendMessage({ type, nonce })) as
    ApiResponse<T> | undefined;
  if (!response?.ok) throw new Error(uiText('E0529'));
  return response.data;
}
void send<{ sessionId: string; handleId: string }>('VERIFY_YOUTUBE_DIRECTORY_PICKER')
  .then(async (value) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.sessionId,
      ) ||
      value.handleId !== `youtube-${value.sessionId}`
    )
      throw new Error(uiText('E0266'));
    context = value;
    const previous = await getLastVideoDirectory();
    previousHandle = previous ? (await store.get(previous.handleId))?.handle : undefined;
    if (previousHandle) status.textContent = uiText('E0530', { p1: previousHandle.name });
    choose.disabled = false;
    if (!previousHandle) status.textContent = uiText('E0531');
    if (previousHandle) {
      const reuse = document.createElement('button');
      reuse.textContent = uiText('E0532', { p1: previousHandle.name });
      choose.before(reuse);
      reuse.addEventListener('click', async () => {
        if (!context || pending || !previousHandle) return;
        pending = true;
        reuse.disabled = choose.disabled = true;
        try {
          if ((await verifyDirectoryPermission(previousHandle, { request: true })) !== 'granted')
            throw new Error(uiText('E0533'));
          await store.save(context.handleId, previousHandle);
          await send('CONFIRM_YOUTUBE_DIRECTORY_PICKER');
          window.close();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : uiText('E0534');
          pending = false;
          reuse.disabled = choose.disabled = false;
        }
      });
    }
  })
  .catch(() => {
    status.textContent = uiText('E0529');
  });

choose.addEventListener('click', async () => {
  if (!context || pending) return;
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options: {
        id: string;
        mode: 'readwrite';
        startIn: FileSystemHandle | 'downloads';
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) {
    status.textContent = uiText('E0535');
    return;
  }
  pending = true;
  choose.disabled = true;
  status.textContent = uiText('E0536');
  try {
    // Called directly from the user's click, before any asynchronous operation.
    const handle = await picker.call(window, {
      id: 'foxfetch-video',
      mode: 'readwrite',
      startIn: (previousHandle as FileSystemHandle | undefined) ?? 'downloads',
    });
    await store.save(context.handleId, handle as unknown as FileSystemDirectoryHandleLike);
    status.textContent = uiText('E0537');
    await send('CONFIRM_YOUTUBE_DIRECTORY_PICKER');
    window.close();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      status.textContent = uiText('E0538');
      pending = false;
      choose.disabled = false;
    } else {
      // Do not delete a handle after an ambiguous commit acknowledgement.
      status.textContent = uiText('E0539');
    }
  }
});
async function close() {
  await send('CANCEL_YOUTUBE_DIRECTORY_PICKER').catch(() => undefined);
  window.close();
}
document.getElementById('close')!.addEventListener('click', () => {
  void close();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void close();
});
