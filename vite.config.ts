import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Expose GATEWAY_* vars from .env (in addition to the default VITE_* prefix)
  envPrefix: ['VITE_', 'GATEWAY_'],
  plugins: [
    react(),
    tailwindcss(),
  ],
})
