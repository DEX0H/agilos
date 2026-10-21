import { defineConfig } from 'vite';

// Relative base so the build works both on localhost and under a GitHub Pages sub-path.
export default defineConfig({
  base: './',
});
