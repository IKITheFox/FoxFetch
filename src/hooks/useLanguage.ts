import { useSyncExternalStore } from 'react';
import { getLanguage, subscribeLanguage } from '../shared/i18n';

export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}
