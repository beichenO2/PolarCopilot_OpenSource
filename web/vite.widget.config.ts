import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Library-mode build for @polarcop/checkup-widget.
 *
 * Produces two artefacts in `checkup-widget/dist/`:
 *   - checkup-widget.es.js   (ES module; for bundler consumers)
 *   - checkup-widget.umd.js  (UMD; for direct <script src> embed)
 *
 * Run via `npm run build:widget`.
 */

export default defineConfig({
  build: {
    outDir: 'checkup-widget/dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: 'esbuild',
    lib: {
      entry: resolve(__dirname, 'src/checkup/index.ts'),
      name: 'PolarCheckup',
      fileName: (format) => `checkup-widget.${format}.js`,
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      // html2canvas is bundled (no external) so the widget is drop-in.
      external: [],
    },
  },
});
