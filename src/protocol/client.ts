// GatewayClient: WebSocket transport for Gateway Protocol v4.
// Handles handshake, req/res correlation, event dispatch, watchdog, and reconnection per
// the strategy defined in DESIGN_DECISIONS.md section 8.

import { clearDeviceToken } from './handshake.ts'
import { doHandshake } from './handshake.ts'
import { GatewayError } from './frames.ts'
import type { GatewayFrame, HelloOkPayload } from './frames.ts'

// ─── Public types ─────────────────────────────────────────────────────────────

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'pairing_required'

type EventCallback = (payload: unknown) => void

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CALL_TIMEOUT_MS = 30_000
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_IDLE_THRESHOLD_MS = 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

// Synthetic event name used internally to notify React hooks of connection state changes.
// Not a server-side event — prefixed with $ to distinguish it.
export const EVENT_CONNECTION_STATE = '$connectionState'

// ─── GatewayClient ────────────────────────────────────────────────────────────

export class GatewayClient {
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'

  private seq = 0
  private pending = new Map<string, PendingCall>()
  private listeners = new Map<string, Set<EventCallback>>()

  private lastActivity = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Set to true on explicit disconnect() so auto-reconnect skips
  private stopping = false
  // Tracks whether the initial connect() promise is still outstanding
  private connectResolve: (() => void) | null = null
  private connectReject: ((err: Error) => void) | null = null
  // Number of consecutive reconnect attempts (resets on success)
  private reconnectAttempt = 0
  // Guards the one-shot 250ms fast-retry budget for stale tokens
  private usedFastRetry = false

  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'visible' && this._state !== 'connected') {
      this.reconnectNow()
    }
  }

  constructor(private readonly url: string) {}

  // ─── Public API ─────────────────────────────────────────────────────────────

  get connectionState(): ConnectionState {
    return this._state
  }

  /**
   * Initiates the WebSocket connection and full handshake.
   * Resolves on first successful hello-ok.
   * Rejects only for PAIRING_REQUIRED (requires manual `openclaw devices approve`).
   * All other transient errors trigger internal retries with backoff.
   */
  connect(): Promise<void> {
    this.stopping = false
    if (this._state === 'connected') return Promise.resolve()

    // Dedup: return the in-flight connect promise if one exists
    if (this.connectResolve !== null) {
      return new Promise<void>((resolve, reject) => {
        const origResolve = this.connectResolve
        const origReject = this.connectReject
        this.connectResolve = () => { origResolve?.(); resolve() }
        this.connectReject = (err) => { origReject?.(err); reject(err) }
      })
    }

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      document.addEventListener('visibilitychange', this.visibilityHandler)
      this.openSocket()
    })
  }

  /**
   * Sends an RPC call and returns the response payload.
   * Rejects with GatewayError on server-side errors, or Error on timeout / no connection.
   */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this._state !== 'connected') {
      return Promise.reject(new Error(`Cannot call ${method}: not connected (state=${this._state})`))
    }

    const id = `req-${++this.seq}-${Date.now()}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  /**
   * Subscribes to a server-side event (or the synthetic '$connectionState' event).
   * Returns an unsubscribe function.
   */
  on(eventName: string, callback: EventCallback): () => void {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set())
    this.listeners.get(eventName)!.add(callback)
    return () => this.listeners.get(eventName)?.delete(callback)
  }

  /** Closes the connection cleanly and stops all reconnect attempts. */
  disconnect(): void {
    this.stopping = true
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.clearReconnectTimer()
    this.stopWatchdog()
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
    this.setState('disconnected')
    this.rejectAllPending(new Error('Client disconnected'))
  }

  // ─── Internal: socket lifecycle ─────────────────────────────────────────────

  private openSocket(): void {
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

    const ws = new WebSocket(this.url)
    this.ws = ws

    ws.onmessage = (ev: MessageEvent) => { void this.onMessage(ev) }
    ws.onclose = (ev: CloseEvent) => this.onClose(ev)
    // onerror is always followed by onclose; log only, don't double-handle
    ws.onerror = () => {}
  }

  private async onMessage(ev: MessageEvent): Promise<void> {
    this.lastActivity = Date.now()

    let frame: GatewayFrame
    try {
      frame = JSON.parse(ev.data as string) as GatewayFrame
    } catch {
      return
    }

    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        await this.handleChallenge(frame)
      } else {
        this.dispatch(frame.event, frame.payload)
      }
      return
    }

    if (frame.type === 'res') {
      const p = this.pending.get(frame.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(frame.id)
      if (frame.ok) {
        p.resolve(frame.payload)
      } else {
        const err = new GatewayError(
          frame.error?.code ?? 'ERROR',
          frame.error?.message ?? JSON.stringify(frame.error),
          frame.error?.details,
        )
        p.reject(err)
      }
    }
  }

  private async handleChallenge(frame: GatewayFrame & { type: 'event' }): Promise<void> {
    try {
      const hello = await doHandshake(frame, (method, params) => this.sendRaw(method, params))
      this.onHelloOk(hello)
    } catch (err) {
      this.handleHandshakeError(err as Error)
    }
  }

  /** Raw send used internally by handshake — bypasses the connection-state guard in call() */
  private sendRaw(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ws) return Promise.reject(new Error('No WebSocket'))
    const id = `req-${++this.seq}-${Date.now()}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  private onHelloOk(hello: HelloOkPayload): void {
    this.setState('connected')
    this.reconnectAttempt = 0
    this.usedFastRetry = false
    // Use tickIntervalMs from hello-ok policy as the watchdog period (section 8, DESIGN_DECISIONS.md)
    this.startWatchdog(hello.policy?.tickIntervalMs ?? WATCHDOG_INTERVAL_MS)

    // Resolve the caller's connect() promise (only on the first successful handshake)
    const resolve = this.connectResolve
    this.connectResolve = null
    this.connectReject = null
    resolve?.()
  }

  private handleHandshakeError(err: Error): void {
    const code = err instanceof GatewayError ? err.code : err.message.split(':')[0].trim()

    if (code === 'PAIRING_REQUIRED') {
      // Do not retry — show UI message and wait for manual approval
      this.setState('pairing_required')
      const reject = this.connectReject
      this.connectResolve = null
      this.connectReject = null
      reject?.(err)
      return
    }

    if (code === 'AUTH_DEVICE_TOKEN_MISMATCH' || code === 'AUTH_TOKEN_MISMATCH') {
      void clearDeviceToken().then(() => {
        const delay = !this.usedFastRetry ? 250 : this.nextBackoff()
        this.usedFastRetry = true
        this.scheduleReconnect(delay)
      })
      return
    }

    if (code === 'UNAVAILABLE') {
      const retryMs =
        (err instanceof GatewayError && typeof err.details?.retryAfterMs === 'number')
          ? err.details.retryAfterMs
          : this.nextBackoff()
      this.scheduleReconnect(retryMs)
      return
    }

    this.scheduleReconnect(this.nextBackoff())
  }

  private onClose(ev: CloseEvent): void {
    this.stopWatchdog()
    this.rejectAllPending(new Error('WebSocket closed'))
    this.ws = null

    if (this.stopping) {
      this.setState('disconnected')
      return
    }

    // 1008 is "policy violation" — gateway uses it for pairing required
    if (ev.code === 1008) {
      this.setState('pairing_required')
      const reject = this.connectReject
      this.connectResolve = null
      this.connectReject = null
      reject?.(new Error(`PAIRING_REQUIRED: ${ev.reason}`))
      return
    }

    this.setState('reconnecting')
    this.scheduleReconnect(this.nextBackoff())
  }

  // ─── Internal: reconnection ──────────────────────────────────────────────────

  private scheduleReconnect(delayMs: number): void {
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delayMs)
  }

  private reconnectNow(): void {
    this.clearReconnectTimer()
    this.openSocket()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private nextBackoff(): number {
    const ms = Math.min(BACKOFF_BASE_MS * 2 ** this.reconnectAttempt, BACKOFF_MAX_MS)
    this.reconnectAttempt++
    return ms
  }

  // ─── Internal: watchdog ──────────────────────────────────────────────────────

  private startWatchdog(tickMs: number = WATCHDOG_INTERVAL_MS): void {
    this.lastActivity = Date.now()
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > WATCHDOG_IDLE_THRESHOLD_MS) {
        // Socket has gone zombie — close it ourselves and reconnect
        this.ws?.close(4000, 'tick timeout')
      }
    }, tickMs)
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  // ─── Internal: helpers ───────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    this.dispatch(EVENT_CONNECTION_STATE, state)
  }

  private dispatch(eventName: string, payload: unknown): void {
    const cbs = this.listeners.get(eventName)
    if (!cbs) return
    for (const cb of cbs) cb(payload)
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
