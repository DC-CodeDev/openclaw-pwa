// Device identity: Ed25519 keypair via WebCrypto, deviceId = sha256(raw_public_key_bytes) hex,
// sign v3 challenge payload, persist keypair + deviceToken in IndexedDB.

const DB_NAME = 'openclaw-pwa'
const DB_VERSION = 1
const STORE = 'device'

// Module-level keypair cache so we only load from IDB once per page lifetime
let _keypair: CryptoKeyPair | null = null

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

function idbDelete(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DeviceIdentity {
  /** sha256(raw_public_key_bytes) in hex */
  id: string
  /** base64url of raw 32-byte Ed25519 public key */
  publicKey: string
}

// ─── Keypair management ───────────────────────────────────────────────────────

async function generateKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'Ed25519' } as Algorithm,
    true,
    ['sign', 'verify'] as KeyUsage[],
  ) as Promise<CryptoKeyPair>
}

async function identityFromKeypair(kp: CryptoKeyPair): Promise<DeviceIdentity> {
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))

  // deviceId = sha256(raw_public_key_bytes) as hex
  const hashBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPub))
  const id = Array.from(hashBytes).map((b) => b.toString(16).padStart(2, '0')).join('')

  // publicKey field in connect frame = base64url of raw bytes
  const publicKey = btoa(String.fromCharCode(...rawPub))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  return { id, publicKey }
}

export async function getOrCreateDevice(): Promise<DeviceIdentity> {
  if (_keypair) return identityFromKeypair(_keypair)

  const db = await openDB()
  const privJwk = await idbGet<JsonWebKey>(db, 'privateKeyJwk')
  const pubJwk = await idbGet<JsonWebKey>(db, 'publicKeyJwk')

  if (privJwk && pubJwk) {
    const privateKey = await crypto.subtle.importKey(
      'jwk', privJwk, { name: 'Ed25519' } as Algorithm, true, ['sign'] as KeyUsage[],
    )
    const publicKey = await crypto.subtle.importKey(
      'jwk', pubJwk, { name: 'Ed25519' } as Algorithm, true, ['verify'] as KeyUsage[],
    )
    _keypair = { privateKey, publicKey }
    return identityFromKeypair(_keypair)
  }

  // First run: generate and persist
  const kp = await generateKeypair()
  const [storedPriv, storedPub] = await Promise.all([
    crypto.subtle.exportKey('jwk', kp.privateKey),
    crypto.subtle.exportKey('jwk', kp.publicKey),
  ])
  await idbPut(db, 'privateKeyJwk', storedPriv)
  await idbPut(db, 'publicKeyJwk', storedPub)

  _keypair = kp
  return identityFromKeypair(kp)
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/** Signs a UTF-8 string with the device private key. Returns base64url signature. */
export async function signPayload(payload: string): Promise<string> {
  if (!_keypair) throw new Error('Device not initialized — call getOrCreateDevice() first')
  const data = new TextEncoder().encode(payload)
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' } as Algorithm, _keypair.privateKey, data),
  )
  return btoa(String.fromCharCode(...sig))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// ─── deviceToken persistence ──────────────────────────────────────────────────

export async function persistDeviceToken(token: string): Promise<void> {
  const db = await openDB()
  await idbPut(db, 'deviceToken', token)
}

export async function loadDeviceToken(): Promise<string | null> {
  const db = await openDB()
  return (await idbGet<string>(db, 'deviceToken')) ?? null
}

export async function clearDeviceToken(): Promise<void> {
  const db = await openDB()
  await idbDelete(db, 'deviceToken')
}
