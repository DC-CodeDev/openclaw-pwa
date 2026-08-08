# OpenClaw PWA Frontend — Especificación Técnica

> **Estado:** Borrador de diseño
> **Fecha:** 2026-08-07
> **Decisión tomada:** Opción A — el PWA habla **directo** al Gateway por WebSocket (Gateway Protocol v4). Sin proxy intermedio. La TUI de consola queda como respaldo operativo, no como intermediario.

---

## 1. Arquitectura

```
┌─────────────────────┐        WebSocket (JSON frames)        ┌──────────────────────┐
│  React PWA (front)  │ ────────────────────────────────────▶ │  OpenClaw Gateway     │
│  Vite + React + SW  │ ◀──────────────────────────────────── │  ws://<host>:18789    │
└─────────────────────┘            Gateway Protocol v4        └──────────────────────┘
                                                                      │
                                                              ┌───────┴───────┐
                                                              │ Agent runtime │
                                                              │ (sesiones,    │
                                                              │ tools, usage) │
                                                              └───────────────┘
```

- **El Gateway ES el backend.** No hay servidor intermedio, no hay REST propio, no hay proxy.
- La consola TUI (`openclaw`) sigue existiendo como herramienta de respaldo/operación. No participa en el flujo del PWA.
- El PWA puede servirse desde cualquier lado (Vite dev server, build estático, hosteado) — solo necesita poder alcanzar el WebSocket del gateway.

---

## 2. Por qué WebSocket y NO el endpoint HTTP

OpenClaw tiene un endpoint HTTP estilo OpenAI (`POST /v1/chat/completions`, `GET /v1/models`, etc.), pero **no sirve para este frontend**:

| Necesidad | HTTP OpenAI-compat | Gateway Protocol WS (v4) |
|---|---|---|
| Listar sesiones | ❌ stateless por request | ✅ `sessions.list` |
| Session id (sessionKey) | ❌ se deriva de `user`/header | ✅ explícito en `sessions.create/list/get` |
| Cambiar de agente | ⚠️ vía header `x-openclaw-agent-id` | ✅ `agents.list` + sesiones agent-scoped |
| Tokens por sesión | ❌ | ✅ `sessions.usage` / `sessions.usage.timeseries` |
| Streaming de respuesta | ✅ SSE | ✅ eventos `chat` con `deltaText` |
| Tool calls en vivo | ⚠️ shape limitado | ✅ eventos `session.tool` |
| Info del agente activo | ❌ | ✅ `agent.identity.get` + `agents.list` |
| Abortar ejecución | ❌ | ✅ `chat.abort` / `sessions.abort` |
| Aprobaciones (exec) | ❌ | ✅ `exec.approval.*` |

**Conclusión:** el protocolo WS es la superficie nativa que usa la propia Control UI (Vite + Lit) y el CLI. Implementarlo es invertir una vez para tener TODO el control plane disponible.

---

## 3. Transporte y framing

- **URL:** `ws://<host>:18789` (mismo puerto que la Control UI HTTP). Con TLS sería `wss://`.
- **Frames:** texto con JSON.
- **Request:** `{ "type": "req", "id": "<uuid>", "method": "<method>", "params": { ... } }`
- **Response:** `{ "type": "res", "id": "<uuid>", "ok": true, "payload": { ... } }` (o `ok: false` con `error`)
- **Event (server→client):** `{ "type": "event", "event": "<nombre>", "payload": { ... }, "seq": N }`
- Métodos con efectos secundarios requieren **idempotency keys**.

---

## 4. Handshake y autenticación (lo más delicado)

### 4.1 Flujo de conexión

1. **Abrir WebSocket** al gateway.
2. **Recibir challenge** (pre-connect):
   ```json
   { "type": "event", "event": "connect.challenge", "payload": { "nonce": "…", "ts": 1737264000000 } }
   ```
3. **Enviar connect** — el primer frame DEBE ser `connect`:
   ```json
   {
     "type": "req",
     "id": "…",
     "method": "connect",
     "params": {
       "minProtocol": 4,
       "maxProtocol": 4,
       "client": { "id": "hue-pwa", "version": "0.1.0", "platform": "web", "mode": "operator" },
       "role": "operator",
       "scopes": ["operator.read", "operator.write"],
       "caps": [],
       "commands": [],
       "permissions": {},
       "auth": { "token": "<GATEWAY_TOKEN>" },
       "locale": "es-UY",
       "userAgent": "hue-pwa/0.1.0",
       "device": {
         "id": "<device_fingerprint>",
         "publicKey": "<clave pública>",
         "signature": "<firma del nonce>",
         "signedAt": 1737264000000,
         "nonce": "<el nonce recibido>"
       }
     }
   }
   ```
4. **Recibir `hello-ok`** (o error retryable `UNAVAILABLE` con `details.reason: "startup-sidecars"` → reintentar con `retryAfterMs`).

   `hello-ok` incluye:
   - `server.version`, `server.connId`
   - `features.methods` / `features.events` → **usar para descubrir la superficie real**
   - `auth.deviceToken` → **PERSISTIR** (reconexiones sin re-pairing)
   - `policy.maxPayload`, `policy.maxBufferedBytes`, `policy.tickIntervalMs` → respetar

### 4.2 Firma del dispositivo

- El `device.id` debe ser un **fingerprint derivado de un keypair** (ej: hash de la clave pública).
- `device.signature` firma el payload del challenge (v3: incluye `platform` y `deviceFamily` además de device/client/role/scopes/token/nonce).
- En browser: **WebCrypto** (ECDSA P-256 o Ed25519 si el runtime lo soporta). Generar el keypair una vez, persistir la clave privada (IndexedDB) — si se pierde, hay que re-pairing.
- Errores típicos y su `details.code`: `DEVICE_AUTH_NONCE_REQUIRED`, `DEVICE_AUTH_NONCE_MISMATCH`, `DEVICE_AUTH_SIGNATURE_INVALID`, `DEVICE_AUTH_DEVICE_ID_MISMATCH`, `DEVICE_AUTH_PUBLIC_KEY_INVALID`.

### 4.3 Pairing (primer dispositivo)

- Primer connect desde un dispositivo/browser nuevo → `disconnected (1008): pairing required`.
- Resolver desde la consola de respaldo:
  ```bash
  openclaw devices list
  openclaw devices approve <requestId>
  ```
- **Loopback local (`127.0.0.1`/`localhost`) se auto-aprueba.**
- Una vez aprobado, el dispositivo queda recordado hasta que se revoque (`openclaw devices revoke --device <id> --role <role>`).
- Cada browser profile genera un device id único → cambiar de browser = re-pairing.
- Si cambias el scope pedido (read → write/admin) en un dispositivo ya pareado, requiere **aprobación explícita nueva** (no es reconnect silencioso).

### 4.4 Reconexión

- Reconectar con el `deviceToken` persistido (en `auth.token` o como device token) reutiliza los scopes aprobados.
- Backoff inicial 1s → máx 30s. Fast-retry 250ms tras close por device-token.
- Timeout por RPC: 30s. Tick: respetar `policy.tickIntervalMs` (default 30s); si hay silencio > tickIntervalMs × 2, el server cierra con code 4000.

---

## 5. RPCs por feature (el mapa completo)

### 5.1 Cambiar de agente (Ctrl+G)

```text
1. agents.list                      → inventario de agentes (modelo efectivo, metadata)
2. Al elegir agente:                → las sesiones son agent-scoped
   a. sessions.list (por agentId)   → buscar sesión activa existente
   b. o sessions.create             → crear sesión nueva para ese agente
3. chat.history (sessionKey)        → cargar transcript de la sesión elegida
```

### 5.2 `/new` — nueva sesión

```text
sessions.create   → sesión nueva (te devuelve el sessionKey nuevo)
o
sessions.reset    → resetear la sesión actual
```

### 5.3 Info del agente actual

```text
agent.identity.get   → identidad efectiva del agente/sesión (nombre, avatar, etc.)
agents.list          → metadata (modelo, runtime)
sessions.get         → fila completa de la sesión activa
```

### 5.4 Session id

- El `sessionKey` es tu id de sesión. Fuentes: `sessions.create`, `sessions.list`, `sessions.describe`, `sessions.get`.
- Se usa como parámetro en `chat.send`, `chat.history`, `sessions.patch`, `sessions.usage`, etc.

### 5.5 Tokens / usage

```text
sessions.usage                 → resumen de usage por sesión (tokens por sesión)
sessions.usage.timeseries      → series temporal de una sesión
sessions.usage.logs            → entries de usage de una sesión
usage.status                   → ventanas/remaining quota de providers (global)
```

### 5.6 Chat

```text
chat.send       → enviar mensaje a una sesión (sessionKey + contenido)
chat.history    → transcript (display-normalizado: sin tags de directivas, sin XML de tools, sin NO_REPLY silenciosos)
chat.abort      → cancelar
chat.inject     → inyectar mensaje (para la consola de respaldo / automation)
chat.message.get → leer un mensaje completo del transcript (bounded, sin truncar)
```

### 5.7 Streaming de respuesta (eventos)

- `chat` — updates de transcript: en v4 los deltas traen `deltaText`; `message` es el snapshot acumulado. `replace: true` + `deltaText` = reemplazo no-prefix.
- `session.message` — transcript de sesión suscrita.
- `session.tool` — tool calls / resultados en vivo (para las cards de tools).
- `session.operation` — operaciones in-flight de la sesión.
- `sessions.changed` — el índice/metadata de sesiones cambió.
- Requieren suscripción previa: `sessions.subscribe` / `sessions.messages.subscribe`.

### 5.8 Suscripciones

```text
sessions.subscribe            → eventos de cambio del índice de sesiones
sessions.messages.subscribe   → eventos de transcript de UNA sesión (sessionKey)
sessions.unsubscribe / sessions.messages.unsubscribe → apagar
```

---

## 6. Guía de implementación PWA (React + Vite)

### 6.1 Stack sugerido

- **Vite + React + TypeScript**
- **vite-plugin-pwa** (Workbox) → manifest, service worker, instalable, offline shell
- **WS nativo del browser** (no hace falta librería) + un wrapper tipado del protocolo
- **Zustand o Jotai** → estado global (sesión activa, agente activo, usage)
- **IndexedDB** → persistir: device keypair, deviceToken, última sesión activa

### 6.2 Estructura de carpetas

```text
src/
├── protocol/
│   ├── client.ts          # clase GatewayClient: connect, req/res, events, reconnect
│   ├── frames.ts          # tipos de req/res/event
│   ├── handshake.ts       # challenge → firma → connect → hello-ok
│   ├── device.ts          # keypair, fingerprint, firma (WebCrypto)
│   └── methods.ts         # helpers tipados: chat.send, sessions.*, agents.*, usage.*
├── store/
│   ├── session.ts         # sesión activa, agente activo
│   ├── messages.ts        # transcript por sesión
│   └── usage.ts           # tokens por sesión
├── components/
│   ├── ChatView.tsx
│   ├── Composer.tsx
│   ├── AgentSwitcher.tsx  # Ctrl+G
│   ├── SessionList.tsx
│   ├── ToolCard.tsx       # session.tool events
│   └── StatusBar.tsx      # agente actual, sessionKey, tokens
├── hooks/
│   ├── useGateway.ts      # conexión + estado
│   └── useStreaming.ts    # deltas → mensaje acumulado
└── App.tsx
```

### 6.3 Orden de implementación (recomendado)

1. **Fase 0 — Sonda:** script Node mínimo (o directamente en el browser) que haga handshake contra el gateway y llame `health` + `agents.list`. Valida auth y pairing antes de tocar React.
2. **Fase 1 — Núcleo protocolo:** `GatewayClient` (connect, req/res con idempotency, eventos, reconnect con deviceToken, tick).
3. **Fase 2 — Chat básico:** `chat.send` + streaming de eventos `chat`/`session.message` → render de mensajes.
4. **Fase 3 — Sesiones:** `sessions.list/create/reset` + sidebar + `/new` (Ctrl+N o botón) + `sessions.usage` en el header.
5. **Fase 4 — Agentes:** `agents.list` + `AgentSwitcher` con **Ctrl+G** (keybinding global en el PWA) + cambio de sesión activa por agente.
6. **Fase 5 — Tool cards:** suscribirse a `session.tool` y renderizar ejecuciones de tools en vivo.
7. **Fase 6 — PWA real:** manifest, service worker, instalación, offline shell (el chat necesita conexión, pero el shell y el historial cacheado funcionan offline).
8. **Fase 7 — Extras:** `chat.abort` (botón stop), aprobaciones de exec (`exec.approval.requested` → botón aprobar/rechazar), `sessions.patch` (overrides de modelo/thinking por sesión), histórico de usage.

### 6.4 Consideraciones PWA

- El WebSocket **no sobrevive al service worker offline** — el chat requiere conexión viva. El PWA offline sirve para: shell, historial cacheado, config.
- Reconnect automático con backoff + estado visual "reconectando…".
- Notificaciones push del sistema: fuera de scope inicial (requiere relay/push config), pero el gateway tiene `push.test` y soporte iOS para más adelante.
- **Seguridad:** el token del gateway vive en el browser (localStorage/sessionStorage). Para uso local/tailnet está bien; si algún día lo exponés a internet, migrar a Opción B (proxy con el token server-side) o autenticar via trusted-proxy.

### 6.5 Respuesta por voz (Azure TTS) — VERIFICADO 2026-08-07

**El Gateway NO es texto puro in/out.** Tiene TTS nativo con 14 proveedores, incluido **Azure Speech** (provider oficial `azure-speech`, REST directo con SSML). El audio viaja por el MISMO WebSocket — sin servicio aparte, sin segunda fuente de verdad.

#### Config (recurso Speech Service, región Brazil South, tier F0)

```json5
{
  messages: {
    tts: {
      auto: "off",          // IMPORTANTE: solo el PWA habla (via tts.speak). Global OFF = nadie más recibe audio auto.
      provider: "azure-speech",
      providers: {
        "azure-speech": {
          speakerVoice: "es-MX-LucianoNeural",
          lang: "es-MX",
          region: "brazilsouth",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
      },
    },
  },
}
```

- **API key → NO va en el JSON.** Cascada de resolución: `apiKey` en config → env `AZURE_SPEECH_KEY` → `AZURE_SPEECH_API_KEY` → `SPEECH_KEY`. Recomendado: exportar `AZURE_SPEECH_KEY` en el entorno del gateway (o SecretRef `apiKey: "${AZURE_SPEECH_KEY}"`).
- **Región:** código Azure (`brazilsouth`), no el nombre humano. El provider deriva `https://brazilsouth.tts.speech.microsoft.com`. Overrides opcionales: `endpoint`/`baseUrl`.
- **Voz:** ShortName de Azure tal cual (`es-MX-LucianoNeural`), va como `<voice name="...">` en el SSML. El provider puede listar voces contra el recurso (filtra deprecadas).
- **Formato:** default MP3 `audio-24khz-48kbitrate-mono-mp3`; WAV/PCM: `riff-24khz-16bit-mono-pcm`; voice-note: `voiceNoteOutputFormat` (default `ogg-24khz-16bit-mono-opus`).
- **Tier F0:** gratis con cuota mensual de caracteres; al agotarla, Azure responde 429 y el gateway reporta fallo de TTS (se puede configurar fallback a otro provider).

#### ⚠️ Lección aprendida (2026-08-07): los providers TTS son extensiones separadas

**Los providers TTS NO vienen cargados por defecto en el runtime del gateway** — son extensiones que hay que instalar. En esta máquina, `azure-speech` (y elevenlabs, microsoft, tts-local-cli) existían en el código fuente (`/usr/lib/openclaw/extensions/`) pero NO estaban instalados en el runtime activo (`/usr/lib/openclaw/dist-runtime/extensions/`). Por eso el gateway decía `elevenlabs: no provider registered` incluso con ElevenLabs configurado.

Solución aplicada:
1. `mkdir -p ~/.openclaw/plugins && cp -r /usr/lib/openclaw/extensions/azure-speech ~/.openclaw/plugins/azure-speech` (copiar a un dir de desarrollo propio, NO linkear directo al dir bundled: `plugins.load.paths` ignora rutas legacy).
2. `openclaw plugins install ~/.openclaw/plugins/azure-speech --link` (TS source fallback funciona en paths locales de desarrollo).
3. Limpiar del config la ruta legacy que generaba warning.
4. `systemctl --user restart openclaw-gateway`.
5. Verificar: `openclaw plugins list | grep azure` → enabled.

Nota: el CLI `openclaw infer tts convert` (aun con `--gateway`) usa un runtime reducido que NO ve las extensiones — no sirve para probar providers de extensión. La prueba correcta es la tool `tts` via `POST /tools/invoke` (o el RPC WS).

#### Seguridad (key server-side, el browser nunca la ve)

1. El gateway llama a Azure con la key (server-side) → recibe el audio.
2. `tts.speak` devuelve solo `audioBase64` al PWA — la key nunca sale del gateway.
3. Verificado en vivo: `POST /tools/invoke {name: tts}` → `ok: true`, `provider: azure-speech`, MP3 24kHz válido.

#### Cómo funciona (decisión final: solo el PWA habla)

- **Global `messages.tts.auto: "off"`** → el gateway NUNCA sintetiza audio automático para nadie (consola, webchat, canales = texto puro).
- **El PWA es el único que habla:** llama la RPC `tts.speak` por el mismo WS con el texto del mensaje → recibe `{ audioBase64, provider, outputFormat, mimeType, fileExtension }` y reproduce.
- **Sincronización:** el transcript es la fuente de verdad; el audio es una vista derivada que el PWA genera bajo demanda (auto al llegar el mensaje, o botón "escuchar"). Reproducir mensajes viejos = gratis (mismo `tts.speak` con el texto del historial).
- NO usar auto-TTS para el PWA: genera audio adjunto al ReplyPayload para TODOS los clientes de la sesión, no solo el PWA.

#### RPCs de TTS disponibles por WS

| Método | Propósito |
|---|---|
| `tts.status` | Estado actual, provider activo, intentos/fallbacks |
| `tts.enable` / `tts.disable` | Auto-TTS on/off (prefs locales) |
| `tts.convert` | Texto → audio (devuelve `audioPath` local; no para PWA remoto) |
| `tts.speak` | Texto → audio **inline base64** (para clientes remotos — EL que usa el PWA) |
| `tts.setProvider` / `tts.setPersona` | Cambiar provider/persona (prefs locales) |
| `tts.providers` | Listar providers configurados y estado |

#### Notas

- Los replies del agente pueden traer `[[tts:...]]` directives inline (overrides de voz/modelo por reply) y `[[tts:text]]...[[/tts:text]]` (cues expresivas solo-audio). El streaming los strippea del texto visible.
- Modos de `auto`: `off` (default), `always`, `inbound` (solo tras voz entrante), `tagged` (solo con directives).
- Si el reply supera `maxLength` (default 1500 chars) y el summary está activo, se resume con `summaryModel` antes de sintetizar.
- Voz bidireccional real (mic → STT → modelo → voz) = sistema **Talk** (`talk.session.*` con gateway-relay, `talk.speak` streaming PCM). Feature aparte, no necesario para responder por voz.
- Piper/`tts-local-cli` queda descartado como provider principal (Azure elegido), pero sigue existiendo como opción local sin nube si algún día se necesita.

#### Referencia de código (repo OpenClaw)

- Provider: `extensions/azure-speech/tts.ts`
- RPC handlers: `src/gateway/server-methods/tts.ts` (`tts.speak` en el código)
- Tipos reply: `src/auto-reply/reply-payload.ts` (`ReplyPayload`, `ReplyMediaAttachment`)
- Docs local: `/usr/lib/openclaw/docs/providers/azure-speech.md` y `/usr/lib/openclaw/docs/tools/tts.md`

### 6.6 Keepalive y reconnect — VERIFICADO en código (2026-08-07)

#### Keepalive: PASIVO, no hay que mandar nada

- El gateway manda **pings a nivel WebSocket** (frame de control, no JSON) cada **25s** (`src/gateway/server/ws-connection.ts`). El `pong` lo responde automáticamente el stack del browser/`ws` — cero código del lado del PWA.
- Si un pong se pierde, el server mata el socket (`heartbeat-timeout`) porque la conexión está medio-muerta.
- **NO existe un RPC tipo ping/heartbeat para llamar.** `health` es un probe pesado, no se usa para keepalive.
- `hello-ok.policy.tickIntervalMs` (default 30s) NO es algo que el cliente deba ejecutar: es el dato para el watchdog defensivo.
- **El cierre 4000 "tick timeout" lo hace el CLIENTE de referencia** (`startTickWatch()` en `packages/gateway-client/src/client.ts`): si pasan `tickIntervalMs × 2` (60s) sin recibir NINGÚN frame JSON, se cierra solo para no quedar en un socket zombi. `onActivity` se dispara con cualquier frame recibido.

Implementación recomendada en el GatewayClient del PWA:
1. `lastActivity = Date.now()` en cada frame recibido (evento o respuesta).
2. Timer cada ~30s: si `now - lastActivity > 60s` → `close(4000, "tick timeout")` + reconnect. Red de seguridad contra zombis.
3. Riesgo real en PWA: el browser congela pestañas en background y el WS muere silencioso (1006). Defensa: `visibilitychange` → si no hay conexión viva, reconectar YA; más backoff estándar.

#### Reconnect: distinguir casos, NO tratar todo igual

| Caso | Señal | Acción |
|---|---|---|
| Red caída / server reiniciando | close 1006, o error connect `UNAVAILABLE` con `retryAfterMs` (gateway starting → close 1013) | Backoff estándar 1s→2s→4s→…→máx 30s |
| Pairing requerido | error connect `PAIRING_REQUIRED` (close 1008 "pairing required") | **NO reintentar en loop** — pausar y mostrar "aprobá el dispositivo" |
| Token stale | error connect `AUTH_DEVICE_TOKEN_MISMATCH` / `AUTH_TOKEN_MISMATCH` | Borrar token guardado, **retry a 250ms** (budget de 1 uso), luego backoff normal |
| Socket zombi | 60s sin frames | Cerrar 4000, reconectar |

- **El fast-retry 250ms NO es un close code de WebSocket** — es el resultado del frame `connect`: cuando el server responde error con advice `retry_with_device_token`, el cliente de referencia borra el token stale y hace `resetReconnectBackoff(250)` (`handleConnectRequestFailure` en `packages/gateway-client/src/client.ts`).
- **Cuidado con PAIRING_REQUIRED:** reintentar en loop genera una solicitud de pairing NUEVA cada vez, y cada una SUPERSEDE la anterior — `openclaw devices approve <requestId>` podría aprobar la request equivocada. Pausar es lo correcto.
- Backoff estándar del cliente de referencia: `{ initialMs: 1000, multiplier: 2, maxMs: 30000 }`.

---

## 7. Referencias

- Docs locales: `/usr/lib/openclaw/docs/gateway/protocol.md` (el doc completo del protocolo v4)
- Docs locales: `/usr/lib/openclaw/docs/gateway/openai-http-api.md` (por qué NO usamos esto)
- Docs locales: `/usr/lib/openclaw/docs/web/control-ui.md` (la UI oficial: mismo protocolo, sirve de referencia de implementación)
- Cliente de referencia: `src/gateway/client.ts` en el repo de OpenClaw
- Schemas del protocolo: `packages/gateway-protocol/src/schema.ts` (TypeBox)
- **No existe SDK npm de cliente** — el paquete `openclaw` es el CLI completo (87 MB). Se implementa el protocolo o se copia el cliente de referencia.

---

## 8. Decisiones pendientes

- [ ] ¿Servir el PWA desde el gateway (como la Control UI) o standalone? (standalone es más simple: `vite build` → cualquier static host)
- [ ] ¿Host del gateway: localhost, tailnet, VPS? (afecta wss vs ws y pairing)
- [ ] ¿Soportar aprobaciones de exec desde el PWA en v1? (sugerido: sí, es un botón)
- [ ] ¿Tema visual: qué estética? (el emoji 🔵 de HUE está disponible 😉)
- [ ] Nombre del proyecto / repo
- [ ] Voz: ¿auto-TTS (cada respuesta hablada) + botón re-escuchar (`tts.speak`)? (recomendado: ambos)
- [ ] Voz: **DECIDIDO** — Azure Speech, región `brazilsouth`, tier F0, voz `es-MX-LucianoNeural`, `lang: es-MX`. Key en config del gateway (o env). Global `auto: off` — SOLO el PWA habla via `tts.speak` bajo demanda. Plugin `azure-speech` instalado en `~/.openclaw/plugins/azure-speech` (ver lección en 6.5).
