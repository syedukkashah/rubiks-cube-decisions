// Student identity overlay (AGENTS.md 3.8 and 9 item 8). The header variant sits in the fixed,
// topmost app header on every view; the slide variant is the large badge on /slide.
// Missing values render a loud warning instead of nothing.

export interface IdentityBadgeProps {
  name: string;
  roll: string;
  variant?: 'header' | 'slide';
}

export function IdentityBadge({ name, roll, variant = 'header' }: IdentityBadgeProps) {
  const missing = [!name && 'VITE_STUDENT_NAME', !roll && 'VITE_STUDENT_ROLL'].filter(Boolean) as string[];
  if (missing.length) {
    return (
      <div className={`identity identity--${variant} identity--missing`} role="alert" data-testid="identity-badge">
        <strong>⚠ STUDENT IDENTITY MISSING</strong>
        <span>Set {missing.join(' and ')} in frontend/.env and restart the dev server.</span>
        {(name || roll) && <span>{[name, roll].filter(Boolean).join(' · ')}</span>}
      </div>
    );
  }
  return (
    <div className={`identity identity--${variant}`} data-testid="identity-badge" aria-label={`Student ${name}, roll number ${roll}`}>
      <span className="identity__label">STUDENT</span>
      <span className="identity__name">{name}</span>
      <span className="identity__roll">{roll}</span>
    </div>
  );
}
