import { t as uiText } from '../../shared/i18n';
export const youtubePreparationStages = {
  get 'refreshing-source'() {
    return uiText('E1585');
  },
  get downloading() {
    return uiText('E1586');
  },
  get 'verifying-source'() {
    return uiText('E1587');
  },
  get merging() {
    return uiText('E1588');
  },
  get 'verifying-output'() {
    return uiText('E1589');
  },
} as const;
export type YouTubePreparationStage = keyof typeof youtubePreparationStages;
