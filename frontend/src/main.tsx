import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiProvider } from './api/ApiContext';
import type { ApiClient } from './api/client';
import { createHttpClient } from './api/httpClient';
import { App, ROUTER_FUTURE } from './App';
import { config } from './config';
import '@fontsource/inter-tight/400.css';
import '@fontsource/inter-tight/500.css';
import '@fontsource/inter-tight/600.css';
import '@fontsource/inter-tight/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

// Mock mode is loaded lazily so fixture data never ships in a live-backend build.
async function loadApi(): Promise<ApiClient> {
  if (config.useMocks) {
    const { createMockClient } = await import('./mocks/mockClient');
    return createMockClient({ scenario: config.mockScenario, persist: true });
  }
  return createHttpClient(config.apiBaseUrl);
}

const root = createRoot(document.getElementById('root')!);
void loadApi().then((api) => {
  root.render(
    <StrictMode>
      <BrowserRouter future={ROUTER_FUTURE}>
        <ApiProvider api={api}>
          <App />
        </ApiProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
