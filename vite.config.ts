import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = `http://127.0.0.1:${process.env.VATRA_PORT ?? 4317}`;

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/ws': { target, ws: true },
    },
  },
});
