// Handshake: receive connect.challenge → build v3 signing payload → send connect frame → await hello-ok.
// client.id "webchat" + mode "ui": CONFIRMADO contra gateway 2026.6.2 (2026-08-08) que esta
// combinación permite sessions.patch. Con mode "webchat" el gateway bloquea el patch
// ("webchat clients cannot patch sessions; use chat.send for session-scoped updates") aunque
// el id sea webchat-ui/openclaw-control-ui; con mode "ui" el patch funciona (scope admin).
// gateway.controlUi.allowedOrigins quedó configurado (http://localhost:5173) por si se
// necesitara el id webchat-ui en el futuro.

import {
  clearDeviceToken,
  getOrCreateDevice,
  loadDeviceToken,
  persistDeviceToken,
  signPayload,
} from './device.ts'
import type { EventFrame, HelloOkPayload } from './frames.ts'

const CLIENT_ID = 'webchat'
const CLIENT_MODE = 'ui'
const CLIENT_VERSION = '0.1.0'
const CLIENT_PLATFORM = 'web'
// deviceFamily is empty string for web PWA — confirmed in probe signing payload (last field)
const CLIENT_DEVICE_FAMILY = ''
const ROLE = 'operator'
// operator.admin es REQUERIDO por RPC de gestión como sessions.patch (override de thinking) y
// tts.speak. OJO con el mecanismo de pairing del gateway: para un device YA pareado, pedir más
// scopes que su línea base aprobada genera PAIRING_REQUIRED ("scope upgrade pending approval")
// hasta que alguien con admin apruebe la request (openclaw devices approve / Control UI / RPC
// device.pair.approve). Devices nuevos en loopback se auto-aprueban con lo que pidan.
// Esto rompió la app una vez (2026-08-08) al cambiar de read/write a read/write/admin sin
// aprobar el upgrade del device del browser — la UI ya muestra el estado pairing_required.
const SCOPES = ['operator.read', 'operator.write', 'operator.admin']

export type SendFn = (method: string, params: Record<string, unknown>) => Promise<unknown>

/**
 * Performs the full connect handshake given an already-received challenge event frame.
 * `send` must be a raw RPC function wired to the open WebSocket.
 *
 * Returns the hello-ok payload. Throws a GatewayError on failure (PAIRING_REQUIRED,
 * AUTH_DEVICE_TOKEN_MISMATCH, AUTH_TOKEN_MISMATCH, UNAVAILABLE, etc.).
 */
export async function doHandshake(
  challengeFrame: EventFrame,
  send: SendFn,
): Promise<HelloOkPayload> {
  const { nonce, ts } = challengeFrame.payload as { nonce: string; ts: number }
  const signedAtMs = ts ?? Date.now()

  const device = await getOrCreateDevice()

  // Use stored deviceToken as auth.token if available (fast re-auth for already-paired devices).
  // The token used in auth.token must also appear in the v3 signing payload.
  const storedToken = await loadDeviceToken()
  const gatewayToken = import.meta.env.GATEWAY_TOKEN as string
  const authToken = storedToken ?? gatewayToken

  // v3 signing payload — exact field order matters, confirmed from probe source (section 7)
  const signingPayload = [
    'v3',
    device.id,
    CLIENT_ID,
    CLIENT_MODE,
    ROLE,
    SCOPES.join(','),
    String(signedAtMs),
    authToken,
    nonce,
    CLIENT_PLATFORM,
    CLIENT_DEVICE_FAMILY,
  ].join('|')

  const signature = await signPayload(signingPayload)

  const hello = (await send('connect', {
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: CLIENT_ID,
      version: CLIENT_VERSION,
      platform: CLIENT_PLATFORM,
      mode: CLIENT_MODE,
    },
    role: ROLE,
    scopes: SCOPES,
    caps: [],
    commands: [],
    permissions: {},
    auth: { token: authToken },
    locale: 'es-UY',
    userAgent: `openclaw-pwa/${CLIENT_VERSION}`,
    device: {
      id: device.id,
      publicKey: device.publicKey,
      signature,
      signedAt: signedAtMs,
      nonce,
    },
  })) as HelloOkPayload

  if (hello.auth?.deviceToken) {
    await persistDeviceToken(hello.auth.deviceToken)
  }

  return hello
}

/** Clears the cached deviceToken so the next handshake falls back to the gateway token. */
export { clearDeviceToken }
