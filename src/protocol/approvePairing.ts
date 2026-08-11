// Opens a temporary WebSocket connection with a fresh ephemeral device identity
// (auto-approved on loopback) to call device.pair.approve on behalf of the PWA's
// actual device, which is stuck in PAIRING_REQUIRED state.
// The main GatewayClient's WS is closed when PAIRING_REQUIRED fires, so it cannot
// call RPCs itself — this helper acts as a one-shot proxy.

import { getOrCreateDevice } from './device.ts'

interface GwFrame {
  type: string
  event?: string
  payload?: unknown
  id?: string
  ok?: boolean
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

interface PendingEntry {
  requestId: string
  deviceId?: string
  createdAtMs?: number
}

export async function approvePendingPairing(
  gatewayUrl: string,
  gatewayToken: string,
): Promise<void> {
  // The device that's stuck in pending — we'll match it in device.pair.list
  const myDevice = await getOrCreateDevice()

  // Fresh ephemeral keypair — never persisted, used only for this approval call
  const kp = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as Algorithm,
    true,
    ['sign', 'verify'] as KeyUsage[],
  ) as CryptoKeyPair

  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPub))
  const tmpId = Array.from(hashBytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const tmpPub = btoa(String.fromCharCode(...rawPub))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

  async function sign(payload: string): Promise<string> {
    const data = new TextEncoder().encode(payload)
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' } as Algorithm, kp.privateKey, data),
    )
    return btoa(String.fromCharCode(...sig))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl)
    let seq = 0
    const calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    let settled = false

    function finish(err?: Error) {
      if (settled) return
      settled = true
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000)
        }
      } catch { /* ignore */ }
      if (err) reject(err)
      else resolve()
    }

    function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const id = `ap-${++seq}-${Date.now()}`
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          calls.delete(id)
          rej(new Error(`timeout: ${method}`))
        }, 15_000)
        calls.set(id, { resolve: (v) => { clearTimeout(timer); res(v) }, reject: (e) => { clearTimeout(timer); rej(e) }, timer })
        ws.send(JSON.stringify({ type: 'req', id, method, params }))
      })
    }

    ws.onmessage = async (ev: MessageEvent) => {
      let frame: GwFrame
      try { frame = JSON.parse(ev.data as string) as GwFrame } catch { return }

      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        const { nonce, ts } = frame.payload as { nonce: string; ts: number }
        const signedAtMs = ts ?? Date.now()
        const scopes = ['operator.read', 'operator.write', 'operator.admin']

        const sigPayload = [
          'v3', tmpId, 'openclaw-probe', 'probe', 'operator', scopes.join(','),
          String(signedAtMs), gatewayToken, nonce, 'linux', '',
        ].join('|')

        try {
          const signature = await sign(sigPayload)
          await rpc('connect', {
            minProtocol: 4, maxProtocol: 4,
            client: { id: 'openclaw-probe', version: '0.1.0', platform: 'linux', mode: 'probe' },
            role: 'operator', scopes, caps: [], commands: [], permissions: {},
            auth: { token: gatewayToken }, locale: 'es-UY',
            userAgent: 'openclaw-pwa-approve/0.1.0',
            device: { id: tmpId, publicKey: tmpPub, signature, signedAt: signedAtMs, nonce },
          })
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)))
          return
        }

        // Temp connection established — find and approve the pending entry
        try {
          const list = (await rpc('device.pair.list', {})) as { pending?: PendingEntry[] }
          const entries = list.pending ?? []

          // Prefer matching our exact deviceId; fall back to most-recent (--latest semantics)
          let target = entries.find((p) => p.deviceId === myDevice.id)
          if (!target && entries.length > 0) {
            target = entries.reduce((a, b) =>
              (a.createdAtMs ?? 0) >= (b.createdAtMs ?? 0) ? a : b,
            )
          }
          if (!target) {
            finish(new Error('No hay solicitudes de pairing pendientes para este dispositivo'))
            return
          }

          await rpc('device.pair.approve', { requestId: target.requestId })
          finish()
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)))
        }
        return
      }

      if (frame.type === 'res' && frame.id) {
        const p = calls.get(frame.id)
        if (!p) return
        calls.delete(frame.id)
        if (frame.ok) p.resolve(frame.payload)
        else p.reject(new Error(`${frame.error?.code ?? 'ERROR'}: ${frame.error?.message ?? 'unknown'}`))
      }
    }

    ws.onerror = () => finish(new Error('Error de conexión WebSocket al gateway'))
    ws.onclose = (ev: CloseEvent) => {
      if (!settled && ev.code !== 1000 && ev.code !== 1005) {
        finish(new Error(`Gateway cerró inesperadamente: ${ev.code} ${ev.reason}`))
      }
    }
  })
}
