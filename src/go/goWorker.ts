// 바둑 AI 웹워커 — MCTS 탐색·계가를 메인 스레드 밖에서 실행 (UI 안 멈춤)
// - 트리 재사용: MctsSearch 하나를 유지, 다음 수 요청 때 이전 탐색 서브트리를 계승
// - 폰더링: 어려움 난이도는 사람이 생각하는 동안에도 백그라운드로 계속 탐색.
//   짧은 슬라이스로 쪼개 돌려 새 메시지(착수 요청 등)에 즉시 반응한다.
import {
  MctsSearch,
  diffLimits,
  finalizeGame,
  mctsMove,
  play,
  type Diff,
  type GoState,
} from './go';

type Req =
  | { id: number; kind: 'move'; state: GoState; diff: Diff }
  | { id: number; kind: 'final'; state: GoState }
  | { kind: 'stop' };

const ctx = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent<Req>) => void) | null;
};

const search = new MctsSearch();

// ── 폰더링 ──────────────────────────────────────────────────────
const PONDER_SLICE_MS = 40;
const PONDER_MAX_ITER = 50000; // 상한(배터리·메모리 보호)
let ponderTimer: ReturnType<typeof setTimeout> | null = null;
let ponderLeft = 0;

function stopPonder() {
  if (ponderTimer != null) clearTimeout(ponderTimer);
  ponderTimer = null;
  ponderLeft = 0;
}

function ponderSlice() {
  ponderTimer = null;
  if (ponderLeft <= 0) return;
  ponderLeft -= search.run(PONDER_SLICE_MS, ponderLeft, true);
  if (ponderLeft > 0) ponderTimer = setTimeout(ponderSlice, 0);
}

function startPonder(state: GoState) {
  search.sync(state);
  ponderLeft = PONDER_MAX_ITER;
  ponderTimer = setTimeout(ponderSlice, 0);
}

ctx.onmessage = (e) => {
  const m = e.data;
  stopPonder();
  if (m.kind === 'move') {
    let move: number;
    if (m.diff === 'easy') {
      move = mctsMove(m.state, 'easy'); // 쉬움: 재사용/폰더링 없이 가볍게
    } else {
      const { ms, maxIter } = diffLimits(m.diff);
      search.sync(m.state); // 폰더링·이전 탐색 서브트리가 있으면 계승
      search.run(ms, maxIter, true);
      move = search.bestMove();
    }
    ctx.postMessage({ id: m.id, move });
    // 중간·어려움: 방금 둔 수를 반영한 국면(사람 차례)에서 폰더링 시작
    if (m.diff !== 'easy') {
      const r = play(m.state, move);
      if (r && r.state.passes < 2) startPonder(r.state);
    }
  } else if (m.kind === 'final') {
    search.reset(); // 게임 종료 → 트리 폐기(메모리 회수)
    ctx.postMessage({ id: m.id, result: finalizeGame(m.state) });
  } else {
    search.reset(); // stop: 새 게임/무르기/화면 이탈 → 폰더링 중단·트리 폐기
  }
};
