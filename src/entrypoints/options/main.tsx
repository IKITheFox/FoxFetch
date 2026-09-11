import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeUiTheme } from '../../shared/ui-theme';

import '../../styles/base.css';
import '../../styles/ui.css';
import { App } from './SettingsPage';

const root = document.getElementById('root');
if (!root) throw new Error('找不到应用挂载节点');

void initializeUiTheme().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
