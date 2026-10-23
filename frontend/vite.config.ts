/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the FastAPI backend (AGENTS.md 5.1).
// BACKEND_URL is a dev-server setting only; it is never exposed to the browser bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const backend = env.BACKEND_URL || 'http://localhost:8000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
      },
      // Mock mode imports the shared fixtures from ../contract.
      fs: { allow: ['.', '../contract'] },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
