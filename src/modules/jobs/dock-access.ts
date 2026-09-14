import { budgetedSessionStorage } from '../storage/session-budget';
import type { MergeDockPhase, MergeDockView } from '../../shared/types';
import { normalizeMediaTitle } from '../../shared/media-title';
import { MERGE_DOWNLOAD_PROGRESS_END, MERGE_MUX_PROGRESS_END } from './progress';
import type { MergeJob } from './types';
import type { StorageAreaLike } from './store';
import { isMergeJobStopping } from './cancellation';
import { canRepeatMergeDownload } from './repeat-download';
import {
  publicConfigurationDiagnostic,
  publicNetworkDiagnostic,
  publicTimelineDiagnostic,
  publicSourceTimelineDiagnostic,
} from './public-diagnostics';

export const MERGE_DOCK_GRANT_PREFIX = 'foxfetch:merge-dock-grant:';
export const MERGE_DOCK_GRANT_TTL_MS = 6 * 60 * 60 * 1_000;

export type MergeDockGrantScope = 'action' | 'path';

export interface MergeDockGrant {
  token: string;
  scope: MergeDockGrantScope;
  jobId: string;
  tabId: number;
  pageUrl: string;
  mediaEpoch: number;
  issuedAt: number;
  expiresAt: number;
}

export interface MergeDockGrantPair {
  actionToken: string;
  pathToken: string;
}

export interface MergeDockGrantRequest {
  token: string;
  scope: MergeDockGrantScope;
  tabId: number;
  pageUrl: string;
}

export interface MergeDockPermissionMessageLike {
  type?: unknown;
  token?: unknown;
  action?: unknown;
}

export interface MergeDockPermissionSenderLike {
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
}

function key(token: string): string {
  return `${MERGE_DOCK_GRANT_PREFIX}${token}`;
}

function isGrant(value: unknown): value is MergeDockGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<MergeDockGrant>;
  return (
    typeof grant.token === 'string' &&
    (grant.scope === 'action' || grant.scope === 'path') &&
    typeof grant.jobId === 'string' &&
    Number.isInteger(grant.tabId) &&
    typeof grant.pageUrl === 'string' &&
    Number.isInteger(grant.mediaEpoch) &&
    typeof grant.issuedAt === 'number' &&
    typeof grant.expiresAt === 'number'
  );
}

function jobOwner(job: MergeJob): { tabId: number; pageUrl: string; mediaEpoch: number } {
  const tabId = job.ownerTabId;
  const pageUrl = job.ownerPageUrl ?? job.videoContext?.pageUrl ?? job.audioContext?.pageUrl;
  if (tabId == null || !pageUrl) throw new Error('合并任务缺少来源页面绑定');
  return { tabId, pageUrl, mediaEpoch: job.ownerMediaEpoch ?? 0 };
}

/**
 * Issues page-safe capabilities for a merge Dock. The job id and all source
 * metadata stay in extension storage and are recovered only after sender checks.
 */
export class MergeDockGrantBroker {
  private readonly issuedGrants = new Map<string, MergeDockGrant>();
  private readonly activeOwners = new Map<
    number,
    { jobId: string; pageUrl: string; mediaEpoch: number; permissionEligible: boolean }
  >();
  private readonly permissionClaims = new Set<string>();

  constructor(
    private readonly storage: StorageAreaLike = budgetedSessionStorage,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = () => crypto.randomUUID(),
  ) {}

  async getOrIssue(job: MergeJob): Promise<MergeDockGrantPair> {
    const owner = jobOwner(job);
    const permissionEligible =
      canRepeatMergeDownload(job) ||
      (job.cancellationRequestedAt == null &&
        (job.state === 'ready' ||
          job.state === 'permission_required' ||
          job.state === 'failed' ||
          canRepeatMergeDownload(job)));
    this.activateOwner(job.id, owner, permissionEligible);
    const grants = (await this.readAll()).filter(
      (grant) =>
        grant.jobId === job.id &&
        grant.tabId === owner.tabId &&
        grant.pageUrl === owner.pageUrl &&
        grant.mediaEpoch === owner.mediaEpoch &&
        grant.expiresAt > this.now(),
    );
    const action = grants.find((grant) => grant.scope === 'action');
    const path = grants.find((grant) => grant.scope === 'path');
    if (action && path) {
      this.issuedGrants.set(action.token, action);
      this.issuedGrants.set(path.token, path);
      return { actionToken: action.token, pathToken: path.token };
    }
    await this.clearJob(job.id);
    this.activateOwner(job.id, owner, permissionEligible);
    const issuedAt = this.now();
    const actionGrant = this.createGrant('action', job.id, owner, issuedAt);
    const pathGrant = this.createGrant('path', job.id, owner, issuedAt);
    await this.storage.set({
      [key(actionGrant.token)]: actionGrant,
      [key(pathGrant.token)]: pathGrant,
    });
    this.issuedGrants.set(actionGrant.token, actionGrant);
    this.issuedGrants.set(pathGrant.token, pathGrant);
    return { actionToken: actionGrant.token, pathToken: pathGrant.token };
  }

  /**
   * Synchronously claims a live action capability before opening Chrome's
   * optional-permission prompt. This check deliberately uses only grants that
   * this Service Worker issued or re-published; an arbitrary string from the
   * page must never be able to induce a browser permission prompt.
   */
  claimPermissionRequest(
    token: string,
    request: Pick<MergeDockGrantRequest, 'tabId' | 'pageUrl'>,
  ): boolean {
    const grant = this.issuedGrants.get(token);
    const owner = grant ? this.activeOwners.get(grant.tabId) : undefined;
    if (
      !grant ||
      !owner ||
      grant.scope !== 'action' ||
      grant.expiresAt <= this.now() ||
      this.permissionClaims.has(token) ||
      grant.tabId !== request.tabId ||
      grant.pageUrl !== request.pageUrl ||
      owner.jobId !== grant.jobId ||
      owner.pageUrl !== grant.pageUrl ||
      owner.mediaEpoch !== grant.mediaEpoch ||
      !owner.permissionEligible
    ) {
      if (grant?.expiresAt != null && grant.expiresAt <= this.now()) {
        this.issuedGrants.delete(token);
        this.permissionClaims.delete(token);
      }
      return false;
    }
    this.permissionClaims.add(token);
    return true;
  }

  releasePermissionClaim(token: string): void {
    this.permissionClaims.delete(token);
  }

  async authorize(request: MergeDockGrantRequest): Promise<MergeDockGrant> {
    const value = (await this.storage.get(key(request.token)))[key(request.token)];
    const grant = isGrant(value) ? value : undefined;
    if (!grant || grant.expiresAt <= this.now()) {
      throw new Error('合并操作已过期，请重新打开当前视频的下载面板');
    }
    if (
      grant.scope !== request.scope ||
      grant.tabId !== request.tabId ||
      grant.pageUrl !== request.pageUrl
    ) {
      throw new Error('合并操作与当前页面不匹配');
    }
    return { ...grant };
  }

  async clearJob(jobId: string): Promise<void> {
    for (const [token, grant] of this.issuedGrants) {
      if (grant.jobId !== jobId) continue;
      this.issuedGrants.delete(token);
      this.permissionClaims.delete(token);
    }
    for (const [tabId, owner] of this.activeOwners) {
      if (owner.jobId === jobId) this.activeOwners.delete(tabId);
    }
    const records = await this.storage.get(null);
    const removals = Object.entries(records)
      .filter(
        ([storageKey, value]) =>
          storageKey.startsWith(MERGE_DOCK_GRANT_PREFIX) && isGrant(value) && value.jobId === jobId,
      )
      .map(([storageKey]) => storageKey);
    if (removals.length > 0) await this.storage.remove(removals);
  }

  async clearTab(tabId: number): Promise<void> {
    this.activeOwners.delete(tabId);
    for (const [token, grant] of this.issuedGrants) {
      if (grant.tabId !== tabId) continue;
      this.issuedGrants.delete(token);
      this.permissionClaims.delete(token);
    }
    const records = await this.storage.get(null);
    const removals = Object.entries(records)
      .filter(
        ([storageKey, value]) =>
          storageKey.startsWith(MERGE_DOCK_GRANT_PREFIX) && isGrant(value) && value.tabId === tabId,
      )
      .map(([storageKey]) => storageKey);
    if (removals.length > 0) await this.storage.remove(removals);
  }

  private createGrant(
    scope: MergeDockGrantScope,
    jobId: string,
    owner: { tabId: number; pageUrl: string; mediaEpoch: number },
    issuedAt: number,
  ): MergeDockGrant {
    return {
      token: this.createToken(),
      scope,
      jobId,
      ...owner,
      issuedAt,
      expiresAt: issuedAt + MERGE_DOCK_GRANT_TTL_MS,
    };
  }

  private activateOwner(
    jobId: string,
    owner: { tabId: number; pageUrl: string; mediaEpoch: number },
    permissionEligible: boolean,
  ): void {
    const previous = this.activeOwners.get(owner.tabId);
    this.activeOwners.set(owner.tabId, { jobId, ...owner, permissionEligible });
    if (
      !previous ||
      (previous.jobId === jobId &&
        previous.pageUrl === owner.pageUrl &&
        previous.mediaEpoch === owner.mediaEpoch)
    ) {
      return;
    }
    for (const [token, grant] of this.issuedGrants) {
      if (grant.tabId !== owner.tabId) continue;
      this.issuedGrants.delete(token);
      this.permissionClaims.delete(token);
    }
  }

  private async readAll(): Promise<MergeDockGrant[]> {
    const records = await this.storage.get(null);
    return Object.entries(records).flatMap(([storageKey, value]) =>
      storageKey.startsWith(MERGE_DOCK_GRANT_PREFIX) && isGrant(value) ? [value] : [],
    );
  }
}

/** Validate a merge click before synchronously opening Chrome's prompt. */
export function claimMergeDockPermissionFromMessage(
  message: unknown,
  sender: MergeDockPermissionSenderLike,
  broker: Pick<MergeDockGrantBroker, 'claimPermissionRequest'>,
): string | undefined {
  const request =
    message != null && typeof message === 'object'
      ? (message as MergeDockPermissionMessageLike)
      : undefined;
  const tabId = sender.tab?.id;
  const pageUrl = sender.tab?.url ?? sender.url;
  if (
    request?.type !== 'RUN_MERGE_DOCK_ACTION' ||
    typeof request.token !== 'string' ||
    (request.action !== 'merge' && request.action !== 'separate') ||
    typeof tabId !== 'number' ||
    !Number.isInteger(tabId) ||
    (sender.frameId ?? 0) !== 0 ||
    typeof pageUrl !== 'string' ||
    pageUrl.length === 0
  ) {
    return undefined;
  }
  return broker.claimPermissionRequest(request.token, { tabId, pageUrl })
    ? request.token
    : undefined;
}

function displayState(job: MergeJob): MergeDockView['state'] {
  if (job.state === 'cancelled') return 'cancelled';
  if (isMergeJobStopping(job)) return 'cancelling';
  if (job.state === 'permission_required') return 'permission_required';
  if (job.state === 'ready') return 'ready';
  if (job.state === 'completed') return 'completed';
  if (job.state === 'failed' || job.state === 'blocked_drm') {
    return 'failed';
  }
  if (['fetching', 'muxing', 'saving', 'verifying', 'paused'].includes(job.state)) return 'running';
  return 'preparing';
}

export function publicMergeDockPhase(job: MergeJob): MergeDockPhase {
  if (isMergeJobStopping(job)) return 'cancelling';
  // A resolving job can read entire tracks as a capability check. That is not
  // a user-started download, even when its worker emits a fetching phase.
  if (job.state === 'queued' || job.state === 'resolving') return job.state;
  if (job.state === 'verifying' && job.publicationPending === true) return 'saving';
  return job.state;
}

function publicFailureMessage(job: MergeJob): string | undefined {
  if (job.state === 'cancelled') return undefined;
  if (isMergeJobStopping(job)) {
    return job.cancellationFailure === 'CLEANUP_FAILED'
      ? '任务已停止，但临时文件尚未清理完成，请重试返回。'
      : job.cancellationFailure === 'STOP_TIMEOUT'
        ? '任务尚未确认停止，请重试返回。'
        : undefined;
  }
  const reason = job.failure?.reason ? PUBLIC_MERGE_FAILURE_REASONS[job.failure.reason] : undefined;
  if (reason) return reason;
  switch (job.failure?.code) {
    case undefined:
      return undefined;
    case 'HOST_PERMISSION_REQUIRED':
      return '需要媒体来源网站权限，授权后会自动继续。';
    case 'DRM_PROTECTED':
      return '该媒体受 DRM 保护，无法合并下载。';
    case 'LIVE_STREAM_UNSUPPORTED':
      return '暂不支持合并正在直播的媒体。';
    case 'VIDEO_TRACK_MISSING':
    case 'AUDIO_TRACK_MISSING':
      return '媒体轨不完整，请重新选择视频。';
    case 'SOURCE_UNREADABLE':
    case 'NETWORK_FAILED':
      return '无法读取媒体来源，请检查网络或授权后重试。';
    case 'RANGE_RESPONSE_INVALID':
      return '媒体来源返回了异常的 Range 数据，已停止拼接以避免文件损坏。';
    case 'OUTPUT_WRITE_FAILED':
      return '浏览器未能保存输出文件，请更换保存位置后重试。';
    case 'OUTPUT_PARSE_FAILED':
      return '无法读取生成的文件，未将其保存为完整媒体。';
    case 'OUTPUT_TRACK_MISMATCH':
      return '输出文件的音视频轨不完整或编码不匹配。';
    case 'OUTPUT_TIMELINE_MISMATCH':
      return '生成文件的播放时间信息异常，尚不能确认处理成功。';
    case 'OUTPUT_AV_OFFSET_MISMATCH':
      return '生成文件的音画同步检查未通过。';
    case 'OUTPUT_DURATION_MISMATCH':
      return '输出时长与来源不一致，可能未完整合并。';
    case 'OUTPUT_SIZE_MISMATCH':
      return '输出文件大小校验失败，未继续下载。';
    case 'OUTPUT_METADATA_MISMATCH':
      return '生成文件的媒体信息与原始文件不一致，未保存为完整视频。';
    case 'OUTPUT_SIGNATURE_MISMATCH':
      return '输出文件格式校验失败，未继续下载。';
    case 'OUTPUT_VERIFY_FAILED':
      return '输出文件验证失败，未保存不完整文件。';
    case 'CANCELLED':
      return '合并任务已取消。';
    case 'INVALID_URL':
    case 'UNSUPPORTED_PROTOCOL':
      return '媒体来源无效或不受支持。';
    case 'TIMELINE_MISMATCH':
      return '音视频时间线或媒体身份不匹配，可选择分别下载。';
    case 'SOURCE_FORMAT_UNSUPPORTED':
      return '媒体文件格式无法安全读取，可选择分别下载。';
    case 'CODEC_UNKNOWN':
    case 'CONTAINER_INCOMPATIBLE':
    case 'TRANSCODE_REQUIRED':
      return '当前音视频格式无法无损合并，可选择分别下载。';
    case 'DYNAMIC_RANGE_UNVERIFIED':
      return 'HDR 或杜比视界信息未通过检查，无法生成完整视频。';
    case 'INTERNAL_ERROR':
      return '后台合并任务失败，请重试。';
  }
}

function formatProgressBytes(bytes: number): string {
  const normalized = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = normalized;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(1).replace(/\.0$/u, '')} ${units[unitIndex]}`;
}

function publicStatus(job: MergeJob, phase: MergeDockPhase): string {
  if (job.state === 'cancelled') return '任务已停止';
  if (isMergeJobStopping(job)) return publicFailureMessage(job) ?? '正在停止任务…';
  if (job.state === 'queued') return '等待后台检查';
  if (job.state === 'resolving') {
    if (job.progress.readBytes > 0) {
      return `正在读取媒体 · ${formatProgressBytes(job.progress.readBytes)}${job.progress.totalBytes ? ` / ${formatProgressBytes(job.progress.totalBytes)}` : ''}`;
    }
    return PUBLIC_MERGE_STAGES[job.progress.stage ?? ''] ?? '正在读取视频信息';
  }
  if (job.state === 'permission_required') return '等待媒体来源网站权限';
  if (job.state === 'ready') return '检查完成，可以合并下载。';
  if (job.state === 'fetching') {
    const downloaded = formatProgressBytes(job.progress.readBytes);
    return job.progress.totalBytes != null && job.progress.totalBytes > 0
      ? `已下载 ${downloaded} / ${formatProgressBytes(job.progress.totalBytes)}`
      : `已下载 ${downloaded}`;
  }
  if (job.state === 'muxing') {
    const ratio = job.progress.ratio;
    const phaseRatio =
      ratio == null
        ? null
        : Math.max(
            0,
            Math.min(
              1,
              (ratio - MERGE_DOWNLOAD_PROGRESS_END) /
                (MERGE_MUX_PROGRESS_END - MERGE_DOWNLOAD_PROGRESS_END),
            ),
          );
    return phaseRatio == null
      ? '正在合并媒体轨道'
      : `合并中 · 已处理 ${Math.round(phaseRatio * 100)}%`;
  }
  if (phase === 'saving') return '正在保存文件';
  if (phase === 'verifying') return '正在检查生成的文件';
  if (job.state === 'paused') return '后台任务已暂停';
  if (job.state === 'completed') return '保存成功';
  return publicFailureMessage(job) ?? '后台合并任务失败，请重试。';
}

export function presentMergeDockJob(
  job: MergeJob,
  tokens: MergeDockGrantPair,
  path: Pick<MergeDockView, 'savePath' | 'pathMode'>,
): MergeDockView {
  const state = displayState(job);
  const phase = publicMergeDockPhase(job);
  const busy = state === 'preparing' || state === 'running' || state === 'cancelling';
  const separateAllowed = job.failure?.canDownloadSeparately ?? true;
  const error = publicFailureMessage(job);
  const visibleFailure =
    !isMergeJobStopping(job) && job.state !== 'cancelled' ? job.failure : undefined;
  const timeline = publicTimelineDiagnostic(visibleFailure?.timeline);
  const sourceTimeline = publicSourceTimelineDiagnostic(visibleFailure?.sourceTimeline);
  const network = publicNetworkDiagnostic(visibleFailure?.network ?? job.progress.network);
  const configuration = publicConfigurationDiagnostic(visibleFailure?.configuration);
  return {
    ...tokens,
    title:
      normalizeMediaTitle(
        job.title ?? job.fileName,
        job.ownerPageUrl ?? job.videoContext?.pageUrl ?? '',
      ) || job.fileName,
    state,
    phase,
    snapshot: {
      taskKey: job.viewKey ?? tokens.actionToken,
      mediaEpoch: job.ownerMediaEpoch ?? 0,
      revision: job.revision ?? 0,
    },
    status: publicStatus(job, phase),
    progress:
      state === 'preparing' || state === 'permission_required'
        ? null
        : state === 'ready'
          ? 0
          : state === 'completed'
            ? 1
            : job.state === 'fetching' && job.progress.totalBytes == null
              ? null
              : job.progress.ratio,
    savePath: path.savePath,
    pathMode: path.pathMode,
    mergeEnabled:
      canRepeatMergeDownload(job) ||
      (job.cancellationRequestedAt == null &&
        (canRepeatMergeDownload(job) ||
          job.state === 'ready' ||
          job.state === 'permission_required' ||
          (job.state === 'failed' && job.failure?.retryable === true))),
    separateEnabled:
      separateAllowed &&
      !busy &&
      (job.state !== 'completed' || canRepeatMergeDownload(job)) &&
      job.state !== 'cancelled' &&
      job.state !== 'blocked_drm',
    busy,
    cancelEnabled: state !== 'completed' && state !== 'cancelled',
    returnRequiresConfirmation: [
      'preparing',
      'permission_required',
      'running',
      'cancelling',
    ].includes(state),
    diagnostics: {
      stage:
        PUBLIC_MERGE_STAGES[visibleFailure?.stage ?? job.progress.stage ?? ''] ??
        (visibleFailure ? '任务处理' : publicStatus(job, phase)),
      readBytes: Math.max(0, Number.isFinite(job.progress.readBytes) ? job.progress.readBytes : 0),
      totalBytes:
        Number.isFinite(job.progress.totalBytes) && Number(job.progress.totalBytes) > 0
          ? job.progress.totalBytes
          : null,
      startedAt: job.createdAt,
      lastProgressAt: job.progress.lastProgressAt ?? job.updatedAt,
      ...(job.viewKey && /^[a-f\d-]{36}$/iu.test(job.viewKey)
        ? { taskReference: job.viewKey }
        : {}),
      ...(timeline ? { timeline } : {}),
      ...(sourceTimeline ? { sourceTimeline } : {}),
      ...(network ? { network } : {}),
      ...(configuration ? { configuration } : {}),
      ...(job.failure && !isMergeJobStopping(job) && job.state !== 'cancelled'
        ? { errorCode: job.failure.code }
        : {}),
      ...(job.failure?.reason &&
      !isMergeJobStopping(job) &&
      job.state !== 'cancelled' &&
      PUBLIC_MERGE_FAILURE_REASONS[job.failure.reason]
        ? {
            reasonCode: job.failure.reason,
            reason: PUBLIC_MERGE_FAILURE_REASONS[job.failure.reason],
          }
        : {}),
    },
    ...(error ? { error } : {}),
  };
}

const PUBLIC_MERGE_STAGES: Readonly<Record<string, string>> = {
  storage: '正在检查临时存储',
  'source-selection': '正在选择媒体来源',
  'source-headers': '正在连接媒体来源',
  'source-body': '正在读取媒体',
  'media-metadata': '正在读取视频信息',
  'decoder-config': '正在检查编码配置',
  staging: '正在暂存媒体',
  muxing: '正在合并媒体',
  'dv-restore': '正在保留杜比视界配置',
  'verify-video': '正在校验视频',
  'verify-audio': '正在校验音频',
  'verify-output': '正在检查生成的文件',
  saving: '正在保存文件',
};

const PUBLIC_MERGE_FAILURE_REASONS: Readonly<Record<string, string>> = {
  NETWORK_TIMEOUT: '连接媒体来源超时，请检查网络后重试。',
  BODY_STALLED: '媒体读取长时间没有进展，已停止本次操作。',
  PARSER_TIMEOUT: '媒体解析长时间没有进展，已停止本次操作。',
  WORKER_START_TIMEOUT: '下载引擎未能及时启动，请重试。',
  WORKER_UNRESPONSIVE: '下载引擎没有响应，已中止本次处理。',
  STORAGE_QUOTA: '临时存储空间不足，请释放空间后重试。',
  RANGE_INVALID: '来源返回的分段范围异常，已停止读取以避免损坏。',
  RANGE_UNSUPPORTED: '来源未继续支持分段读取，正在改用磁盘顺序暂存。',
  SOURCE_EDIT_LIST_UNSUPPORTED: '来源时间轴结构暂无法验证，请查看具体原因。',
  SOURCE_IDENTITY_MISMATCH: '音视频不属于同一媒体，请重新选择当前视频。',
  DYNAMIC_RANGE_CONFLICT: '来源的 HDR / 杜比视界标记与实际配置冲突。',
  DV_CONFIG_MISSING: '来源缺少杜比视界配置信息，无法确认生成文件能保留原有效果。',
  DV_SOURCE_INCOMPLETE: '杜比视界来源不完整，无法生成完整保真视频。',
  DV_SAMPLE_ENTRY_UNSUPPORTED: '当前杜比视界样本类型尚不支持保真封装。',
  DV_PROFILE_UNSUPPORTED: '当前杜比视界 Profile 尚不支持保真封装。',
  DV_LAYERS_UNSUPPORTED: '当前杜比视界增强层结构尚不支持保真封装。',
  DV_BIT_DEPTH_UNSUPPORTED: '当前杜比视界位深尚不支持保真封装。',
  DV_STRUCTURE_AMBIGUOUS: '无法确认杜比视界轨道结构，已停止生成完整视频。',
  HEVC_CONFIG_MISSING: '来源缺少完整 HEVC 编码配置，无法安全封装。',
  HDR_CONFIG_INCOMPLETE: '来源缺少完整的 HDR 色彩信息，无法确认生成文件能保留原有效果。',
  DV_COMPATIBILITY_VIEW_FAILED: '无法安全读取杜比视界兼容轨道。',
  DV_RESTORE_FAILED: '无法恢复杜比视界配置信息，未生成完整视频。',
  VIDEO_PACKET_MISMATCH: '生成的视频数据与原始数据不一致，未生成完整视频。',
  AUDIO_PACKET_MISMATCH: '生成的音频数据与原始数据不一致，未生成完整视频。',
  PACKET_TIMELINE_MISMATCH: '视频和音频的播放时间信息不一致，未生成完整视频。',
  DV_METADATA_MISMATCH: '生成文件的杜比视界信息未通过检查，未生成完整视频。',
  HDR_METADATA_MISMATCH: '生成文件的 HDR 信息未通过检查，未生成完整视频。',
  OUTPUT_READBACK_FAILED: '保存前无法重新读取生成的文件，请重试。',
  VERIFICATION_INCOMPLETE: '文件检查尚未完成，暂不能确认保存成功。',
};
