import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { N, BLACK, WHITE, checkWin, emptyBoard, inRange, isFull, forbidden, FORBIDDEN_LABEL, type Board, type Diff } from './omok';
import { requestOmokMove } from './omokAi';
import { playPlace } from '../sound';
import { useSquareSize } from '../useSquareSize';
import './OmokGame.css';

const MAX_BOARD_PX = 620; // 데스크톱에서 판이 커질 상한
const STARS = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
type Status = 'playing' | 'won' | 'lost' | 'draw';

const DIFFS: { key: Diff; label: string }[] = [
  { key: 'easy', label: '쉬움' },
  { key: 'medium', label: '중간' },
  { key: 'hard', label: '어려움' },
];

export default function OmokGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [status, setStatus] = useState<Status>('playing');
  const [thinking, setThinking] = useState(false);
  const [diff, setDiff] = useState<Diff>('medium');
  const [lastMove, setLastMove] = useState<[number, number] | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // 금수 안내(잠깐 표시)
  const reqRef = useRef(0); // 새 게임 시 진행 중이던 AI 응답 무효화용
  const noticeTimer = useRef(0);

  // 흑(사람)의 금수 자리 — 렌주룰(삼삼·사사·장목). 표시·클릭 차단용.
  const forbiddenPoints = useMemo(() => {
    if (status !== 'playing') return [] as [number, number][];
    const pts: [number, number][] = [];
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++)
        if (!board[r][c] && forbidden(board, r, c) !== 'none') pts.push([r, c]);
    return pts;
  }, [board, status]);

  // 반응형 판 크기 — board-wrap 폭을 측정해 비례로 간격/반지름 계산
  const W = useSquareSize(wrapRef, MAX_BOARD_PX);
  const PAD = Math.round(W * 0.04);
  const STEP = (W - PAD * 2) / (N - 1);
  const R = STEP * 0.42;

  const reset = useCallback(() => {
    reqRef.current++;
    setBoard(emptyBoard());
    setStatus('playing');
    setThinking(false);
    setLastMove(null);
    setNotice(null);
  }, []);

  const place = (r: number, c: number) => {
    if (status !== 'playing' || thinking || board[r][c]) return;
    // 렌주룰 금수(흑): 삼삼·사사·장목은 둘 수 없다
    const fb = forbidden(board, r, c);
    if (fb !== 'none') {
      setNotice(`금수 · ${FORBIDDEN_LABEL[fb]} 자리에는 둘 수 없어요`);
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), 2000);
      return;
    }
    const nb = board.map((row) => [...row]) as Board;
    nb[r][c] = BLACK;
    setBoard(nb);
    setLastMove([r, c]);
    playPlace();
    if (checkWin(nb, r, c, BLACK)) return setStatus('won');
    if (isFull(nb)) return setStatus('draw');
    setThinking(true);
    const rid = ++reqRef.current;
    requestOmokMove(nb, diff).then(([ar, ac]) => {
      if (rid !== reqRef.current) return; // 새 게임으로 무효화됨
      const nb2 = nb.map((row) => [...row]) as Board;
      nb2[ar][ac] = WHITE;
      setBoard(nb2);
      setLastMove([ar, ac]);
      playPlace();
      setThinking(false);
      if (checkWin(nb2, ar, ac, WHITE)) return setStatus('lost');
      if (isFull(nb2)) return setStatus('draw');
    });
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (W / rect.height);
    const c = Math.round((x - PAD) / STEP);
    const r = Math.round((y - PAD) / STEP);
    if (inRange(r, c)) place(r, c);
  };

  // 렌더링
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = W * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = W + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 판
    ctx.fillStyle = '#e3b877';
    ctx.fillRect(0, 0, W, W);
    ctx.strokeStyle = '#8a5a2b';
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const p = PAD + i * STEP;
      ctx.beginPath();
      ctx.moveTo(PAD, p); ctx.lineTo(W - PAD, p);
      ctx.moveTo(p, PAD); ctx.lineTo(p, W - PAD);
      ctx.stroke();
    }
    // 화점
    const DOT = Math.max(2, STEP * 0.14);
    ctx.fillStyle = '#5a3a1e';
    for (const [r, c] of STARS) {
      ctx.beginPath();
      ctx.arc(PAD + c * STEP, PAD + r * STEP, DOT, 0, Math.PI * 2);
      ctx.fill();
    }
    // 돌
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        if (!board[r][c]) continue;
        const x = PAD + c * STEP, y = PAD + r * STEP;
        const black = board[r][c] === BLACK;
        const g = ctx.createRadialGradient(x - R * 0.3, y - R * 0.3, 1, x, y, R);
        if (black) { g.addColorStop(0, '#5a5a5a'); g.addColorStop(1, '#151515'); }
        else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfcfcf'); }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, R, 0, Math.PI * 2);
        ctx.fill();
        if (!black) { ctx.strokeStyle = '#b0b0b0'; ctx.lineWidth = 0.8; ctx.stroke(); }
      }
    // 금수 자리 표시(흑 렌주룰): 붉은 ✕
    const XS = STEP * 0.17;
    ctx.strokeStyle = 'rgba(206, 42, 42, 0.8)';
    ctx.lineWidth = 2;
    for (const [fr, fc] of forbiddenPoints) {
      const x = PAD + fc * STEP, y = PAD + fr * STEP;
      ctx.beginPath();
      ctx.moveTo(x - XS, y - XS); ctx.lineTo(x + XS, y + XS);
      ctx.moveTo(x + XS, y - XS); ctx.lineTo(x - XS, y + XS);
      ctx.stroke();
    }
    // 방금 착수한 돌: 옅게 빛나는 테두리
    if (lastMove) {
      const [lr, lc] = lastMove;
      if (board[lr][lc]) {
        const x = PAD + lc * STEP, y = PAD + lr * STEP;
        ctx.save();
        ctx.shadowColor = 'rgba(255, 224, 120, 0.9)';
        ctx.shadowBlur = 9;
        ctx.strokeStyle = 'rgba(255, 238, 165, 0.95)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, R + STEP * 0.08, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [board, lastMove, forbiddenPoints, W, PAD, STEP, R]);

  const statusText =
    status === 'won' ? '승리!'
    : status === 'lost' ? '패배… 다시 도전!'
    : status === 'draw' ? '무승부'
    : thinking ? 'AI가 생각 중…' : '내 차례 (흑돌)';

  return (
    <main className="page omok">
      <div className="omok__bar">
        <span className={'omok__status' + (status !== 'playing' ? ' done' : '')}>{statusText}</span>
        {notice && <span className="omok__notice">{notice}</span>}
      </div>

      <div className="omok__diff">
        <span className="omok__diff-label">난이도</span>
        <div className="omok__diff-seg">
          {DIFFS.map((d) => (
            <button
              key={d.key}
              className={'omok__diff-btn' + (diff === d.key ? ' on' : '')}
              onClick={() => setDiff(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="omok__board-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="omok__canvas" onClick={onClick} />
        {status !== 'playing' && (
          <div className="omok__over">
            <div className="omok__over-card">
              <h3>
                {status === 'won' ? '승리!' : status === 'lost' ? '패배' : '무승부'}
              </h3>
              <div className="omok__over-btns">
                <button className="omok__btn omok__btn--primary" onClick={reset}>다시하기</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="omok__actions">
        <button className="omok__btn" onClick={reset}>새 게임</button>
      </div>
      <p className="omok__hint">
        교차점을 눌러 흑돌을 놓으세요. 먼저 5개를 연결하면 승리! 흑은 렌주룰 금수(삼삼·사사·장목,{' '}
        <span className="omok__x">✕</span> 표시)에는 둘 수 없습니다.
      </p>
    </main>
  );
}
