// Typed RPC helpers over GatewayClient.call(). One function per Gateway method — no logic, no state,
// just param/return typing so callers never write raw method name strings.

import type { GatewayClient } from './client.ts'
import { loadDeviceToken } from './device.ts'

// ─── Response types ──────────────────────────────────────────────────────────

// Confirmed from probe run: agents.list returns objects with at least { id }
// TODO: confirm full shape (model, description, runtime, etc.) on first real use
export interface Agent {
  id: string
  name?: string
  // model may be a plain string or an object {primary: "..."} — handle both at render time
  model?: string | Record<string, unknown>
  description?: string
}

// Confirmed from control-ui source: sessions.create returns `key` (not `sessionKey`)
// derivedTitle / lastMessagePreview only present when requested via includeDerivedTitles/includeLastMessage flags.
export interface Session {
  key: string         // primary field: confirmed from control-ui source
  sessionKey?: string // legacy alias present in some contexts
  agentId?: string
  kind?: string       // 'main' | 'dm' | 'group' | 'cron' | 'subagent' | 'other'
  status?: string     // 'running' | 'idle'
  derivedTitle?: string        // resolved display name (server-computed). Requires includeDerivedTitles: true
  lastMessagePreview?: string  // truncated last message. Requires includeLastMessage: true
  contextTokens?: number
  contextBudgetStatus?: {
    estimatedPromptTokens?: number
    contextTokenBudget?: number
  }
  startedAt?: number  // epoch ms
  updatedAt?: number  // epoch ms
  // Thinking (confirmado contra gateway real 2026-08-08): `thinkingLevel` SOLO aparece cuando
  // hay override seteado (ausente = sin override); `thinkingDefault` es el nivel por defecto del
  // modelo; `thinkingLevels[]`/`thinkingOptions[]` son las opciones válidas (off|minimal|low|medium|high|xhigh|max).
  thinkingLevel?: string
  thinkingDefault?: string
  thinkingLevels?: Array<{ id: string; label: string }>
  thinkingOptions?: string[]
}

// Confirmed from live probe: content can be a plain string OR an array of typed blocks.
// Observed block types: text, thinking (extended thinking), tool_use, tool_result.
export interface ContentBlock {
  type: string
  text?: string        // type: 'text'
  thinking?: string    // type: 'thinking' (extended thinking)
  // tool_use fields
  id?: string          // tool call id — canonical form
  name?: string
  input?: unknown      // args — canonical form
  // tool_result fields
  tool_use_id?: string // canonical form
  content?: unknown    // result content (string or ContentBlock[])
  is_error?: boolean
  // field name variants (tolerated per DESIGN_DECISIONS sec 7 — normalize at consumption site)
  call_id?: string
  toolCallId?: string
  toolUseId?: string
  tool_call_id?: string
  arguments?: unknown
  args?: unknown
}

export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  // Real shape: plain string for simple messages, ContentBlock[] for tool/thinking sessions
  content: string | ContentBlock[]
  // v4 streaming fields on partial messages
  deltaText?: string
  replace?: boolean
  // Usage for assistant messages — present in chat.history, absent in streaming deltas.
  // totalTokens = input + output + cacheRead: the full context sent for this turn.
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
  }
}

// TODO: confirm chat.send return shape — likely a message id or ack
export interface ChatSendResult {
  messageId?: string
}

// Confirmed from live probe: agent.identity.get returns display name + emoji per session.
// Examples: main → { agentId:"main", name:"J.A.R.V.I.S.", emoji:"🧠" }
//           hue  → { agentId:"hue",  name:"HUE",          emoji:"💠" }
export interface AgentIdentity {
  agentId?: string
  name?: string
  avatar?: string        // "—" when no avatar image is configured
  emoji?: string
  avatarSource?: string
  avatarStatus?: string
  avatarReason?: string
}

// Real shape confirmed 2026-08-08 (probe against the gateway): sessions.usage returns a usage
// report where per-session totals live at sessions[].usage.totalTokens and the aggregate at
// totals.totalTokens. `usage` may be null for sessions with no recorded usage.
export interface SessionUsageTotals {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  totalCost?: number
  inputCost?: number
  outputCost?: number
  cacheReadCost?: number
  cacheWriteCost?: number
  missingCostEntries?: number
}

export interface SessionUsageEntry {
  key?: string
  sessionId?: string
  scope?: string
  updatedAt?: number
  agentId?: string
  usage?: SessionUsageTotals & {
    messageCounts?: {
      total?: number
      user?: number
      assistant?: number
      toolCalls?: number
      toolResults?: number
      errors?: number
    }
  }
}

export interface SessionUsage {
  updatedAt?: number
  startDate?: string
  endDate?: string
  sessions?: SessionUsageEntry[]
  totals?: SessionUsageTotals
  aggregates?: Record<string, unknown>
  cacheStatus?: Record<string, unknown>
}

// Confirmed from section 6.5, verified in live POST /tools/invoke test on 2026-08-07
export interface TtsSpeakResult {
  audioBase64: string
  provider: string
  outputFormat: string
  mimeType: string
  fileExtension: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Send a user message to a session. Side-effect method — generates an idempotency key.
 * Confirmed from control-ui source: param is `message` (not `content`).
 */
export async function chatSend(
  client: GatewayClient,
  sessionKey: string,
  message: string,
): Promise<ChatSendResult> {
  return client.call('chat.send', {
    sessionKey,
    message,
    idempotencyKey: crypto.randomUUID(),
  }) as Promise<ChatSendResult>
}

/**
 * Load the display-normalized transcript for a session (no directive tags, no tool XML,
 * no NO_REPLY silents — per section 5.6).
 */
export async function chatHistory(
  client: GatewayClient,
  sessionKey: string,
): Promise<ChatMessage[]> {
  const raw = await client.call('chat.history', { sessionKey })
  // Normalize: may be a plain array or wrapped in { messages: [...] }
  // TODO: confirm shape on first real call and remove the branch that doesn't apply
  if (Array.isArray(raw)) return raw as ChatMessage[]
  const wrapped = raw as { messages?: ChatMessage[] }
  return wrapped.messages ?? []
}

/** Cancel an in-progress generation for a session. */
export async function chatAbort(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  await client.call('chat.abort', { sessionKey })
}

// ── Sessions ─────────────────────────────────────────────────────────────────

/** List sessions, optionally filtered by agentId (needed for Ctrl+G agent switch flow). */
export async function sessionsList(
  client: GatewayClient,
  agentId?: string,
): Promise<Session[]> {
  const params: Record<string, unknown> = {
    includeDerivedTitles: true,
    includeLastMessage: true,
  }
  if (agentId !== undefined) params.agentId = agentId
  const raw = await client.call('sessions.list', params)
  // TODO: confirm shape — may be array or { sessions: [...] }
  if (Array.isArray(raw)) return raw as Session[]
  const wrapped = raw as { sessions?: Session[] }
  return wrapped.sessions ?? []
}

/**
 * Create a new session for an agent. Returns the new session including its sessionKey.
 * NOTE: sessions.create rejects unknown properties — idempotencyKey confirmed NOT accepted.
 * Real shape confirmed 2026-08-08: { ok, key, sessionId, entry: { sessionId, sessionFile,
 * updatedAt }, runStarted } — updatedAt is nested in `entry`, flattened here onto Session.updatedAt.
 */
export async function sessionsCreate(
  client: GatewayClient,
  agentId: string,
): Promise<Session> {
  const raw = await client.call('sessions.create', { agentId })
  const r = raw as { key?: string; sessionKey?: string; entry?: { updatedAt?: number } }
  const session: Session = {
    ...(r as Record<string, unknown>),
    key: r.key ?? r.sessionKey,
  } as Session
  if (r.entry?.updatedAt != null) session.updatedAt = r.entry.updatedAt
  return session
}

/** Fetch the full session row for a given sessionKey. */
export async function sessionsGet(
  client: GatewayClient,
  sessionKey: string,
): Promise<Session> {
  return client.call('sessions.get', { sessionKey }) as Promise<Session>
}

// Confirmado contra el gateway real (2026-08-08): sessions.patch devuelve
// { ok, path, key, entry: { sessionId, updatedAt, sessionFile, ... } } y requiere scope
// operator.admin (sin admin: INVALID_REQUEST missing scope). El mismo método actualiza
// model/archived/pinned/etc. — acá solo se expone thinkingLevel que es lo que consume la UI.
export interface SessionsPatchResult {
  ok?: boolean
  key?: string
  path?: string
  entry?: { sessionId?: string; updatedAt?: number }
  resolved?: Record<string, unknown>
}

/**
 * PATCH de una sesión. `thinkingLevel` acepta un override válido
 * (off|minimal|low|medium|high|xhigh|max — valores confirmados en el error del gateway)
 * o `null` para LIMPIAR el override y volver al thinkingDefault del modelo.
 * Confirmado 2026-08-08: `"default"` NO es válido (INVALID_REQUEST); null es el mecanismo de limpieza.
 */
export async function sessionsPatch(
  client: GatewayClient,
  key: string,
  patch: { thinkingLevel: string | null },
): Promise<SessionsPatchResult> {
  return client.call('sessions.patch', { key, thinkingLevel: patch.thinkingLevel }) as Promise<SessionsPatchResult>
}

/**
 * Reset a session (clears its transcript). Side-effect — idempotency key generated automatically.
 * Equivalent to `/new` within the same session.
 */
export async function sessionsReset(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  // NOTE: if sessions.reset also rejects idempotencyKey (same schema as create), remove it here too
  await client.call('sessions.reset', { sessionKey })
}

/**
 * Subscribe to transcript events for one session (session.message events).
 * Must be called before the gateway will start pushing chat/session.message events for this key.
 */
export async function sessionsSubscribe(
  client: GatewayClient,
  sessionKey: string,
  agentId?: string,
): Promise<void> {
  // Confirmed from control-ui source: param is `key` (not `sessionKey`), optional `agentId`
  const params: Record<string, unknown> = { key: sessionKey }
  if (agentId !== undefined) params.agentId = agentId
  await client.call('sessions.messages.subscribe', params)
}

/** Unsubscribe from transcript events for a session. */
export async function sessionsUnsubscribe(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  // Same convention: `key` not `sessionKey`
  await client.call('sessions.messages.unsubscribe', { key: sessionKey })
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** List all available agents (used for the Ctrl+G AgentSwitcher). */
export async function agentsList(client: GatewayClient): Promise<Agent[]> {
  const raw = await client.call('agents.list', {})
  // Normalize: probe observed both plain array and { agents: [...] } shapes
  if (Array.isArray(raw)) return raw as Agent[]
  const wrapped = raw as { agents?: Agent[] }
  return wrapped.agents ?? []
}

/**
 * Get the effective identity of the agent for a session (name, avatar, etc.).
 * Used to populate the StatusBar and AgentSwitcher labels.
 */
export async function agentIdentityGet(
  client: GatewayClient,
  sessionKey: string,
): Promise<AgentIdentity> {
  return client.call('agent.identity.get', { sessionKey }) as Promise<AgentIdentity>
}

// ── Usage ─────────────────────────────────────────────────────────────────────

/**
 * Fetch token usage summary for a session (displayed in StatusBar).
 * Confirmed 2026-08-08: param is `key` (NOT sessionKey — the server rejects sessionKey with
 * INVALID_REQUEST), same convention as sessions.messages.subscribe.
 */
export async function sessionsUsage(
  client: GatewayClient,
  sessionKey: string,
): Promise<SessionUsage> {
  return client.call('sessions.usage', { key: sessionKey }) as Promise<SessionUsage>
}

// ── TTS ──────────────────────────────────────────────────────────────────────

/**
 * Synthesize text to audio via the Gateway's TTS provider (Azure Speech in production).
 * Returns audioBase64 + metadata for the PWA to decode and play — the gateway key never
 * reaches the browser (section 3, DESIGN_DECISIONS.md).
 *
 * CONFIRMADO contra el gateway instalado (2026.6.2, 2026-08-08):
 * - Requiere scope `operator.admin` en el handshake (antes: INVALID_REQUEST missing scope).
 * - tts.speak NO existe en 2026.6.2 (unknown method) — aparece en versiones más nuevas.
 *   En 2026.6.2 el método real es `tts.convert`, que devuelve { audioPath, provider,
 *   outputFormat, voiceCompatible } con un archivo local al gateway (no servible al browser).
 * - Shape objetivo (tts.speak): { audioBase64, provider, outputFormat, mimeType, fileExtension }.
 * TODO: validar en producción cuando el gateway tenga tts.speak.
 * El flujo que el PWA usa HOY en 2026.6.2 es ttsConvertAndFetch() (abajo): tts.convert +
 * el endpoint HTTP assistant-media — tts.speak queda solo para cuando el gateway se actualice.
 */
export async function ttsSpeak(
  client: GatewayClient,
  text: string,
  sessionKey?: string,
): Promise<TtsSpeakResult> {
  const params: Record<string, unknown> = { text }
  if (sessionKey !== undefined) params.sessionKey = sessionKey
  return client.call('tts.speak', params) as Promise<TtsSpeakResult>
}

// ── TTS real en 2026.6.2: tts.convert + endpoint de media ─────────────────────
// tts.speak no existe en el gateway instalado — el flujo adoptado (verificado en vivo,
// DESIGN_DECISIONS.md sección 7) es: tts.convert → audioPath → meta=1 (ticket) → fetch del
// archivo. El Blob resultante se reproduce con useAudioPlayback.

// Shape de tts.convert (confirmado 2026.6.2): no devuelve audio inline, devuelve la ruta de
// un archivo temporal en el host del gateway (audioPath) — el browser no puede leer esa ruta
// directo, se sirve por el endpoint HTTP assistant-media con un ticket de corta duración.
export interface TtsConvertResult {
  audioPath: string
  provider: string
  outputFormat: string
  voiceCompatible?: boolean
}

// Respuesta de GET /__openclaw__/assistant-media?meta=1&source=<path>:
// { available: true, mediaTicket: "v1.<payload>.<sig>", mediaTicketExpiresAt, mimeType?, ... }
// o { available: false, reason, code } cuando el archivo no existe / no es accesible.
export interface AssistantMediaMeta {
  available: boolean
  mediaTicket?: string
  mediaTicketExpiresAt?: string
  mimeType?: string
  reason?: string
  code?: string
}

// Mismo criterio de token que el handshake (handshake.ts): el deviceToken del pairing tiene
// prioridad, cae al GATEWAY_TOKEN compartido. El endpoint de media acepta ambos como bearer
// (device-token y shared-secret se verifican en authorizeControlUiReadRequest).
async function resolveMediaBearerToken(): Promise<string | null> {
  const deviceToken = await loadDeviceToken()
  if (deviceToken) return deviceToken
  const gatewayToken = import.meta.env.GATEWAY_TOKEN
  return gatewayToken || null
}

// URL RELATIVA a propósito: el gateway 2026.6.2 NO emite headers CORS en assistant-media
// (verificado en vivo, 2026-08-08) — un fetch cross-origin al puerto del gateway es bloqueado
// por el browser, con o sin bearer, con o sin ticket. El Control UI oficial lo resuelve siendo
// same-origin (lo sirve el propio gateway); el PWA hace lo mismo por el proxy de /__openclaw__
// (vite en dev, reverse proxy en prod — ver vite.config.ts y DESIGN_DECISIONS.md sección 7).
const ASSISTANT_MEDIA_PATH = '/__openclaw__/assistant-media'

/**
 * Flujo TTS real del gateway (DESIGN_DECISIONS.md sección 7, verificado en vivo):
 *   tts.convert(texto) → audioPath (archivo temporal en el host del gateway)
 *   GET /__openclaw__/assistant-media?meta=1&source=<audioPath> (bearer) → mediaTicket
 *   GET /__openclaw__/assistant-media?source=<audioPath>&mediaTicket=<ticket> → blob de audio
 * Devuelve el Blob de audio listo para decodificar/reproducir.
 * Pasos 2 y 3 corren en secuencia inmediata sin demoras: el mediaTicket expira en minutos y
 * los archivos TTS tienen lifecycle de limpieza — no cachear el ticket ni diferir el fetch.
 */
export async function ttsConvertAndFetch(client: GatewayClient, text: string): Promise<Blob> {
  const convert = (await client.call('tts.convert', { text })) as TtsConvertResult
  if (!convert.audioPath) {
    throw new Error(`tts.convert no devolvió audioPath: ${JSON.stringify(convert)}`)
  }

  const token = await resolveMediaBearerToken()
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  // La misma string `source` (mismo encoding) en ambos requests: el ticket queda ligado al source.
  const source = encodeURIComponent(convert.audioPath)

  // meta=1 justo antes de reproducir — el ticket NO se cachea (expira en minutos).
  const metaRes = await fetch(`${ASSISTANT_MEDIA_PATH}?meta=1&source=${source}`, { headers })
  if (!metaRes.ok) {
    throw new Error(`assistant-media meta falló: HTTP ${metaRes.status}`)
  }
  const meta = (await metaRes.json()) as AssistantMediaMeta
  if (!meta.available || !meta.mediaTicket) {
    throw new Error(
      `assistant-media: archivo no disponible (${meta.code ?? 'unknown'}): ${meta.reason ?? 'sin detalle'}`,
    )
  }

  // Fetch inmediato con el ticket — secuencia sin demoras (lifecycle de limpieza del archivo).
  const mediaRes = await fetch(
    `${ASSISTANT_MEDIA_PATH}?source=${source}&mediaTicket=${encodeURIComponent(meta.mediaTicket)}`,
  )
  if (!mediaRes.ok) {
    throw new Error(`assistant-media fetch falló: HTTP ${mediaRes.status}`)
  }
  return mediaRes.blob()
}

// ── Run Limiter ───────────────────────────────────────────────────────────────

export interface RunLimiterStatusResult {
  paused: boolean
  runId?: string
  expiresAt?: number
}

/**
 * Consulta si el run actual para una sesión está pausado por el plugin run-limiter.
 * Se llama desde el PWA después de cada chat event state='final'.
 * Si paused=true, el PWA debe disparar una notificación del navegador.
 */
export async function runLimiterStatus(
  client: GatewayClient,
  sessionKey: string,
): Promise<RunLimiterStatusResult> {
  return client.call('run-limiter.status', { sessionKey }) as Promise<RunLimiterStatusResult>
}

export interface RunLimiterSetLimitResult {
  ok: boolean
  limit: number
}

/**
 * Actualiza el límite activo de tool calls en el plugin run-limiter.
 * El cambio es inmediato: el próximo before_tool_call ya usa el nuevo valor.
 * El plugin conserva este valor hasta su próximo reinicio — no se resetea al recargar el PWA.
 */
export async function runLimiterSetLimit(
  client: GatewayClient,
  limit: number,
): Promise<RunLimiterSetLimitResult> {
  return client.call('run-limiter.setLimit', { limit }) as Promise<RunLimiterSetLimitResult>
}
