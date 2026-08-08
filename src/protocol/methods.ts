// Typed RPC helpers over GatewayClient.call(). One function per Gateway method — no logic, no state,
// just param/return typing so callers never write raw method name strings.

import type { GatewayClient } from './client.ts'

// ─── Response types ──────────────────────────────────────────────────────────

// Confirmed from probe run: agents.list returns objects with at least { id }
// TODO: confirm full shape (model, description, runtime, etc.) on first real use
export interface Agent {
  id: string
  name?: string
  model?: string
  description?: string
}

// TODO: confirm full Session shape — sessions.create guarantees sessionKey per section 5.2
export interface Session {
  sessionKey: string
  agentId?: string
  createdAt?: string
  updatedAt?: string
  state?: string
}

// TODO: confirm ChatMessage field names in v4 (role / content are standard, id may differ)
export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  // v4 streaming fields on partial messages
  deltaText?: string
  replace?: boolean
}

// TODO: confirm chat.send return shape — likely a message id or ack
export interface ChatSendResult {
  messageId?: string
}

// TODO: confirm agent.identity.get full shape (section 5.3 mentions name + avatar)
export interface AgentIdentity {
  name?: string
  agentId?: string
  avatar?: string
  description?: string
}

// TODO: confirm sessions.usage shape — section 5.5 describes token totals per session
export interface SessionUsage {
  sessionKey?: string
  tokens?: {
    input: number
    output: number
    total: number
  }
  cost?: number
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
 * TODO: confirm exact param name for the message body (may be "message" or "text" — using "content" for now)
 */
export async function chatSend(
  client: GatewayClient,
  sessionKey: string,
  content: string,
): Promise<ChatSendResult> {
  return client.call('chat.send', {
    sessionKey,
    content,
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
  const params: Record<string, unknown> = {}
  if (agentId !== undefined) params.agentId = agentId
  const raw = await client.call('sessions.list', params)
  // TODO: confirm shape — may be array or { sessions: [...] }
  if (Array.isArray(raw)) return raw as Session[]
  const wrapped = raw as { sessions?: Session[] }
  return wrapped.sessions ?? []
}

/**
 * Create a new session for an agent. Returns the new session including its sessionKey.
 * Side-effect — idempotency key generated automatically.
 */
export async function sessionsCreate(
  client: GatewayClient,
  agentId: string,
): Promise<Session> {
  return client.call('sessions.create', {
    agentId,
    idempotencyKey: crypto.randomUUID(),
  }) as Promise<Session>
}

/** Fetch the full session row for a given sessionKey. */
export async function sessionsGet(
  client: GatewayClient,
  sessionKey: string,
): Promise<Session> {
  return client.call('sessions.get', { sessionKey }) as Promise<Session>
}

/**
 * Reset a session (clears its transcript). Side-effect — idempotency key generated automatically.
 * Equivalent to `/new` within the same session.
 */
export async function sessionsReset(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  await client.call('sessions.reset', {
    sessionKey,
    idempotencyKey: crypto.randomUUID(),
  })
}

/**
 * Subscribe to transcript events for one session (session.message events).
 * Must be called before the gateway will start pushing chat/session.message events for this key.
 */
export async function sessionsSubscribe(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  await client.call('sessions.messages.subscribe', { sessionKey })
}

/** Unsubscribe from transcript events for a session. */
export async function sessionsUnsubscribe(
  client: GatewayClient,
  sessionKey: string,
): Promise<void> {
  await client.call('sessions.messages.unsubscribe', { sessionKey })
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

/** Fetch token usage summary for a session (displayed in StatusBar). */
export async function sessionsUsage(
  client: GatewayClient,
  sessionKey: string,
): Promise<SessionUsage> {
  return client.call('sessions.usage', { sessionKey }) as Promise<SessionUsage>
}

// ── TTS ──────────────────────────────────────────────────────────────────────

/**
 * Synthesize text to audio via the Gateway's TTS provider (Azure Speech in production).
 * Returns audioBase64 + metadata for the PWA to decode and play — the gateway key never
 * reaches the browser (section 3, DESIGN_DECISIONS.md).
 *
 * sessionKey is optional context; include it so the gateway can apply per-agent voice overrides
 * if supported. TODO: confirm whether sessionKey is a valid param for tts.speak.
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
