import { Fragment } from 'react';

/**
 * A move string as the backend sent it (e.g. "R'", "U2"), rendered as one token.
 * JetBrains Mono gives the ASCII apostrophe a full character cell, so "R'" would read as "R '";
 * each prime gets its own span that styles.css pulls tight against the letter. The text content
 * stays exactly the backend's string, so copying it still gives "R'".
 */
export function MoveText({ move, className }: { move: string; className?: string }) {
  const parts = move.split("'");
  return (
    <span className={className ? `move ${className}` : 'move'}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <span className="move__prime">'</span>}
        </Fragment>
      ))}
    </span>
  );
}
