import { memo } from 'react';

// Renders a 54-character facelet string (Kociemba order U R F D L B, AGENTS.md 4.2)
// as an unfolded net. Pure rendering: it never applies or interprets moves.
//
//        U
//     L  F  R  B
//        D

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
type Face = (typeof FACE_ORDER)[number];

/** Grid position (in face units) of each face in the net. */
const FACE_POS: Record<Face, [number, number]> = {
  U: [1, 0],
  L: [0, 1],
  F: [1, 1],
  R: [2, 1],
  B: [3, 1],
  D: [1, 2],
};

/** Standard Western scheme: each letter is the face whose centre the colour belongs to. */
const FACE_COLORS: Record<Face, string> = {
  U: '#f4f4f1',
  R: '#d0312d',
  F: '#1f9d55',
  D: '#f7d417',
  L: '#f2780c',
  B: '#2563d6',
};

const FACE_NAMES: Record<Face, string> = { U: 'Up', R: 'Right', F: 'Front', D: 'Down', L: 'Left', B: 'Back' };

const STICKER = 10;
const GAP = 1.2;
const FACE_GAP = 3;
const FACE_SIZE = 3 * STICKER + 2 * GAP;
const WIDTH = 4 * FACE_SIZE + 3 * FACE_GAP;
const HEIGHT = 3 * FACE_SIZE + 2 * FACE_GAP;

const isFace = (c: string): c is Face => (FACE_ORDER as readonly string[]).includes(c);

function isRenderableFacelets(facelets: string): boolean {
  return facelets.length === 54 && [...facelets].every(isFace);
}

export interface CubeNetProps {
  facelets: string;
  /** Face to outline, e.g. the face turned by the latest move. */
  highlightFace?: string | null;
  size?: number;
  label?: string;
}

function CubeNetImpl({ facelets, highlightFace = null, size = 220, label = 'Cube state' }: CubeNetProps) {
  const height = (size * HEIGHT) / WIDTH;
  if (!isRenderableFacelets(facelets)) {
    return (
      <div className="cube-net cube-net--empty" style={{ width: size, height }} role="img" aria-label={`${label}: unavailable`}>
        <span>State unavailable</span>
      </div>
    );
  }
  return (
    <svg
      className="cube-net"
      width={size}
      height={height}
      viewBox={`${-FACE_GAP} ${-FACE_GAP} ${WIDTH + 2 * FACE_GAP} ${HEIGHT + 2 * FACE_GAP}`}
      role="img"
      aria-label={`${label}: ${facelets}`}
      data-facelets={facelets}
    >
      {FACE_ORDER.map((face, fi) => {
        const [col, row] = FACE_POS[face];
        const ox = col * (FACE_SIZE + FACE_GAP);
        const oy = row * (FACE_SIZE + FACE_GAP);
        return (
          <g key={face} data-face={face}>
            <title>{FACE_NAMES[face]} face</title>
            {Array.from({ length: 9 }, (_, i) => {
              const c = facelets[fi * 9 + i] as Face;
              return (
                <rect
                  key={i}
                  className="cube-net__sticker"
                  x={ox + (i % 3) * (STICKER + GAP)}
                  y={oy + Math.floor(i / 3) * (STICKER + GAP)}
                  width={STICKER}
                  height={STICKER}
                  rx={1.6}
                  fill={FACE_COLORS[c]}
                />
              );
            })}
            {highlightFace === face && (
              <rect
                className="cube-net__highlight"
                x={ox - 1.6}
                y={oy - 1.6}
                width={FACE_SIZE + 3.2}
                height={FACE_SIZE + 3.2}
                rx={2.5}
                fill="none"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export const CubeNet = memo(CubeNetImpl);
