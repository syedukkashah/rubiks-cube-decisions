import { CONTRACT_VERSION, type Health } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

const major = (v: string) => v.split('.')[0] ?? '';

/** Backend reachability, contract major-version match (AGENTS.md 7.4) and API-key setup state. */
export function HealthBanner({ health, error, onRetry }: { health: Health | null; error: unknown; onRetry: () => void }) {
  if (error) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (!health) return null;
  const mismatch = health.contract_version && major(health.contract_version) !== major(CONTRACT_VERSION);
  return (
    <>
      {mismatch && (
        <div className="notice notice--error" role="alert">
          <span className="notice__icon" aria-hidden="true">!</span>
          <div className="notice__body">
            <strong>API contract mismatch</strong>
            <span className="notice__message">
              Backend speaks contract v{health.contract_version}; this frontend was built for v{CONTRACT_VERSION}. Data may
              display incorrectly until both sides are updated (AGENTS.md section 7).
            </span>
          </div>
        </div>
      )}
      {!health.api_key_configured && (
        <div className="notice notice--warn" role="alert">
          <span className="notice__icon" aria-hidden="true">!</span>
          <div className="notice__body">
            <strong>OpenRouter API key not configured on the backend</strong>
            <span className="notice__guidance">
              Live runs need it. The one-click benchmark still works: it simulates, or replays a saved live recording,
              with no OpenRouter calls. For the live pass, put OPENROUTER_API_KEY in backend/.env (see
              backend/.env.example) and restart the backend. The key never goes into the frontend.
            </span>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onRetry}>
            Re-check
          </button>
        </div>
      )}
    </>
  );
}
