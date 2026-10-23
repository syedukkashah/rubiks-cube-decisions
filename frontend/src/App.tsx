import { NavLink, Navigate, Outlet, Route, Routes, useSearchParams } from 'react-router-dom';
import { useApi } from './api/ApiContext';
import { CONTRACT_VERSION } from './api/types';
import { HealthBanner } from './components/HealthBanner';
import { IdentityBadge } from './components/IdentityBadge';
import { config } from './config';
import { BenchmarkPage } from './pages/BenchmarkPage';
import { StatsSlidePage } from './pages/StatsSlidePage';
import { useAsync } from './state/useAsync';

// eslint-disable-next-line react-refresh/only-export-components
export const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

function Shell() {
  const api = useApi();
  const health = useAsync(() => api.getHealth(), [api]);
  const [params] = useSearchParams();
  const run = params.get('run');
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__logo" aria-hidden="true" />
          <div>
            <h1>Rubik’s Cube Race</h1>
            <p>Fast decision models vs a frontier LLM</p>
          </div>
        </div>
        <nav className="topnav" aria-label="Views">
          <NavLink to={run ? `/?run=${encodeURIComponent(run)}` : '/'} end>
            Benchmark
          </NavLink>
          <NavLink to={run ? `/slide?run=${encodeURIComponent(run)}` : '/slide'}>Final slide</NavLink>
        </nav>
        <div className="topbar__chips">
          <span className={`chip ${api.mode === 'mock' ? 'chip--warn' : 'chip--ok'}`}>
            {api.mode === 'mock' ? 'Mock data' : 'Live backend'}
          </span>
          <span className="chip" title="API contract version">
            Contract v{health.data?.contract_version || CONTRACT_VERSION}
          </span>
        </div>
      </header>
      <div className="shell__notices">
        <HealthBanner health={health.data} error={health.error} onRetry={health.reload} />
      </div>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<BenchmarkPage />} />
        </Route>
        <Route path="/slide" element={<StatsSlidePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <IdentityBadge name={config.studentName} roll={config.studentRoll} />
    </>
  );
}
