import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        popup: 'popup.html',
        library: 'library.html',
        permission: 'permission.html',
        offscreen: 'offscreen.html',
        background: 'src/background.ts',
      },
      output: { entryFileNames: (entry) => entry.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js' },
    },
  },
});
