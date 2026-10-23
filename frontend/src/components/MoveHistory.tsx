import { useEffect, useRef } from 'react';
import type { MoveRecord } from '../api/types';
import { formatConfidence, formatMs, INVALID_REASON_LABEL } from '../lib/format';
import type { InvalidOutput } from '../state/runReducer';

export interface MoveHistoryProps {
  moves: MoveRecord[];
  /** Rejected outputs from move_invalid events, shown inline but never counted as moves. */
  invalid?: InvalidOutput[];
  /** Hide the confidence column when no model in view reports one. */
  showConfidence?: boolean;
  height?: number;
}

type Row =
  | { kind: 'move'; key: string; order: number; move: MoveRecord }
  | { kind: 'invalid'; key: string; order: number; item: InvalidOutput };

/** Applied moves (Trial.moves) with rejected attempts slotted before the move they preceded. */
export function MoveHistory({ moves, invalid = [], showConfidence = true, height = 220 }: MoveHistoryProps) {
  const rows: Row[] = [
    ...moves.map((m): Row => ({ kind: 'move', key: `m${m.index}`, order: m.index, move: m })),
    ...invalid.map((i): Row => ({ kind: 'invalid', key: `i${i.seq}`, order: i.move_index - 0.5 + i.attempt / 1000, item: i })),
  ].sort((a, b) => a.order - b.order);

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <div className="history" style={{ height }} ref={scroller}>
      <table className="history__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Move</th>
            <th scope="col" className="num">Latency</th>
            {showConfidence && <th scope="col" className="num">Conf.</th>}
            <th scope="col" className="num">Retries</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr className="history__empty">
              <td colSpan={showConfidence ? 5 : 4}>No moves yet</td>
            </tr>
          )}
          {rows.map((row) =>
            row.kind === 'move' ? (
              <tr key={row.key}>
                <td className="num muted">{row.move.index}</td>
                <td className="history__move">{row.move.move}</td>
                <td className="num">{formatMs(row.move.latency_ms)}</td>
                {showConfidence && <td className="num">{formatConfidence(row.move.confidence)}</td>}
                <td className="num muted">{row.move.retries}</td>
              </tr>
            ) : (
              <tr key={row.key} className="history__invalid">
                <td className="num muted">{row.item.move_index}</td>
                <td colSpan={showConfidence ? 4 : 3}>
                  <span aria-hidden="true">⚠ </span>
                  {INVALID_REASON_LABEL[row.item.reason] ?? row.item.reason} (attempt {row.item.attempt})
                  {row.item.raw_response && <code className="history__raw">{row.item.raw_response}</code>}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
