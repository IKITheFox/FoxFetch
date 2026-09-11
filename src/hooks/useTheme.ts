import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import type { ThemeMode } from '../shared/types';
import { applyUiTheme } from '../shared/ui-theme';

export type ResolvedTheme = 'light' | 'dark';

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme(mode: ThemeMode): ResolvedTheme {
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme());

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) =>
      setSystemTheme(event.matches ? 'dark' : 'light');
    setSystemTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const resolved = useMemo<ResolvedTheme>(
    () => (mode === 'auto' ? systemTheme : mode),
    [mode, systemTheme],
  );

  useLayoutEffect(() => {
    applyUiTheme(mode, resolved === 'dark');
  }, [mode, resolved]);

  return resolved;
}
