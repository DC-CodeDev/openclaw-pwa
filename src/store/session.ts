// Zustand store: WebSocket connection state + active session/agent.
// Mirrors GatewayClient state so React components stay reactive without touching the client directly.

import { create } from 'zustand'
import { EVENT_CONNECTION_STATE, type ConnectionState } from '../protocol/client.ts'
import { gatewayClient } from '../protocol/gatewayInstance.ts'

interface SessionStore {
  connectionState: ConnectionState
  sessionKey: string | null
  agentId: string | null
  setActiveSession: (sessionKey: string, agentId: string) => void
  clearActiveSession: () => void
}

export const useSessionStore = create<SessionStore>((set) => ({
  connectionState: gatewayClient.connectionState,
  sessionKey: null,
  agentId: null,
  setActiveSession: (sessionKey, agentId) => set({ sessionKey, agentId }),
  clearActiveSession: () => set({ sessionKey: null, agentId: null }),
}))

// Subscribe at module load — unsubscribe intentionally omitted (lifetime = app lifetime).
gatewayClient.on(EVENT_CONNECTION_STATE, (state) => {
  useSessionStore.setState({ connectionState: state as ConnectionState })
})
