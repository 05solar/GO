// 오목(15×15) 규칙 + 알파-베타 수읽기 AI
// - 정적 평가: 판 위 모든 길이-5 창(window)을 훑어 흑/백 잠재력 합산
// - AI: 한 수 승리/방어를 먼저 처리한 뒤 알파-베타로 여러 수 앞을 내다본다
export const N = 15;
export const BLACK = 1;
export const WHITE = 2;
export type Cell = 0 | 1 | 2;
export type Board = Cell[][];
export type Diff = 'easy' | 'medium' | 'hard';

export const emptyBoard = (): Board => Array.from({ length: N }, () => Array<Cell>(N).fill(0));

const DIRS = [
  [0, 1], [1, 0], [1, 1], [1, -1],
];

export function inRange(r: number, c: number) {
  return r >= 0 && r < N && c >= 0 && c < N;
}

export function checkWin(b: Board, r: number, c: number, who: Cell): boolean {
  for (const [dr, dc] of DIRS) {
    let cnt = 1;
    for (let s = 1; s < 5; s++) {
      const nr = r + dr * s, nc = c + dc * s;
      if (inRange(nr, nc) && b[nr][nc] === who) cnt++;
      else break;
    }
    for (let s = 1; s < 5; s++) {
      const nr = r - dr * s, nc = c - dc * s;
      if (inRange(nr, nc) && b[nr][nc] === who) cnt++;
      else break;
    }
    if (cnt >= 5) return true;
  }
  return false;
}

export function isFull(b: Board): boolean {
  return b.every((row) => row.every((v) => v));
}

// (r,c)에 who가 뒀다고 가정했을 때의 라인 점수 합 (후보 정렬용)
function patternScore(len: number, ends: number): number {
  if (len >= 5) return 100000;
  if (len === 4) return ends === 2 ? 10000 : ends === 1 ? 1000 : 0;
  if (len === 3) return ends === 2 ? 1000 : ends === 1 ? 100 : 0;
  if (len === 2) return ends === 2 ? 100 : ends === 1 ? 10 : 0;
  if (len === 1) return ends === 2 ? 10 : ends === 1 ? 1 : 0;
  return 0;
}
function cellScore(b: Board, r: number, c: number, who: Cell): number {
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let len = 1;
    let ends = 0;
    let s = 1;
    while (true) {
      const nr = r + dr * s, nc = c + dc * s;
      if (inRange(nr, nc) && b[nr][nc] === who) { len++; s++; }
      else { if (inRange(nr, nc) && b[nr][nc] === 0) ends++; break; }
    }
    s = 1;
    while (true) {
      const nr = r - dr * s, nc = c - dc * s;
      if (inRange(nr, nc) && b[nr][nc] === who) { len++; s++; }
      else { if (inRange(nr, nc) && b[nr][nc] === 0) ends++; break; }
    }
    total += patternScore(len, ends);
  }
  return total;
}
function hasNeighbor(b: Board, r: number, c: number): boolean {
  for (let dr = -2; dr <= 2; dr++)
    for (let dc = -2; dc <= 2; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (inRange(nr, nc) && b[nr][nc]) return true;
    }
  return false;
}
function candidates(b: Board): [number, number][] {
  const list: [number, number][] = [];
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++)
      if (!b[r][c] && hasNeighbor(b, r, c)) list.push([r, c]);
  return list;
}

// ── 정적 평가: 판 위 모든 길이-5 창을 훑어 흑/백 잠재력을 합산 ──
// 한 창 안에 한쪽 색만 있으면 그 색 돌 수에 따라 가치를 준다(백 +, 흑 −).
// 열린 4·닫힌 4, 3, 2 …가 자연스럽게 반영돼 그리디 1-플라이보다 형세를 잘 읽는다.
const WIN = 1_000_000;
const RUN = [0, 1, 14, 160, 1800, WIN]; // 창 안 같은 색 돌 수(0~5)별 가치
export function evalBoard(b: Board): number {
  let s = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      for (const [dr, dc] of DIRS) {
        const er = r + dr * 4, ec = c + dc * 4;
        if (!inRange(er, ec)) continue; // 창이 판을 벗어나면 건너뜀
        let w = 0, bl = 0;
        for (let k = 0; k < 5; k++) {
          const v = b[r + dr * k][c + dc * k];
          if (v === WHITE) w++;
          else if (v === BLACK) bl++;
        }
        if (w && bl) continue; // 두 색이 섞인 창은 무가치
        if (w) s += RUN[w];
        else if (bl) s -= RUN[bl];
      }
    }
  }
  return s;
}

// 후보들을 정적 점수(공격+수비 근접도) 순으로 정렬 — 알파-베타 가지치기 효율 ↑
function ordered(cs: [number, number][], b: Board, k: number): [number, number][] {
  if (cs.length <= 1) return cs;
  return cs
    .map(([r, c]) => ({ rc: [r, c] as [number, number], v: cellScore(b, r, c, WHITE) + cellScore(b, r, c, BLACK) }))
    .sort((a, z) => z.v - a.v)
    .slice(0, Math.min(k, cs.length))
    .map((o) => o.rc);
}

// who가 지금 한 수로 5목을 만드는 자리들(=반드시 대응해야 하는 위협)
function winningPoints(b: Board, cs: [number, number][], who: Cell): [number, number][] {
  const res: [number, number][] = [];
  for (const [r, c] of cs) {
    b[r][c] = who;
    const w = checkWin(b, r, c, who);
    b[r][c] = 0;
    if (w) res.push([r, c]);
  }
  return res;
}

// 강제수 탐색이 들어간 알파-베타 미니맥스.
// - 둘 차례 쪽이 5목 완성 가능 → 그 즉시 승리로 평가(굳이 두지 않아도 됨)
// - 상대가 5목 완성 위협(열린/막힌 4)을 걸어두면 → 후보를 '막는 수'로 강제(가지치기 + 심화)
//   이 두 규칙 덕에 4 위협은 절대 놓치지 않고, 강제 라인은 깊게 파고든다.
function minimax(
  b: Board, depth: number, alpha: number, beta: number, maxing: boolean, k: number, deadline: number
): number {
  if (performance.now() > deadline) return evalBoard(b); // 시간 초과 → 정적 평가로 중단
  const cs = candidates(b);
  if (!cs.length) return evalBoard(b);
  const who: Cell = maxing ? WHITE : BLACK;
  const opp: Cell = maxing ? BLACK : WHITE;

  // 내가 지금 5목을 완성할 수 있으면 = 내 승리
  for (const [r, c] of cs) {
    b[r][c] = who;
    const w = checkWin(b, r, c, who);
    b[r][c] = 0;
    if (w) return maxing ? WIN + depth : -(WIN + depth);
  }
  if (depth <= 0) return evalBoard(b);

  // 상대가 5목 완성 위협을 걸어뒀으면 그 자리들만(강제 방어)
  const forced = winningPoints(b, cs, opp);
  const moveCands = forced.length ? forced : ordered(cs, b, k);

  let best = maxing ? -Infinity : Infinity;
  for (const [r, c] of moveCands) {
    b[r][c] = who;
    const v = checkWin(b, r, c, who)
      ? (maxing ? WIN + depth : -(WIN + depth))
      : minimax(b, depth - 1, alpha, beta, !maxing, k, deadline);
    b[r][c] = 0;
    if (maxing) {
      if (v > best) best = v;
      if (best > alpha) alpha = best;
    } else {
      if (v < best) best = v;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break; // 가지치기
  }
  return best;
}

// 루트 탐색: 이번 깊이의 최선수/평가/완료여부 반환
function searchRoot(
  b: Board, depth: number, k: number, deadline: number
): { move: [number, number]; val: number; done: boolean } {
  const cands = ordered(candidates(b), b, 16);
  let bestMove = cands[0];
  let bestVal = -Infinity;
  let alpha = -Infinity;
  let done = true;
  for (const [r, c] of cands) {
    if (performance.now() > deadline) { done = false; break; }
    b[r][c] = WHITE;
    const v = checkWin(b, r, c, WHITE)
      ? WIN + depth
      : minimax(b, depth - 1, alpha, Infinity, false, k, deadline);
    b[r][c] = 0;
    if (v > bestVal) { bestVal = v; bestMove = [r, c]; }
    if (v > alpha) alpha = v;
  }
  return { move: bestMove, val: bestVal, done };
}

// AI(백) 착수 결정 — 반복심화(iterative deepening) + 시간 예산.
// 중간=최대 6수, 어려움=최대 10수까지, 강제 라인은 그보다 더 깊이 읽는다.
export function chooseMove(b: Board, diff: Diff, budgetMs: number): [number, number] {
  const cs = candidates(b);
  if (!cs.length) return [Math.floor(N / 2), Math.floor(N / 2)];

  // 쉬움: 35% 무작위, 아니면 수비를 거의 안 보는 약한 상위 후보 중 랜덤
  if (diff === 'easy') {
    if (Math.random() < 0.35) return cs[Math.floor(Math.random() * cs.length)];
    const scored = cs
      .map(([r, c]) => ({ rc: [r, c] as [number, number], v: cellScore(b, r, c, WHITE) + cellScore(b, r, c, BLACK) * 0.3 }))
      .sort((a, z) => z.v - a.v);
    const top = scored.slice(0, Math.min(5, scored.length));
    return top[Math.floor(Math.random() * top.length)].rc;
  }

  // 1) 한 수로 이기면 즉시 둔다
  const myWins = winningPoints(b, cs, WHITE);
  if (myWins.length) return myWins[0];
  // 2) 상대가 한 수로 이기는 자리는 즉시 막는다
  const blocks = winningPoints(b, cs, BLACK);
  if (blocks.length) return blocks[0];

  // 3) 반복심화 알파-베타
  const maxDepth = diff === 'hard' ? 10 : 6;
  const k = diff === 'hard' ? 12 : 10;
  const deadline = performance.now() + budgetMs;
  let best = ordered(cs, b, 1)[0];
  for (let d = 2; d <= maxDepth; d += 2) {
    const res = searchRoot(b, d, k, deadline);
    if (res.move) best = res.move;
    if (!res.done) break; // 시간 초과 — 이 깊이까지가 한계
    if (Math.abs(res.val) >= WIN) break; // 필승/필패 확정 → 더 깊이 볼 필요 없음
  }
  return best;
}

// 동기 편의 래퍼(테스트·폴백용). 워커에서는 chooseMove를 직접 예산과 함께 부른다.
export function aiMove(b: Board, diff: Diff): [number, number] {
  return chooseMove(b, diff, diff === 'hard' ? 1200 : diff === 'medium' ? 450 : 0);
}
