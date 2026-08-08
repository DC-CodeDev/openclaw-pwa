# OpenClaw PWA — DESIGN_DECISIONS.md

> Estado: decisiones cerradas en reunión de diseño, previas a implementación con CC.
> Este documento complementa (no reemplaza) `openclaw-pwa-frontend.md`, que sigue siendo la fuente de verdad del protocolo Gateway v4.
> Fecha de cierre de esta ronda: 2026-08-07

---

## 1. Arquitectura general (heredada, confirmada)

- PWA habla **directo** al Gateway por WebSocket (Gateway Protocol v4). Sin proxy intermedio.
- La TUI de consola sigue existiendo como respaldo operativo, no participa en el flujo del PWA.
- Fuente de verdad de la conversación: el transcript de la sesión (`chat.history`, eventos `chat`/`session.message`). Todo lo demás (audio incluido) es una vista derivada.

---

## 2. Toggle Texto / Audio

- Un solo modo de interfaz con **toggle**, no dos apps separadas (referencia: voice mode de ChatGPT).
- Ambos modos comparten el mismo store de sesión/mensajes/historial — cambiar de modo nunca resetea ni pierde nada.
- El input **siempre es texto** en esta fase. No hay entrada por voz (mic) todavía — queda fuera de alcance, posible fase futura.

### Modo Texto
- Interfaz de chat estándar: `MessageList` + `Composer`.
- Streaming de respuesta vía eventos `chat` (`deltaText` acumulándose) — texto aparece palabra por palabra.
- No dispara síntesis de voz bajo ninguna circunstancia.

### Modo Audio
- Interfaz reemplaza el chat legible por `AsciiCanvas` (matriz ASCII mutante, ver sección 4).
- El `Composer` de texto sigue visible y es la única forma de enviar mensajes.
- Cada respuesta se sintetiza a voz vía `tts.speak`, disparado automáticamente por el PWA (no por el Gateway).

---

## 3. Motor de voz (TTS)

### Decisión final: Azure Text-to-Speech

- **Provider nativo del Gateway**: `azure-speech` (extensión propia, habla REST directo con Azure usando SSML — no es un provider genérico armado a mano).
- **Voz**: `es-MX-LucianoNeural`
- **Región**: `brazilsouth`
- **Recurso Azure**: `jarvishue`, resource group `openclaw-pwa`, tier **F0 (gratuito)**
- **Cuota F0**: 500.000 caracteres/mes — muy por encima del uso personal esperado (~1 hora de audio estimada)
- **Formato de salida**: MP3 por defecto (`audio-24khz-48kbitrate-mono-mp3`); WAV/PCM disponible si se necesita (`riff-24khz-16bit-mono-pcm`)

### Historial de la decisión (por qué no Piper)
- Piper fue evaluado primero (local, gratis, sin dependencia de red). Se probaron voces en español (`es_ES`) y **ninguna convenció**: acento percibido como raro, sin personalidad de voz.
- Piper sigue vivo pero cambió de licencia: repo original MIT archivado en oct. 2025, desarrollo activo continúa en fork GPL-3.0 (`OHF-Voice/piper1-gpl`). No es un problema para este proyecto (uso local/personal), pero queda anotado por si se piensa distribuir algo comercialmente en el futuro.
- Se evaluó ElevenLabs (mejor calidad percibida del mercado, clonación de voz desde 1 min de audio) — descartado por ahora por costo, queda como candidato futuro si se quiere clonación de voz real.
- Azure ganó por: acento mexicano (Luciano) que sí convenció, tier gratuito amplio para el uso esperado, sin necesidad de tarjeta para activarlo, y catálogo mucho más grande de voces/acentos en español que Piper.

### Arquitectura de invocación — decisión revisada

**Se descartó auto-TTS a nivel Gateway.** Diseño inicial contemplaba `messages.tts.auto: "always"` global, con el audio viajando adjunto al `ReplyPayload` (`attachments[]`) en el mismo evento de chat. Se abandonó porque esa config es global al Gateway: con cambio de agente (Ctrl+G) y múltiples clientes posibles (consola, otros frontends), *todos* los clientes conectados recibirían audio generado, no solo el PWA.

**Diseño final**: `messages.tts.auto` en `off` global. El PWA es el único cliente que invoca la RPC `tts.speak` bajo demanda — es el único cliente que "habla", por diseño.

- Texto y audio ya **no llegan sincronizados por protocolo**. El PWA es responsable de pedir el audio cuando corresponde.
- Ventaja adicional: reproducir un mensaje viejo del historial es gratis — mismo mecanismo (`tts.speak` con el texto de cualquier mensaje pasado). Sirve tanto para el flujo automático como para un futuro botón "re-escuchar".

### Seguridad de la API key
- La key de Azure vive **exclusivamente** en el entorno del Gateway (server-side), vía variable de entorno (`AZURE_SPEECH_KEY`, con fallback en cascada a `AZURE_SPEECH_API_KEY` / `SPEECH_KEY`) o `SecretRef` en config (`apiKey: "${AZURE_SPEECH_KEY}"`).
- El PWA/browser **nunca** ve la key, en ninguna forma: ni en el WS, ni en el payload, ni en config del front. Solo recibe `audioBase64` ya generado.

### Config de referencia (Gateway)
```json5
{
  messages: {
    tts: {
      auto: "off", // global: nadie recibe audio automático
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

### Validación pendiente antes de tocar el PWA
- Correr `/tts status` y `/tts audio Hola desde la consola` para validar provider + voz + región en el back, antes de que CC toque una sola línea del frontend.
- Nota operativa: los providers TTS son extensiones que no vienen instaladas por defecto en el runtime del Gateway — hay que verificar que estén instaladas (esto ya mordió una vez en la sesión de descubrimiento con OpenClaw).

---

## 4. AsciiCanvas — máquina de estados

El canvas visual (heredado del PDF/skeleton de Gemini, reescrito en cuanto a fuente de audio) tiene **tres estados**, no dos. No hay componente de "loading" separado — el propio canvas en su estado de reposo/procesando cumple esa función.

```
REPOSO
  → sin sesión activa / nada en curso / cola de audio vacía y sin operación in-flight
  → mutationRate baja, colores apagados (grises, azul tenue)

PROCESANDO (nuevo respecto al diseño original de Gemini)
  → hay una operación in-flight (session.tool / session.operation) SIN audio sonando,
    O se está generando el audio de un fragmento (tts.speak en vuelo)
  → sin texto/audio nuevo todavía
  → animación propia (pulso lento), color distintivo a definir en fase de estilo visual
  → NO depende de audioLevel real (es una animación de espera, no reactiva a audio)

HABLANDO
  → audio de un fragmento reproduciéndose
  → mutationRate mapeada desde audioLevel real (0.05 – 0.45, rango heredado del
    prototipo de Gemini, sujeto a ajuste en calibración visual)
  → colores intensos (rojo/azul/blanco brillante)
```

Pendiente de fase visual (no bloqueante para arquitectura): paleta de color específica para el estado PROCESANDO, que debe ser visualmente distinguible tanto del reposo como del habla activa.

---

## 5. Manejo de respuestas por etapas (tareas largas con pausas)

Caso real observado: OpenClaw puede responder en múltiples fragmentos separados por minutos (tool calls, esperas), no como un único mensaje continuo.

### Decisiones
- **Cada fragmento se habla apenas está completo** — no se espera a que termine toda la tarea para sintetizar un único audio largo.
- **Cola FIFO de reproducción**: si un fragmento nuevo llega mientras otro se está reproduciendo, se encola. Nunca se interrumpe un audio en curso; nunca suenan dos a la vez.

### Pseudocódigo — `useSessionAudioState`
```
fragmentQueue: []
isSpeaking: boolean

al llegar fragmento de texto completo (mode === "audio"):
  → fragmentQueue.push(texto)
  → si !isSpeaking → procesarSiguienteFragmento()

procesarSiguienteFragmento():
  → si fragmentQueue vacía:
      isSpeaking = false
      estado = (hay operación in-flight) ? PROCESANDO : REPOSO
      return
  → isSpeaking = true
  → estado = PROCESANDO (generando audio)
  → texto = fragmentQueue.shift()
  → tts.speak(texto) → esperar audioBase64
  → estado = HABLANDO
  → useAudioPlayback reproduce; AsciiCanvas consume audioLevel real
  → al terminar reproducción → procesarSiguienteFragmento() [recursivo]
```

---

## 6. Hooks nuevos respecto al diseño original de Gemini

El código que trajo Gemini (`useAudioVolume.js`) está pensado para **captura de micrófono** (`getUserMedia` + `MediaStreamSource`) — es decir, input de voz. No sirve para el caso de uso actual (audio de salida/TTS). Se reutiliza el mismo principio de análisis (AnalyserNode + cálculo de volumen promedio desde `frequencyData`), pero con una fuente distinta.

```
useAudioPlayback(audioBase64 | null)
  → si null: audioLevel = valor de reposo (bajo, puede tener algo de random chico)
  → si llega audioBase64:
      decodificar a AudioBuffer
      crear AnalyserNode conectado a ese buffer (MediaElementSource o buffer source,
        NO MediaStreamSource — esa es la pieza que Gemini tenía mal apuntada)
      reproducir
      en cada frame: leer frequencyData → calcular volumen → audioLevel real
      al terminar → volver a audioLevel de reposo
  → return { audioLevel }
```

`useAudioVolume` (captura de mic) queda anotado como posible hook futuro, para cuando se agregue input por voz — no se descarta el código de Gemini, se pospone.

---

## 7. Fase 0 — Sonda de handshake (validada)

Estado: **completada y funcionando** contra la instalación real del Gateway. Script descartable en Node, vive en `~/Projects/openclaw-pwa/openclaw-handshake-probe.mjs` — sirve como referencia de implementación para el `GatewayClient` real, no como código de producción.

### Datos de conexión confirmados (no asumidos)
- URL: `ws://127.0.0.1:18789`
- Puerto: `18789` (confirmado en config y en el unit de systemd)
- Auth mode: `token`
- Token: vive en `~/.openclaw/openclaw.json` → `gateway.auth.token` (48 chars). La sonda lo lee del JSON en runtime, nunca hardcodeado. Copia operativa también en `~/Projects/openclaw-pwa/.env` (permisos 600, con `.gitignore` ya armado para que nunca se commitee).
- Pairing: loopback directo (`127.0.0.1`) se auto-aprueba, sin necesidad de `openclaw devices approve`. Tailnet/LAN sí lo pedirían — relevante para cuando el Gateway deje de ser localhost-only (ver sección 9, pendiente de nube).

### Corrección importante sobre el `.md` original

**El payload de ejemplo del `.md` original tiene un error que la sonda reveló en la práctica**: `client.id` y `client.mode` NO son valores libres — son **enums cerrados** que el servidor valida estrictamente. El ejemplo original (`"id": "hue-pwa", "mode": "operator"`) es inválido (`operator` es un `role` válido, no un `mode` válido — la sonda lo confirmó fallando con ese mismo error).

Pares válidos confirmados contra el server real:
- Para sondas/scripts descartables: `client.id: "openclaw-probe"`, `client.mode: "probe"`
- **Para el PWA (a usar en el `GatewayClient` real)**: `client.id: "webchat"`, `client.mode: "webchat"` — o alternativamente `client.id: "openclaw-control-ui"`, `client.mode: "ui"`

### Contrato de firma del device (no estaba en el `.md`, salió del código real)

- **Algoritmo**: Ed25519 (PEM). Se firma con la clave privada, el server verifica con la pública.
- **deviceId**: `sha256(raw_public_key_bytes)` en hex, donde raw son los 32 bytes de la clave pública.
- **Payload a firmar (v3)**, todo en minúsculas:
  ```
  v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes.join(",")>|<signedAtMs>|<token>|<nonce>|<platform>|<deviceFamily>
  ```
  `signedAtMs` = el `ts` recibido en el challenge.
- **signature**: firma Ed25519 del payload completo, codificada en base64url.
- El frame `device` final: `{ id, publicKey (base64url raw), signature (base64url), signedAt, nonce }`.

### Resultado de la validación (run real)
```
✅ hello-ok: protocol 4 | server 2026.6.2 | role operator | scopes [read, write]
✅ deviceToken emitido: true
✅ 189 métodos disponibles
✅ health: ok, eventLoop sano, plugins cargando
✅ agents.list: main, hue
```

### Nota sobre persistencia (relevante para el PWA real)
El `deviceToken` que emite el server queda como identidad efímera por sesión de la sonda. El `GatewayClient` real del PWA, al persistir su keypair + `deviceToken` en IndexedDB (como ya estaba previsto en el `.md` original, sección 6.1), no debería volver a pedir pairing en conexiones futuras.

### Organización de carpetas del proyecto
Todo unificado en `~/Projects/openclaw-pwa/` (mayúscula): `DESIGN_DECISIONS.md`, `openclaw-pwa-frontend.md`, la sonda `openclaw-handshake-probe.mjs`, `.env` (token, con permisos 600) y `.gitignore` ya preparado para cuando se inicialice git.

---

## 8. Keepalive y reconexión (GatewayClient)

Diseñado antes de implementar el `GatewayClient` real, corrigiendo una suposición inicial incorrecta (se pensó que el cliente tenía que mandar algo periódicamente — no es así).

### Keepalive: pasivo, cero trabajo del cliente
- El servidor manda un `ping` a nivel de protocolo WebSocket (frame de control, no JSON) cada 25s.
- El `pong` lo responde el stack WebSocket del navegador automáticamente — no requiere código propio.
- **No existe ningún método RPC de ping/heartbeat.** `health` existe pero es un probe pesado, no sirve para esto y no debe usarse con ese fin.
- El `tickIntervalMs` (30s) que llega en `hello-ok.policy` no es algo que el cliente deba *ejecutar* — es el dato de referencia para el watchdog defensivo (ver abajo), que es responsabilidad del cliente, no una exigencia del protocolo.

### Watchdog de socket zombi (responsabilidad del cliente, no del servidor)
- `lastActivity` se actualiza en **cualquier** frame recibido (`res` o `event`).
- Timer propio corriendo cada 30s: si pasaron más de 60s sin actividad, el cliente se cierra a sí mismo con code `4000` ("tick timeout") y dispara reconexión.
- Es una red de seguridad contra sockets que quedaron "medio muertos" sin que se note.

### Reconexión: por casos específicos, no genérica

El fast-retry de 250ms mencionado en el `.md` original **no depende de un close code de WebSocket** — depende del `error.details.code` que viene en la respuesta del frame `connect` cuando falla el intento de autenticación.

| Caso | Señal | Acción |
|---|---|---|
| Red caída / server reiniciando | `close 1006`, o error `UNAVAILABLE` con `retryAfterMs` (`close 1013` "gateway starting") | Backoff estándar: 1s → 2s → 4s → … → máx 30s |
| **Pairing requerido** | error connect `PAIRING_REQUIRED` (`close 1008` "pairing required") | **No reintentar en loop.** Pausar, mostrar en UI "aprobá el dispositivo con `openclaw devices approve`", esperar confirmación manual |
| Token stale | error connect `AUTH_DEVICE_TOKEN_MISMATCH` / `AUTH_TOKEN_MISMATCH` | Borrar `deviceToken` guardado, reintentar a 250ms (una sola vez, budget de un solo uso), luego caer a backoff estándar si vuelve a fallar |
| Socket zombi | 60s sin frames (watchdog propio) | Cerrar con `4000`, reconectar |

**Por qué `PAIRING_REQUIRED` es crítico y no puede tratarse como cualquier desconexión**: si se reintenta en loop sin pausar, se genera una solicitud de pairing nueva en cada intento — el operador corre el riesgo de que `openclaw devices approve` apruebe la request equivocada (las requests con auth cambiado superseden a la pendiente anterior). Este caso exige detección explícita y pausa, no reintento automático.

### Caso específico de PWA: pestaña en background
- El riesgo real de un PWA (a diferencia de una TUI o cliente de escritorio) no es el keepalive en sí — es que el navegador puede congelar la pestaña en segundo plano y matar el WebSocket silenciosamente (`close 1006` sin aviso previo).
- Mitigación: escuchar el evento `visibilitychange` del navegador — al volver la pestaña a foco, si `connectionState !== "connected"`, reconectar inmediatamente en vez de esperar a que el usuario note que algo no responde.

---

## 9. Estructura de carpetas (heredada del .md, sin cambios)

```text
src/
├── protocol/
│   ├── client.ts
│   ├── frames.ts
│   ├── handshake.ts
│   ├── device.ts
│   └── methods.ts
├── store/
│   ├── session.ts
│   ├── messages.ts
│   └── usage.ts
├── components/
│   ├── ChatView.tsx
│   ├── Composer.tsx
│   ├── AgentSwitcher.tsx
│   ├── SessionList.tsx
│   ├── ToolCard.tsx
│   ├── StatusBar.tsx
│   ├── ModeToggle.tsx          # nuevo
│   ├── AsciiCanvas.tsx         # nuevo, reemplaza el prototipo p5.js de Gemini
│   └── TextChatPanel.tsx       # nuevo, contenedor del modo texto
├── hooks/
│   ├── useGateway.ts
│   ├── useStreaming.ts
│   ├── useAudioPlayback.ts     # nuevo
│   └── useSessionAudioState.ts # nuevo
└── App.tsx
```

---

## 10. Decisiones cerradas en esta ronda

- **Nombre del proyecto / repo**: `openclaw-pwa`. ("jarvishue" queda solo como nombre del recurso Azure, sin relación con el nombre del proyecto.)
- **Hosting del PWA**: standalone (`vite build` → static host). No se sirve desde el Gateway.
- **Ubicación del Gateway**: localhost por ahora (uso en esta PC exclusivamente). Nube queda como fase lejana, sin fecha — cuando se retome, implica pasar de `ws://` a `wss://` y resolver certificados/pairing remoto.
- **Aprobaciones de exec desde el PWA**: descartado para v1, no solo pospuesto. Razón: OpenClaw ya distingue en sus propias directivas entre acciones grandes (pide autorización explícita) y chicas (autorización ya dada de antemano). La consola TUI sigue operando en paralelo al PWA por diseño — el flujo real es "el PWA es una capa visual más linda sobre la misma sesión que la consola", así que las aprobaciones de exec se resuelven ahí, sin necesidad de replicar `exec.approval.*` en el frontend.

## 11. Pendientes que siguen abiertos

- [x] ~~Fase 0 — sonda de handshake~~ → completada, ver sección 7
- [x] ~~Diseño de keepalive/reconexión~~ → completado, ver sección 8
- [ ] Paleta de color / estilo concreto del estado PROCESANDO en el AsciiCanvas
- [ ] Confirmar disponibilidad de `es-MX-LucianoNeural` en `brazilsouth` vía `/tts status` (validación de back antes de tocar frontend)
- [ ] Input por voz (mic) — explícitamente fuera de alcance de esta fase, revisar `useAudioVolume.js` de Gemini cuando se retome

---

## 12. Fuera de alcance en esta fase (explícito)

- Input por voz / micrófono
- Clonación de voz (ElevenLabs u otro)
- Notificaciones push
- Aprobaciones de exec desde el PWA (decisión consciente, ver sección 10 — la consola TUI cubre este caso en paralelo)
- Gateway en la nube (fase lejana, sin fecha)
