import type { MediaAsset, MergeJobSeed, MergeJobSourceContext } from '../../shared/types';
import { extensionFromUrl, sanitizeFilename, stableId } from '../../shared/utils';
import {
  installMediaRequestContext,
  releaseMediaRequestContexts,
  type MediaRequestContextSource,
} from '../downloads/request-context';

function cloneSourceContext(context: MergeJobSourceContext): MergeJobSourceContext {
  return {
    pageUrl: context.pageUrl,
    ...(context.requestHeaders ? { requestHeaders: { ...context.requestHeaders } } : {}),
  };
}

/**
 * Carries captured request metadata into a replacement job only while the
 * corresponding media URL is unchanged. A failed/blocked job is replaced on
 * retry, but its Referer/Authorization context is still needed by the
 * "download separately" fallback.
 */
export function inheritUnchangedMergeJobContexts(
  previous: Pick<MergeJobSeed, 'videoUrl' | 'audioUrl' | 'videoContext' | 'audioContext'> | null,
  nextVideoUrl: string,
  nextAudioUrl: string,
): Pick<MergeJobSeed, 'videoContext' | 'audioContext'> {
  const inherited: Pick<MergeJobSeed, 'videoContext' | 'audioContext'> = {};
  if (previous?.videoUrl === nextVideoUrl && previous.videoContext) {
    inherited.videoContext = cloneSourceContext(previous.videoContext);
  }
  if (previous?.audioUrl === nextAudioUrl && previous.audioContext) {
    inherited.audioContext = cloneSourceContext(previous.audioContext);
  }
  return inherited;
}

export function mergeJobRequestContextSources(
  job: Pick<
    MergeJobSeed,
    'videoUrl' | 'audioUrl' | 'videoSources' | 'audioSources' | 'videoContext' | 'audioContext'
  >,
): MediaRequestContextSource[] {
  const result: MediaRequestContextSource[] = [];
  const seen = new Set<string>();
  const append = (
    primaryUrl: string,
    mirrors: MergeJobSeed['videoSources'],
    context: MergeJobSeed['videoContext'],
  ): void => {
    for (const url of [primaryUrl, ...(mirrors ?? []).map((source) => source.url)]) {
      if (seen.has(url)) continue;
      seen.add(url);
      result.push({
        url,
        pageUrl: context?.pageUrl ?? '',
        ...(context?.requestHeaders ? { requestHeaders: { ...context.requestHeaders } } : {}),
      });
    }
  };
  append(job.videoUrl, job.videoSources, job.videoContext);
  append(job.audioUrl, job.audioSources, job.audioContext);
  return result;
}

export function mergeJobDownloadAssets(job: MergeJobSeed): [MediaAsset, MediaAsset] {
  const pageTitle = job.title ?? 'FoxFetch-media';
  const makeAsset = (
    kind: 'video' | 'audio',
    url: string,
    context: MergeJobSeed['videoContext'],
  ): MediaAsset => {
    const extension = extensionFromUrl(url) ?? (kind === 'video' ? 'mp4' : 'm4a');
    const label = kind === 'video' ? '视频轨' : '音频轨';
    return {
      id: stableId(`merge-download:${kind}:${url}`),
      url,
      pageUrl: context?.pageUrl ?? '',
      pageTitle,
      frameId: 0,
      kind,
      detectedBy: ['network'],
      extension,
      filename: `${sanitizeFilename(pageTitle, 'FoxFetch-media')}-${label}.${extension}`,
      ...(context?.requestHeaders ? { requestHeaders: { ...context.requestHeaders } } : {}),
      downloadable: true,
      discoveredAt: job.createdAt,
    };
  };

  return [
    makeAsset('video', job.videoUrl, job.videoContext),
    makeAsset('audio', job.audioUrl, job.audioContext),
  ];
}

export interface MergeJobRequestContextDependencies {
  install(source: MediaRequestContextSource): Promise<number | undefined>;
  release(ruleIds: readonly number[]): Promise<void>;
}

const DEFAULT_DEPENDENCIES: MergeJobRequestContextDependencies = {
  install: (source) => installMediaRequestContext(source, 'merge'),
  release: releaseMediaRequestContexts,
};

/** Owns the exact DNR rules used by one visible merge job page. */
export class MergeJobRequestContextLease {
  private ruleIds: number[] = [];
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies = DEFAULT_DEPENDENCIES) {}

  get activeRuleIds(): number[] {
    return [...this.ruleIds];
  }

  ensure(job: MergeJobSeed): Promise<number[]> {
    return this.serialize(async () => {
      await this.releaseCurrent();
      const installed: number[] = [];
      try {
        for (const source of mergeJobRequestContextSources(job)) {
          const id = await this.dependencies.install(source);
          if (id != null && !installed.includes(id)) installed.push(id);
        }
      } catch (error) {
        if (installed.length > 0) await this.dependencies.release(installed).catch(() => undefined);
        throw error;
      }
      this.ruleIds = installed;
      return [...installed];
    });
  }

  release(): Promise<void> {
    return this.serialize(() => this.releaseCurrent());
  }

  private async releaseCurrent(): Promise<void> {
    if (this.ruleIds.length === 0) return;
    const current = [...this.ruleIds];
    await this.dependencies.release(current);
    this.ruleIds = [];
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
