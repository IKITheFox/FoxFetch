import { useRef, useState } from 'react';
import type { AppSettings } from '../shared/types';
import { t } from '../shared/i18n';
import { useLanguage } from '../hooks/useLanguage';
import { Tooltip } from './Tooltip';

export function LanguageButton({
  value,
  onChange,
}: {
  value: AppSettings['uiLanguage'];
  onChange: (patch: Partial<AppSettings>) => Promise<unknown>;
}) {
  useLanguage();
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const english = value === 'en';
  const label = t(english ? 'language.current.en' : 'language.current.zh');
  return (
    <span className="language-button-wrap">
      <Tooltip content={label}>
        <button
          type="button"
          className="icon-button language-button"
          aria-label={label}
          disabled={busy}
          onClick={() => {
            if (active.current) return;
            active.current = true;
            setBusy(true);
            setError(false);
            void onChange({ uiLanguage: english ? 'zh-CN' : 'en' })
              .catch(() => setError(true))
              .finally(() => {
                active.current = false;
                setBusy(false);
              });
          }}
        >
          {english ? 'EN' : '中'}
        </button>
      </Tooltip>
      {error && (
        <span role="alert" className="language-error">
          {t('language.saveFailed')}
        </span>
      )}
    </span>
  );
}
