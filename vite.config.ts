import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  // Proxy /__openclaw__/* → gateway HTTP (mismo patrón same-origin que el Control UI).
  // El gateway 2026.6.2 NO emite headers CORS en assistant-media (verificado en vivo), así que
  // el browser solo puede consumirlo same-origin: en dev lo hace vite, en prod hace falta un
  // reverse proxy (nginx/caddy) que reenvíe /__openclaw__/* al puerto del gateway.
  const gatewayWs = env.GATEWAY_URL
  const gatewayTarget = gatewayWs
    ? gatewayWs.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    : 'http://127.0.0.1:18789'

  return {
    // Expose GATEWAY_* vars from .env (in addition to the default VITE_* prefix)
    envPrefix: ['VITE_', 'GATEWAY_'],
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      proxy: {
        '/__openclaw__': {
          target: gatewayTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
