import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/smart-digital-locker-jmti/',
  server: {
    port: 5173
  }
})
