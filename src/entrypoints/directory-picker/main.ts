import { t as uiText } from '../../shared/i18n';
import '../../styles/scrollbars.css';
import {
  ExtensionDirectoryHandleStore,
  verifyDirectoryPermission,
  type FileSystemDirectoryHandleLike,
} from '../../modules/downloads/directory-handle-store';
import type { ApiResponse, MergeDirectoryPickerContext, MergeDockView } from '../../shared/types';
import { startDirectoryPickerTheme } from './theme';
import { installStaticTextSelectionGuard } from '../../modules/ui/static-text-selection';
import { getLastVideoDirectory } from '../../modules/jobs/path-policy';

const disposeStaticTextSelection = installStaticTextSelectionGuard(document);
window.addEventListener('pagehide', disposeStaticTextSelection, { once: true });

void startDirectoryPickerTheme().then((dispose) => {
  window.addEventListener('pagehide', dispose, { once: true });
});

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | 'downloads';
}

type PickerWindow = Window & {
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
};

const params = new URLSearchParams(location.search);
const sessionId = params.get('session') ?? '';
let platform = 'web';
let handleId = `merge-${platform}`;
const pendingHandleId = `pending-${sessionId}`;
const store = new ExtensionDirectoryHandleStore();

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing directory picker element: ${id}`);
  return found as T;
}

async function cancelAndClose(): Promise<void> {
  await send<null>({ type: 'CANCEL_MERGE_DIRECTORY_PICKER', sessionId }).catch(() => undefined);
  window.close();
}

const status = element<HTMLParagraphElement>('status');
const choose = element<HTMLButtonElement>('choose');
const defaultPath = element<HTMLElement>('default-path');
const customPath = element<HTMLElement>('custom-path');
defaultPath.textContent = `Downloads/FoxFetch/${platform}`;

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as ApiResponse<T> | undefined;
  if (!response?.ok) throw new Error(response?.error || uiText('E0325'));
  return response.data;
}

async function restoreCurrentDirectory(): Promise<FileSystemDirectoryHandleLike | undefined> {
  const last = await getLastVideoDirectory();
  const current = await store.get(last?.handleId ?? handleId).catch(() => undefined);
  if (!current) return undefined;
  customPath.textContent = uiText('E0326', { p1: current.metadata.name });
  return current.handle;
}

let currentHandle: FileSystemDirectoryHandleLike | undefined;
let contextReady = false;
let actionPending = false;
choose.disabled = true;
element<HTMLButtonElement>('use-default').disabled = true;

function setActionPending(pending: boolean): void {
  actionPending = pending;
  choose.disabled = !contextReady || pending;
  element<HTMLButtonElement>('use-default').disabled = !contextReady || pending;
}

void send<MergeDirectoryPickerContext>({ type: 'VERIFY_MERGE_DIRECTORY_PICKER', sessionId })
  .then(async (context) => {
    platform = context.platform;
    handleId = context.current?.handleId ?? `merge-${platform}`;
    defaultPath.textContent = context.defaultPath;
    currentHandle = await restoreCurrentDirectory();
    contextReady = true;
    setActionPending(false);
  })
  .catch((error: unknown) => {
    status.dataset.tone = 'error';
    status.textContent = error instanceof Error ? error.message : uiText('E0327');
  });

choose.addEventListener('click', async () => {
  if (!contextReady || actionPending) return;
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) {
    status.dataset.tone = 'error';
    status.textContent = uiText('E0328');
    return;
  }
  setActionPending(true);
  status.dataset.tone = 'working';
  status.textContent = uiText('E0329');
  try {
    const handle = await picker.call(window, {
      id: 'foxfetch-video',
      mode: 'readwrite',
      startIn: (currentHandle as FileSystemHandle | undefined) ?? 'downloads',
    });
    const permission = await verifyDirectoryPermission(
      handle as unknown as FileSystemDirectoryHandleLike,
      { request: true },
    );
    if (permission !== 'granted') {
      throw new DOMException(uiText('E0330'), 'NotAllowedError');
    }
    const record = await store.save(
      pendingHandleId,
      handle as unknown as FileSystemDirectoryHandleLike,
    );
    try {
      await send<MergeDockView>({
        type: 'SET_MERGE_DIRECTORY_TARGET',
        sessionId,
        mode: 'custom',
        directory: record.metadata,
      });
    } catch (error) {
      await store.remove(pendingHandleId).catch(() => undefined);
      throw error;
    }
    window.close();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      status.dataset.tone = '';
      status.textContent = uiText('E0331');
    } else {
      status.dataset.tone = 'error';
      status.textContent = error instanceof Error ? error.message : uiText('E0332');
    }
  } finally {
    setActionPending(false);
  }
});

element<HTMLButtonElement>('use-default').addEventListener('click', async () => {
  if (!contextReady || actionPending) return;
  setActionPending(true);
  status.dataset.tone = 'working';
  status.textContent = uiText('E0333');
  try {
    await send<MergeDockView>({
      type: 'SET_MERGE_DIRECTORY_TARGET',
      sessionId,
      mode: 'automatic',
    });
    window.close();
  } catch (error) {
    status.dataset.tone = 'error';
    status.textContent = error instanceof Error ? error.message : uiText('E0334');
  } finally {
    setActionPending(false);
  }
});
element<HTMLButtonElement>('close').addEventListener('click', () => {
  void cancelAndClose();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void cancelAndClose();
});
