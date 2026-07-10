// 오목 AI 호출 래퍼 — 웹워커 우선, 워커를 못 쓰는 환경이면 동기 계산으로 폴백
import { chooseMove, type Board, type Diff } from './omok';

type Resp = { id: number; move: [number, number] };

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, (r: Resp | null) => void>();

// 난이도별 탐색 시간 예산(ms)
function budgetFor(diff: Diff): number {
  return diff === 'hard' ? 1600 : diff === 'medium' ? 550 : 0;
}

function getWorker(): Worker | null {
  if (failed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./omokWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Resp>) => {
      const cb = pending.get(e.data.id);
      if (cb) {
        pending.delete(e.data.id);
        cb(e.data);
      }
    };
    worker.onerror = () => {
      failed = true;
      worker?.terminate();
      worker = null;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(null); // 대기 중이던 요청은 동기 폴백으로
    };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

export async function requestOmokMove(board: Board, diff: Diff): Promise<[number, number]> {
  const budgetMs = budgetFor(diff);
  const w = getWorker();
  if (w) {
    const id = ++seq;
    const r = await new Promise<Resp | null>((resolve) => {
      pending.set(id, resolve);
      w.postMessage({ id, board, diff, budgetMs });
    });
    if (r) return r.move;
  }
  // 워커 실패 → 한 프레임 양보 후 동기 계산('생각 중…'이 먼저 그려지게)
  await new Promise((res) => setTimeout(res, 30));
  return chooseMove(board, diff, budgetMs);
}
