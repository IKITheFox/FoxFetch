import { useEffect } from 'react';

import { installStaticTextSelectionGuard } from '../modules/ui/static-text-selection';

export function useStaticTextSelection(): void {
  useEffect(() => installStaticTextSelectionGuard(document), []);
}
