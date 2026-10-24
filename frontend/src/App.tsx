import { Navigate, Outlet, Route, Routes, useLocation, useSearchParams, Link } from 'react-router-dom';
import { useApi } from './api/ApiContext';
import { HealthBanner } from './components/HealthBanner';
import { IdentityBadge } from './components/IdentityBadge';
import { SourceChip } from './components/SourceChip';
import { config } from './config';
import { BenchmarkPage } from './pages/BenchmarkPage';
import { StatsSlidePage } from './pages/StatsSlidePage';
import { ShellStatusProvider, useShellStatus, type Stage } from './state/shellStatus';
import { useAsync } from './state/useAsync';
import type { StreamStatus } from './state/useRunSession';

// eslint-disable-next-line react-refresh/only-export-components
export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

const STREAM_TEXT: Record<StreamStatus, string> = {
  idle: 'No run selected',
  loading: 'Loading run…',
  connecting: 'Connecting…',
  live: 'Live · SSE connected',
  reconnecting: 'Reconnecting…',
  closed: 'Run complete · stream closed',
  error: 'Run failed to load',
};

/** Query string that keeps the selected session/run when moving between views. */
function selection(params: URLSearchParams): URLSearchParams {
  const keep = new URLSearchParams();
  for (const key of ['session', 'run']) {
    const v = params.get(key);
    if (v) keep.set(key, v);
  }
  return keep;
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="0" y="0" width="10" height="10" rx="2" fill="#E0393E" />
      <rect x="12" y="0" width="10" height="10" rx="2" fill="#F2F3F5" />
      <rect x="0" y="12" width="10" height="10" rx="2" fill="#2D6BDF" />
      <rect x="12" y="12" width="10" height="10" rx="2" fill="#22A95B" />
    </svg>
  );
}

function Header() {
  const api = useApi();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const status = useShellStatus();
  const sel = selection(params);
  const hasRun = sel.toString() !== '';
  const view = (stage: Stage) => {
    const q = new URLSearchParams(sel);
    q.set('view', stage);
    return `/?${q.toString()}`;
  };
  const current: Stage | 'slide' = pathname.startsWith('/slide') ? 'slide' : status.stage;
  const items: { key: Stage | 'slide'; label: string; to: string | null }[] = [
    { key: 'setup', label: 'Setup', to: '/' },
    { key: 'race', label: 'Race', to: hasRun ? view('race') : null },
    { key: 'results', label: 'Results', to: hasRun ? view('results') : null },
    { key: 'slide', label: 'Slide', to: hasRun ? `/slide?${sel.toString()}` : '/slide' },
  ];
  const streaming = status.stream === 'live' || status.stream === 'connecting' || status.stream === 'reconnecting';

  return (
    <header className="appbar">
      <div className="appbar__brand">
        <Logo />
        <span className="appbar__name">Cube Race</span>
        <span className="appbar__sub">Assignment 02</span>
      </div>
      <nav className="appbar__nav" aria-label="Views">
        {items.map((item) =>
          item.to ? (
            <Link key={item.key} to={item.to} aria-current={current === item.key ? 'page' : undefined}>
              {item.label}
            </Link>
          ) : (
            <span key={item.key} aria-disabled="true" title="Start or open a run first">
              {item.label}
            </span>
          ),
        )}
      </nav>
      <div className="appbar__spacer" />
      {status.stage !== 'setup' && (
        <span className={`stream stream--${status.stream}`}>
          <span className={`stream__dot ${streaming ? 'pulse' : ''}`} aria-hidden="true" />
          {STREAM_TEXT[status.stream]}
        </span>
      )}
      {status.session && <SourceChip session={status.session} />}
      <span className={`mode mode--${api.mode}`} title={api.mode === 'mock' ? 'VITE_USE_MOCKS=true: fixtures, no backend' : 'Connected to the backend API'}>
        {api.mode === 'mock' ? 'MOCK DATA' : 'BACKEND'}
      </span>
      <IdentityBadge name={config.studentName} roll={config.studentRoll} />
    </header>
  );
}

function Shell() {
  const api = useApi();
  const health = useAsync(() => api.getHealth(), [api]);
  return (
    <div className="shell">
      <Header />
      <div className="shell__notices">
        <HealthBanner health={health.data} error={health.error} onRetry={health.reload} />
      </div>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <ShellStatusProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<BenchmarkPage />} />
        </Route>
        <Route path="/slide" element={<StatsSlidePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ShellStatusProvider>
  );
}
