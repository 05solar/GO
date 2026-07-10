import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages는 https://05solar.github.io/GO/ 하위 경로로 서빙하므로 base를 저장소 이름으로.
// 로컬 개발(dev)에서는 base가 '/'여도 무방하도록, 배포 빌드에서만 '/GO/'를 쓴다.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/GO/' : '/',
  plugins: [react()],
}));
