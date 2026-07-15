// 바둑 AI 호출 래퍼 — 웹워커 우선, 워커를 못 쓰는 환경이면 동기 계산으로 폴백
import { evalPosition, finalizeGame, mctsMove, type Diff, type FinalResult, type GoState, type PositionEval } from './go';

type Resp = { id: number; move?: number; result?: FinalResult; evalResult?: PositionEval };

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, (r: Resp | null) => void>();

function getWorker(): Worker | null {
  if (failed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./goWorker.ts', import.meta.url), { type: 'module' });
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

function call(req: Record<string, unknown>): Promise<Resp | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, ...req });
  });
}

// 동기 폴백 전에 한 프레임 양보 — '생각 중…' 표시가 먼저 그려지게
const yieldFrame = () => new Promise((r) => setTimeout(r, 30));

export async function requestAiMove(state: GoState, diff: Diff): Promise<number> {
  const r = await call({ kind: 'move', state, diff });
  if (r && r.move !== undefined) return r.move;
  await yieldFrame();
  return mctsMove(state, diff);
}

export async function requestFinalize(state: GoState): Promise<FinalResult> {
  const r = await call({ kind: 'final', state });
  if (r && r.result) return r.result;
  await yieldFrame();
  return finalizeGame(state);
}

export async function requestEval(state: GoState): Promise<PositionEval> {
  const r = await call({ kind: 'eval', state });
  if (r && r.evalResult) return r.evalResult;
  await yieldFrame();
  return evalPosition(state);
}

// 새 게임/무르기/화면 이탈 시 워커의 폰더링을 멈추고 탐색 트리를 버리게 한다
export function notifyStop(): void {
  if (!worker) return;
  worker.postMessage({ kind: 'stop' });
}
