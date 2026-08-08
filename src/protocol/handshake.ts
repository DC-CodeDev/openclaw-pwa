// Handshake: receive connect.challenge → build v3 signing payload → send connect frame → await hello-ok.
// Uses client.id "webchat" / client.mode "webchat" — confirmed valid enums against the real server (section 7, DESIGN_DECISIONS.md).

import {
  clearDeviceToken,
  getOrCreateDevice,
  loadDeviceToken,
  persistDeviceToken,
  signPayload,
} from './device.ts'
import type { EventFrame, HelloOkPayload } from './frames.ts'

const CLIENT_ID = 'webchat'
const CLIENT_MODE = 'webchat'
const CLIENT_VERSION = '0.1.0'
const CLIENT_PLATFORM = 'web'
// deviceFamily is empty string for web PWA — confirmed in probe signing payload (last field)
const CLIENT_DEVICE_FAMILY = ''
const ROLE = 'operator'
const SCOPES = ['operator.read', 'operator.write']

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
