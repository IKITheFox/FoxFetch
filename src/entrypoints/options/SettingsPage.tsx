import { t as uiText } from '../../shared/i18n';
import { messageText } from '../../shared/i18n/legacy-message';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Brand } from '../../components/Brand';
import { Button } from '../../components/Button';
import { CustomSelect } from '../../components/CustomSelect';
import { InlineNotice, LoadingView } from '../../components/StateView';
import { Toggle } from '../../components/Toggle';
import { useAppSettings, sendUiRequest } from '../../hooks/useExtensionApi';
import { useTheme } from '../../hooks/useTheme';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';
import { FULL_MEDIA_ACCESS_PERMISSIONS } from '../../modules/permissions';
import { YOUTUBE_SOURCE_PERMISSIONS } from '../../modules/youtube/source-permissions';
import {
  mergeSettingsDraft,
  permissionSummary,
  settingsValidation,
} from '../../modules/storage/settings-ui';
import './settings.css';
import { normalizeLanguage, previewLanguage, t } from '../../shared/i18n';

export function App({
  embedded = false,
  onClose = () => window.close(),
}: { embedded?: boolean; onClose?: () => void } = {}) {
  const { settings, loading, saving, error, saveSettings } = useAppSettings();
  const [draft, setDraft] = useState(settings);
  const base = useRef(settings);
  const submitting = useRef(false);
  const [committing, setCommitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const cancelFocus = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' }>();
  const [validation, setValidation] = useState<Record<string, string>>({});
  const [permissions, setPermissions] = useState<{
    summary: string;
    full: boolean;
    youtube: boolean;
  }>();
  const [permissionError, setPermissionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(location.hash === '#permissions');
  useEffect(() => {
    const follow = () => {
      if (location.hash === '#permissions') setManage(true);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  useTheme(dirty ? draft.themeMode : settings.themeMode);
  useEffect(() => {
    previewLanguage(dirty ? normalizeLanguage(draft.uiLanguage) : undefined);
    return () => previewLanguage(undefined);
  }, [dirty, draft.uiLanguage]);
  useEffect(() => {
    if (!loading && !dirty) {
      setDraft(settings);
      base.current = settings;
    }
  }, [loading, dirty, settings]);
  useEffect(() => {
    if (!dirty || embedded) return;
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, embedded]);
  const refreshPermissions = useCallback(async () => {
    try {
      const [all, full, youtube] = await Promise.all([
        chrome.permissions.getAll(),
        chrome.permissions.contains(FULL_MEDIA_ACCESS_PERMISSIONS),
        chrome.permissions.contains(YOUTUBE_SOURCE_PERMISSIONS),
      ]);
      setPermissions({ summary: permissionSummary(all.origins ?? []), full, youtube });
      setPermissionError(false);
    } catch {
      setPermissionError(true);
    }
  }, []);
  useEffect(() => {
    const refresh = () => {
      void refreshPermissions();
    };
    refresh();
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);
    window.addEventListener('focus', refresh);
    return () => {
      chrome.permissions.onAdded.removeListener(refresh);
      chrome.permissions.onRemoved.removeListener(refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [refreshPermissions]);
  const update = (next: AppSettings) => {
    setDraft(next);
    setDirty(JSON.stringify(next) !== JSON.stringify(base.current));
    setNotice(undefined);
    setValidation({});
  };
  const playback = (patch: Partial<AppSettings['playback']>) =>
    update({ ...draft, playback: { ...draft.playback, ...patch } });
  const download = (patch: Partial<AppSettings['download']>) =>
    update({ ...draft, download: { ...draft.download, ...patch } });
  const cancel = () => {
    setDraft(settings);
    base.current = settings;
    setDirty(false);
    setValidation({});
    setNotice(undefined);
  };
  const save = async () => {
    if (submitting.current) return;
    const problems = settingsValidation(draft);
    setValidation(problems);
    if (Object.keys(problems).length) {
      setNotice({
        tone: 'error',
        get text() {
          return uiText('E0384');
        },
      });
      return;
    }
    try {
      submitting.current = true;
      setCommitting(true);
      const current = await sendUiRequest<AppSettings>({ type: 'GET_SETTINGS' });
      const next = mergeSettingsDraft(base.current, draft, current);
      await saveSettings(next, current);
      setDirty(false);
      setNotice({
        tone: 'success',
        get text() {
          return uiText('E0385');
        },
      });
      return true;
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: reason instanceof Error ? reason.message : uiText('E0386'),
      });
    } finally {
      submitting.current = false;
      setCommitting(false);
    }
  };
  const requestClose = () => {
    if (submitting.current) return;
    if (!dirty) {
      onClose();
      return;
    }
    previousFocus.current = document.activeElement as HTMLElement;
    setConfirmClose(true);
  };
  const dismissConfirm = () => {
    setConfirmClose(false);
    previousFocus.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (confirmClose) cancelFocus.current?.focus({ preventScroll: true });
  }, [confirmClose]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (submitting.current) return;
      if (confirmClose) dismissConfirm();
      else requestClose();
    };
    const message = (event: MessageEvent) => {
      if (!embedded || event.source !== parent) return;
      if (event.data?.type === 'FOXF_SETTINGS_CLOSE') requestClose();
      if (event.data?.type === 'FOXF_SETTINGS_PERMISSIONS') setManage(true);
    };
    document.addEventListener('keydown', key);
    window.addEventListener('message', message);
    return () => {
      document.removeEventListener('keydown', key);
      window.removeEventListener('message', message);
    };
  });
  const changePermission = async (kind: 'full' | 'youtube') => {
    if (!permissions || busy) return;
    const granted = permissions[kind];
    if (granted && !window.confirm(uiText('E0389'))) return;
    setBusy(true);
    try {
      const scope = kind === 'full' ? FULL_MEDIA_ACCESS_PERMISSIONS : YOUTUBE_SOURCE_PERMISSIONS;
      // webRequest is shared by other granted media hosts; revoke only this scope's origins.
      const changed = await (granted
        ? chrome.permissions.remove({ origins: scope.origins ?? [] })
        : chrome.permissions.request(scope));
      const remains = await chrome.permissions.contains(scope);
      await refreshPermissions();
      setNotice({
        tone: 'success',
        text: !changed
          ? uiText('E0390')
          : granted && remains
            ? uiText('E0391')
            : granted
              ? uiText('E0392')
              : uiText('E0393'),
      });
    } catch {
      setNotice({
        tone: 'error',
        get text() {
          return uiText('E0394');
        },
      });
    } finally {
      setBusy(false);
    }
  };
  const browserPage = async (url: string) => {
    try {
      await chrome.tabs.create({ url });
    } catch {
      setNotice({
        tone: 'error',
        get text() {
          return uiText('E0395');
        },
      });
    }
  };
  const number = (
    id: string,
    label: string,
    value: number,
    min: number,
    max: number,
    change: (v: number) => void,
    step: string,
    field: string,
  ) => (
    <div className="setting-row">
      <label htmlFor={id}>{label}</label>
      <div className="settings-field">
        <input
          id={id}
          className="number-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isNaN(value) ? '' : value}
          aria-invalid={!!validation[field]}
          aria-describedby={validation[field] ? `${id}-error` : undefined}
          onChange={(e) => change(e.target.value === '' ? NaN : Number(e.target.value))}
        />
        {validation[field] && (
          <small id={`${id}-error`} role="alert">
            {validation[field]}
          </small>
        )}
      </div>
    </div>
  );
  if (loading)
    return (
      <main className="settings-page">
        <LoadingView label={uiText('E0396')} />
      </main>
    );
  return (
    <main className={`settings-page${embedded ? ' settings-embedded' : ''}`}>
      <header
        className="settings-top"
        inert={confirmClose}
        onPointerDown={(event) => {
          if (!embedded || event.button !== 0 || (event.target as Element).closest('button'))
            return;
          drag.current = { x: event.screenX, y: event.screenY };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          parent.postMessage(
            {
              type: 'FOXF_SETTINGS_DRAG',
              dx: event.screenX - drag.current.x,
              dy: event.screenY - drag.current.y,
            },
            '*',
          );
          drag.current = { x: event.screenX, y: event.screenY };
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        <Brand subtitle={uiText('E0397')} />
        <Button variant="ghost" onClick={requestClose} aria-label={uiText('E0398')}>
          ×
        </Button>
      </header>
      <div className={embedded ? 'settings-content settings-scroll' : undefined}>
        <fieldset
          className={embedded ? 'settings-fields' : 'settings-content'}
          inert={confirmClose}
          disabled={committing}
          aria-label={uiText('E0399')}
        >
          {embedded && new URLSearchParams(location.search).get('fallback') === '1' && (
            <p className="settings-note">{uiText('E0400')}</p>
          )}
          {error || notice ? (
            <InlineNotice tone={error ? 'error' : notice!.tone}>
              {error ?? notice!.text}
            </InlineNotice>
          ) : null}
          <section aria-labelledby="playback-heading">
            <h2 id="playback-heading">{uiText('E0401')}</h2>
            <div className="settings-panel">
              <div className="setting-row">
                <span>{t('language.label')}</span>
                <div className="settings-segments" aria-label={t('language.label')}>
                  {(
                    [
                      ['zh-CN', '中文'],
                      ['en', 'English'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={normalizeLanguage(draft.uiLanguage) === value}
                      onClick={() => update({ ...draft, uiLanguage: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>{uiText('E0402')}</span>
                <div className="settings-segments" aria-label={uiText('E0402')}>
                  {(
                    [
                      ['auto', uiText('E0107')],
                      ['light', uiText('E0403')],
                      ['dark', uiText('E0404')],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draft.themeMode === value}
                      onClick={() => update({ ...draft, themeMode: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <Toggle
                label={uiText('E0405')}
                checked={draft.playback.showController}
                onChange={(showController) => playback({ showController })}
              />
              {number(
                'default-rate',
                uiText('E0406'),
                draft.playback.defaultRate,
                0.0625,
                16,
                (defaultRate) => playback({ defaultRate }),
                'any',
                'rate',
              )}
              <Toggle
                label={uiText('E0407')}
                checked={draft.playback.lockRate}
                onChange={(lockRate) => playback({ lockRate })}
              />
              <details open={!!validation.seek}>
                <summary>{uiText('E0408')}</summary>
                <Toggle
                  label={uiText('E0409')}
                  checked={draft.playback.preservesPitch}
                  onChange={(preservesPitch) => playback({ preservesPitch })}
                />
                {number(
                  'seek-step',
                  uiText('E0410'),
                  draft.playback.seekStep,
                  1,
                  120,
                  (seekStep) => playback({ seekStep }),
                  'any',
                  'seek',
                )}
                <div className="setting-row">
                  <span>
                    {' '}
                    {uiText('E0411')}
                    <small>{uiText('E0412')}</small>
                  </span>
                  <Button
                    icon="external"
                    onClick={() => void browserPage('chrome://extensions/shortcuts')}
                  >
                    {' '}
                    {uiText('E0413')}{' '}
                  </Button>
                </div>
              </details>
            </div>
          </section>
          <section aria-labelledby="download-heading">
            <h2 id="download-heading">{uiText('E0414')}</h2>
            <div className="settings-panel">
              <div className="setting-row">
                <span>{uiText('download.preference')}</span>
                <div
                  className="settings-segments"
                  role="group"
                  aria-label={uiText('download.preference')}
                >
                  {(['compatibility', 'quality', 'size'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={(draft.download.preference ?? 'compatibility') === value}
                      onClick={() => download({ preference: value })}
                    >
                      {uiText(`download.${value}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <label htmlFor="save-mode">{uiText('E0415')}</label>
                <CustomSelect
                  id="save-mode"
                  label={uiText('E0415')}
                  value={draft.download.saveAs ? 'ask' : 'automatic'}
                  onChange={(v) => download({ saveAs: v === 'ask' })}
                  options={[
                    {
                      value: 'automatic',
                      get label() {
                        return uiText('E0416');
                      },
                    },
                    {
                      value: 'ask',
                      get label() {
                        return uiText('E0417');
                      },
                    },
                  ]}
                />
              </div>
              <Toggle
                label={uiText('E0418')}
                description={uiText('E0419')}
                checked={draft.autoScanGrantedSites}
                onChange={(autoScanGrantedSites) =>
                  update({ ...draft, autoScanGrantedSites, youtubeEnabled: true })
                }
              />
              {draft.youtubeEnabled === false && (
                <p className="settings-note"> {uiText('E0420')} </p>
              )}
              <Toggle
                label={uiText('E0421')}
                checked={draft.showAdvancedMedia}
                onChange={(showAdvancedMedia) => update({ ...draft, showAdvancedMedia })}
              />
              <details open={!!validation.count}>
                <summary>{uiText('E0422')}</summary>
                {number(
                  'concurrency',
                  uiText('E0423'),
                  draft.download.concurrentDownloads,
                  1,
                  8,
                  (concurrentDownloads) => download({ concurrentDownloads }),
                  '1',
                  'count',
                )}
                <p className="settings-note"> {uiText('E0424')} </p>
              </details>
            </div>
          </section>
          <section id="permissions" aria-labelledby="permissions-heading">
            <h2 id="permissions-heading">{uiText('E0430')}</h2>
            <div className="settings-panel">
              <div className="setting-row">
                <strong>
                  {permissionError
                    ? uiText('E0431')
                    : messageText(permissions?.summary ?? uiText('E0432'))}
                </strong>
                <Button
                  onClick={() => {
                    setManage(!manage);
                    if (permissionError) void refreshPermissions();
                  }}
                  aria-expanded={manage}
                >
                  {manage ? uiText('E0433') : uiText('E0434')}
                </Button>
              </div>
              <p className="settings-note">{uiText('E0435')}</p>
              {manage && (
                <div className="settings-permissions">
                  <div className="setting-row">
                    <span>
                      {' '}
                      {uiText('E0436')}
                      <small>{uiText('E0437')}</small>
                    </span>
                    <Button
                      disabled={busy || permissionError || !permissions}
                      onClick={() => void changePermission('youtube')}
                    >
                      {permissions?.youtube ? uiText('E0438') : uiText('E0439')}
                    </Button>
                  </div>
                  <div className="setting-row">
                    <span>
                      {' '}
                      {uiText('E0440')}
                      <small>{uiText('E0441')}</small>
                    </span>
                    <Button
                      disabled={busy || permissionError || !permissions}
                      onClick={() => void changePermission('full')}
                    >
                      {permissions?.full ? uiText('E0438') : uiText('E0439')}
                    </Button>
                  </div>
                  <div className="setting-row">
                    <span>
                      {' '}
                      {uiText('E0442')}
                      <small>{uiText('E0443')}</small>
                    </span>
                    <Button
                      icon="external"
                      onClick={() =>
                        void browserPage(`chrome://extensions/?id=${chrome.runtime.id}`)
                      }
                    >
                      {' '}
                      {uiText('E0444')}{' '}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
          <div className="settings-bottom">
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm(uiText('E0445')))
                  update({ ...structuredClone(DEFAULT_SETTINGS), youtubeEnabled: true });
              }}
            >
              {' '}
              {uiText('E0446')}{' '}
            </Button>
            <small>
              v{chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version}
            </small>
          </div>
          <p className="settings-copyright">Copyright © 2026 IKITheFox</p>
        </fieldset>
      </div>
      {(embedded || dirty) && (
        <footer
          className="settings-save"
          inert={confirmClose || !dirty}
          aria-hidden={!dirty}
          style={!dirty ? { visibility: 'hidden' } : undefined}
        >
          <span>{uiText('E0449')}</span>
          <Button disabled={saving || committing} onClick={cancel}>
            {' '}
            {uiText('E0450')}{' '}
          </Button>
          <Button
            variant="primary"
            icon="check"
            loading={saving || committing}
            onClick={() => void save()}
          >
            {' '}
            {uiText('E0451')}{' '}
          </Button>
        </footer>
      )}
      {confirmClose && (
        <div className="settings-confirm-shade">
          <section
            className="settings-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-confirm-title"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              );
              const first = buttons[0],
                last = buttons.at(-1);
              if (!buttons.length) {
                event.preventDefault();
                return;
              }
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <h2 id="settings-confirm-title">{uiText('E0452')}</h2>
            <div className="settings-confirm-actions">
              <Button
                variant="primary"
                disabled={committing}
                onClick={() =>
                  void save().then((ok) => {
                    if (ok) onClose();
                    else setConfirmClose(false);
                  })
                }
              >
                {' '}
                {uiText('E0453')}{' '}
              </Button>
              <Button
                disabled={committing}
                onClick={() => {
                  cancel();
                  onClose();
                }}
              >
                {' '}
                {uiText('E0454')}{' '}
              </Button>
              <button
                className="button button--secondary button--md"
                ref={cancelFocus}
                disabled={committing}
                onClick={dismissConfirm}
              >
                {' '}
                {uiText('E0101')}{' '}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
