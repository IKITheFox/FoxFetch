import type { ApiResponse, MediaAsset } from '../../shared/types';

export async function loadInlineImage(
  tabId: number,
  pageUrl: string,
  asset: MediaAsset,
  preview: boolean,
): Promise<string> {
  const ref = asset.inlineImage;
  if (!ref?.token || asset.kind !== 'image') throw new Error('图片需要重新扫描。');
  const tab = await chrome.tabs.get(tabId);
  if (tab.url !== pageUrl) throw new Error('页面已变化，请重新扫描。');
  const response = (await chrome.tabs.sendMessage(
    tabId,
    {
      type: 'AGENT_READ_INLINE_IMAGE',
      token: ref.token,
      pageUrl: ref.pageUrl,
      preview,
    },
    { frameId: asset.frameId },
  )) as ApiResponse<string>;
  if (!(response.ok && typeof response.data === 'string' && /^data:image\//i.test(response.data))) {
    throw new Error('无法读取原页面图片，请重新扫描。');
  }
  if (preview && response.data.length > 128 * 1024) throw new Error('缩略图过大。');
  if ((await chrome.tabs.get(tabId)).url !== pageUrl) throw new Error('页面已变化，请重新扫描。');
  return response.data;
}
