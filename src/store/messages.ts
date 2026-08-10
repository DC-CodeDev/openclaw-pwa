// Zustand store: chat transcript for the active session.
// Handles streaming via `chat` events (deltaText accumulation + state:'final' to mark done).
// `session.message` events carry no streaming content — they notify transcript changes
// (the control-ui uses them to reload via chatHistory RPC; we handle them in a future phase).

import { create } from 'zustand'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { useSessionStore } from './session.ts'
import { enqueueAudioFragment } from '../hooks/useSessionAudioState.ts'
import { runLimiterStatus } from '../protocol/methods.ts'
import { TurnWatchdog } from './watchdog.ts'

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: MessageRole
  text: string
  isStreaming: boolean
}

interface MessagesStore {
  messages: ChatMessage[]
  // True desde que se envía un mensaje hasta que llega el primer delta de texto real
  // (o un estado terminal). Alimenta el indicador de espera en ChatView.
  waitingForResponse: boolean
  // True cuando el watchdog de silencio disparó: 45s sin ningún evento del gateway.
  // Se limpia automáticamente cuando llega cualquier evento posterior (recuperación tardía).
  silenceWarning: boolean
  setWaitingForResponse: (v: boolean) => void
  addMessage: (message: ChatMessage) => void
  appendDelta: (messageId: string, deltaText: string) => void
  markMessageComplete: (messageId: string) => void
  clearMessages: () => void
}

export const useMessagesStore = create<MessagesStore>((set) => ({
  messages: [],
  waitingForResponse: false,
  silenceWarning: false,

  setWaitingForResponse: (v) => set({ waitingForResponse: v }),

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

  clearMessages: () => set({ messages: [], waitingForResponse: false, silenceWarning: false }),
}))

// ─── Watchdog de silencio por turno ──────────────────────────────────────────
// Dispara si pasan 45s sin NINGÚN evento del gateway (chat o session.tool) para la sesión
// activa. Resuelve el caso de sesión ocupada por otro cliente: el gateway no emite error
// explícito en ese caso — el silencio total es la única señal disponible.
// Cada evento de actividad reinicia el reloj (sliding window), por lo que tareas largas
// con actividad intermitente (tool calls, deltas) no lo disparan.

const WATCHDOG_MS = 45_000

const watchdog = new TurnWatchdog(WATCHDOG_MS, () => {
  console.warn('[watchdog] 45s sin actividad — posible sesión ocupada. t=' + new Date().toISOString())
  useMessagesStore.setState({ waitingForResponse: false, silenceWarning: true })
})

export function startTurnWatchdog(): void {
  useMessagesStore.setState({ silenceWarning: false })
  watchdog.start()
}

export function cancelTurnWatchdog(): void {
  watchdog.cancel()
}

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

// ── Pieza 5 (PWA): notificación de pausa por límite de tool calls ─────────────
// runIds ya notificados — evita disparar la notificación más de una vez por pausa.
const notifiedPauseRunIds = new Set<string>()

function fireRunLimitNotification(): void {
  const body = '¿Continuar o resumir? Respondé en la app.'
  const title = 'OpenClaw — límite de tool calls'
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/openclaw.svg' })
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') new Notification(title, { body, icon: '/openclaw.svg' })
    }).catch(() => {})
  }
  // 'denied' → sin notificación, sin pedido adicional
}

// Pieza 5 (PWA): al recibir state='final', consultar run-limiter.status y notificar si paused.
// La detección es exclusivamente vía RPC — nunca inspeccionando el texto del mensaje.
function checkRunLimiterPause(sessionKey: string): void {
  runLimiterStatus(gatewayClient, sessionKey)
    .then((status) => {
      if (status.paused && status.runId && !notifiedPauseRunIds.has(status.runId)) {
        notifiedPauseRunIds.add(status.runId)
        fireRunLimitNotification()
      }
    })
    .catch(() => {})
}

gatewayClient.on('chat', (raw) => {
  const p = raw as ChatEventPayload

  // Filter to active session
  const activeKey = useSessionStore.getState().sessionKey
  if (p.sessionKey && p.sessionKey !== activeKey) return

  // Cualquier evento de chat es actividad: resetear el reloj del watchdog.
  // Si el watchdog ya disparó y el aviso está visible, este evento prueba que la sesión
  // eventualmente respondió — limpiar el aviso (recuperación tardía con gracia).
  watchdog.reschedule()
  if (useMessagesStore.getState().silenceWarning) {
    useMessagesStore.setState({ silenceWarning: false })
  }

  // Ignore hidden stream text (tool-internal content the UI shouldn't show)
  if (p.isHiddenStreamText) return

  const msgId = p.runId ?? 'stream-unknown'
  const store = useMessagesStore.getState()
  const exists = store.messages.some((m) => m.id === msgId)

  if (typeof p.deltaText === 'string' && p.deltaText.length > 0) {
    if (!exists) {
      store.addMessage({ id: msgId, role: 'assistant', text: p.deltaText, isStreaming: true })
      // Llegó el primer delta real → la respuesta está en pantalla, apagar el indicador.
      useMessagesStore.setState({ waitingForResponse: false })
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
    // Turno terminado → cancelar watchdog (normal) y limpiar cualquier aviso residual.
    watchdog.cancel()
    // Turno terminado sin texto (abort/error antes del primer delta) → el indicador
    // no debe quedar colgado para siempre.
    useMessagesStore.setState({ waitingForResponse: false })
    if (exists || typeof p.deltaText === 'string') {
      store.markMessageComplete(msgId)
    }

    // Fase 6 — audio: turno del agente COMPLETO (solo 'final', no aborted/error con texto
    // parcial) + modo audio → encolar el texto completo como fragmento TTS (cola FIFO de
    // useSessionAudioState). La fragmentación más granular queda como mejora futura.
    if (p.state === 'final' && useSessionStore.getState().uiMode === 'audio') {
      const msg = useMessagesStore.getState().messages.find((m) => m.id === msgId)
      if (msg && msg.role === 'assistant' && msg.text.trim().length > 0) {
        enqueueAudioFragment(msg.text)
      }
    }

    // Pieza 5 (PWA): consultar estado de pausa exclusivamente via RPC (nunca por texto)
    if (p.state === 'final' && activeKey) {
      checkRunLimiterPause(activeKey)
    }
  }
})

// session.tool events también cuentan como actividad de turno — una tool running prueba
// que la sesión está procesando, aunque aún no haya llegado ningún deltaText.
gatewayClient.on('session.tool', (raw) => {
  const p = raw as { stream?: string; sessionKey?: string }
  if (p.stream !== 'tool') return
  const activeKey = useSessionStore.getState().sessionKey
  if (p.sessionKey && p.sessionKey !== activeKey) return
  watchdog.reschedule()
})
