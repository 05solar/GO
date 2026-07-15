// SGF(Smart Game Format) 내보내기 — 표준 기보 포맷. 다른 바둑 프로그램/뷰어와 호환.
// 좌표는 좌상단 기준 a..s (열, 행) 두 글자. 패스는 빈 대괄호 [].
import { PASS } from './go';

export interface SgfMeta {
  size: number;
  komi: number;
  diff?: string; // 상대 AI 난이도(표시용)
  date?: string; // YYYY-MM-DD
  result?: string; // 예: "B+3.5", "W+R"
}

// idx → SGF 좌표(예: 3행 4열 → "dc"). 판 밖/패스는 빈 문자열.
function coord(mv: number, n: number): string {
  if (mv === PASS || mv < 0) return '';
  const c = mv % n;
  const r = (mv / n) | 0;
  return String.fromCharCode(97 + c) + String.fromCharCode(97 + r);
}

// 착수 순서(흑 선착, 이후 교대)를 SGF 문자열로. moves는 board idx 배열(패스는 PASS).
export function movesToSgf(moves: number[], meta: SgfMeta): string {
  const n = meta.size;
  let out = `(;GM[1]FF[4]CA[UTF-8]AP[기보:go-omok]SZ[${n}]KM[${meta.komi}]RU[Korean]`;
  out += `PB[나]PW[AI${meta.diff ? ` (${meta.diff})` : ''}]`;
  if (meta.date) out += `DT[${meta.date}]`;
  if (meta.result) out += `RE[${meta.result}]`;
  for (let i = 0; i < moves.length; i++) {
    out += `;${i % 2 === 0 ? 'B' : 'W'}[${coord(moves[i], n)}]`;
  }
  return out + ')';
}
