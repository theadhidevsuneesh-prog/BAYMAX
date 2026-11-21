import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the built app loads from file:// inside Electron
// Build settings: port 5173 for development, output to frontend/dist.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
