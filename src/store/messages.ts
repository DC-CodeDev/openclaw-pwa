// Zustand store: chat transcript per session, streaming deltaText accumulation from chat/session.message events

import { create } from 'zustand'

interface MessagesStore {
  messages: Record<string, unknown[]>
}

export const useMessagesStore = create<MessagesStore>(() => ({
  messages: {},
}))
