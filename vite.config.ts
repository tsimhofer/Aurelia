import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base path ensures static assets resolve cleanly on GitHub Pages
  // regardless of whether hosted at /<repo-name>/ or a custom domain.
  base: './',
});
