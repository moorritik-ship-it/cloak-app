import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // simple-peer pulls in Node core modules (Buffer, process, stream, events)
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'events', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    tailwindcss(),
    react(),
  ],
  optimizeDeps: {
    include: ['simple-peer', 'buffer', 'process'],
  },
  server: {
    // Backend API (Express + Socket.io). Keep port in sync with backend PORT / server.js.
    proxy: {
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/leaderboard': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
})
