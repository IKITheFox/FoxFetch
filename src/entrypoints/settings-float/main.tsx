import { t as uiText } from '../../shared/i18n';
import { createRoot } from 'react-dom/client';
import { App } from '../options/SettingsPage';
import '../../styles/base.css';
import '../../styles/ui.css';

// No page-supplied state or commands can save settings or request permissions.
void chrome.runtime
  .sendMessage({ type: 'VERIFY_SETTINGS_FRAME' })
  .then((result) => {
    if (!result?.ok || !result.data) return;
    createRoot(document.getElementById('root')!).render(
      <App
        embedded
        onClose={() => {
          void chrome.runtime
            .sendMessage({ type: 'RELEASE_SETTINGS_FRAME' })
            .catch(() => undefined);
          parent.postMessage({ type: 'FOXF_SETTINGS_CLOSED' }, '*');
        }}
      />,
    );
    parent.postMessage({ type: 'FOXF_SETTINGS_READY' }, '*');
  })
  .catch(() => {
    document.getElementById('root')!.textContent = uiText('E0488');
  });
