import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const floatingEntry = resolve(__dirname, 'floating.html');

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ...(existsSync(floatingEntry) ? { floating: floatingEntry } : {}),
      },
    },
    target: 'es2021',
    sourcemap: false,
  },
});
