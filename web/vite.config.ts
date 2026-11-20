/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_PROXY_TARGET || 'http://localhost:8787';
  return {
    // rutas relativas: el proxy sirve el build en /app/ (proxy/src/app.ts)
    base: './',
    plugins: [preact()],
    server: {
      port: 5173,
      // el SW de desarrollo vive en /src/sw.ts pero controla todo el origen
      headers: { 'Service-Worker-Allowed': '/' },
      proxy: {
        '/api': { target, changeOrigin: true, ws: true },
        '/wh': { target, changeOrigin: true },
      },
    },
    preview: {
      proxy: {
        '/api': { target, changeOrigin: true, ws: true },
        '/wh': { target, changeOrigin: true },
      },
    },
    build: { target: 'es2022', sourcemap: true },
    test: {
      environment: 'node',
      include: ['test/**/*.test.ts'],
      testTimeout: 20000,
    },
  };
});
