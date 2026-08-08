// Gateway Protocol v4 frame types: RequestFrame, ResponseFrame, EventFrame, and GatewayError

export interface RequestFrame {
  type: 'req'
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface ResponseFrame {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

export interface EventFrame {
  type: 'event'
  event: string
  payload?: unknown
  seq?: number
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame

export interface HelloOkPayload {
  protocol: number
  server: { version: string; connId: string }
  auth: { role: string; scopes: string[]; deviceToken?: string }
  features: { methods: string[]; events: string[] }
  policy: { maxPayload: number; maxBufferedBytes: number; tickIntervalMs: number }
}

// Thrown from call() for rejected RPC responses; carries the server error code for pattern matching
export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`)
    this.name = 'GatewayError'
  }
}
