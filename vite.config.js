import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/health': 'http://localhost:8787',
      '/ice-config': 'http://localhost:8787',
      '/signaling': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
