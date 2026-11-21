import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Dispatch and Soil are built on their own, after the field app, into the same dist/ folder.
// A separate build means the two never share code files, so changes here can't
// alter what the field app loads.
export default defineConfig({
  plugins: [react()],
  build: {
    emptyOutDir: false,
    copyPublicDir: false,
    rollupOptions: {
      input: { dispatch: resolve(__dirname, 'dispatch.html'), soil: resolve(__dirname, 'soil.html') },
      output: {
        entryFileNames: 'dispatch-assets/[name]-[hash].js',
        chunkFileNames: 'dispatch-assets/[name]-[hash].js',
        assetFileNames: 'dispatch-assets/[name]-[hash][extname]',
      },
    },
  },
})
