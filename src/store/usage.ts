// Zustand store: token usage per session from sessions.usage / sessions.usage.timeseries

import { create } from 'zustand'

interface UsageStore {
  usage: Record<string, unknown>
}

export const useUsageStore = create<UsageStore>(() => ({
  usage: {},
}))
