export {
  bilibiliMediaResourceFamily,
  buildMediaProducts,
  enrichBilibiliNetworkAsset,
  type MediaProduct,
  type MediaProductCapabilities,
  type MediaProductCompleteSelection,
  type MediaProductDefaultSelection,
  type MediaProductPageInfo,
  type MediaProductProvider,
  type MediaProductQuality,
  type MediaProductTrack,
  type MediaProductVideoCodec,
  type MediaProductVideoComposition,
} from './media-products';

export {
  assessMediaAssetTrust,
  isTrustedMediaAssetForDisplay,
  selectPrimaryVideoAnchor,
  currentVideoPlaybackAnchor,
  providerIdentityMatchesPage,
  type MediaAssetTrustAssessment,
  type MediaAssetTrustContext,
  type MediaAssetTrustReason,
  type MediaProductPlaybackAnchor,
} from './media-trust';

export {
  mediaArtworkTitleKey,
  mediaArtworkDisplayUrl,
  readBoundMediaArtwork,
  validateBoundMediaArtwork,
  safeMediaArtworkUrl,
  selectCurrentVideoArtwork,
  selectCurrentVideoTitle,
  selectCurrentVideoArtworkForProduct,
  type CurrentVideoArtwork,
} from './media-artwork';

export {
  validateMediaProductDownload,
  type MediaProductDownloadIntent,
  type ValidatedMediaProductDownload,
} from './media-product-download';

export {
  mediaProductDomain,
  mediaProductPoster,
  presentMediaProduct,
  productDisplayTrack,
  productDownloadOptions,
  productQuality,
  productQualityOptions,
  productTrack,
  selectProductDownload,
  type MediaProductCardDownloadMode,
  type MediaProductCardModel,
  type MediaProductDownloadOption,
  type MediaProductDownloadSelection,
  type MediaProductQualityOption,
} from './media-product-presentation';

export {
  reconcileProductQualitySelections,
  type QualitySelectionProduct,
} from './quality-selection-state';

export {
  MEDIA_DOCK_TOKEN_TTL_MS,
  MediaDockProductGrantBroker,
  claimMediaDockPermissionFromMessage,
  createMergeDockAfterPermissionSettles,
  mediaDockPermissionModesForProduct,
  type MediaDockGrantStorage,
  type MediaDockPermissionMessageLike,
  type MediaDockPermissionSenderLike,
  type MediaDockProductGrant,
  type MediaDockProductGrantContext,
  type MediaDockProductGrantInput,
  type MediaDockProductGrantRequest,
  type MediaDockProductPermissionRequest,
} from './media-dock-access';
