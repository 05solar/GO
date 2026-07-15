import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PASS, KOMI, emptyState, play, type GoState, type Diff, type FinalResult } from './go';
import { notifyStop, requestAiMove, requestFinalize } from './goAi';
import { movesToSgf } from './sgf';
import { useSquareSize } from '../useSquareSize';
import './GoGame.css';

type BoardSize = 9 | 13;

const MAX_BOARD_PX = 620; // 데스크톱에서 판이 커질 상한

// 크기별 좌표/화점 (간격·반지름은 측정된 폭에서 비례로 계산)
const LAYOUT: Record<BoardSize, { cols: string; stars: number[][] }> = {
  9: { cols: 'ABCDEFGHJ', stars: [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]] },
  13: { cols: 'ABCDEFGHJKLMN', stars: [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]] },
};

const SIZES: { key: BoardSize; label: string }[] = [
  { key: 9, label: '9×9' },
  { key: 13, label: '13×13' },
];

const PLACE_MS = 170; // 착수 팝 애니메이션
const CAPTURE_MS = 300; // 따냄 페이드 애니메이션

type Status = 'playing' | 'scoring' | 'won' | 'lost';

const DIFFS: { key: Diff; label: string }[] = [
  { key: 'easy', label: '쉬움' },
  { key: 'medium', label: '중간' },
  { key: 'hard', label: '어려움' },
];

const DIFF_LABEL: Record<Diff, string> = { easy: '쉬움', medium: '중간', hard: '어려움' };

const BLACK = 1;

// 기보 한 마디: 이 국면과 그 국면을 만든 수(첫 노드는 빈 판, move=null)
interface Node {
  state: GoState;
  move: number | null; // 이 상태를 만든 수 (null=시작, PASS=패스, 그 외=착수점)
  moveNo: number; // 시작(0)부터의 착수 순번 — 홀수=흑, 짝수=백
}

interface Anim {
  idx: number;
  color: 1 | 2;
  kind: 'place' | 'capture';
  t0: number;
}

// 호버 미리보기는 마우스 환경에서만
const HOVER_OK =
  typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: hover)').matches;

// ── 착수음: 웹오디오로 짧은 '딱' 소리 (파일 불필요) ──────────────
let audio: AudioContext | null = null;
function stoneSound(capture: boolean) {
  try {
    type AudioWin = Window & { webkitAudioContext?: typeof AudioContext };
    const AC = window.AudioContext || (window as AudioWin).webkitAudioContext;
    if (!AC) return;
    audio = audio || new AC();
    if (audio.state === 'suspended') void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(capture ? 340 : 230, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.09);
    gain.gain.setValueAtTime(0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  } catch {
    /* 사운드 실패는 무시 */
  }
}

// easeOutBack: 살짝 튀었다 자리 잡는 팝 느낌
function easeOutBack(k: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = k - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function GoGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<BoardSize>(9);
  // 기보: 시작 국면부터의 전체 수순. cursor 는 화면에 보여줄 위치(복기용).
  const [record, setRecord] = useState<Node[]>(() => [
    { state: emptyState(9), move: null, moveNo: 0 },
  ]);
  const [cursor, setCursor] = useState(0);
  const recordRef = useRef(record); // 비동기(워커 응답) 중 최신 기보 참조용
  recordRef.current = record;

  const [status, setStatus] = useState<Status>('playing');
  const [thinking, setThinking] = useState(false);
  const [diff, setDiff] = useState<Diff>('medium');
  const [result, setResult] = useState<FinalResult | null>(null);
  const [resigned, setResigned] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [showCard, setShowCard] = useState(true);
  const [showNumbers, setShowNumbers] = useState(false);
  const [copied, setCopied] = useState(false);
  const reqRef = useRef(0); // 진행 중인 워커 요청 무효화용
  const animsRef = useRef<Anim[]>([]);

  // 현재 보여주는 국면(복기 위치 기준)
  const cur = record[cursor];
  const state = cur.state;
  const lastMove = cur.move != null && cur.move >= 0 ? cur.move : null;
  const moves = cur.moveNo;
  const atTip = cursor === record.length - 1;

  // 반응형 판 크기 — board-wrap 폭을 측정해 비례로 간격/반지름 계산
  const boardPx = useSquareSize(wrapRef, MAX_BOARD_PX);
  const layout = LAYOUT[size];
  const W = boardPx;
  const PAD = Math.round(W * 0.06);
  const STEP = (W - PAD * 2) / (size - 1);
  const R = STEP * 0.46;

  // 좌표 표기(예: D4). 열은 I를 건너뛴 표기, 행은 아래가 1.
  const coordLabel = useCallback(
    (mv: number | null): string => {
      if (mv == null) return '';
      if (mv === PASS) return '패스';
      return `${layout.cols[mv % size]}${size - Math.floor(mv / size)}`;
    },
    [layout, size]
  );

  // 화면을 떠나면 워커 폰더링 중단
  useEffect(() => () => notifyStop(), []);

  // 새 게임 시작(크기 지정). 크기 전환도 이 경로로.
  const startGame = useCallback((nextSize: BoardSize) => {
    reqRef.current++;
    notifyStop();
    animsRef.current = [];
    const fresh: Node[] = [{ state: emptyState(nextSize), move: null, moveNo: 0 }];
    recordRef.current = fresh;
    setSize(nextSize);
    setRecord(fresh);
    setCursor(0);
    setStatus('playing');
    setThinking(false);
    setResult(null);
    setResigned(false);
    setHover(null);
    setShowCard(true);
  }, []);

  const reset = useCallback(() => startGame(size), [startGame, size]);

  // 이전 판 → 새 판 비교로 착수/따냄 애니메이션 등록 + 착수음
  const addAnims = (prev: Int8Array, next: Int8Array, placed: number) => {
    const t0 = performance.now();
    let captured = false;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== 0 && next[i] === 0) {
        animsRef.current.push({ idx: i, color: prev[i] as 1 | 2, kind: 'capture', t0 });
        captured = true;
      }
    }
    if (next[placed] !== 0) {
      animsRef.current.push({ idx: placed, color: next[placed] as 1 | 2, kind: 'place', t0 });
    }
    stoneSound(captured);
  };

  // 기보 끝에 한 마디 추가하고 그 위치로 이동(항상 최신을 보게)
  const appendNode = (node: Node) => {
    const nr = [...recordRef.current, node];
    recordRef.current = nr;
    setRecord(nr);
    setCursor(nr.length - 1);
  };

  // 종국 처리: 죽은 돌 자동 판정(워커) → 한국식 계가
  const finish = useCallback((s: GoState, byResign = false) => {
    setStatus('scoring');
    setThinking(false);
    setResigned(byResign);
    const rid = ++reqRef.current;
    requestFinalize(s).then((sc) => {
      if (rid !== reqRef.current) return; // 그 사이 새 게임 시작됨
      setResult(sc);
      setShowCard(true);
      const humanWon = !byResign && sc.winner === BLACK;
      setStatus(humanWon ? 'won' : 'lost');
    });
  }, []);

  // AI(백) 착수 — 웹워커에서 비동기 탐색
  const aiTurn = useCallback(
    (s: GoState) => {
      setThinking(true);
      const rid = ++reqRef.current;
      requestAiMove(s, diff).then((mv) => {
        if (rid !== reqRef.current) return; // 무르기/새 게임/복기로 무효화됨
        const r = play(s, mv);
        const ns = r ? r.state : play(s, PASS)!.state;
        const played = r && mv !== PASS ? mv : PASS;
        if (r && mv !== PASS) addAnims(s.board, ns.board, mv);
        const tip = recordRef.current[recordRef.current.length - 1];
        appendNode({ state: ns, move: played, moveNo: tip.moveNo + 1 });
        setThinking(false);
        if (ns.passes >= 2) finish(ns);
      });
    },
    [diff, finish]
  );

  // 사람(흑) 착수. 복기 중(과거 국면)에 두면 그 지점부터 새 변화로 이어간다.
  const place = (idx: number) => {
    if (status !== 'playing' || thinking) return;
    if (state.toMove !== BLACK) return;
    const r = play(state, idx);
    if (!r) return; // 불법수(자리참·패·자살수)
    const base = atTip ? recordRef.current : recordRef.current.slice(0, cursor + 1);
    const nr: Node[] = [...base, { state: r.state, move: idx, moveNo: cur.moveNo + 1 }];
    recordRef.current = nr;
    addAnims(state.board, r.state.board, idx);
    setRecord(nr);
    setCursor(nr.length - 1);
    setHover(null);
    if (r.state.passes >= 2) return finish(r.state);
    aiTurn(r.state);
  };

  const humanPass = () => {
    if (status !== 'playing' || thinking || !atTip || state.toMove !== BLACK) return;
    const r = play(state, PASS)!;
    appendNode({ state: r.state, move: PASS, moveNo: cur.moveNo + 1 });
    setHover(null);
    if (r.state.passes >= 2) return finish(r.state);
    aiTurn(r.state);
  };

  // 무르기: 내 마지막 착수 직전(AI 응수 포함)으로 되돌림
  const undo = () => {
    if (status !== 'playing' || thinking) return;
    const rec = recordRef.current;
    if (rec.length <= 1) return;
    const nr = rec.slice();
    const dropped = nr.pop()!;
    if (dropped.moveNo % 2 === 0 && nr.length > 1) nr.pop(); // 백 응수였으면 내 수까지
    reqRef.current++;
    notifyStop();
    animsRef.current = [];
    recordRef.current = nr;
    setRecord(nr);
    setCursor(nr.length - 1);
    setHover(null);
  };

  const resign = () => {
    if (status !== 'playing' || thinking) return;
    finish(state, true);
  };

  // ── 복기(리뷰) 내비게이션 ──────────────────────────────────────
  const goTo = (i: number) => {
    const clamped = Math.max(0, Math.min(record.length - 1, i));
    if (clamped !== cursor) {
      animsRef.current = [];
      setCursor(clamped);
      setHover(null);
    }
  };

  // ── SGF 내보내기 ───────────────────────────────────────────────
  const buildSgf = (): string => {
    const moveList = recordRef.current.slice(1).map((n) => (n.move == null ? PASS : n.move));
    let re: string | undefined;
    if (result && (status === 'won' || status === 'lost')) {
      re = resigned
        ? 'W+R'
        : `${result.winner === BLACK ? 'B' : 'W'}+${result.margin.toFixed(1)}`;
    }
    return movesToSgf(moveList, { size, komi: KOMI, diff: DIFF_LABEL[diff], date: today(), result: re });
  };

  const downloadSgf = () => {
    const blob = new Blob([buildSgf()], { type: 'application/x-go-sgf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `기보-${size}x${size}-${today()}.sgf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copySgf = async () => {
    try {
      await navigator.clipboard.writeText(buildSgf());
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 클립보드 권한 없음 등은 무시 */
    }
  };

  const pointFromEvent = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (W / rect.height);
    const c = Math.round((x - PAD) / STEP);
    const r = Math.round((y - PAD) / STEP);
    return r >= 0 && r < size && c >= 0 && c < size ? r * size + c : null;
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const idx = pointFromEvent(e);
    if (idx != null) place(idx);
  };

  const canPlayHere = status === 'playing' && !thinking && state.toMove === BLACK;

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!HOVER_OK) return;
    if (!canPlayHere) {
      if (hover != null) setHover(null);
      return;
    }
    const idx = pointFromEvent(e);
    const ok = idx != null && state.board[idx] === 0 && idx !== state.ko;
    setHover(ok ? idx : null);
  };

  // 착수 번호 오버레이용: 현재 국면에서 각 교차점의 돌이 몇 수째 놓인 것인지
  const numAt = useMemo(() => {
    if (!showNumbers) return null;
    const arr = new Int16Array(size * size);
    for (let i = 1; i <= cursor; i++) {
      const prev = record[i - 1].state.board;
      const curB = record[i].state.board;
      for (let j = 0; j < arr.length; j++) if (prev[j] !== 0 && curB[j] === 0) arr[j] = 0;
      const mv = record[i].move;
      if (mv != null && mv >= 0) arr[mv] = record[i].moveNo;
    }
    return arr;
  }, [showNumbers, cursor, record, size]);

  // 렌더링 (애니메이션 중에는 rAF 루프)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const COLS = layout.cols;
    const STARS = layout.stars;
    const n = size;
    const FONT_PX = Math.max(8, Math.round(PAD * 0.44)); // 좌표 글자
    const DOT = Math.max(2, STEP * 0.1); // 화점
    const TER = STEP * 0.11; // 종국 집 표시 반칸
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = W * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = W + 'px';

    const px = (idx: number): [number, number] => [PAD + (idx % n) * STEP, PAD + Math.floor(idx / n) * STEP];

    const drawStone = (x: number, y: number, color: number, rad: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      const black = color === BLACK;
      const g = ctx.createRadialGradient(x - rad * 0.27, y - rad * 0.27, 1, x, y, rad);
      if (black) {
        g.addColorStop(0, '#5a5a5a');
        g.addColorStop(1, '#151515');
      } else {
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, '#cfcfcf');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
      if (!black) {
        ctx.strokeStyle = '#b0b0b0';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const gameOver = (status === 'won' || status === 'lost') && result != null;
    const deadSet = gameOver && atTip ? new Set(result.dead) : null;

    const draw = (): boolean => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 판
      ctx.fillStyle = '#e3b877';
      ctx.fillRect(0, 0, W, W);
      ctx.strokeStyle = '#8a5a2b';
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const p = PAD + i * STEP;
        ctx.beginPath();
        ctx.moveTo(PAD, p);
        ctx.lineTo(W - PAD, p);
        ctx.moveTo(p, PAD);
        ctx.lineTo(p, W - PAD);
        ctx.stroke();
      }
      // 좌표 (위: A~, 왼쪽: n~1)
      ctx.fillStyle = 'rgba(90, 58, 30, 0.7)';
      ctx.font = `700 ${FONT_PX}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i++) {
        const p = PAD + i * STEP;
        ctx.fillText(COLS[i], p, PAD * 0.4);
        ctx.fillText(String(n - i), PAD * 0.4, p);
      }
      // 화점
      ctx.fillStyle = '#5a3a1e';
      for (const [r, c] of STARS) {
        ctx.beginPath();
        ctx.arc(PAD + c * STEP, PAD + r * STEP, DOT, 0, Math.PI * 2);
        ctx.fill();
      }

      const now = performance.now();
      animsRef.current = animsRef.current.filter(
        (a) => now - a.t0 < (a.kind === 'place' ? PLACE_MS : CAPTURE_MS)
      );
      const anims = animsRef.current;
      const placeAnim = new Map<number, Anim>();
      for (const a of anims) if (a.kind === 'place') placeAnim.set(a.idx, a);

      // 돌 (죽은 돌은 반투명, 착수 직후엔 팝 애니메이션)
      const b = state.board;
      for (let i = 0; i < b.length; i++) {
        if (!b[i]) continue;
        const [x, y] = px(i);
        let rad = R;
        const a = placeAnim.get(i);
        if (a) {
          const k = Math.min(1, (now - a.t0) / PLACE_MS);
          rad = R * (0.65 + 0.35 * easeOutBack(k));
        }
        const alpha = deadSet?.has(i) ? 0.35 : 1;
        drawStone(x, y, b[i], rad, alpha);
      }
      // 따낸 돌 페이드아웃
      for (const a of anims) {
        if (a.kind !== 'capture') continue;
        const k = Math.min(1, (now - a.t0) / CAPTURE_MS);
        const [x, y] = px(a.idx);
        drawStone(x, y, a.color, R * (1 - 0.25 * k), 1 - k);
      }
      // 착수 번호 오버레이(복기·기보 감상용)
      if (numAt) {
        ctx.font = `700 ${Math.max(8, Math.round(R * 0.85))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < b.length; i++) {
          if (!b[i] || numAt[i] <= 0 || deadSet?.has(i)) continue;
          if (placeAnim.has(i)) continue; // 팝 애니 중엔 생략
          const [x, y] = px(i);
          ctx.fillStyle = b[i] === BLACK ? '#f2f2f2' : '#151515';
          ctx.fillText(String(numAt[i]), x, y);
        }
      } else if (!gameOver && lastMove != null && b[lastMove]) {
        // 마지막 착수 표시 (번호 표시 중엔 생략)
        const [x, y] = px(lastMove);
        ctx.strokeStyle = b[lastMove] === BLACK ? 'rgba(255,238,165,0.95)' : 'rgba(220,60,60,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, R * 0.45, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 착수 미리보기(고스트 돌)
      if (!gameOver && hover != null && b[hover] === 0) {
        const [x, y] = px(hover);
        drawStone(x, y, BLACK, R, 0.4);
      }
      // 종국: 집(영역) 표시 — 사석 자리 포함 (최종 국면에서만)
      if (gameOver && deadSet && result) {
        for (let i = 0; i < b.length; i++) {
          if (b[i] !== 0 && !deadSet.has(i)) continue;
          const t = result.territory[i];
          if (t === 0) continue;
          const [x, y] = px(i);
          if (t === BLACK) {
            ctx.fillStyle = '#151515';
            ctx.fillRect(x - TER, y - TER, TER * 2, TER * 2);
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - TER, y - TER, TER * 2, TER * 2);
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - TER, y - TER, TER * 2, TER * 2);
          }
        }
      }
      return anims.length > 0;
    };

    let raf = 0;
    const loop = () => {
      if (draw()) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [state, lastMove, hover, result, status, layout, size, boardPx, numAt, atTip]);

  const statusText =
    status === 'won'
      ? '승리!'
      : status === 'lost'
      ? resigned
        ? '기권패… 다시 도전!'
        : '패배… 다시 도전!'
      : status === 'scoring'
      ? '계가 중… (죽은 돌 판정)'
      : thinking
      ? 'AI(백)가 생각 중…'
      : !atTip
      ? `복기 중 · ${cursor}/${record.length - 1}수`
      : `내 차례 (흑돌) · ${moves + 1}수째`;

  const busy = thinking || status === 'scoring';
  const gameOver = status === 'won' || status === 'lost';
  const inProgress = moves > 0 && status === 'playing';
  const totalMoves = record.length - 1;

  // 기보 목록: (흑, 백) 짝으로 묶은 행
  const kifuRows: { no: number; b?: { i: number; label: string }; w?: { i: number; label: string } }[] = [];
  for (let i = 1; i < record.length; i += 2) {
    kifuRows.push({
      no: (i + 1) / 2,
      b: { i, label: coordLabel(record[i].move) },
      w: record[i + 1] ? { i: i + 1, label: coordLabel(record[i + 1].move) } : undefined,
    });
  }

  return (
    <main className="page baduk">
      <div className="baduk__bar">
        <span
          className={
            'baduk__status' + (gameOver ? ' done' : '') + (busy ? ' busy' : '') + (!atTip ? ' review' : '')
          }
        >
          {statusText}
        </span>
      </div>

      <div className="baduk__meta">
        <span className="baduk__cap">흑 따냄 {state.capB}</span>
        <span className="baduk__cap">백 따냄 {state.capW}</span>
        <span className="baduk__cap">덤 {KOMI}</span>
      </div>

      <div className="baduk__diff">
        <span className="baduk__diff-label">판 크기</span>
        <div className="baduk__diff-seg">
          {SIZES.map((sz) => (
            <button
              key={sz.key}
              className={'baduk__diff-btn' + (size === sz.key ? ' on' : '')}
              onClick={() => size !== sz.key && startGame(sz.key)}
              title={inProgress ? '판을 바꾸면 새 게임이 시작됩니다' : undefined}
            >
              {sz.label}
            </button>
          ))}
        </div>
      </div>

      <div className="baduk__diff">
        <span className="baduk__diff-label">난이도</span>
        <div className="baduk__diff-seg">
          {DIFFS.map((d) => (
            <button
              key={d.key}
              className={'baduk__diff-btn' + (diff === d.key ? ' on' : '')}
              onClick={() => setDiff(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="baduk__board-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className={'baduk__canvas' + (!atTip ? ' review' : '')}
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        />
        {gameOver && result && (
          showCard ? (
            <div className="baduk__over" onClick={() => setShowCard(false)}>
              <div className="baduk__over-card" onClick={(e) => e.stopPropagation()}>
                <h3>{status === 'won' ? '승리!' : resigned ? '기권패' : '패배'}</h3>
                <p className="baduk__over-score">
                  흑 {result.black}집 · 백 {result.white.toFixed(1)}집
                </p>
                <p className="baduk__over-margin">
                  {result.dead.length > 0 ? `사석 ${result.dead.length}개 자동 판정 · ` : ''}
                  {result.winner === BLACK ? '흑' : '백'} {result.margin.toFixed(1)}집 승
                </p>
                <div className="baduk__over-btns">
                  <button className="baduk__btn baduk__btn--primary" onClick={reset}>
                    다시하기
                  </button>
                  <button className="baduk__btn" onClick={() => setShowCard(false)}>
                    기보 복기
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button className="baduk__over-chip" onClick={() => setShowCard(true)}>
              결과 보기
            </button>
          )
        )}
      </div>

      {/* 복기 내비게이션 */}
      <div className="baduk__review">
        <div className="baduk__nav">
          <button className="baduk__nav-btn" onClick={() => goTo(0)} disabled={cursor === 0} title="처음">
            ⏮
          </button>
          <button className="baduk__nav-btn" onClick={() => goTo(cursor - 1)} disabled={cursor === 0} title="이전 수">
            ◀
          </button>
          <span className="baduk__nav-pos">
            {cursor} <span className="baduk__nav-sep">/</span> {totalMoves}
          </span>
          <button
            className="baduk__nav-btn"
            onClick={() => goTo(cursor + 1)}
            disabled={atTip}
            title="다음 수"
          >
            ▶
          </button>
          <button className="baduk__nav-btn" onClick={() => goTo(totalMoves)} disabled={atTip} title="마지막">
            ⏭
          </button>
        </div>
        <button
          className={'baduk__toggle' + (showNumbers ? ' on' : '')}
          onClick={() => setShowNumbers((v) => !v)}
          title="돌 위에 착수 순번 표시"
        >
          수순 {showNumbers ? '켜짐' : '꺼짐'}
        </button>
      </div>

      {/* 기보 목록 */}
      {totalMoves > 0 && (
        <div className="baduk__kifu">
          {kifuRows.map((row) => (
            <div className="baduk__kifu-row" key={row.no}>
              <span className="baduk__kifu-no">{row.no}</span>
              <button
                className={'baduk__kifu-cell b' + (cursor === row.b!.i ? ' on' : '')}
                onClick={() => goTo(row.b!.i)}
              >
                {row.b!.label}
              </button>
              {row.w ? (
                <button
                  className={'baduk__kifu-cell w' + (cursor === row.w.i ? ' on' : '')}
                  onClick={() => goTo(row.w!.i)}
                >
                  {row.w.label}
                </button>
              ) : (
                <span className="baduk__kifu-cell empty" />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="baduk__actions">
        <button
          className="baduk__btn"
          onClick={humanPass}
          disabled={status !== 'playing' || busy || !atTip}
        >
          패스
        </button>
        <button
          className="baduk__btn"
          onClick={undo}
          disabled={status !== 'playing' || busy || record.length <= 1}
        >
          무르기
        </button>
        <button className="baduk__btn" onClick={resign} disabled={status !== 'playing' || busy}>
          기권
        </button>
        <button className="baduk__btn" onClick={reset}>
          새 게임
        </button>
      </div>

      <div className="baduk__actions baduk__actions--sgf">
        <button className="baduk__btn" onClick={downloadSgf} disabled={totalMoves === 0}>
          SGF 저장
        </button>
        <button className="baduk__btn" onClick={copySgf} disabled={totalMoves === 0}>
          {copied ? '복사됨 ✓' : 'SGF 복사'}
        </button>
      </div>

      <p className="baduk__hint">
        교차점을 눌러 흑돌을 놓으세요. 과거 수로 돌아가 다른 곳에 두면 그 자리부터 새 변화로 이어집니다. 두 번
        연속 패스하면 죽은 돌을 자동 판정해 계가합니다 · 한국식 계가(집 + 사석) · 백 덤 {KOMI}집
      </p>
    </main>
  );
}
