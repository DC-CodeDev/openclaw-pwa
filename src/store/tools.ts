// Zustand store: tool call records for the active session.
// Two data sources feed this store — one per lifecycle stage:
//   live:    session.tool WS events (running → done/error in real time)
//   fallback: chat state='final' → reload from chat.history (for agents that skip session.tool)
//   history: selectSession → tool_use/tool_result blocks from chat.history (settled, durable)
// Merge rule: setSessionRecords() (history) replaces all live state — same pattern as messages.

import { create } from 'zustand'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { useSessionStore } from './session.ts'
import { useMessagesStore } from './messages.ts'
import type { ChatMessage } from './messages.ts'
import { chatHistory } from '../protocol/methods.ts'
import type { ContentBlock } from '../protocol/methods.ts'

function extractTextLocal(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is ContentBlock & { type: 'text'; text: string } =>
      b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n')
}

// Rows de tool del transcript (role real 'toolResult', variantes 'tool'/'toolCall'/'toolUse')
// NO son visibles en el chat: su contenido se renderiza como ToolCard. Sin este filtro
// el output crudo de las tools se mostraba como mensaje del asistente (bug auditado 2026-08-09).
export function isChatVisibleRole(role: string): boolean {
  return role === 'user' || role === 'assistant' || role === 'system'
}

export type ToolStatus = 'running' | 'done' | 'error'

export interface ToolCallRecord {
  id: string         // toolCallId (live) | tool_use.id (history)
  runId?: string     // matches ChatMessage.id — determines render position
  name: string
  args?: unknown
  status: ToolStatus
  output?: string
  startedAt: number  // epoch ms (0 when sourced from history — timestamp not available)
  updatedAt: number
}

interface ToolsStore {
  records: ToolCallRecord[]
  upsertRecord: (r: ToolCallRecord) => void
  setSessionRecords: (records: ToolCallRecord[]) => void
  clearRecords: () => void
}

export const useToolsStore = create<ToolsStore>((set) => ({
  records: [],

  upsertRecord: (r) =>
    set((state) => {
      const idx = state.records.findIndex((x) => x.id === r.id)
      if (idx === -1) return { records: [...state.records, r] }
      const next = [...state.records]
      next[idx] = r
      return { records: next }
    }),

  setSessionRecords: (records) => set({ records }),

  clearRecords: () => set({ records: [] }),
}))

// ─── History extraction helpers ───────────────────────────────────────────────
// chat.history is display-normalized, but we tolerate field name variants per DESIGN_DECISIONS sec 7.

export function isToolUseType(type: string): boolean {
  return type === 'tool_use' || type === 'toolCall' || type === 'tool_call' || type === 'tooluse'
}

export function isToolResultType(type: string): boolean {
  return type === 'tool_result' || type === 'toolResult'
}

export function getToolUseId(b: ContentBlock): string | null {
  return b.id ?? b.call_id ?? b.toolCallId ?? b.toolUseId ?? b.tool_call_id ?? null
}

export function getToolResultId(b: ContentBlock): string | null {
  return b.tool_use_id ?? b.tool_call_id ?? b.toolUseId ?? b.toolCallId ?? b.call_id ?? b.id ?? null
}

export function getToolArgs(b: ContentBlock): unknown {
  return b.input ?? b.arguments ?? b.args
}

export function blockContentToString(content: unknown): string | undefined {
  if (content === null || content === undefined) return undefined
  if (typeof content === 'string') return content || undefined
  if (Array.isArray(content)) {
    const text = (content as ContentBlock[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
    return text || JSON.stringify(content, null, 2) || undefined
  }
  return JSON.stringify(content, null, 2) || undefined
}

// Extract settled ToolCallRecords from a chat.history message array.
// tool-role messages (containing tool_result blocks) are paired with the preceding tool_use
// blocks via their shared id. Returns records with runId pointing to the assistant message id.
export function extractToolRecordsFromHistory(
  messages: { id?: string; role: string; content: string | ContentBlock[] }[],
  msgIds: string[],
): ToolCallRecord[] {
  const resultMap = new Map<string, { output: string | undefined; isError: boolean }>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (!isToolResultType(block.type)) continue
      const id = getToolResultId(block)
      if (!id) continue
      resultMap.set(id, {
        output: blockContentToString(block.content),
        isError: block.is_error === true,
      })
    }
  }

  const records: ToolCallRecord[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (!isToolUseType(block.type)) continue
      const id = getToolUseId(block)
      if (!id) continue
      const result = resultMap.get(id)
      const status: ToolStatus = result ? (result.isError ? 'error' : 'done') : 'done'
      records.push({
        id,
        runId: msgIds[i],
        name: block.name ?? '',
        args: getToolArgs(block),
        status,
        output: result?.output,
        startedAt: 0,
        updatedAt: 0,
      })
    }
  }
  return records
}

// ─── Live adapter: session.tool ───────────────────────────────────────────────
// Mirrors the Activity tab logic in the Control UI (DESIGN_DECISIONS sec 7).
// NOTE: confirmed via live testing that some agents don't emit session.tool events.
// The chat fallback below handles those cases.

type SessionToolData = {
  phase: 'start' | 'update' | 'result'
  name: string
  toolCallId: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  exitCode?: number
}

type SessionToolPayload = {
  runId: string
  stream: string
  ts: number
  sessionKey?: string
  data: SessionToolData
}

function deriveStatus(data: SessionToolData): ToolStatus {
  if (data.phase !== 'result') return 'running'
  const res = data.result as Record<string, unknown> | null | undefined
  const resultIsError = typeof res?.is_error === 'boolean' ? res.is_error : false
  const resultStatus = typeof res?.status === 'string' ? res.status : ''
  if (
    data.isError === true ||
    resultIsError ||
    /error|fail/i.test(resultStatus) ||
    (typeof data.exitCode === 'number' && isFinite(data.exitCode) && data.exitCode !== 0)
  ) {
    return 'error'
  }
  return 'done'
}

function rawToString(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') return raw || undefined
  if (Array.isArray(raw)) {
    const text = (raw as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
    return text || JSON.stringify(raw, null, 2) || undefined
  }
  return JSON.stringify(raw, null, 2) || undefined
}

gatewayClient.on('session.tool', (raw) => {
  const p = raw as SessionToolPayload
  if (p.stream !== 'tool') return

  const activeKey = useSessionStore.getState().sessionKey
  if (p.sessionKey && p.sessionKey !== activeKey) return

  const { data } = p
  const store = useToolsStore.getState()
  const existing = store.records.find((r) => r.id === data.toolCallId)
  const status = deriveStatus(data)

  store.upsertRecord({
    id: data.toolCallId,
    runId: p.runId,
    name: data.name,
    args: data.phase === 'start' ? data.args : existing?.args,
    status,
    output:
      data.phase === 'result'
        ? rawToString(data.result)
        : data.phase === 'update'
          ? rawToString(data.partialResult)
          : existing?.output,
    startedAt: existing?.startedAt ?? p.ts,
    updatedAt: p.ts,
  })
})

// ─── Fallback adapter: chat state='final' → history reload ───────────────────
// Triggered when an agent completes a turn without emitting session.tool events.
// Loads tool_use/tool_result blocks from chat.history and settles the records.

type ChatFinalPayload = { sessionKey?: string; runId?: string; state?: string }

gatewayClient.on('chat', (raw) => {
  const p = raw as ChatFinalPayload
  if (p.state !== 'final') return

  const { sessionKey } = useSessionStore.getState()
  if (!sessionKey) return
  if (p.sessionKey && p.sessionKey !== sessionKey) return

  // If session.tool events already provided records (startedAt > 0), skip.
  if (useToolsStore.getState().records.some((r) => r.startedAt !== 0)) return

  // Wait briefly for the transcript to be fully written before reading history.
  setTimeout(() => {
    void chatHistory(gatewayClient, sessionKey)
      .then((msgs) => {
        const ts = Date.now()
        const msgIds = msgs.map((m, i) => m.id ?? `hist-${i}-${ts}`)
        const records = extractToolRecordsFromHistory(msgs, msgIds)
        if (records.length === 0) return

        useToolsStore.getState().setSessionRecords(records)

        // Update messages store to include tool_use messages from history.
        // These don't appear in live streaming (no deltaText), so the runId linkage
        // for ToolCards only works after messages are replaced with the authoritative history.
        const mapped: ChatMessage[] = []
        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i]
          if (!isChatVisibleRole(m.role)) continue
          mapped.push({
            id: msgIds[i],
            role: m.role as ChatMessage['role'],
            text: extractTextLocal(m.content),
            isStreaming: false,
          })
        }
        useMessagesStore.setState({ messages: mapped })
      })
      .catch(() => {})
  }, 1500)
})
