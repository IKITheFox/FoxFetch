import { t as uiText } from '../shared/i18n';
/** Only control messages cross the frame boundary; preferences stay in the extension frame. */
export async function mountSettingsFrame(
  container: HTMLElement,
  options: {
    token: string;
    section?: 'permissions';
    fallback?: boolean;
    onClose: () => void;
    onDrag?: (dx: number, dy: number) => void;
  },
) {
  const root = container.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.title = uiText('E0399');
  frame.style.cssText = 'display:block;border:0;width:100%;height:100%;color-scheme:normal';
  const url = new URL(chrome.runtime.getURL('settings-float.html'));
  url.searchParams.set('token', options.token);
  if (options.section) url.hash = options.section;
  if (options.fallback) url.searchParams.set('fallback', '1');
  frame.src = url.href;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => rejectReady(new Error(uiText('E1555'))), 10000);
  const listener = (event: MessageEvent) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== new URL(chrome.runtime.getURL('/')).origin
    )
      return;
    const message = event.data;
    if (message?.type === 'FOXF_SETTINGS_READY') {
      clearTimeout(timer);
      resolveReady();
    }
    if (message?.type === 'FOXF_SETTINGS_CLOSED') options.onClose();
    if (
      message?.type === 'FOXF_SETTINGS_DRAG' &&
      Number.isFinite(message.dx) &&
      Number.isFinite(message.dy)
    )
      options.onDrag?.(
        Math.max(-2000, Math.min(2000, message.dx)),
        Math.max(-2000, Math.min(2000, message.dy)),
      );
  };
  window.addEventListener('message', listener);
  root.append(frame);
  return {
    ready,
    section: () =>
      frame.contentWindow?.postMessage({ type: 'FOXF_SETTINGS_PERMISSIONS' }, new URL(url).origin),
    close: () =>
      frame.contentWindow?.postMessage({ type: 'FOXF_SETTINGS_CLOSE' }, new URL(url).origin),
    dispose: () => {
      clearTimeout(timer);
      window.removeEventListener('message', listener);
      container.remove();
    },
  };
}

let overlay: Awaited<ReturnType<typeof mountSettingsFrame>> | undefined;
let opening: Promise<void> | undefined;
/** Extension popup/resource-center host. Underlying React tree remains mounted. */
export function openLocalSettings(section?: 'permissions', fallback = false): Promise<void> {
  if (overlay) {
    if (section) overlay.section();
    return overlay.ready;
  }
  if (opening) return opening;
  opening = (async () => {
    const result = await chrome.runtime.sendMessage({ type: 'ISSUE_SETTINGS_FRAME' });
    if (!result?.ok) throw new Error(uiText('E1556'));
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;z-index:2147483647;left:max(10px,calc(50% - 205px));top:5vh;width:min(410px,calc(100vw - 20px));height:85vh;border:1px solid #45454d;border-radius:20px;overflow:hidden;box-shadow:0 18px 60px #0006;background:#0b0c10';
    document.body.append(container);
    const previousFocus = document.activeElement as HTMLElement | null;
    const clamp = (dx = 0, dy = 0) => {
      const rect = container.getBoundingClientRect();
      container.style.left = `${Math.max(0, Math.min(innerWidth - rect.width, rect.left + dx))}px`;
      container.style.top = `${Math.max(0, Math.min(innerHeight - rect.height, rect.top + dy))}px`;
    };
    const resize = () => clamp();
    const close = () => {
      window.removeEventListener('resize', resize);
      overlay?.dispose();
      overlay = undefined;
      previousFocus?.focus();
    };
    overlay = await mountSettingsFrame(container, {
      token: result.data,
      fallback,
      ...(section ? { section } : {}),
      onClose: close,
      onDrag: clamp,
    });
    window.addEventListener('resize', resize);
    try {
      await overlay.ready;
    } catch (error) {
      close();
      throw error;
    }
  })().finally(() => {
    opening = undefined;
  });
  return opening;
}
