// Compila el service worker como un único script clásico (IIFE) en dist/sw.js.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  define: { __SW_VERSION__: JSON.stringify(String(Date.now())) },
  build: {
    target: 'es2022',
    emptyOutDir: false,
    outDir: 'dist',
    sourcemap: true,
    lib: {
      entry: 'src/sw.ts',
      formats: ['iife'],
      name: 'mcsw',
      fileName: () => 'sw.js',
    },
  },
});
