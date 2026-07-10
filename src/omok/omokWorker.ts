// 오목 AI 웹워커 — 반복심화 알파-베타 탐색을 메인 스레드 밖에서 실행(UI 안 멈춤)
import { chooseMove, type Board, type Diff } from './omok';

type Req = { id: number; board: Board; diff: Diff; budgetMs: number };

const ctx = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent<Req>) => void) | null;
};

ctx.onmessage = (e) => {
  const { id, board, diff, budgetMs } = e.data;
  const move = chooseMove(board, diff, budgetMs);
  ctx.postMessage({ id, move });
};
