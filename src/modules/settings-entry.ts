import { issueSettingsFrame } from './settings-frame-session';

/** Route to an explicit page; the caller owns an extension-local fallback. */
export async function openSettingsPage(
  section?: 'permissions',
  tabId?: number,
  dispatch?: (tabId: number, token: string, section?: 'permissions') => Promise<unknown>,
): Promise<{ opened: boolean }> {
  if (tabId === undefined || !dispatch) return { opened: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (
      !tab.url ||
      !/^https?:\/\//.test(tab.url) ||
      /^https:\/\/chromewebstore.google.com\//.test(tab.url)
    )
      return { opened: false };
    const result = (await dispatch(tabId, await issueSettingsFrame(tabId), section)) as {
      ok?: boolean;
    };
    return { opened: result?.ok === true };
  } catch {
    return { opened: false };
  }
}
