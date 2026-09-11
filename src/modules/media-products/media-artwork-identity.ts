import type {
  AgentSnapshot,
  BoundMediaArtwork,
  MediaArtworkIdentityBinding,
  TabMediaState,
} from '../../shared/types';
import { siteMediaRouteKey } from '../detector/site-media';
import type { ValidatedMainWorldMediaManifest } from '../detector/main-world-media';
import { providerIdentityMatchesPage } from './media-trust';
import { validateBoundMediaArtwork, type MediaArtworkContext } from './media-artwork';

const documentKeyPattern = /^[A-Za-z0-9_-]{16,96}$/u;
const providerPattern = /^bilibili:BV[0-9A-Za-z]+:[1-9]\d{0,19}$/u;

export interface DocumentBoundMainWorldManifest {
  manifest: ValidatedMainWorldMediaManifest;
  documentId: string;
}

/** MAIN and isolated probes run concurrently; same URL does not prove same document. */
export function selectDocumentBoundMainWorldManifest(
  result: DocumentBoundMainWorldManifest | undefined,
  agentDocumentId: string | undefined,
): ValidatedMainWorldMediaManifest | undefined {
  return result?.documentId && result.documentId === agentDocumentId ? result.manifest : undefined;
}

function samePlayer(snapshot: AgentSnapshot, state: MediaArtworkContext): boolean {
  const left = snapshot.activeMedia;
  const right = state.activeMedia;
  return Boolean(
    left &&
    right &&
    left.kind === 'video' &&
    right.kind === 'video' &&
    left.frameId === 0 &&
    right.frameId === 0 &&
    siteMediaRouteKey(snapshot.pageUrl) === siteMediaRouteKey(state.pageUrl) &&
    left.routeKey === siteMediaRouteKey(state.pageUrl) &&
    right.routeKey === left.routeKey &&
    snapshot.mediaEpoch === state.mediaEpoch &&
    left.mediaEpoch === snapshot.mediaEpoch &&
    right.mediaEpoch === left.mediaEpoch &&
    left.elementId === right.elementId &&
    left.lifecycleGeneration === right.lifecycleGeneration,
  );
}

/** Issue only from an admitted snapshot and the independently validated current state. */
export function createMediaArtworkIdentity(
  snapshot: AgentSnapshot,
  state: TabMediaState,
  documentId: string | undefined,
  currentDocumentId: string | undefined,
): MediaArtworkIdentityBinding | undefined {
  if (
    !documentId ||
    documentId !== currentDocumentId ||
    !snapshot.artworkDocumentKey ||
    !documentKeyPattern.test(snapshot.artworkDocumentKey) ||
    !state.providerIdentity ||
    !providerPattern.test(state.providerIdentity) ||
    !providerIdentityMatchesPage(state.pageUrl, state.providerIdentity) ||
    !samePlayer(snapshot, state)
  )
    return undefined;
  return {
    artworkDocumentKey: snapshot.artworkDocumentKey,
    pageIdentity: siteMediaRouteKey(state.pageUrl),
    mediaEpoch: snapshot.mediaEpoch,
    elementId: snapshot.activeMedia!.elementId,
    lifecycleGeneration: snapshot.activeMedia!.lifecycleGeneration,
    providerIdentity: state.providerIdentity,
  };
}

/** Called only after the Agent authenticates its extension-background sender. */
export function acceptMediaArtworkIdentity(
  value: unknown,
  context: MediaArtworkContext,
  documentKey: string,
): string | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const expectedKeys = [
      'artworkDocumentKey',
      'pageIdentity',
      'mediaEpoch',
      'elementId',
      'lifecycleGeneration',
      'providerIdentity',
    ];
    if (
      Object.keys(value).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(value, key))
    )
      return undefined;
    const binding = value as MediaArtworkIdentityBinding;
    const active = context.activeMedia;
    if (
      !active ||
      active.kind !== 'video' ||
      active.frameId !== 0 ||
      typeof binding.artworkDocumentKey !== 'string' ||
      !documentKeyPattern.test(binding.artworkDocumentKey) ||
      binding.artworkDocumentKey !== documentKey ||
      binding.pageIdentity !== siteMediaRouteKey(context.pageUrl) ||
      active.routeKey !== binding.pageIdentity ||
      !Number.isSafeInteger(binding.mediaEpoch) ||
      binding.mediaEpoch < 0 ||
      binding.mediaEpoch !== context.mediaEpoch ||
      binding.mediaEpoch !== active.mediaEpoch ||
      binding.elementId !== active.elementId ||
      !Number.isSafeInteger(binding.lifecycleGeneration) ||
      binding.lifecycleGeneration < 0 ||
      binding.lifecycleGeneration !== active.lifecycleGeneration ||
      typeof binding.providerIdentity !== 'string' ||
      !providerPattern.test(binding.providerIdentity) ||
      !providerIdentityMatchesPage(context.pageUrl, binding.providerIdentity) ||
      (context.providerIdentity != null &&
        context.providerIdentity.toUpperCase() !== binding.providerIdentity.toUpperCase())
    )
      return undefined;
    return binding.providerIdentity;
  } catch {
    return undefined;
  }
}

/** A late successful reply is not authority to resurrect an old document/part. */
export function validateMediaArtworkIdentityReply(
  reply: AgentSnapshot,
  binding: MediaArtworkIdentityBinding,
  state: TabMediaState,
): BoundMediaArtwork | undefined {
  if (
    reply.artworkDocumentKey !== binding.artworkDocumentKey ||
    state.providerIdentity?.toUpperCase() !== binding.providerIdentity.toUpperCase() ||
    binding.pageIdentity !== siteMediaRouteKey(state.pageUrl) ||
    binding.mediaEpoch !== state.mediaEpoch ||
    binding.elementId !== state.activeMedia?.elementId ||
    binding.lifecycleGeneration !== state.activeMedia?.lifecycleGeneration ||
    !samePlayer(reply, state)
  )
    return undefined;
  return validateBoundMediaArtwork(reply.artwork, state);
}
