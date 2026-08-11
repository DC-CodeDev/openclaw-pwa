// Zustand store: WebSocket connection state + active session/agent + known session list.
// Circular imports with messages.ts and tools.ts are intentional and safe: both stores are only
// accessed inside function bodies (never during module initialization), so ES live bindings resolve correctly.

import { create } from 'zustand'
import { EVENT_CONNECTION_STATE, EVENT_PAIRING_REQUEST_ID, type ConnectionState } from '../protocol/client.ts'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { sessionsList, agentsList, sessionsUnsubscribe } from '../protocol/methods.ts'
import type { Session, Agent } from '../protocol/methods.ts'
import { useMessagesStore } from './messages.ts'
import { useToolsStore } from './tools.ts'

export type UiMode = 'texto' | 'audio'

interface SessionStore {
  connectionState: ConnectionState
  pairingRequestId: string | null
  uiMode: UiMode                // toggle Texto/Audio — ambos modos comparten el mismo store (sección 2)
  setUiMode: (mode: UiMode) => void
  sessionKey: string | null
  agentId: string | null           // agent of the active session
  agentDisplayName: string | null  // display name from agent.identity.get (e.g. "J.A.R.V.I.S.")
  activeAgentId: string | null     // selected agent filter (AgentSwitcher / Ctrl+G)
  sessions: Session[]
  agents: Agent[]
  setActiveSession: (sessionKey: string, agentId: string | null) => void
  clearActiveSession: () => void
  loadSessions: () => Promise<void>
  loadAgents: () => Promise<void>
  setActiveAgent: (agentId: string) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  connectionState: gatewayClient.connectionState,
  pairingRequestId: null,
  uiMode: 'texto',
  sessionKey: null,
  agentId: null,
  agentDisplayName: null,
  activeAgentId: null,
  sessions: [],
  agents: [],

  setActiveSession: (sessionKey, agentId) => set({ sessionKey, agentId }),
  setUiMode: (uiMode) => set({ uiMode }),
  clearActiveSession: () => set({ sessionKey: null, agentId: null, agentDisplayName: null }),

  loadSessions: async () => {
    const list = await sessionsList(gatewayClient)
    set({ sessions: list })
  },

  loadAgents: async () => {
    const list = await agentsList(gatewayClient)
    set({ agents: list })
  },

  setActiveAgent: (agentId) => {
    const { agentId: sessionAgentId, sessionKey } = get()
    // Clear if there is an active session AND it belongs to a different agent (or we don't
    // know its agent — sessionAgentId is null after reconnects because sessions.list doesn't
    // populate agentId, so we must compare on sessionKey presence, not sessionAgentId).
    if (sessionKey !== null && sessionAgentId !== agentId) {
      sessionsUnsubscribe(gatewayClient, sessionKey).catch(() => {})
      useMessagesStore.getState().clearMessages()
      useToolsStore.getState().clearRecords()
      set({ activeAgentId: agentId, sessionKey: null, agentId: null, agentDisplayName: null })
    } else {
      set({ activeAgentId: agentId })
    }
  },
}))

// Subscribe at module load — unsubscribe intentionally omitted (lifetime = app lifetime).
gatewayClient.on(EVENT_CONNECTION_STATE, (state) => {
  const s = state as ConnectionState
  // Clear the requestId when leaving pairing_required so stale IDs don't persist.
  useSessionStore.setState({ connectionState: s, ...(s !== 'pairing_required' ? { pairingRequestId: null } : {}) })
})
gatewayClient.on(EVENT_PAIRING_REQUEST_ID, (id) => {
  useSessionStore.setState({ pairingRequestId: id as string })
})
