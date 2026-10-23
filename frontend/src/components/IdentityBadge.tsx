// Student identity overlay (AGENTS.md 3.8 and 9 item 8). Rendered once at the app root,
// outside every route, fixed and topmost so it is visible on every view for the whole
// recording. Missing values render a loud warning instead of nothing.

export function IdentityBadge({ name, roll }: { name: string; roll: string }) {
  const missing = [!name && 'VITE_STUDENT_NAME', !roll && 'VITE_STUDENT_ROLL'].filter(Boolean) as string[];
  if (missing.length) {
    return (
      <div className="identity identity--missing" role="alert" data-testid="identity-badge">
        <strong>⚠ STUDENT IDENTITY MISSING</strong>
        <span>
          Set {missing.join(' and ')} in frontend/.env and restart the dev server.
        </span>
        {(name || roll) && <span>{[name, roll].filter(Boolean).join(' · ')}</span>}
      </div>
    );
  }
  return (
    <div className="identity" data-testid="identity-badge" aria-label={`Student ${name}, roll number ${roll}`}>
      <span className="identity__name">{name}</span>
      <span className="identity__roll">Roll No. {roll}</span>
    </div>
  );
}
