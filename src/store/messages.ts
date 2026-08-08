// Zustand store: chat transcript for the active session.
// Handles streaming via `chat` events (deltaText accumulation + state:'final' to mark done).
// `session.message` events carry no streaming content — they notify transcript changes
// (the control-ui uses them to reload via chatHistory RPC; we handle them in a future phase).

import { create } from 'zustand'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { useSessionStore } from './session.ts'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: MessageRole
  text: string
  isStreaming: boolean
}

interface MessagesStore {
  messages: ChatMessage[]
  addMessage: (message: ChatMessage) => void
  appendDelta: (messageId: string, deltaText: string) => void
  markMessageComplete: (messageId: string) => void
  clearMessages: () => void
}

export const useMessagesStore = create<MessagesStore>((set) => ({
  messages: [],

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  appendDelta: (messageId, deltaText) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, text: m.text + deltaText } : m,
      ),
    })),

  markMessageComplete: (messageId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, isStreaming: false } : m,
      ),
    })),

  clearMessages: () => set({ messages: [] }),
}))

// ─── Gateway event wiring ─────────────────────────────────────────────────────
// `chat` events carry streaming content (confirmed from control-ui source analysis):
//   { sessionKey, runId, state, deltaText?, replace?, message? }
// - deltaText at top level (NOT nested inside message)
// - runId is the streaming message identifier
// - state: 'streaming' while in progress, 'final' when done
//
// `session.message` events notify transcript changes but carry no streaming content —
// handled in a future phase (reload via chatHistory RPC).

type ChatEventPayload = {
  sessionKey?: string
  runId?: string
  state?: string
  deltaText?: string
  replace?: boolean
  message?: Record<string, unknown>
  isHiddenStreamText?: boolean
}

gatewayClient.on('chat', (raw) => {
  const p = raw as ChatEventPayload

  // Filter to active session
  const activeKey = useSessionStore.getState().sessionKey
  if (p.sessionKey && p.sessionKey !== activeKey) return

  // Ignore hidden stream text (tool-internal content the UI shouldn't show)
  if (p.isHiddenStreamText) return

  const msgId = p.runId ?? 'stream-unknown'
  const store = useMessagesStore.getState()
  const exists = store.messages.some((m) => m.id === msgId)

  if (typeof p.deltaText === 'string' && p.deltaText.length > 0) {
    if (!exists) {
      store.addMessage({ id: msgId, role: 'assistant', text: p.deltaText, isStreaming: true })
    } else if (p.replace === true) {
      useMessagesStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === msgId ? { ...m, text: p.deltaText! } : m,
        ),
      }))
    } else {
      store.appendDelta(msgId, p.deltaText)
    }
  }

  // Mark complete when the run reaches a terminal state
  if (p.state === 'final' || p.state === 'aborted' || p.state === 'error') {
    if (exists || typeof p.deltaText === 'string') {
      store.markMessageComplete(msgId)
    }
  }
})
