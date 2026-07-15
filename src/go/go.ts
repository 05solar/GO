// 가변 크기(9×9·13×13) 바둑 엔진 + MCTS(몬테카를로 트리 탐색) AI
// - 착수/따냄(포획)/자살수 금지/패(ko) 규칙
// - 계가: 중국식 집계(area scoring) 보조 + 한국식(집 + 사석) 최종 계가, 백 덤(komi) 6.5
// - AI: UCT+RAVE 기반 MCTS + 전술 롤아웃(단수 따냄/탈출·자충수 회피·착수점 주변 우선)
//   · RAVE(AMAF): 시뮬레이션 어디서든 좋았던 수의 통계를 공유해 적은 탐색으로 수렴
//   · MctsSearch: 트리를 수 사이에 재사용(상대 응수 서브트리 계승) + 폰더링 지원
// - 종국: 소유권 롤아웃으로 죽은 돌 자동 판정 → 사석 반영 한국식 계가 (finalizeGame)
// - 탐색은 goWorker.ts(웹워커)에서 실행되어 UI를 막지 않는다
// - 판 크기는 GoState.board 길이로 결정되며, 엔진은 진입점에서 자동으로 그 크기에 맞춘다.

export const MAX_N = 13; // 지원 최대 변길이(스크래치 버퍼 상한)
const MAX_SZ = MAX_N * MAX_N;
export const KOMI = 6.5; // 백 덤
export type Color = 1 | 2; // 1=흑, 2=백
export type Diff = 'easy' | 'medium' | 'hard';
export const PASS = -1;

// 현재 엔진이 맞춰진 판 크기. setSize()로 전환한다.
export let N = 9;
export let SZ = N * N;


export interface GoState {
  board: Int8Array; // 0=빈점, 1=흑, 2=백
  ko: number; // 패로 인해 금지된 점 (없으면 -1)
  toMove: Color; // 둘 차례
  passes: number; // 연속 패스 수 (2면 종국)
  capB: number; // 흑이 따낸 돌 수 (표시용)
  capW: number; // 백이 따낸 돌 수 (표시용)
}

// ── 인접점(상하좌우)·대각점: 크기별로 만들어 캐시 ──────────────────
let NEI: number[][] = [];
let DIA: number[][] = [];
const tableCache = new Map<number, { NEI: number[][]; DIA: number[][] }>();

function buildTables(n: number): { NEI: number[][]; DIA: number[][] } {
  const nei: number[][] = [];
  const dia: number[][] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const idx = r * n + c;
      const nb: number[] = [];
      const di: number[] = [];
      if (r > 0) nb.push(idx - n);
      if (r < n - 1) nb.push(idx + n);
      if (c > 0) nb.push(idx - 1);
      if (c < n - 1) nb.push(idx + 1);
      if (r > 0 && c > 0) di.push(idx - n - 1);
      if (r > 0 && c < n - 1) di.push(idx - n + 1);
      if (r < n - 1 && c > 0) di.push(idx + n - 1);
      if (r < n - 1 && c < n - 1) di.push(idx + n + 1);
      nei[idx] = nb;
      dia[idx] = di;
    }
  }
  return { NEI: nei, DIA: dia };
}

// 엔진을 변길이 n에 맞춘다(같으면 무시). 인접표는 크기별로 캐시.
export function setSize(n: number): void {
  if (n === N && NEI.length === SZ) return;
  N = n;
  SZ = n * n;
  let t = tableCache.get(n);
  if (!t) {
    t = buildTables(n);
    tableCache.set(n, t);
  }
  NEI = t.NEI;
  DIA = t.DIA;
}
setSize(9); // 초기화

const isqrt = (x: number): number => (Math.sqrt(x) + 0.5) | 0;
// 상태를 받는 진입점에서 판 크기를 board 길이에 동기화(한 판 내에서는 무비용).
const ensure = (len: number): void => {
  if (len !== SZ) setSize(isqrt(len));
};

export function emptyState(n = 9): GoState {
  setSize(n);
  return { board: new Int8Array(n * n), ko: -1, toMove: 1, passes: 0, capB: 0, capW: 0 };
}

export function cloneState(s: GoState): GoState {
  return { board: s.board.slice(), ko: s.ko, toMove: s.toMove, passes: s.passes, capB: s.capB, capW: s.capW };
}

// ── 무리(group) 활로 계산: 세대 스탬프로 스크래치 재사용(할당 없음) ──
// 세대(gGen/gLibGen)는 flood 호출마다 증가한다. Int32Array 스탬프에 저장하므로
// 2^31을 넘기면 저장값이 잘려 비교가 깨진다(무한 재방문 → 스택 오버플로).
// 안전 한계 근처에서 스탬프 배열을 0으로 비우고 세대를 리셋해 이를 막는다.
const GEN_MAX = 0x7fffffff;
const gSeen = new Int32Array(MAX_SZ);
let gGen = 0;
const gLib = new Int32Array(MAX_SZ);
let gLibGen = 0;
const gStack = new Int32Array(MAX_SZ);
const gGroup = new Int32Array(MAX_SZ); // 따낸 돌 수집용

// 세대 증가(오버플로 직전 리셋). 반드시 flood 시작 시에만 호출.
function bumpGen(): void {
  if (++gGen >= GEN_MAX) {
    gSeen.fill(0);
    gGen = 1;
  }
}
function bumpLibGen(): void {
  if (++gLibGen >= GEN_MAX) {
    gLib.fill(0);
    gLibGen = 1;
  }
}

// idx 무리에 활로가 하나라도 있으면 true (찾는 즉시 종료 → 매우 빠름)
function hasLiberty(board: Int8Array, idx: number): boolean {
  const color = board[idx];
  bumpGen();
  let sp = 0;
  gStack[sp++] = idx;
  gSeen[idx] = gGen;
  while (sp > 0) {
    const cur = gStack[--sp];
    const ns = NEI[cur];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const v = board[n];
      if (v === 0) return true;
      if (v === color && gSeen[n] !== gGen) {
        gSeen[n] = gGen;
        gStack[sp++] = n;
      }
    }
  }
  return false;
}

// idx 무리의 활로 수
function countLiberties(board: Int8Array, idx: number): number {
  const color = board[idx];
  bumpGen();
  bumpLibGen();
  let sp = 0;
  gStack[sp++] = idx;
  gSeen[idx] = gGen;
  let libs = 0;
  while (sp > 0) {
    const cur = gStack[--sp];
    const ns = NEI[cur];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const v = board[n];
      if (v === 0) {
        if (gLib[n] !== gLibGen) {
          gLib[n] = gLibGen;
          libs++;
        }
      } else if (v === color && gSeen[n] !== gGen) {
        gSeen[n] = gGen;
        gStack[sp++] = n;
      }
    }
  }
  return libs;
}

// idx 무리가 단수(활로 1)면 그 유일 활로 점, 아니면 -1
function atariPoint(board: Int8Array, idx: number): number {
  const color = board[idx];
  bumpGen();
  bumpLibGen();
  let sp = 0;
  gStack[sp++] = idx;
  gSeen[idx] = gGen;
  let libs = 0;
  let pt = -1;
  while (sp > 0) {
    const cur = gStack[--sp];
    const ns = NEI[cur];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const v = board[n];
      if (v === 0) {
        if (gLib[n] !== gLibGen) {
          gLib[n] = gLibGen;
          libs++;
          pt = n;
          if (libs > 1) return -1;
        }
      } else if (v === color && gSeen[n] !== gGen) {
        gSeen[n] = gGen;
        gStack[sp++] = n;
      }
    }
  }
  return libs === 1 ? pt : -1;
}

// idx 무리의 돌들을 gGroup 에 담고 개수 반환(따냄 제거용)
function collectGroup(board: Int8Array, idx: number): number {
  const color = board[idx];
  bumpGen();
  let sp = 0;
  gStack[sp++] = idx;
  gSeen[idx] = gGen;
  let c = 0;
  while (sp > 0) {
    const cur = gStack[--sp];
    gGroup[c++] = cur;
    const ns = NEI[cur];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      if (board[n] === color && gSeen[n] !== gGen) {
        gSeen[n] = gGen;
        gStack[sp++] = n;
      }
    }
  }
  return c;
}

// idx 무리의 활로 점들을 libBuf 에 담고 개수 반환(축 읽기용)
const libBuf = new Int32Array(MAX_SZ);
function collectLibs(board: Int8Array, idx: number): number {
  const color = board[idx];
  bumpGen();
  bumpLibGen();
  let sp = 0;
  gStack[sp++] = idx;
  gSeen[idx] = gGen;
  let libs = 0;
  while (sp > 0) {
    const cur = gStack[--sp];
    const ns = NEI[cur];
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      const v = board[n];
      if (v === 0) {
        if (gLib[n] !== gLibGen) {
          gLib[n] = gLibGen;
          libBuf[libs++] = n;
        }
      } else if (v === color && gSeen[n] !== gGen) {
        gSeen[n] = gGen;
        gStack[sp++] = n;
      }
    }
  }
  return libs;
}

// 착수 시도. 합법이면 새 상태, 불법(자리참·패·자살수)이면 null.
export function play(s: GoState, move: number): { state: GoState; captured: number } | null {
  ensure(s.board.length);
  if (move === PASS) {
    return {
      state: {
        board: s.board,
        ko: -1,
        toMove: (3 - s.toMove) as Color,
        passes: s.passes + 1,
        capB: s.capB,
        capW: s.capW,
      },
      captured: 0,
    };
  }
  const { board, ko, toMove } = s;
  if (move < 0 || move >= SZ || board[move] !== 0) return null; // 빈 자리가 아님
  if (move === ko) return null; // 패
  const nb = board.slice();
  nb[move] = toMove;
  const opp = (3 - toMove) as Color;
  let capCount = 0;
  let oneCapPt = -1;
  const ns = NEI[move];
  for (let i = 0; i < ns.length; i++) {
    const n = ns[i];
    if (nb[n] === opp && !hasLiberty(nb, n)) {
      const c = collectGroup(nb, n);
      for (let k = 0; k < c; k++) nb[gGroup[k]] = 0;
      if (c === 1) oneCapPt = gGroup[0];
      capCount += c;
    }
  }
  if (!hasLiberty(nb, move)) return null; // 자살수 (따냄 뒤에도 활로 없음)
  let newKo = -1;
  if (capCount === 1) {
    let ownAdj = false;
    let libs = 0;
    for (let i = 0; i < ns.length; i++) {
      const v = nb[ns[i]];
      if (v === toMove) ownAdj = true;
      else if (v === 0) libs++;
    }
    if (!ownAdj && libs === 1) newKo = oneCapPt; // 단수 되따냄 → 패
  }
  return {
    state: {
      board: nb,
      ko: newKo,
      toMove: opp,
      passes: 0,
      capB: s.capB + (toMove === 1 ? capCount : 0),
      capW: s.capW + (toMove === 2 ? capCount : 0),
    },
    captured: capCount,
  };
}

// 해당 빈점이 color의 '진짜 눈'인지 (자기 눈 메우기/거짓눈 방지용)
function isEye(board: Int8Array, idx: number, color: Color): boolean {
  if (board[idx] !== 0) return false;
  const ns = NEI[idx];
  for (let i = 0; i < ns.length; i++) if (board[ns[i]] !== color) return false; // 상하좌우 전부 내 돌
  const ds = DIA[idx];
  let own = 0;
  for (let i = 0; i < ds.length; i++) if (board[ds[i]] === color) own++;
  const offBoard = 4 - ds.length; // 반 밖(가·귀) 대각 수
  if (offBoard > 0) return own === ds.length; // 가/귀: 존재하는 대각이 전부 내 돌
  return own >= 3; // 가운데: 대각 4곳 중 3곳 이상 내 돌
}

// ── 계가(중국식 집계) ────────────────────────────────────────────
export interface ScoreResult { black: number; white: number; winner: Color; margin: number }

const scSeen = new Uint8Array(MAX_SZ);
const scStack = new Int32Array(MAX_SZ);
const scRegion = new Int32Array(MAX_SZ);
export function scoreArea(board: Int8Array, komi = KOMI): ScoreResult {
  let black = 0;
  let white = 0;
  for (let i = 0; i < SZ; i++) scSeen[i] = 0;
  for (let i = 0; i < SZ; i++) {
    const v = board[i];
    if (v === 1) black++;
    else if (v === 2) white++;
    else if (!scSeen[i]) {
      // 빈 영역(집) 탐색 → 접한 색이 한 쪽뿐이면 그 색의 집
      let rc = 0;
      let touchB = false;
      let touchW = false;
      let sp = 0;
      scStack[sp++] = i;
      scSeen[i] = 1;
      while (sp > 0) {
        const cur = scStack[--sp];
        scRegion[rc++] = cur;
        const ns = NEI[cur];
        for (let k = 0; k < ns.length; k++) {
          const n = ns[k];
          const nv = board[n];
          if (nv === 0) {
            if (!scSeen[n]) {
              scSeen[n] = 1;
              scStack[sp++] = n;
            }
          } else if (nv === 1) touchB = true;
          else touchW = true;
        }
      }
      if (touchB && !touchW) black += rc;
      else if (touchW && !touchB) white += rc;
    }
  }
  const wTotal = white + komi;
  const margin = black - wTotal; // 양수면 흑 우세
  return { black, white: wTotal, winner: margin > 0 ? 1 : 2, margin: Math.abs(margin) };
}

// 빈 영역을 집으로 분류: 반환 배열에서 빈점 = 0(공배/dame)·1(흑집)·2(백집), 돌 = 그 색
function classify(board: Int8Array): Int8Array {
  const cls = new Int8Array(SZ);
  const seen = new Uint8Array(SZ);
  const stack = new Int32Array(SZ);
  const region = new Int32Array(SZ);
  for (let i = 0; i < SZ; i++) {
    if (board[i] !== 0) {
      cls[i] = board[i];
      continue;
    }
    if (seen[i]) continue;
    let rc = 0;
    let touchB = false;
    let touchW = false;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      region[rc++] = cur;
      const ns = NEI[cur];
      for (let k = 0; k < ns.length; k++) {
        const n = ns[k];
        const nv = board[n];
        if (nv === 0) {
          if (!seen[n]) {
            seen[n] = 1;
            stack[sp++] = n;
          }
        } else if (nv === 1) touchB = true;
        else touchW = true;
      }
    }
    const t = touchB && !touchW ? 1 : touchW && !touchB ? 2 : 0;
    for (let k = 0; k < rc; k++) cls[region[k]] = t;
  }
  return cls;
}

// 한국식(집 + 사석) 계가. 흑 = 흑집 + 흑이 잡은 돌, 백 = 백집 + 백이 잡은 돌 + 덤.
export function scoreGame(state: GoState, komi = KOMI): ScoreResult {
  ensure(state.board.length);
  const cls = classify(state.board);
  let tB = 0;
  let tW = 0;
  for (let i = 0; i < SZ; i++) {
    if (state.board[i] === 0) {
      if (cls[i] === 1) tB++;
      else if (cls[i] === 2) tW++;
    }
  }
  const black = tB + state.capB;
  const white = tW + state.capW + komi;
  const margin = black - white;
  return { black, white, winner: margin > 0 ? 1 : 2, margin: Math.abs(margin) };
}

// ── 롤아웃 정책 ──────────────────────────────────────────────────
const rEmpties = new Int32Array(MAX_SZ);
function shuffle(arr: Int32Array, len: number) {
  for (let k = len - 1; k > 0; k--) {
    const j = (Math.random() * (k + 1)) | 0;
    const t = arr[k];
    arr[k] = arr[j];
    arr[j] = t;
  }
}

function shuffleList(a: number[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

// 전술 한 수:
//   (useGlobal일 때만) 1) 전역 단수 따냄  2) 전역 단수 방어
//   3) 직전 착수점 주변(3×3) 무작위
//   4) 전역 무작위(자충 회피)
// 전역 스캔은 비싸므로 롤아웃 첫 수에서만 켠다(기존 판의 단수 상황을 반영).
// 반환 [새 상태, 이번에 둔 점]
function heuristicStep(s: GoState, last: number, useGlobal: boolean): { state: GoState; last: number } {
  const board = s.board;
  const M = s.toMove;
  const O = (3 - M) as Color;

  if (useGlobal) {
    // 1) 판 전체에서 '따낼 수 있는' 상대 단수 그룹의 활로에 착수 → 따냄
    const caps: number[] = [];
    for (let i = 0; i < SZ; i++) {
      if (board[i] === O) {
        const p = atariPoint(board, i);
        if (p >= 0) caps.push(p);
      }
    }
    if (caps.length) {
      shuffleList(caps);
      for (const mv of caps) {
        const r = play(s, mv);
        if (r && r.captured > 0) return { state: r.state, last: mv };
      }
    }
    // 2) 내 단수 그룹이 있으면 살린다 (활로로 늘리거나 되따냄)
    const defs: number[] = [];
    for (let i = 0; i < SZ; i++) {
      if (board[i] === M) {
        const p = atariPoint(board, i);
        if (p >= 0) defs.push(p);
      }
    }
    if (defs.length) {
      shuffleList(defs);
      for (const mv of defs) {
        const r = play(s, mv);
        if (r && (r.captured > 0 || countLiberties(r.state.board, mv) >= 2)) {
          return { state: r.state, last: mv };
        }
      }
    }
  } else if (last >= 0) {
    // 국지: 직전 착수점에 인접한 단수 그룹만 대응(따냄/탈출)
    const cand: number[] = [];
    for (const n of NEI[last]) {
      const v = board[n];
      if (v === O || v === M) {
        const p = atariPoint(board, n);
        if (p >= 0) cand.push(p);
      }
    }
    if (cand.length) {
      shuffleList(cand);
      for (const mv of cand) {
        const r = play(s, mv);
        if (r && (r.captured > 0 || countLiberties(r.state.board, mv) >= 2)) {
          return { state: r.state, last: mv };
        }
      }
    }
  }

  if (last >= 0) {
    // 3) 착수점 주변(3×3) 무작위 — 자충수는 회피
    if (Math.random() < 0.5) {
      const loc: number[] = [];
      for (const n of NEI[last]) if (board[n] === 0 && !isEye(board, n, M)) loc.push(n);
      for (const d of DIA[last]) if (board[d] === 0 && !isEye(board, d, M)) loc.push(d);
      for (let i = loc.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const t = loc[i];
        loc[i] = loc[j];
        loc[j] = t;
      }
      for (const mv of loc) {
        const r = play(s, mv);
        if (r && (r.captured > 0 || countLiberties(r.state.board, mv) >= 2)) {
          return { state: r.state, last: mv };
        }
      }
    }
  }

  // 4) 전역 무작위 — 눈/자충 회피 우선, 없으면 아무 합법수, 그래도 없으면 패스
  let m = 0;
  for (let i = 0; i < SZ; i++) if (board[i] === 0) rEmpties[m++] = i;
  shuffle(rEmpties, m);
  for (let k = 0; k < m; k++) {
    const mv = rEmpties[k];
    if (isEye(board, mv, M)) continue;
    const r = play(s, mv);
    if (r && (r.captured > 0 || countLiberties(r.state.board, mv) >= 2)) return { state: r.state, last: mv };
  }
  for (let k = 0; k < m; k++) {
    const mv = rEmpties[k];
    if (isEye(board, mv, M)) continue;
    const r = play(s, mv);
    if (r) return { state: r.state, last: mv };
  }
  return { state: play(s, PASS)!.state, last: -1 };
}

// 순수 무작위 한 수(쉬움용) — 눈만 회피
function randomStep(s: GoState): { state: GoState; last: number } {
  const board = s.board;
  const M = s.toMove;
  let m = 0;
  for (let i = 0; i < SZ; i++) if (board[i] === 0) rEmpties[m++] = i;
  shuffle(rEmpties, m);
  for (let k = 0; k < m; k++) {
    const mv = rEmpties[k];
    if (isEye(board, mv, M)) continue;
    const r = play(s, mv);
    if (r) return { state: r.state, last: mv };
  }
  return { state: play(s, PASS)!.state, last: -1 };
}

// ── RAVE(AMAF)용 착수 기록: 이번 시뮬레이션에서 각 색이 둔 점 (세대 스탬프) ──
const rvB = new Int32Array(MAX_SZ);
const rvW = new Int32Array(MAX_SZ);
let rvGen = 0;

// 롤아웃 → 최종 집 차이(부호: 흑 - 백, 양수면 흑 우세)
function rollout(start: GoState, heuristic: boolean): number {
  let s = cloneState(start);
  let last = -1;
  let moves = 0;
  const maxMoves = SZ * 2;
  while (s.passes < 2 && moves < maxMoves) {
    const mover = s.toMove;
    const step = heuristic ? heuristicStep(s, last, moves === 0) : randomStep(s);
    s = step.state;
    last = step.last;
    if (last >= 0) (mover === 1 ? rvB : rvW)[last] = rvGen;
    moves++;
  }
  const res = scoreArea(s.board);
  return res.winner === 1 ? res.margin : -res.margin;
}

// ── MCTS + RAVE ─────────────────────────────────────────────────
interface Node {
  move: number; // 부모에서 이 노드로 온 수 (루트는 -2)
  justMoved: Color; // 그 수를 둔 색
  toMove: Color; // 이 노드에서 둘 색
  parent: Node | null;
  children: Node[];
  untried: number[]; // 아직 펼치지 않은 후보수 (합법성은 펼칠 때 검증)
  visits: number;
  wins: number; // justMoved 관점의 승수
  raveVisits: number; // RAVE: 이 수가 시뮬레이션 어딘가에서 같은 색으로 두어진 횟수
  raveWins: number; // RAVE: 그때의 justMoved 관점 값 누적
}

// 눈이 아닌 빈점 후보 + 패(마지막에 팝되도록 맨 앞)
function candidates(s: GoState): number[] {
  const list: number[] = [PASS];
  for (let i = 0; i < SZ; i++) {
    if (s.board[i] === 0 && !isEye(s.board, i, s.toMove)) list.push(i);
  }
  return list;
}

function makeNode(s: GoState, move: number, parent: Node | null): Node {
  return {
    move,
    justMoved: (3 - s.toMove) as Color,
    toMove: s.toMove,
    parent,
    children: [],
    untried: candidates(s),
    visits: 0,
    wins: 0,
    raveVisits: 0,
    raveWins: 0,
  };
}

// ── 축(ladder) 읽기 ─────────────────────────────────────────────
// 활로 1~2개의 그룹을 두고 공격자/방어자가 번갈아 두며 잡히는지 판정한다.
// 축머리(ladder breaker)로 활로가 늘거나 공격 돌을 되따내면 도망 성공으로 본다.
const LADDER_MAX = 80; // 읽기 깊이 상한(플라이). 대부분의 축은 이 안에 결판난다.

// 공격자 차례. 방어자 그룹(groupIdx)을 축으로 잡을 수 있으면 true.
function ladderAttack(state: GoState, groupIdx: number, depth: number): boolean {
  if (depth <= 0) return false;
  const libN = collectLibs(state.board, groupIdx);
  if (libN >= 3) return false; // 활로 3 이상 → 이미 도망
  if (libN === 0) return true;
  const pts: number[] = [];
  for (let i = 0; i < libN; i++) pts.push(libBuf[i]);
  // 공격자는 방어자를 단수로 모는 활로에 착수
  for (const L of pts) {
    const r = play(state, L);
    if (!r) continue;
    if (r.state.board[groupIdx] === 0) return true; // 곧바로 따냄
    const dl = countLiberties(r.state.board, groupIdx);
    if (dl <= 1 && !ladderDefend(r.state, groupIdx, depth - 1)) return true;
  }
  return false;
}

// 방어자 차례(그룹 단수). 도망쳐 살아나면 true.
function ladderDefend(state: GoState, groupIdx: number, depth: number): boolean {
  if (depth <= 0) return true; // 못 읽으면 보수적으로 '살아있다'
  const L = atariPoint(state.board, groupIdx);
  if (L < 0) return true; // 단수가 아님 → 산 것으로 간주
  const r = play(state, L); // 활로로 늘려 도망
  if (!r) return false; // 도망 불가(자살/불법) → 잡힘
  if (r.state.board[groupIdx] === 0) return false;
  if (countLiberties(r.state.board, groupIdx) >= 3) return true; // 도망 성공(축머리·되따냄)
  return !ladderAttack(r.state, groupIdx, depth - 1);
}

// 착수 후보의 사전 평가(0~1). 롤아웃 분산이 큰 초반에도 상식적인 수를 두게 한다.
function priorValue(s: GoState, mv: number, r: { state: GoState; captured: number }): number {
  if (mv === PASS) return 0.05; // 패스는 트리에서 사실상 선택 금지 수준으로 억제
  const pboard = s.board;
  const M = s.toMove;
  const O = (3 - M) as Color;
  let v = 0.5;

  // 따냄 → 좋음
  if (r.captured > 0) v += 0.1 + 0.05 * Math.min(r.captured, 4);

  // 착수 후 내 돌의 활로
  const libs = countLiberties(r.state.board, mv);
  if (r.captured === 0) {
    if (libs === 1) v -= 0.35; // 자충수(스스로 단수) → 나쁨
    else if (libs === 2) v -= 0.05;
  }

  // 상대 그룹을 단수로 몬 수 → 축으로 잡히면(도망 불가) 큰 가점
  for (const n of NEI[mv]) {
    if (r.state.board[n] === O && atariPoint(r.state.board, n) >= 0) {
      if (!ladderDefend(r.state, n, LADDER_MAX)) { v += 0.22; break; }
    }
  }

  // 내 단수 그룹을 잇는 수 → 축으로 죽는 그룹을 끌고가면 헛수(감점), 살아나면 가점
  for (const n of NEI[mv]) {
    if (pboard[n] === M && atariPoint(pboard, n) >= 0) {
      if (r.captured > 0 || libs >= 3) v += 0.18;
      else if (ladderAttack(r.state, mv, LADDER_MAX)) v -= 0.28; // 잡히는 축을 도망 = 나쁨
      else v += 0.15;
      break;
    }
  }

  // 기존 돌 근처(접전) 선호 · 외딴 수/1선 억제
  let adj = false;
  for (const n of NEI[mv]) if (pboard[n] !== 0) { adj = true; break; }
  if (!adj) for (const d of DIA[mv]) if (pboard[d] !== 0) { adj = true; break; }
  const row = (mv / N) | 0;
  const col = mv % N;

  const onEdge = row === 0 || row === N - 1 || col === 0 || col === N - 1;
  const mid = (N - 1) / 2;
  if (adj) v += 0.08;
  else {
    if (onEdge) v -= 0.12; // 외딴 1선 = 나쁨
    const dc = Math.abs(row - mid) + Math.abs(col - mid);
    if (dc <= 3) v += 0.04; // 중앙 쪽이면 소폭 가점(초반 세력)
  }

  return v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v;
}

const UCT_C = 0.35; // 낮은 탐색: 사전확률(prior)이 초기 정렬을 담당
const PRIOR_K = 30; // 사전확률 가상 방문 수(클수록 휴리스틱 신뢰↑)
const RAVE_K = 300; // β = √(K/(3n+K)): 방문이 적을 땐 RAVE, 쌓일수록 실측 가치로 이행

// UCT + RAVE 혼합 선택: 방문이 적은 자식은 AMAF 통계(β 가중)로 빠르게 걸러낸다
function uctSelect(node: Node): Node {
  let best = node.children[0];
  let bestVal = -Infinity;
  const logN = Math.log(node.visits + 1);
  for (const ch of node.children) {
    const q = ch.wins / ch.visits;
    const beta = Math.sqrt(RAVE_K / (3 * ch.visits + RAVE_K));
    const qr = ch.raveVisits > 0 ? ch.raveWins / ch.raveVisits : q;
    const val = (1 - beta) * q + beta * qr + UCT_C * Math.sqrt(logN / ch.visits);
    if (val > bestVal) {
      bestVal = val;
      best = ch;
    }
  }
  return best;
}

// 시뮬레이션 결과(흑 기준 마진) → color 관점의 값(0~1).
function valueOf(margin: number, color: Color): number {
  const signed = color === 1 ? margin : -margin;
  const win = signed > 0 ? 1 : 0;
  let m = 0.5 + signed / (2 * SZ); // SZ = 판 넓이로 마진 정규화
  if (m < 0) m = 0;
  else if (m > 1) m = 1;
  return 0.75 * win + 0.25 * m;
}

// 무작위 합법수(눈 회피). 쉬움 난이도의 실수 유발용.
function randomMove(s: GoState): number {
  const board = s.board;
  const M = s.toMove;
  let m = 0;
  for (let i = 0; i < SZ; i++) if (board[i] === 0) rEmpties[m++] = i;
  shuffle(rEmpties, m);
  for (let k = 0; k < m; k++) {
    const mv = rEmpties[k];
    if (isEye(board, mv, M)) continue;
    if (play(s, mv)) return mv;
  }
  return PASS;
}

// 난이도별 탐색 예산 (웹워커에서 돌므로 UI 블로킹 없음).
// 판이 커지면(13×13) 넓이에 비례해 시뮬레이션 수를 늘려 기력을 유지한다.
export function diffLimits(diff: Diff): { ms: number; maxIter: number } {
  const scale = SZ / 81; // 9×9=1.0, 13×13≈2.09
  const msMul = Math.min(1.6, scale);
  if (diff === 'easy') return { ms: 150, maxIter: Math.round(2200 * scale) };
  if (diff === 'medium') return { ms: Math.round(1800 * msMul), maxIter: Math.round(90000 * scale) };
  return { ms: Math.round(4500 * msMul), maxIter: Math.round(400000 * scale) };
}

function sameState(a: GoState, b: GoState): boolean {
  if (a.toMove !== b.toMove || a.ko !== b.ko || a.passes !== b.passes) return false;
  if (a.board.length !== b.board.length) return false;
  for (let i = 0; i < a.board.length; i++) if (a.board[i] !== b.board[i]) return false;
  return true;
}

// 지속형 MCTS 탐색기.
export class MctsSearch {
  private root: Node | null = null;
  private rootState: GoState | null = null;

  reset(): void {
    this.root = null;
    this.rootState = null;
  }

  sync(state: GoState): void {
    ensure(state.board.length);
    if (this.root && this.rootState && this.rootState.board.length === state.board.length) {
      if (sameState(this.rootState, state)) return;
      for (const ch of this.root.children) {
        const r1 = play(this.rootState, ch.move);
        if (!r1) continue;
        if (sameState(r1.state, state)) return this.adopt(ch, state);
        for (const gc of ch.children) {
          const r2 = play(r1.state, gc.move);
          if (r2 && sameState(r2.state, state)) return this.adopt(gc, state);
        }
      }
    }
    this.root = makeNode(state, -2, null);
    this.rootState = cloneState(state);
  }

  private adopt(n: Node, state: GoState): void {
    n.parent = null;
    this.root = n;
    this.rootState = cloneState(state);
  }

  // 실행한 시뮬레이션 횟수를 반환
  run(ms: number, maxIter: number, heuristic: boolean): number {
    const root = this.root;
    const state = this.rootState;
    if (!root || !state) return 0;
    ensure(state.board.length);
    const start = performance.now();
    let iter = 0;

    while (iter < maxIter && performance.now() - start < ms) {
      iter++;
      // RAVE 착수 기록 세대(오버플로 직전 리셋 — Int32 스탬프 비교가 깨지는 것 방지)
      if (++rvGen >= GEN_MAX) {
        rvB.fill(0);
        rvW.fill(0);
        rvGen = 1;
      }
      let node = root;
      let s = cloneState(state);

      // 1) 선택
      while (node.untried.length === 0 && node.children.length > 0) {
        node = uctSelect(node);
        s = play(s, node.move)!.state;
      }
      // 2) 확장 (합법수가 나올 때까지 후보를 소진) — 사전확률로 가상 방문 시딩
      while (node.untried.length > 0) {
        const mv = node.untried.pop()!;
        const r = play(s, mv);
        if (r) {
          const pv = priorValue(s, mv, r);
          s = r.state;
          const child = makeNode(s, mv, node);
          child.visits = PRIOR_K;
          child.wins = PRIOR_K * pv;
          child.raveVisits = PRIOR_K;
          child.raveWins = PRIOR_K * pv;
          node.children.push(child);
          node = child;
          break;
        }
      }
      // 3) 시뮬레이션 (흑 기준 집 차이)
      const margin = rollout(s, heuristic);
      // 4) 역전파 — 실측 가치 + RAVE(AMAF) 갱신.
      let n: Node | null = node;
      while (n) {
        n.visits++;
        n.wins += valueOf(margin, n.justMoved);
        for (const ch of n.children) {
          if (ch.move < 0) continue; // 패스는 RAVE 제외
          const stamp = ch.justMoved === 1 ? rvB : rvW;
          if (stamp[ch.move] === rvGen) {
            ch.raveVisits++;
            ch.raveWins += valueOf(margin, ch.justMoved);
          }
        }
        if (n.move >= 0) (n.justMoved === 1 ? rvB : rvW)[n.move] = rvGen;
        n = n.parent;
      }
    }
    return iter;
  }

  // 방문수 내림차순으로 보되, '헛수'는 건너뛰고 실속 있는 최선수를 고른다.
  // 승부가 갈린 종반에는 모든 수의 승률이 비슷해 방문수 1위가 자충 헛수가 되기 쉽다.
  // 그런 수는 한국룰에서 상대에게 사석만 헌납하므로(끝내기 실점) 걸러낸다.
  // 단, 패스가 최상위(탐색이 종국을 선호)면 패스한다 — 헛수로 대국을 끌지 않는다.
  bestMove(): number {
    const root = this.root;
    const state = this.rootState;
    if (!root || !state) return PASS;
    ensure(state.board.length);

    const cls = classify(state.board);

    // 상대가 방금 패스했고, 판이 실제로 정리됐으며(공배 거의 없음) 이쪽이 확실히 이기면(마진 ≥2)
    // 함께 패스해 종국한다. — 사람이 끝내려 패스했을 때 AI가 헛수로 대국을 끌지 않도록.
    // 공배 조건이 없으면 초반 실수 패스에도 덤빨로 조기 종료되므로 반드시 확인한다.
    if (state.passes === 1) {
      let dame = 0;
      for (let i = 0; i < SZ; i++) if (state.board[i] === 0 && cls[i] === 0) dame++;
      if (dame <= 2) {
        const sc = scoreArea(state.board);
        if (sc.winner === state.toMove && sc.margin >= 2) return PASS;
      }
    }

    // 판이 절반 이상 찼는지(종반) — 초반엔 classify가 빈 판 전체를 한쪽 '집'으로 오판하므로,
    // '상대 집 침투 금지' 필터는 종반에만 적용해야 한다(아니면 초반에 양쪽이 즉시 패스).
    let stones = 0;
    for (let i = 0; i < SZ; i++) if (state.board[i] !== 0) stones++;
    const endgame = 2 * stones >= SZ;
    const opp = (3 - state.toMove) as Color;

    const kids = root.children.slice().sort((a, b) => b.visits - a.visits);
    for (const ch of kids) {
      const mv = ch.move;
      if (mv === PASS) return PASS; // 탐색이 패스를 최상으로 봄 → 종국
      const r = play(state, mv);
      if (!r) continue; // 불법(자리참·패·자살)
      if (r.captured === 0) {
        // 자충 throw-in(놓자마자 단수, 따냄 없음) → 사석 헌납 헛수
        if (countLiberties(r.state.board, mv) === 1) continue;
        // 자기 확정 영역(집) 메우기(따냄 없음) → 손해 헛수
        if (cls[mv] === state.toMove) continue;
        // 종반에 상대의 확정 집에 투입 → 반드시 죽는 사석. 가망 없는 침투 방지.
        if (endgame && cls[mv] === opp) continue;
      }
      return mv; // 실속 있는 최선수
    }
    return PASS; // 둘 만한 수가 없으면 패스(종국)
  }

  // 디버그/테스트용: 현재 루트의 실측 방문수(가상 방문 제외 안 함)
  rootVisits(): number {
    return this.root ? this.root.visits : 0;
  }
}

// AI 착수 결정(일회성). 반환은 board idx 또는 PASS(-1).
export function mctsMove(state: GoState, diff: Diff): number {
  ensure(state.board.length);
  if (diff === 'easy' && Math.random() < 0.35) return randomMove(state);
  const { ms, maxIter } = diffLimits(diff);
  const search = new MctsSearch();
  search.sync(state);
  search.run(ms, maxIter, diff !== 'easy');
  return search.bestMove();
}

// ── 종국 처리: 소유권 추정 → 죽은 돌 판정 → 사석 반영 계가 ──────────
export interface FinalResult extends ScoreResult {
  dead: number[]; // 죽었다고 판정된 돌들의 idx (표시용)
  territory: Int8Array; // 사석 제거 후 분류: 돌=그 색, 빈점=0(공배)·1(흑집)·2(백집)
}

// 현 국면에서 전술 롤아웃을 여러 판 돌려 각 점의 소유권을 추정.
export function estimateOwnership(state: GoState, playouts = 200): Float32Array {
  ensure(state.board.length);
  const own = new Float32Array(SZ);
  const maxMoves = SZ * 2;
  for (let p = 0; p < playouts; p++) {
    let s = cloneState(state);
    s.passes = 0; // 종국 상태(연속 패스 2)에서 불려도 롤아웃이 돌도록 리셋
    let last = -1;
    let moves = 0;
    while (s.passes < 2 && moves < maxMoves) {
      const step = heuristicStep(s, last, moves === 0);
      s = step.state;
      last = step.last;
      moves++;
    }
    const cls = classify(s.board);
    for (let i = 0; i < SZ; i++) {
      if (cls[i] === 1) own[i] += 1;
      else if (cls[i] === 2) own[i] -= 1;
    }
  }
  for (let i = 0; i < SZ; i++) own[i] /= playouts;
  return own;
}

// ── 형세판단(현 국면 승률·예상 집수 추정) ────────────────────────
export interface PositionEval {
  blackWinRate: number; // 흑 예상 승률 0~1
  blackScore: number; // 흑 예상 집(area, 평균)
  whiteScore: number; // 백 예상 집(area + 덤, 평균)
  leader: Color; // 우세한 쪽
  margin: number; // 우세 집수(절댓값)
  playouts: number;
}

// 현 국면에서 전술 롤아웃을 여러 판 끝까지 돌려 승률과 예상 집수를 추정한다.
export function evalPosition(state: GoState, komi = KOMI, playouts = 320): PositionEval {
  ensure(state.board.length);
  let bWins = 0;
  let bSum = 0;
  let wSum = 0;
  const maxMoves = SZ * 2;
  for (let p = 0; p < playouts; p++) {
    let s = cloneState(state);
    s.passes = 0; // 종국(연속 패스 2)에서 불려도 롤아웃이 돌도록 리셋
    let last = -1;
    let moves = 0;
    while (s.passes < 2 && moves < maxMoves) {
      const step = heuristicStep(s, last, moves === 0);
      s = step.state;
      last = step.last;
      moves++;
    }
    const res = scoreArea(s.board, komi); // res.white 는 덤 포함
    if (res.winner === 1) bWins++;
    bSum += res.black;
    wSum += res.white;
  }
  const black = bSum / playouts;
  const white = wSum / playouts;
  const margin = black - white;
  return {
    blackWinRate: bWins / playouts,
    blackScore: black,
    whiteScore: white,
    leader: margin >= 0 ? 1 : 2,
    margin: Math.abs(margin),
    playouts,
  };
}

// 종국 계가: 소유권이 상대 쪽으로 기운 돌을 사석으로 걷어낸 뒤 한국식(집 + 사석) 계가.
const DEAD_TH = 0.25;
export function finalizeGame(state: GoState, komi = KOMI): FinalResult {
  ensure(state.board.length);
  const own = estimateOwnership(state);
  const board = state.board.slice();
  const dead: number[] = [];
  let capB = state.capB;
  let capW = state.capW;
  for (let i = 0; i < SZ; i++) {
    const v = board[i];
    if (v === 1 && own[i] < -DEAD_TH) {
      dead.push(i);
      board[i] = 0;
      capW++; // 죽은 흑돌 → 백의 사석
    } else if (v === 2 && own[i] > DEAD_TH) {
      dead.push(i);
      board[i] = 0;
      capB++; // 죽은 백돌 → 흑의 사석
    }
  }
  const cls = classify(board);
  let tB = 0;
  let tW = 0;
  for (let i = 0; i < SZ; i++) {
    if (board[i] === 0) {
      if (cls[i] === 1) tB++;
      else if (cls[i] === 2) tW++;
    }
  }
  const black = tB + capB;
  const white = tW + capW + komi;
  const margin = black - white;
  return { black, white, winner: margin > 0 ? 1 : 2, margin: Math.abs(margin), dead, territory: cls };
}

// 테스트/벤치용: 고정 시뮬레이션 수로 한 수 결정(트리 재사용·폰더링 없음).
export function moveWithSims(state: GoState, sims: number): number {
  ensure(state.board.length);
  const search = new MctsSearch();
  search.sync(state);
  search.run(Number.POSITIVE_INFINITY, sims, true);
  return search.bestMove();
}

// 좌표 변환 유틸(현재 크기 기준)
export const rc = (idx: number): [number, number] => [Math.floor(idx / N), idx % N];
export const toIdx = (r: number, c: number) => r * N + c;

// 축 읽기(테스트/디버그용). 상태의 둘 차례가 공격자이고 groupIdx가 방어자 그룹(활로 ≤2)일 때
// 공격자가 잡으면 true. 방어자 차례(단수)라면 !defends 로 뒤집어 쓴다.
export function __ladderAttack(state: GoState, groupIdx: number): boolean {
  ensure(state.board.length);
  return ladderAttack(state, groupIdx, LADDER_MAX);
}
export function __ladderDefend(state: GoState, groupIdx: number): boolean {
  ensure(state.board.length);
  return ladderDefend(state, groupIdx, LADDER_MAX);
}
