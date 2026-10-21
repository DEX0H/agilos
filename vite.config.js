import { defineConfig } from 'vite';

// Relative base so the build works both on localhost and under a GitHub Pages sub-path.
// Two pages: the game, and auth.html (Google sign-in for the Windows app).
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { main: 'index.html', auth: 'auth.html' },
    },
  },
});
