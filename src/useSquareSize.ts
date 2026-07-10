import { useEffect, useState, type RefObject } from 'react';

// 요소의 실제 폭을 관찰해 [min, max] 범위의 정사각형 변길이(px)를 돌려준다.
// 캔버스 판을 컨테이너 폭에 맞춰 반응형으로 키우는 데 쓴다.
export function useSquareSize<T extends HTMLElement>(ref: RefObject<T>, max: number, min = 240): number {
  const [px, setPx] = useState(Math.min(max, 360));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setPx(Math.max(min, Math.min(max, Math.floor(w))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, max, min]);
  return px;
}
