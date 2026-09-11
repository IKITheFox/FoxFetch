/** Background-only registry. Tokens live inside closed shadow roots, never page messages. */
interface SettingsSession {
  tabId?: number;
  documentId?: string;
  issued: number;
}
const sessions = new Map<string, SettingsSession>();
export async function issueSettingsFrame(tabId?: number): Promise<string> {
  for (const [key, entry] of sessions)
    if (Date.now() - entry.issued > (entry.documentId ? 12 * 60 * 60 * 1000 : 30000)) {
      sessions.delete(key);
      await chrome.storage.session.remove(`foxfetch:settings-frame:${key}`);
    }
  if (sessions.size >= 128) throw new Error('设置窗口过多，请关闭不使用的窗口。');
  const token = crypto.randomUUID();
  const entry = { ...(tabId !== undefined ? { tabId } : {}), issued: Date.now() };
  sessions.set(token, entry);
  await chrome.storage.session.set({ [`foxfetch:settings-frame:${token}`]: entry });
  return token;
}
export async function verifySettingsFrame(sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.documentId) return false;
  const url = new URL(sender.url);
  if (
    `${url.protocol}//${url.host}${url.pathname}` !== chrome.runtime.getURL('settings-float.html')
  )
    return false;
  const token = url.searchParams.get('token') ?? '';
  if (!/^[\da-f-]{36}$/i.test(token)) return false;
  const key = `foxfetch:settings-frame:${token}`;
  const session =
    sessions.get(token) ??
    ((await chrome.storage.session.get(key))[key] as SettingsSession | undefined);
  if (!session || session.tabId !== sender.tab?.id) return false;
  if (Date.now() - session.issued > 12 * 60 * 60 * 1000) return false;
  if (session.documentId) return session.documentId === sender.documentId;
  if (Date.now() - session.issued > 30_000) return false;
  session.documentId = sender.documentId;
  sessions.set(token, session);
  await chrome.storage.session.set({ [key]: session });
  return true;
}

export async function releaseSettingsFrame(sender: chrome.runtime.MessageSender): Promise<void> {
  if (!(await verifySettingsFrame(sender))) return;
  const token = new URL(sender.url!).searchParams.get('token')!;
  sessions.delete(token);
  await chrome.storage.session.remove(`foxfetch:settings-frame:${token}`);
}
