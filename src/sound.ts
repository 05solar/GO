// 웹오디오 기반 짧은 효과음(파일 불필요).
// 사기 바둑알이 나무판에 부딪히는 '딱! 탁!' — 전부 대역통과 잡음 임팩트로 합성.
// (피치 글라이드가 없어 '광선총' 느낌이 나지 않음. 높은 Q가 나무 울림의 음정감을 준다.)
let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function ctx(): AudioContext | null {
  try {
    type AW = Window & { webkitAudioContext?: typeof AudioContext };
    const AC = window.AudioContext || (window as AW).webkitAudioContext;
    if (!AC) return null;
    audio = audio || new AC();
    if (audio.state === 'suspended') void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

// 짧은 백색잡음 버퍼(캐시해 여러 타격에서 재사용)
function getNoise(ac: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ac.sampleRate) return noise;
  const len = Math.floor(ac.sampleRate * 0.2);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  noise = buf;
  return buf;
}

interface Hit {
  freq: number; // 대역통과 중심 주파수(낮을수록 둔탁, 높을수록 딱딱)
  q: number; // 클수록 좁고 음정감(나무 울림) ↑
  gain: number;
  decay: number; // 감쇠(초) — 짧을수록 건조한 타격
  delay?: number;
}

// 대역통과 잡음 임팩트 — 부딪히는 타격음(피치 미끄러짐 없음)
function hit(ac: AudioContext, t: number, o: Hit) {
  const start = t + (o.delay ?? 0);
  const src = ac.createBufferSource();
  src.buffer = getNoise(ac);
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = o.freq;
  bp.Q.value = o.q;
  const g = ac.createGain();
  g.gain.setValueAtTime(o.gain, start); // 즉시 온셋(타격)
  g.gain.exponentialRampToValueAtTime(0.0001, start + o.decay);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(start);
  src.stop(start + o.decay + 0.02);
}

// 착수음: 사기알이 나무판에 부딪히는 '딱! 탁!'
export function playPlace() {
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime;
  hit(ac, t, { freq: 2600, q: 1.4, gain: 0.5, decay: 0.02 }); // 딱 — 밝은 어택
  hit(ac, t, { freq: 820, q: 3.5, gain: 0.42, decay: 0.05 }); // 탁 — 나무 울림 바디
  hit(ac, t, { freq: 330, q: 3, gain: 0.26, decay: 0.06 }); // 저역 두께
}

// 따냄음: 딴 돌이 상대 통에 '묵직하게 떨어지는' 중후한 소리 —
// 저역 무게감을 키우고 고역 클링크는 절제해 은은하게.
export function playCapture() {
  const ac = ctx();
  if (!ac) return;
  const t = ac.currentTime;
  hit(ac, t, { freq: 1700, q: 1.2, gain: 0.26, decay: 0.016 }); // 부딪히는 순간(부드러운 접촉)
  hit(ac, t, { freq: 300, q: 5, gain: 0.4, decay: 0.14 }); // 중후한 저역 바디(무게감)
  hit(ac, t, { freq: 520, q: 4.5, gain: 0.26, decay: 0.11 }); // 중역 바디
  hit(ac, t, { freq: 2200, q: 8, gain: 0.15, decay: 0.09 }); // 은은한 유리 클링크(밝기 절제)
  hit(ac, t, { freq: 3000, q: 9, gain: 0.09, decay: 0.07 }); // 상위 파셜(약하게)
  hit(ac, t, { freq: 330, q: 5, gain: 0.18, decay: 0.1, delay: 0.075 }); // 튀어 앉는 두 번째(저역)
  hit(ac, t, { freq: 2300, q: 8, gain: 0.08, decay: 0.06, delay: 0.075 }); // 두 번째의 옅은 클링크
}
