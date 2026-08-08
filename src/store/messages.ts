// Zustand store: chat transcript for the active session.
// Actions for streaming (appendDelta + markMessageComplete) wired in the next phase
// when the Composer is ready and the full send→stream→complete loop can be tested end-to-end.

import { create } from 'zustand'

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
