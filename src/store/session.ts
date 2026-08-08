// Zustand store: active session (sessionKey), active agent, WebSocket connection status

import { create } from 'zustand'

interface SessionStore {
  sessionKey: string | null
  agentId: string | null
}

export const useSessionStore = create<SessionStore>(() => ({
  sessionKey: null,
  agentId: null,
}))
