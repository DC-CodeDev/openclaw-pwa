// Single GatewayClient instance for the entire app.
// Created once as a module side-effect — never re-instantiated inside components or hooks.
// Import `gatewayClient` from here; do not call `new GatewayClient()` anywhere else.

import { GatewayClient } from './client.ts'

const url = import.meta.env.GATEWAY_URL as string | undefined
if (!url) throw new Error('GATEWAY_URL is not set — check .env and vite.config.ts envPrefix')

// Token is consumed by handshake.ts (import.meta.env.GATEWAY_TOKEN) — not needed here.
export const gatewayClient = new GatewayClient(url)
