// React hook: manages GatewayClient lifecycle and provides a typed `send` function.
// Exposes connection state + messages via Zustand selectors (reactive).
// `send` reads session state directly from the store at call time (never stale).

import { useCallback, useEffect } from 'react'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { useSessionStore } from '../store/session.ts'
import { useMessagesStore, type ChatMessage } from '../store/messages.ts'
import { agentsList, chatSend, sessionsCreate, sessionsSubscribe } from '../protocol/methods.ts'
import type { ConnectionState } from '../protocol/client.ts'

interface UseGatewayReturn {
  connectionState: ConnectionState
  sessionKey: string | null
  messages: ChatMessage[]
  send: (text: string) => Promise<void>
}

export function useGateway(): UseGatewayReturn {
  const connectionState = useSessionStore((s) => s.connectionState)
  const sessionKey = useSessionStore((s) => s.sessionKey)
  const messages = useMessagesStore((s) => s.messages)

  useEffect(() => {
    // connect() is idempotent: already-connected → resolves immediately,
    // in-progress → joins the existing promise. Safe to call from StrictMode double-invoke.
    // PAIRING_REQUIRED rejects (shown via connectionState); all other errors trigger
    // internal retry with backoff — no action needed here.
    gatewayClient.connect().catch(() => {})
    // No cleanup: gatewayClient is a singleton meant to stay connected for the app's lifetime.
  }, [])

  // send() reads latest sessionKey from the store at call time so it never captures
  // a stale closure value, and useCallback([]) keeps the reference stable across renders.
  const send = useCallback(async (text: string): Promise<void> => {
    let activeSessionKey = useSessionStore.getState().sessionKey

    if (!activeSessionKey) {
      // First message ever: discover the default agent and create a session
      const agents = await agentsList(gatewayClient)
      const firstAgent = agents[0]
      if (!firstAgent) throw new Error('No agents available from gateway')

      const session = await sessionsCreate(gatewayClient, firstAgent.id)
      // sessions.create returns `key` (confirmed from control-ui source)
      const newKey = session.key ?? session.sessionKey
      if (!newKey) throw new Error('sessions.create returned no key')
      activeSessionKey = newKey
      useSessionStore.getState().setActiveSession(activeSessionKey, firstAgent.id)

      // Subscribe so the gateway starts sending chat events for this session
      await sessionsSubscribe(gatewayClient, activeSessionKey, firstAgent.id)
    }

    // Optimistic user message — added after session exists, before chatSend round-trip
    // so the user sees their own message immediately regardless of server latency
    useMessagesStore.getState().addMessage({
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      text,
      isStreaming: false,
    })

    await chatSend(gatewayClient, activeSessionKey, text)
  }, [])

  return { connectionState, sessionKey, messages, send }
}
