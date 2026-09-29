import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      '/health': 'http://localhost:8787',
      '/ice-config': 'http://localhost:8787',
      '/signaling': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
