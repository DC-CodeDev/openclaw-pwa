// React hook: manages GatewayClient lifecycle and provides session management + chat send.
// createNewSession / selectSession live here (not in the store) because they coordinate
// two stores (session + messages) and async protocol calls — the store stays sync.

import { useCallback, useEffect, useState } from 'react'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { useSessionStore } from '../store/session.ts'
import { useMessagesStore, startTurnWatchdog, cancelTurnWatchdog, type ChatMessage } from '../store/messages.ts'
import {
  useToolsStore,
  extractToolRecordsFromHistory,
  isChatVisibleRole,
} from '../store/tools.ts'
import {
  agentsList,
  agentIdentityGet,
  chatSend,
  chatHistory,
  sessionsCreate,
  sessionsSubscribe,
  sessionsUnsubscribe,
} from '../protocol/methods.ts'
import type { Session, Agent, ContentBlock, ChatMessage as GwChatMessage } from '../protocol/methods.ts'
import type { ConnectionState } from '../protocol/client.ts'

// Flatten API content (string | ContentBlock[]) to a displayable string.
// Only text blocks are shown; thinking/tool_use/tool_result blocks are skipped.
// The type check is the filter: any non-'text' block (including type variants like
// 'thinking'/'reasoning' with a text field) is dropped from display.
function isTextBlock(b: ContentBlock): b is ContentBlock & { type: 'text'; text: string } {
  return b.type === 'text' && typeof b.text === 'string'
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
}

// Pure function — outside the hook so the reference is stable (no useCallback needed).
// Returns the last assistant message's usage.totalTokens, which is the total tokens sent
// for that turn (input + cacheRead + output). This is the current context size, NOT the
// accumulated sum across all turns.
function extractContextFromHistory(msgs: GwChatMessage[]): number | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && typeof m.usage?.totalTokens === 'number') {
      return m.usage.totalTokens
    }
  }
  return null
}

interface UseGatewayReturn {
  connectionState: ConnectionState
  sessionKey: string | null
  sessions: Session[]
  agents: Agent[]
  activeAgentId: string | null
  agentDisplayName: string | null
  messages: ChatMessage[]
  waitingForResponse: boolean
  silenceWarning: boolean
  contextEstimate: number | null
  send: (text: string) => Promise<void>
  createNewSession: () => Promise<void>
  selectSession: (key: string) => Promise<void>
  setActiveAgent: (agentId: string) => void
}

export function useGateway(): UseGatewayReturn {
  const connectionState = useSessionStore((s) => s.connectionState)
  const sessionKey = useSessionStore((s) => s.sessionKey)
  const sessions = useSessionStore((s) => s.sessions)
  const agents = useSessionStore((s) => s.agents)
  const activeAgentId = useSessionStore((s) => s.activeAgentId)
  const agentDisplayName = useSessionStore((s) => s.agentDisplayName)
  const setActiveAgent = useSessionStore((s) => s.setActiveAgent)
  const messages = useMessagesStore((s) => s.messages)
  const waitingForResponse = useMessagesStore((s) => s.waitingForResponse)
  const silenceWarning = useMessagesStore((s) => s.silenceWarning)
  const [contextEstimate, setContextEstimate] = useState<number | null>(null)

  useEffect(() => {
    gatewayClient.connect().catch(() => {})
  }, [])

  // Reload session list and agent list every time the connection is established.
  // loadSessions fetches contextBudgetStatus.estimatedPromptTokens (current context size)
  // along with the session metadata — no separate usage RPC needed.
  useEffect(() => {
    if (connectionState === 'connected') {
      const { loadSessions, loadAgents } = useSessionStore.getState()
      loadSessions().catch(console.error)
      loadAgents().catch(console.error)
    }
  }, [connectionState])

  // After each turn ends: refresh session list and update context estimate from fresh history.
  // chatHistory is the authoritative source for context size: last assistant message's
  // usage.totalTokens = tokens sent for that turn (input + cacheRead + output), which is
  // the actual current context size — not the accumulated total across all turns.
  // Delay matches the tools.ts fallback: transcript is fully written ~1.5s after state='final'.
  useEffect(() => {
    const unsub = gatewayClient.on('chat', (raw) => {
      const p = raw as { state?: string; sessionKey?: string }
      if (p.state !== 'final' && p.state !== 'aborted' && p.state !== 'error') return
      const activeKey = useSessionStore.getState().sessionKey
      if (!activeKey || (p.sessionKey && p.sessionKey !== activeKey)) return
      setTimeout(() => {
        useSessionStore.getState().loadSessions().catch(() => {})
        chatHistory(gatewayClient, activeKey)
          .then((msgs) => {
            const est = extractContextFromHistory(msgs)
            if (est !== null) setContextEstimate(est)
          })
          .catch(() => {})
      }, 1600)
    })
    return unsub
  }, [])

  const createNewSession = useCallback(async (): Promise<void> => {
    const state = useSessionStore.getState()

    // Use the active agent filter; fall back to first available if none selected yet.
    let resolvedAgentId: string
    if (state.activeAgentId) {
      resolvedAgentId = state.activeAgentId
    } else {
      const available = state.agents.length > 0 ? state.agents : await agentsList(gatewayClient)
      const first = available[0]
      if (!first) throw new Error('No agents available from gateway')
      resolvedAgentId = first.id
    }

    // Leave previous session cleanly.
    if (state.sessionKey) {
      await sessionsUnsubscribe(gatewayClient, state.sessionKey).catch(() => {})
    }

    const session = await sessionsCreate(gatewayClient, resolvedAgentId)
    const newKey = session.key ?? session.sessionKey
    if (!newKey) throw new Error('sessions.create returned no key')

    useSessionStore.setState((s) => ({
      sessions: [...s.sessions, { ...session, key: newKey, agentId: resolvedAgentId }],
      sessionKey: newKey,
      agentId: resolvedAgentId,
    }))
    cancelTurnWatchdog()
    useMessagesStore.getState().clearMessages()
    useToolsStore.getState().clearRecords()
    setContextEstimate(null)

    await sessionsSubscribe(gatewayClient, newKey, resolvedAgentId)

    agentIdentityGet(gatewayClient, newKey)
      .then((id) => { if (id.name) useSessionStore.setState({ agentDisplayName: id.name }) })
      .catch(() => {})
  }, [])

  const selectSession = useCallback(async (targetKey: string): Promise<void> => {
    const state = useSessionStore.getState()
    if (state.sessionKey === targetKey) return

    if (state.sessionKey) {
      await sessionsUnsubscribe(gatewayClient, state.sessionKey).catch(() => {})
    }

    const found = state.sessions.find((s) => s.key === targetKey)
    const agentId = found?.agentId ?? null

    useSessionStore.setState({ sessionKey: targetKey, agentId })
    cancelTurnWatchdog()
    useMessagesStore.getState().clearMessages()

    await sessionsSubscribe(gatewayClient, targetKey, agentId ?? undefined)

    // Load history and agent identity in parallel.
    const [historyResult, identityResult] = await Promise.allSettled([
      chatHistory(gatewayClient, targetKey),
      agentIdentityGet(gatewayClient, targetKey),
    ])

    if (identityResult.status === 'fulfilled' && identityResult.value.name) {
      useSessionStore.setState({ agentDisplayName: identityResult.value.name })
    }

    if (historyResult.status === 'fulfilled') {
      const histMessages = historyResult.value

      // Update context estimate from the last assistant message's usage.totalTokens.
      const est = extractContextFromHistory(histMessages)
      setContextEstimate(est)

      // Pre-compute stable IDs — needed for runId linkage in tool records.
      const ts = Date.now()
      const msgIds = histMessages.map((m, i) => m.id ?? `hist-${i}-${ts}`)

      // Extract settled tool records and push to store (replaces any live optimistic state).
      const toolRecords = extractToolRecordsFromHistory(histMessages, msgIds)
      useToolsStore.getState().setSessionRecords(toolRecords)

      // Map messages, skipping tool-role rows (their content is rendered as ToolCards).
      // role real del gateway: 'toolResult' (no 'tool') — isChatVisibleRole cubre ambas.
      const mapped: ChatMessage[] = []
      for (let i = 0; i < histMessages.length; i++) {
        const m = histMessages[i]
        if (!isChatVisibleRole(m.role)) continue
        mapped.push({
          id: msgIds[i],
          role: m.role as ChatMessage['role'],
          text: extractText(m.content),
          isStreaming: false,
        })
      }
      useMessagesStore.setState({ messages: mapped })
    }

  }, [])

  // send() reads sessionKey at call time — never captures a stale closure value.
  const send = useCallback(async (text: string): Promise<void> => {
    const activeKey = useSessionStore.getState().sessionKey
    if (!activeKey) return // UI prevents this, but guard defensively.

    useMessagesStore.getState().addMessage({
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text,
      isStreaming: false,
    })
    // Señal de espera: visible hasta que llegue el primer delta o un estado terminal.
    useMessagesStore.getState().setWaitingForResponse(true)
    // Watchdog: si pasan 45s sin ningún evento del gateway, cortar waitingForResponse
    // y mostrar aviso. Cubre el caso de sesión ocupada por otro cliente (el gateway
    // no emite error — el silencio total es la única señal disponible).
    startTurnWatchdog()

    try {
      await chatSend(gatewayClient, activeKey, text)
    } catch (err) {
      // El envío falló y nunca vendrá respuesta → no dejar el indicador colgado.
      cancelTurnWatchdog()
      useMessagesStore.getState().setWaitingForResponse(false)
      throw err
    }
  }, [])

  return {
    connectionState,
    sessionKey,
    sessions,
    agents,
    activeAgentId,
    agentDisplayName,
    messages,
    waitingForResponse,
    silenceWarning,
    contextEstimate,
    send,
    createNewSession,
    selectSession,
    setActiveAgent,
  }
}
