import { siteMediaRouteKey } from '../detector/site-media';

export type VideoNavigationDirection = 'previous' | 'next';
export type VideoNavigationIssue =
  | 'unsupported-page'
  | 'initializing'
  | 'no-ordered-list'
  | 'unrecognized-structure'
  | 'boundary'
  | 'pending'
  | 'stale-control'
  | 'unexpected-destination'
  | 'unconfirmed'
  | 'rejected';

export interface VideoNavigationResult {
  applied: boolean;
  reason?: string;
  code?: VideoNavigationIssue;
}

interface NavigationCandidate {
  element: HTMLElement;
  expectedRoute?: string;
}

interface CandidateResult {
  candidate?: NavigationCandidate;
  reason?: string;
  code?: VideoNavigationIssue;
}

const NAVIGATION_TIMEOUT_MS = 2_000;
const inFlight = new WeakSet<Document>();
const PLAYER_ROOTS = '#bilibili-player, .bpx-player-container, .bilibili-player';
const NATIVE_CONTROLS: Record<VideoNavigationDirection, string> = {
  previous: '.bpx-player-ctrl-prev, .bilibili-player-video-btn-prev',
  next: '.bpx-player-ctrl-next, .bilibili-player-video-btn-next',
};

// Only explicit multipart / collection lists are eligible. In particular,
// `.recommend-list`, generic anchors and other HTMLMediaElements are not.
const ORDERED_LISTS = [
  { root: '.multi-page .cur-list', item: 'li' },
  { root: '.video-pod__list', item: '.video-pod__item' },
  { root: '.video-sections-content-list', item: '.video-episode-card' },
  // Only real links in an explicitly nested multipart list are eligible. These
  // are additionally checked for one BVID and consecutive part numbers below.
  { root: '.video-pod__item .multi-p ul, .video-pod__item .multi-p ol', item: 'li' },
] as const;
const LIST_ROOTS = ORDERED_LISTS.map(({ root }) => root).join(', ');
const UNRELATED_AREAS = '.recommend-list, .rec-list, .bpx-player-ending-related, [data-ad]';
const ACTIVE_ITEM = '.on, .active, .playing, [aria-current="true"], [aria-current="page"]';

function issue(code: VideoNavigationIssue, reason: string): CandidateResult {
  return { code, reason };
}

function boundary(direction: VideoNavigationDirection): CandidateResult {
  return issue(
    'boundary',
    direction === 'next' ? '已经是列表中的最后一个视频。' : '已经是列表中的第一个视频。',
  );
}

function unrecognized(): CandidateResult {
  return issue(
    'unrecognized-structure',
    '当前页面的切换入口或列表顺序尚未确认，请使用网页原生控件。',
  );
}

function isBilibiliVideoPage(doc: Document): boolean {
  try {
    const url = new URL(doc.URL);
    return (
      (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')) &&
      /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)(?:\/|$)/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isRendered(element: HTMLElement, doc: Document): boolean {
  if (
    !element.isConnected ||
    element.closest(
      ':disabled, [disabled], [aria-disabled="true"], .disabled, .bpx-state-disabled',
    ) ||
    element.closest('[hidden], [inert], [aria-hidden="true"]') ||
    element.closest(UNRELATED_AREAS)
  )
    return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = doc.defaultView?.getComputedStyle(current);
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    )
      return false;
  }
  return true;
}

function isUsable(element: HTMLElement, doc: Document): boolean {
  if (!isRendered(element, doc)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function videoLinkRoute(element: HTMLElement, doc: Document): string | undefined {
  const link = element.matches('a[href]')
    ? (element as HTMLAnchorElement)
    : element.querySelector<HTMLAnchorElement>('a[href]');
  if (!link) return undefined;
  try {
    const target = new URL(link.getAttribute('href') ?? '', doc.URL);
    if (
      !['https:', 'http:'].includes(target.protocol) ||
      (target.hostname !== 'bilibili.com' && !target.hostname.endsWith('.bilibili.com')) ||
      !/^\/video\/(?:BV[0-9A-Za-z]+|av\d+)(?:\/|$)/u.test(target.pathname)
    )
      return undefined;
    return navigationRoute(target.href);
  } catch {
    return undefined;
  }
}

function navigationRoute(url: string): string {
  // Part links usually omit CID, even when the current player URL has one.
  // BVID + part is sufficient to verify their explicitly ordered destination.
  const target = new URL(url);
  target.searchParams.delete('cid');
  return siteMediaRouteKey(target.href);
}

function findLinkedListCandidate(
  doc: Document,
  direction: VideoNavigationDirection,
): CandidateResult {
  const currentRoute = navigationRoute(doc.URL);
  const matches: Array<{ list: HTMLElement; result: CandidateResult }> = [];
  for (const descriptor of ORDERED_LISTS) {
    for (const list of doc.querySelectorAll<HTMLElement>(descriptor.root)) {
      if (!isRendered(list, doc)) continue;
      // Nested lists own their rows, active markers and links. An outer episode
      // must not inherit an inner P's marker or jump past its remaining parts.
      const items = [...list.querySelectorAll<HTMLElement>(descriptor.item)].filter(
        (item) => item.closest(LIST_ROOTS) === list,
      );
      const active = items.filter(
        (item) =>
          item.matches(ACTIVE_ITEM) ||
          [...item.querySelectorAll(ACTIVE_ITEM)].some(
            (marker) => marker.closest(LIST_ROOTS) === list,
          ),
      );
      if (active.length !== 1) continue;
      const selected = active[0]!;
      const links = items.map((item) => {
        const own = [...item.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(
          (link) => link.closest(LIST_ROOTS) === list && link.closest(descriptor.item) === item,
        );
        return own.length === 1 ? own[0] : undefined;
      });
      const selectedIndex = items.indexOf(selected);
      const selectedLink = links[selectedIndex];
      if (!selectedLink || videoLinkRoute(selectedLink, doc) !== currentRoute) continue;
      if (list.matches('.multi-p ul, .multi-p ol')) {
        const current = new URL(doc.URL);
        const parts = links.map((link) => {
          if (!link || !videoLinkRoute(link, doc)) return undefined;
          const url = new URL(link.getAttribute('href')!, doc.URL);
          const rawPart = url.searchParams.get('p') ?? '1';
          if (
            url.pathname.replace(/\/$/u, '') !== current.pathname.replace(/\/$/u, '') ||
            !/^[1-9]\d*$/u.test(rawPart)
          )
            return undefined;
          const part = Number(rawPart);
          return Number.isSafeInteger(part) ? part : undefined;
        });
        const step = parts.length > 1 ? (parts[1] ?? 0) - (parts[0] ?? 0) : 1;
        if (
          Math.abs(step) !== 1 ||
          parts.some(
            (part, index) => part == null || (index > 0 && part - parts[index - 1]! !== step),
          )
        ) {
          matches.push({ list, result: unrecognized() });
          continue;
        }
      }
      if (selected.querySelector('.multi-p')) {
        matches.push({ list, result: unrecognized() });
        continue;
      }
      const targetIndex = selectedIndex + (direction === 'next' ? 1 : -1);
      const target = items[targetIndex];
      const link = links[targetIndex];
      const expectedRoute = link && videoLinkRoute(link, doc);
      matches.push({
        list,
        result: !target
          ? boundary(direction)
          : link && expectedRoute && expectedRoute !== currentRoute && isUsable(link, doc)
            ? { candidate: { element: link, expectedRoute } }
            : unrecognized(),
      });
    }
  }
  const deepest = matches.filter(
    ({ list }) => !matches.some((other) => other.list !== list && list.contains(other.list)),
  );
  return deepest.length === 1 ? deepest[0]!.result : deepest.length > 1 ? unrecognized() : {};
}

function findObservedVideoPodCandidate(
  doc: Document,
  direction: VideoNavigationDirection,
): CandidateResult {
  // The live collection UI uses div click handlers, not links: the active
  // marker is on `.simple-base-item` inside its row. Restrict this fallback to
  // that observed, explicit collection structure; never infer a recommendation
  // or turn a title/data attribute/API record into a navigation URL.
  const lists = [...doc.querySelectorAll<HTMLElement>('.video-pod .video-pod__list')].filter(
    (list) => isUsable(list, doc),
  );
  if (lists.length !== 1) return {};
  const list = lists[0]!;
  const rows = [...list.querySelectorAll<HTMLElement>('.video-pod__item')].filter(
    (row) => row.closest('.video-pod__list') === list,
  );
  const activeRows = rows.filter(
    (row) => row.matches(ACTIVE_ITEM) || row.querySelector(ACTIVE_ITEM),
  );
  if (activeRows.length !== 1) return {};
  const selected = activeRows[0]!;
  const action = (row: HTMLElement): HTMLElement | null => {
    // A multi-P header expands a subsection; it is not a video selection.
    // Leave unfamiliar/multipart div variants unavailable instead of clicking
    // a toggle or skipping to another episode across an unknown order.
    if (row.querySelector('a[href]')) return null;
    return row.querySelector<HTMLElement>(':scope > .single-p > .simple-base-item.normal');
  };
  const selectedAction = action(selected);
  if (!selectedAction || !isUsable(selectedAction, doc)) return {};
  // The collection can be server-rendered before the site's click bindings
  // and main player are ready. A visible div is not proof of an active action.
  // Native player controls and ordinary verified links are handled above;
  // only this div-only fallback needs the explicit readiness guard.
  const readyMainPlayer = [...doc.querySelectorAll<HTMLVideoElement>('video')].some((video) => {
    if (
      !video.closest(PLAYER_ROOTS) ||
      !isUsable(video, doc) ||
      video.readyState < 2 ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      return false;
    for (let current: HTMLElement | null = video; current; current = current.parentElement) {
      if (doc.defaultView?.getComputedStyle(current).opacity === '0') return false;
    }
    return true;
  });
  if (doc.readyState !== 'complete' || !readyMainPlayer)
    return issue('initializing', '页面播放器仍在初始化，请稍候再切换视频。');
  const target = rows[rows.indexOf(selected) + (direction === 'next' ? 1 : -1)];
  if (!target) return boundary(direction);
  const targetAction = action(target);
  return targetAction && isUsable(targetAction, doc)
    ? { candidate: { element: targetAction } }
    : {};
}

function findCandidate(doc: Document, direction: VideoNavigationDirection): CandidateResult {
  if (!isBilibiliVideoPage(doc)) {
    return issue('unsupported-page', '此站点或页面尚无可靠的上一／下一视频导航支持。');
  }
  const controls = new Set<HTMLElement>();
  for (const player of doc.querySelectorAll(PLAYER_ROOTS)) {
    for (const control of player.querySelectorAll<HTMLElement>(NATIVE_CONTROLS[direction])) {
      if (isUsable(control, doc)) controls.add(control);
    }
  }
  if (controls.size > 1) return unrecognized();
  if (controls.size === 1) {
    const expectedRoute = findLinkedListCandidate(doc, direction).candidate?.expectedRoute;
    return {
      candidate: { element: [...controls][0]!, ...(expectedRoute ? { expectedRoute } : {}) },
    };
  }
  const linkedList = findLinkedListCandidate(doc, direction);
  if (linkedList.candidate || linkedList.reason) return linkedList;
  const observedPod = findObservedVideoPodCandidate(doc, direction);
  if (observedPod.candidate || observedPod.reason) return observedPod;
  const mainMediaPending = [...doc.querySelectorAll<HTMLVideoElement>('video')].some(
    (video) => video.closest(PLAYER_ROOTS) && isUsable(video, doc) && video.readyState < 2,
  );
  if (doc.readyState !== 'complete' || mainMediaPending)
    return issue('initializing', '页面仍在初始化，正在识别视频切换入口，请稍候再试。');
  if (doc.querySelector('.multi-page, .video-pod, .video-pod__list, .video-sections-content-list'))
    return unrecognized();
  return issue(
    'no-ordered-list',
    '当前页面没有可确认顺序的分 P／合集列表；仍可单击跳转 15 秒或长按调节。',
  );
}

export function inspectVideoNavigation(
  doc: Document,
  direction: VideoNavigationDirection,
): { available: boolean; reason?: string; code?: VideoNavigationIssue } {
  if (inFlight.has(doc))
    return { available: false, code: 'pending', reason: '正在切换视频，请稍候。' };
  const result = findCandidate(doc, direction);
  return result.candidate
    ? { available: true }
    : {
        available: false,
        code: result.code ?? 'unrecognized-structure',
        reason: result.reason ?? '没有可靠的视频切换入口。',
      };
}

/** Click one verified site control; never cycle DOM media or guess a recommendation. */
export async function navigateVideo(
  doc: Document,
  direction: VideoNavigationDirection,
  beforeNavigate?: (expectedRoute?: string) => void,
): Promise<VideoNavigationResult> {
  if (inFlight.has(doc))
    return { applied: false, code: 'pending', reason: '正在切换视频，请稍候。' };
  const { candidate, reason, code } = findCandidate(doc, direction);
  if (!candidate)
    return {
      applied: false,
      code: code ?? 'unrecognized-structure',
      reason: reason ?? '没有可靠的视频切换入口。',
    };
  const view = doc.defaultView;
  if (!view || !isUsable(candidate.element, doc))
    return { applied: false, code: 'stale-control', reason: '视频切换入口已失效，请重试。' };
  const originalRoute = navigationRoute(doc.URL);
  inFlight.add(doc);
  try {
    beforeNavigate?.(candidate.expectedRoute);
    candidate.element.click();
    // click() alone is not proof that a site accepted the operation. Observe
    // the identity-bearing route (BVID/part), not tracking or a CID refresh.
    const startedAt = view.performance.now();
    while (view.performance.now() - startedAt < NAVIGATION_TIMEOUT_MS) {
      const route = navigationRoute(doc.URL);
      if (route !== originalRoute) {
        return !isBilibiliVideoPage(doc) ||
          (candidate.expectedRoute && route !== candidate.expectedRoute)
          ? {
              applied: false,
              code: 'unexpected-destination',
              reason: '页面切换到了其他视频，已停止继续导航。',
            }
          : { applied: true };
      }
      await new Promise<void>((resolve) => view.setTimeout(resolve, 50));
    }
    return {
      applied: false,
      code: 'unconfirmed',
      reason: '已触发页面切换入口，但尚未确认视频切换；请使用网页原生按钮。',
    };
  } catch {
    return {
      applied: false,
      code: 'rejected',
      reason: '网页未接受视频切换操作，请使用网页原生按钮。',
    };
  } finally {
    inFlight.delete(doc);
  }
}
