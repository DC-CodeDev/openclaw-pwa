# OpenClaw PWA — DESIGN_DECISIONS.md

> Estado: decisiones cerradas en reunión de diseño, previas a implementación con CC.
> Este documento complementa (no reemplaza) `openclaw-pwa-frontend.md`, que sigue siendo la fuente de verdad del protocolo Gateway v4.
> Fecha de cierre de esta ronda: 2026-08-07 (actualizado 2026-08-09 — cierre de investigación de tokens y run limiter, ver secciones 7 y 8bis)

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

### Correcciones al protocolo real (Fase 2, no documentadas en el .md original)

Descubiertas implementando el wiring real contra el gateway — el `.md` original tenía la forma general correcta, pero estos detalles de parámetros solo salieron probando en la práctica:

| Método / evento | Asunción original (.md) | Comportamiento real confirmado |
|---|---|---|
| `sessions.create` | Aceptaría `idempotencyKey` como cualquier método con efectos secundarios | Rechaza ese campo — schema estricto, no es válido en este método |
| `sessions.create` (retorno) | Se asumía `{ sessionKey: "..." }` | Retorna `{ key: "..." }` |
| `sessions.messages.subscribe` | Se asumía parámetro `sessionKey` | El parámetro se llama `key` |
| `chat.send` | Se asumía parámetro `content` | El parámetro se llama `message` |
| Streaming de respuesta | Se asumía evento `chat` o `session.message` indistintamente | El evento correcto es `chat`. `session.message` son solo notificaciones de cambio en el transcript, sin el contenido en streaming — se usan para reload de historial, no para mostrar deltas en vivo |
| `sessions.list` (nombre para UI) | Se improvisó `slice(-6)` sobre el `key` — generaba nombres feos tipo "sesión e:main" | Existe `derivedTitle`, pensado exactamente para esto (mismo campo que usa la Control UI oficial). **Requiere pasar `includeDerivedTitles: true`** en la llamada, si no el campo no viene. Para subtítulo: `lastMessagePreview`, requiere `includeLastMessage: true` |

**Sobre el `key` de sesión — no usar para mostrar nombre**: su gramática es `agent:<agentId>:<rest>`, donde solo el primer segmento (`agentId`) tiene significado fijo — el resto (`rest = parts.slice(2).join(":")`) es una ruta de ruteo opaca que varía según el origen (`main`, `dashboard:<uuid>`, `telegram:direct:<peerId>`, `cron:<id>:run:<id>`, etc). Cortar el final del string (como hacía nuestro `slice(-6)` improvisado) expone el marcador de ruteo interno, no un nombre — de ahí "sesión e:main". El gateway ya resuelve un nombre legible mejor del lado del servidor, no hace falta parsear el `key` del lado del cliente.

**Precedencia real de `derivedTitle`** (verificado en el código instalado, no solo en docs): `displayName` del row → `subject` del row → primer mensaje del usuario normalizado y truncado a 60 caracteres (corte inteligente en espacio) → fallback `sessionId.slice(0,8)` + fecha.

**Estructura completa de un item de `sessions.list`** (confirmado contra el RPC real): `key`, `derivedTitle`, `lastMessagePreview`, `agentId`, `kind` (`main`/`dm`/`group`/`cron`/`subagent`/`other`), `channel`, `lastChannel`, `origin.provider`, `deliveryContext`, `sessionId` (UUID), `model`, `status` (`running`/`idle`), `contextTokens`, `startedAt`, `updatedAt` (epoch ms), `systemSent`, `abortedLastRun`, `transcriptPath`.

**`content` de un mensaje NO siempre es un string** — descubierto en Fase 4/5 con un crash real (`Objects are not valid as a React child`) al abrir una sesión con extended thinking habilitado. El campo puede venir como `string` (caso simple) o como un **array de content blocks**:
```
[
  { "type": "thinking", "thinking": "razonamiento interno..." },
  { "type": "text", "text": "respuesta visible" }
]
```
Tipos de bloque observados hasta ahora: `text`, `thinking`, `tool_use`, `tool_result`. El tipo `ContentBlock` está exportado desde `methods.ts` con estos campos. La función `extractText()` en `useGateway.ts` filtra y concatena solo los bloques `type: 'text'` para mostrar en el chat — **`thinking`, `tool_use` y `tool_result` se descartan del display por ahora**, no se pierden del dato crudo, solo no se muestran.

Implicancia para fases futuras: el contenido de `tool_use`/`tool_result` que hoy se descarta es exactamente lo que `ToolCard.tsx` (Fase 5) necesita mostrar — no hay que inventar de dónde sacar esos datos, ya están llegando en el `content` de los mensajes, solo falta consumirlos ahí en vez de tirarlos. El contenido de `thinking` queda como decisión de producto pendiente: ¿mostrarlo colapsado/expandible en algún momento, o mantenerlo oculto?

Estas correcciones ya están aplicadas en `src/protocol/methods.ts`, `src/store/messages.ts` y `src/hooks/useGateway.ts`. Quedan documentadas acá para que cualquier trabajo futuro sobre el protocolo parta de estos valores confirmados, no de los del `.md` original.

**`sessions.list` — corrección**: NO trae `startedAt` como se documentó originalmente en esta sección (Fase 3) — solo `updatedAt` (última actividad de la sesión), que en la práctica es el campo más útil de los dos. Campos adicionales confirmados que no estaban listados antes: `thinkingDefault`, `totalTokensFresh`, `modelProvider`, `contextTokens`, `hasActiveRun`.

**`sessions.create` — `updatedAt` anidado**: el shape real es `{ ok, key, sessionId, entry: { updatedAt, ... }, runStarted }` — `updatedAt` vive dentro de `entry`, no en el nivel raíz de la respuesta. `methods.ts` lo aplana a `Session.updatedAt` antes de exponerlo, para que el resto de la app no tenga que saber navegar esa anidación.

**`sessions.usage` — confirmado por primera vez (StatusBar, contador de tokens)**: el parámetro es `key`, NO `sessionKey` (rechaza con `INVALID_REQUEST` si se manda así — mismo patrón de nombre que ya vimos en `sessions.messages.subscribe`). Shape de respuesta real:
```
{
  updatedAt, startDate, endDate,
  sessions: [{
    key, sessionId, agentId, scope, updatedAt,
    usage: { totalTokens, totalCost, input, output, cacheRead, cacheWrite, ...costs, messageCounts }
  }],
  totals, aggregates, cacheStatus
}
```
Contador a mostrar: `sessions[0].usage.totalTokens`, con fallback a `totals.totalTokens` si el primero no está. `usage` puede venir `null`.

### Tool calls — `session.tool` (en vivo) vs bloques de historial (durable)

Investigado antes de implementar Fase 5 (Tool cards). Son **el mismo tool call visto en dos etapas del ciclo de vida**, no dos sistemas independientes:

- **`session.tool`** (evento WS): proyección **en vivo** mientras la herramienta corre. El runtime emite `start` → `update` → `result` por el stream `tool`, el gateway lo difunde a los suscriptores de la sesión. **Es efímero** — si no estabas suscrito en ese momento (join a mitad de ejecución, reload de página), esa información se pierde para siempre, no hay forma de pedirla después.
- **Bloques `tool_use`/`tool_result`** dentro de `content[]` de un mensaje: el registro **durable**, persistido en el transcript (JSONL), disponible vía `chat.history`. Es la fuente canónica y la que sobrevive a un reload.

**Regla operativa**: lo que te perdiste de `session.tool` se recupera del historial una vez completado el turno. Lo que todavía está corriendo (sin resultado final) solo existe en `session.tool` — no hay otra forma de verlo en vivo.

#### Shape de `session.tool`
```ts
interface SessionToolEvent {
  event: "session.tool";
  payload: {
    runId: string;
    stream: "tool" | "lifecycle" | "fallback" | "compaction"; // solo "tool" trae data de herramienta
    ts: number;
    sessionKey?: string;
    agentId?: string;
    data: {
      phase: "start" | "update" | "result";
      name: string;              // nombre de la herramienta
      toolCallId: string;        // id estable — key de la card
      args?: unknown;            // solo en "start", SANITIZADO (secretos redactados)
      partialResult?: unknown;   // solo en "update", opcional/intermitente
      result?: unknown;          // solo en "result"
      isError?: boolean;
      exitCode?: number;         // tools tipo exec
    };
  };
}
```
- `update` es opcional: tools con solo progress bar no lo emiten.
- Argumentos vienen sanitizados — el Control UI oficial ni los muestra crudo, directamente indica "N argumentos ocultos". No confiar en poder mostrar el detalle completo.
- **Derivación de estado** (misma lógica que usa el Control UI): `phase !== "result"` → `running`; si `isError` (evento o `result.is_error`) o `status` matchea `/error|fail/i` o `exitCode` finito ≠ 0 → `error`; si no → `done`.

#### Shape de los bloques en historial
```ts
{ type: "tool_use", id: string, name: string, input: Record<string, unknown> }   // en content de mensaje assistant
{ type: "tool_result", tool_use_id: string, content: string | ContentBlock[], is_error?: boolean } // en content de mensaje "tool"
```
- **Variantes de nombres de campo a tolerar** (el Control UI las normaliza, conviene hacer lo mismo): tipo de bloque puede venir como `toolCall`/`tool_call`/`tooluse`/`tool_use` o `toolResult`/`tool_result`; el id como `id`/`call_id`/`toolCallId`/`toolUseId`/`tool_call_id`/`tool_use_id`; los argumentos como `input`/`arguments`/`args`.
- `chat.history` ya viene display-normalizado — los bloques estructurados sobreviven intactos, son la fuente correcta para las cards (a diferencia del JSONL crudo del disco, que puede tener otras formas — no relevante para el PWA que solo consume `chat.history`).

#### Arquitectura recomendada (la misma que usa el Control UI oficial en producción)
Un solo modelo interno, dos adaptadores, con merge al recargar:
```
ToolCallRecord { id, name, args?, status: "running"|"done"|"error", output?, startedAt, updatedAt }
  keyed por toolCallId (evento en vivo) / id o tool_use_id (historial)

Adaptador live: session.tool → upsert por toolCallId
  "start" → crea la card en running
  "update" → pisa output con partialResult
  "result" → cierra la card con done/error + output final

Adaptador historial: escanea content[] de cada mensaje de chat.history
  → genera records ya "settled" (sin estado running, van directo a done/error)

Merge: mientras corre un run, las cards live llenan el hueco en tiempo real;
  al recargar historial (luego de que el turno termina), el transcript
  durable reemplaza la cola optimista — mismo patrón que ya usamos para
  mensajes de chat (live events como estado de entrega, chat.history
  como reconstrucción desde la fuente durable)
```
No hace falta ningún endpoint ni evento nuevo del lado del gateway — el mismo `session.tool` que alimenta el Activity tab del Control UI es el que consume el PWA.

**Confirmado en Fase 5, con datos reales**: el agente `J.A.R.V.I.S.` (probado con `exec`/bash) **no emite eventos `session.tool`** — el estado `running` nunca es observable en vivo con este agente. El PWA cae correctamente al adaptador de historial: silencio durante la ejecución → la card aparece directo en `done`/`error` quando el turno completa y se recarga `chat.history` (con ~1.5s de delay tras `chat state='final'`). Esto es comportamiento esperado de la arquitectura de dos adaptadores, no un bug — el adaptador `live` está implementado y funcionaría igual con cualquier agente que sí emita `session.tool`. Si en el futuro se prueba con otro agente y aparece el estado `running` en vivo, es una diferencia de comportamiento entre agentes, no una mejora del código del PWA.

**Tool calls internos (auto-auditoría/debugging) vs relevantes para el usuario — sin distinción nativa en el protocolo.** Verificado contra el código real: ambos casos son exactamente el mismo tipo de evento (`session.tool` / bloques `tool_use`), sin ningún flag de "internal". Dos excepciones estructurales reales:
1. `isHeartbeat: true` en el envelope — tool events de runs de heartbeat se suprimen por defecto en varias superficies (`suppressHeartbeatToolEvents`), pero solo cubre heartbeats, no auto-auditoría dentro de un turno normal.
2. **Separación por subagente** (`sessions_spawn`, session key `agent:<id>:subagent:<uuid>`): si el trabajo interno se delega a un subagente, sus tool events **nunca aparecen en el stream ni en el historial de la sesión padre** — el padre solo ve el `sessions_spawn` y el resultado consolidado. Es la única separación limpia sin heurísticas, pero es una decisión que se toma del lado del agente (`AGENTS.md`/`SOUL.md`), no del PWA.

Para el caso real encontrado (JARVIS haciendo docenas de `grep`/`sed`/`find` sobre su propio código en la sesión principal, sin delegar a subagente): no hay forma de filtrarlo con certeza del lado del cliente. El PWA resuelve el síntoma (collapse por defecto de todas las tool cards, ver Fase 6/UX), pero la solución de raíz — delegar auto-auditoría a subagentes — queda fuera del alcance de este proyecto, es una mejora pendiente del lado de la configuración del agente en OpenClaw.

**Actualización — causa raíz real encontrada, no era diferencia de canal.** Investigado un caso relacionado pero distinto: JARVIS narrando su proceso de debugging como **texto plano dentro del cuerpo de la respuesta** (no como tool call separado, así que ningún filtro de bloques lo agarra). La sospecha inicial era que el WebChat tuviera algún comportamiento distinto a la consola por canal — descartado: **no existe `channels.webchat` en el esquema del Gateway**. La causa real es un **override de sesión**: la sesión del WebChat tenía `Think: high` activo (confirmado con `/status`), mientras que el TUI no arrastraba ese override — son sesiones distintas (`session.dmScope: "per-channel-peer"`, cada superficie crea la suya). Con `deepseek-v4-flash` (modelo con `reasoning: true`) en modo alto de thinking, el modelo derrama su cadena de razonamiento (comandos grep, exploración de archivos) directo en el `content` de la respuesta en vez de mantenerlo en un canal de reasoning estructurado — de ahí el texto plano indistinguible.

El picker de thinking del WebChat escribe ese override inmediatamente vía `sessions.patch` al elegir un nivel — quedó pegado de alguna sesión anterior. **Decisión de producto**: en vez de implementar la delegación a subagentes (que hubiera cubierto tanto tool calls como narración), se optó por exponer el **nivel de thinking como control visible en el StatusBar** — control directo sobre la causa real, evita que el override quede invisible y sin que el usuario se dé cuenta. Pendiente de implementar (ver sección de pendientes). La arquitectura de subagente (`sessions_spawn`, `context: "isolated"`, `mode: "run"`) queda documentada como alternativa disponible si en el futuro aparece otro caso de narración excesiva no relacionado con thinking — se descartó implementarla ahora porque el control de thinking en el StatusBar cubre la causa real encontrada.

**Control de thinking — implementado.** Mecanismo real confirmado contra el gateway:
- **Lectura**: cada row de `sessions.list` trae `thinkingDefault` (nivel por defecto del modelo), `thinkingLevels[]`/`thinkingOptions[]` (valores válidos: `off|minimal|low|medium|high|xhigh|max`), y `thinkingLevel` **solo cuando hay override seteado** (ausente = sin override, heredando el default). `sessions.get` NO sirve para esto — devuelve `{ messages }` (transcript), no la row de metadata.
- **Escritura**: `sessions.patch({ key, thinkingLevel })` → `{ ok, path, key, entry: {...} }`. Para limpiar el override: `thinkingLevel: null` (confirmado que vuelve a estado ausente). `"default"` NO es un valor válido — el gateway lo rechaza, solo acepta los siete niveles reales listados arriba.
- **`sessions.patch` requiere `operator.admin`** en los scopes del handshake — mismo scope que se había revertido por el problema de `tts.speak` inexistente; se re-agrega ahora por una razón real y confirmada.
- **`sessions.patch` rechaza clientes con `client.mode: "webchat"`** explícitamente ("webchat clients cannot patch sessions; use chat.send for session-scoped updates"). `chat.send { thinking }` existe pero es override por-run, no persiste como el de la sesión. La combinación que funciona y que el PWA usa desde este cambio: **`client.id: "webchat"` + `client.mode: "ui"`** (probado empíricamente contra las tres combinaciones posibles) — esto reemplaza el par `webchat`/`webchat` que se había confirmado en la Fase 0, ver esa sección para el contrato de firma que sigue aplicando igual, solo cambia el valor de `mode` en el payload.
- Nota operativa: cada cambio de `client.id`/`client.mode` o de scopes solicitados dispara una nueva aprobación de pairing (comportamiento correcto, documentado en la sección de keepalive/reconexión) — al recargar tras este cambio, hay que aprobar el dispositivo de nuevo con `openclaw devices approve <requestId>`.
- **El `requestId` de pairing es efímero y rota**: si el dispositivo reintenta el pairing con auth cambiado (rol, scopes, o public key nueva), el gateway supersede la entrada pendiente anterior con un `requestId` nuevo. Como el PWA genera una identidad efímera en cada intento de conexión, un `requestId` copiado de `devices list` puede quedar obsoleto para cuando se corre `approve` — el CLI responde `unknown requestId` en ese caso (no es un bug, ni hace falta `openclaw doctor`). **Solución**: usar `openclaw devices approve --latest` (toma automáticamente el request pendiente más reciente) en vez de copiar el id manualmente, o correr `devices list --json` inmediatamente antes de aprobar para tener el id vigente.

**Corrección final — la causa real NO era thinking, era un bug de filtrado de rol (`toolResult` vs `tool`).** Después de implementar el control de thinking, el problema de "narración/thinking visible en el chat" persistió, y un caso extremo (una sesión de auditoría) reveló un consumo de **5.264.000 tokens por PWA contra 170.000 tokens en la misma tarea por terminal** — factor 30x, imposible de explicar por thinking level o por cantidad de tool calls (ambos canales las hacen por igual). Auditoría forense del código del PWA (no del Gateway) encontró la causa real: el mapeo de historial (`useGateway.ts` y `store/tools.ts`) chequeaba `m.role === 'tool'` para saltear filas de resultado de herramienta del render — pero el Gateway emite `role: "toolResult"` (camelCase), no `"tool"`. Esas filas nunca eran filtradas, pasaban de largo hacia `extractText()`, que sí extraía correctamente sus bloques `text` — pero esos bloques contenían **el output crudo de las tool calls** (dumps de `session_status`, trayectorias JSON completas, código fuente minificado), no razonamiento del modelo. Eso es lo que se veía como "thinking en el chat": era salida cruda de herramientas disfrazada de texto de asistente. Medido en la sesión de auditoría: 36 filas `toolResult` = 108.287 caracteres de basura renderizados. Como ese contenido quedaba en el historial visible de la sesión, se reenviaba como contexto en cada tool call subsiguiente — eso, no el thinking, es lo que explica el factor 30x: el historial de la sesión PWA estaba inflado con decenas de miles de caracteres que se repetían en cada llamada (`cacheRead`), mientras la sesión de terminal nunca tuvo este bug y se mantuvo liviana.

**Fix aplicado**: `isChatVisibleRole()` (acepta solo `user`/`assistant`/`system`) reemplaza el chequeo `m.role === 'tool'` en ambos mapeos de historial (`useGateway.ts`, `store/tools.ts`). Las ToolCards siguen funcionando porque `extractToolRecordsFromHistory()` lee las filas crudas *antes* del filtrado de visibilidad. `extractText()` además se endureció con un helper `isTextBlock` explícito, cubriendo variantes como `reasoning` con campo `text`. **Verificado con reducción medida real**: tamaño de DOM tras reload de historial pasó de 120.816 a 12.025 caracteres en la sesión de test (≈90% de contenido basura eliminado), 0 hits de contenido no deseado en los 4 paths probados (streaming en vivo + reload de historial, en dos sesiones distintas).

**Lección de esta cadena de diagnósticos** (queda documentada por su valor para el futuro): se investigó dos veces con una hipótesis equivocada (diferencia de canal, luego thinking level) antes de encontrar la causa real. La señal que finalmente destrabó el diagnóstico correcto fue comparar el **mismo tipo de tarea entre dos canales** (PWA vs terminal) y notar que la magnitud de la diferencia (30x) era demasiado grande para explicarse por un mecanismo que afecta a ambos canales por igual — eso apuntó correctamente a "algo específico del PWA", no del comportamiento del agente.

**Capítulo final — el residual de 12.7x después del fix de `toolResult` tampoco era un bug, era cache de provider + métrica engañosa.** Tras aplicar el fix de la sección anterior, persistía una diferencia de ~12.7x entre auditorías comparables por PWA y por terminal. Antes de auditar más código, se corrió un experimento controlado (no lectura de código) para medir el delta real por turno, no el acumulado de sesión: `sessions.usage(key)` antes/después del mismo tipo de consulta trivial, en los cuatro cruces de la matriz *canal × estado de cache*.

Resultado de la matriz (session files JSONL como fuente de verdad — `sessions.usage` vía RPC resultó no confiable para esto, quedaba en `cacheStatus: "refreshing"` después del turno):

| Canal | Cache | input | cacheRead | total | cost/turno |
|---|---|---|---|---|---|
| Terminal | frío (turno 1) | 28.932 | 0 | 28.959 | $0,00406 |
| Terminal | cálido (turno 2, misma sesión) | 61 | 28.928 | 28.991 | $0,000819 |
| PWA/dashboard | cálido (sesiones nuevas) | 38–166 | 28.288–29.056 | 28.715–29.153 | $0,000835–$0,000897 |
| TUI | cálido (sesión multi-turno) | 46–5.815 | 17.408–29.056 | 23.673–30.859 | $0,000761–$0,001428 |

Con las cuatro celdas cubiertas, terminal en cache cálido ($0,000819) y PWA en cache cálido ($0,000835–$0,000897) son prácticamente idénticos — la variación previa (30x, luego 12.7x) nunca fue una diferencia de canal, era el estado del cache de DeepSeek: primer turno del día = cache frío = system prompt completo como `input` (~28.9k tokens, ~5x más caro); turnos siguientes = cache cálido = solo el mensaje nuevo como `input`, el resto como `cacheRead` (más barato). El PWA es arquitectónicamente incapaz de inflar el costo por-consulta más allá de lo que infla cualquier canal, porque no arma ni reenvía el historial — eso lo hace el Gateway server-side a partir del transcript persistido; `chat.send` manda únicamente `{ sessionKey, message, idempotencyKey }`.

**Bug de métrica, distinto del bug de costo, también resuelto.** El `StatusBar` mostraba `usage.totalTokens` (`useGateway.ts`, `res.sessions[0].usage.totalTokens ?? res.totals.totalTokens`), que es el acumulado histórico de toda la sesión, no el contexto actual. En una sesión con muchos turnos esto crece con cada turno sumado y da la falsa impresión de que el costo se disparó, cuando en realidad solo refleja cuántos turnos tuvo esa sesión — este malentendido fue lo que motivó buena parte de esta investigación. Se evaluó `Session.contextTokens` como reemplazo directo pero se descartó: en 32 de 33 sesiones reales de PWA salía `null`, porque ese campo (`contextBudgetStatus.estimatedPromptTokens`) solo lo escribe el runner CLI (`openclaw agent`), no `chat.send` — no es una fuente confiable para el canal que más importa medir.

**Fix aplicado**: `extractContextFromHistory()` (nueva función de módulo) busca hacia atrás en `chat.history` el `usage.totalTokens` del último mensaje `assistant` — ese valor (`input + cacheRead + output` del último turno) aproxima el tamaño de contexto que se reenviará en el próximo turno, sin depender del campo no confiable. Se calcula en `selectSession` y se actualiza ~1,6s después de cada `chat:final` (mismo delay que ya usa `tools.ts` para otras actualizaciones). Formato de visualización: `formatContextTokens(n)` → `"29.1K/1M"`, denominador hardcodeado (ventana fija de `deepseek/deepseek-v4-flash`, misma referencia que ya muestra la CLI de OpenClaw en terminal).

**Verificado en vivo, en los tres frentes:**
- Delta correcto por turno: sesión multi-turno, antes `29.2K/1M` → después (8s) `29.3K/1M`, delta de 100 tokens coherente con un mensaje corto.
- Consulta con tool call real (clima vía `curl` a API externa, no solo texto): `29.1K/1M` → `31.9K/1M`, delta de ~2.8k coherente con una sola tool call — nada desproporcionado, muy distinto del patrón de 16 tool calls encadenadas de la sesión que disparó la alarma original.
- Respuesta renderizada limpia: tool card colapsada sin desplegar, sin output crudo de herramientas en el texto del chat — confirma que el fix de `isChatVisibleRole()` de la sección anterior sigue sosteniéndose.

Se aprovechó el mismo cambio para deduplicar `isChatVisibleRole()` (dos copias idénticas en `useGateway.ts:47` y `tools.ts:30`) — deuda de mantenimiento sin relación con costos, dejada como única definición exportada desde `tools.ts`.

**Balance de la investigación completa de tokens** (para no repetir el mismo rodeo si el patrón "canal X parece más caro" reaparece en otra app de la Suite): de tres sospechas iniciales, una era un bug real (`role: "toolResult"` sin filtrar, resuelto en el capítulo anterior), una era artefacto de métrica (acumulado histórico mostrado como si fuera costo puntual, resuelto acá), y una nunca fue un bug (diferencia de canal — es estado de cache del provider, comportamiento esperado). La lección operativa: ante una diferencia de costo entre canales, medir el **delta por turno controlando el estado de cache** antes de sospechar del código del cliente — y desconfiar de cualquier métrica que muestre un acumulado sin dejarlo explícito en la UI.

**TTS por agente — confirmado, soportado con deep-merge.** `agents.list[].tts` sobreescribe `messages.tts` (config global), típicamente solo `speakerVoice`, dejando región/credenciales globales intactas. También soporta `personas` (`agents.list[].tts.persona`) para identidad vocal estable multi-proveedor.
```json5
agents: {
  list: [
    { id: "main", tts: { providers: { "azure-speech": { speakerVoice: "es-MX-LucianoNeural" } } } },
    { id: "hue",  tts: { providers: { "azure-speech": { speakerVoice: "es-MX-JorgeNeural" } } } },
  ],
}
```
**Precedencia efectiva** (menor a mayor): `messages.tts` → `agents.list[].tts` → `channels.<channel>.tts` → override de cuenta → prefs locales `/tts` → directivas inline `[[tts:...]]`. Dos gotchas a tener en cuenta: las prefs locales (`/tts provider`, corridas alguna vez en el host) ganan por encima de la config per-agente; y un posible `channels.webchat.tts` también le gana — verificar que no exista uno si las voces por agente no parecen aplicarse.

**Decisión final de arquitectura de audio — `tts.speak` descartado, se usa `tts.convert` + endpoint de media.** Investigado antes de conectar la Fase 6 al flujo real. `tts.speak` (el método que el diseño original asumía, devolviendo `audioBase64` inline) **no existe en ningún release estable ni beta actual** — solo aparece en el CHANGELOG de `main` como "Unreleased" (PRs #100708/#100770). Actualizar el gateway hoy no lo entregaría de todas formas, e implicaría una migración real y no trivial (más de 30 patch releases de diferencia, migración de storage a SQLite, cambio de firma de device proofs, el contrato de config TTS movido de `messages.tts` a `tts` de primer nivel) — riesgo innecesario sobre sesiones/agentes/`sessions.patch`/pairing ya funcionando, a cambio de nada que hoy no se pueda lograr de otra forma.

**Flujo adoptado (verificado en vivo contra el gateway real, 2026.6.2):**
```
1. tts.convert(text) → { audioPath: "/tmp/openclaw/tts-.../voice-....mp3", provider, outputFormat, ... }
2. GET /__openclaw__/assistant-media?meta=1&source=<audioPath>  (con bearer token)
   → devuelve { available: true, mediaTicket: "<ticket corta duración>" } (o file-not-found si no existe)
3. GET /__openclaw__/assistant-media?source=<audioPath>&mediaTicket=<ticket>
   → sirve el archivo con Content-Type: audio/mpeg, soporta Range/ETag
4. El cliente hace fetch() de ese endpoint y arma un blob: URL para reproducir con <audio> o decodificar a AudioBuffer
```
No hace falta servidor ni auth adicional — es el mismo patrón bearer + tickets que el PWA ya usa para avatares/imágenes. El CSP del gateway permite `media-src 'self'`, así que `<audio>` reproduce sin problemas.

**Dos precauciones operativas**: el `mediaTicket` expira en minutos — pedir el `meta=1` justo antes de reproducir, no cachearlo. Los archivos temporales de TTS están sujetos a un lifecycle de limpieza — reproducir poco después de generar, no diferir la reproducción. Ambas se resuelven naturalmente si el flujo hace `tts.convert` → `meta` → `fetch` → reproducir en una secuencia inmediata sin demoras artificiales.

**Nota para el futuro**: cuando `tts.speak` llegue a un release estable, la migración del PWA sería menor (recibir `audioBase64` y reproducir directo en vez del flujo de ticket) — pero no hay apuro, el flujo por ticket es en algunos aspectos más robusto para un browser que base64 inline por WebSocket (no infla el tamaño del mensaje WS, soporta Range para seek). Migrar cuando convenga, no por necesidad.

**Hallazgo crítico — CORS en `assistant-media`, requiere proxy.** El gateway 2026.6.2 **no emite headers CORS** en el endpoint `/__openclaw__/assistant-media` (confirmado: 0 ocurrencias en el bundle instalado; probado en vivo con bearer, con token en query, y sin auth — todos fallan; el preflight `OPTIONS` da 404). La Control UI oficial no sufre esto porque es same-origin (el propio gateway la sirve). El PWA, al correr en otro origen (`localhost:5173` en dev, un dominio propio en producción), no puede hacer el fetch directo al gateway.

**Solución adoptada**: fetch **relativo** a `/__openclaw__/assistant-media` (no a la URL absoluta del gateway) + proxy que reenvía esas rutas al gateway real — en dev, `vite.config.ts` tiene un proxy configurado; en producción, hace falta un reverse proxy equivalente (nginx, Caddy, o lo que corresponda al hosting final) que reenvíe `/__openclaw__/*` al gateway. Esto es una dependencia de infraestructura nueva que no existía antes de la Fase 6 — el PWA dejó de ser "puramente standalone hablando directo al gateway por WS" para el caso específico de servir audio; el WebSocket sigue siendo directo, pero el fetch HTTP de media necesita este proxy. Tenerlo en cuenta al definir el hosting final de producción (ver sección de pendientes, "¿Servir el PWA desde el gateway o standalone?" — este hallazgo es un argumento a favor de reconsiderar esa decisión, o al menos de planificar el proxy con cuidado).

**Contrato final entre hooks** (tras conectar el flujo real): `useAudioPlayback` cambió de recibir `audioBase64: string | null` a recibir `audioBlob: Blob | null` (decodifica con `blob.arrayBuffer()`). `useSessionAudioState` usa `ttsConvertAndFetch()` en vez de la llamada a `ttsSpeak()` original. Los stores (que no pueden llamar hooks directamente) se comunican con el hook de audio vía un bridge a nivel de módulo (`enqueueAudioFragment`/`onAudioEnqueueRequest`). Por ahora, un mensaje completo del agente = un solo fragmento en la cola (la fragmentación más granular para respuestas largas con pausas, diseñada en la sección 5, queda como mejora futura una vez validado el flujo básico).

**Atajo Alt+X — cortar audio.** Corta la reproducción en curso Y vacía la cola completa de fragmentos pendientes (no sigue hablando el resto de una respuesta larga tras cortar). Mismo guard que Ctrl+G (no intercepta si el foco está en el textarea del Composer) — decisión consciente: aunque Alt+X es raro en texto normal, layouts con AltGr emiten `Ctrl+Alt+letra`, así que sin guard interceptaría escritura real. Costo aceptado: con foco en el Composer hay que clickear afuera antes de usar el atajo.

**Confirmado en vivo**: cortar audio mientras suena (`source.start` → Alt+X → cadena `stopAudioPlayback` → `stopActiveAudio` → `source.stop()` → `REPOSO` inmediato). Cortar durante la síntesis (estado PROCESANDO, antes de que el audio empiece a sonar) también descarta el fragmento correctamente. No-op sin audio activo (sin errores).

**No verificado en vivo, garantizado por construcción**: el corte específicamente en el primer fragmento de una cola de 2+ fragmentos pendientes. El vaciado (`queueRef.current = []`) es una operación simple y determinística — se dejó sin verificación en vivo tras dos intentos donde el testeo contra el agente real (15-60s por turno) consumió tiempo desproporcionado sin llegar a completarse. Si en el futuro aparece algún comportamiento raro específicamente en este caso, revisar acá primero.

### Error Boundary (agregado tras el bug de content blocks)
`App.tsx` tiene un `ErrorBoundary` de React envolviendo `ChatView` — cualquier crash de renderizado similar al de content blocks muestra un mensaje de error con botón "reintentar" en vez de tirar abajo toda la interfaz. Red de seguridad, no reemplaza corregir la causa raíz de cada bug puntual que aparezca.

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

## 8bis. Run Limiter — corte de runs largos por gasto no vigilado

> Origen: investigación disparada tras la auditoría de tokens de la sección 7, donde apareció una sesión con 16 tool calls encadenadas. Esa investigación concluyó que el gasto en sí no era un bug (ver sección 7, capítulo final), pero dejó una pregunta abierta y real: **nada en OpenClaw evita que un agente entre en una racha larga de tool calls sin freno**, más allá de un timeout de 48hs que en la práctica no protege nada.

### Diagnóstico previo: qué límites existen hoy en OpenClaw y cuáles no

Verificado contra schema y runtime, no solo documentación:
- **No existe** ningún `maxToolCallsPerRun` ni equivalente a nivel de agente.
- `agents.defaults.timeoutSeconds` es un cap de **tiempo** (48h por defecto), no de cantidad de tool calls.
- `agents.defaults.maxConcurrent` es concurrencia de sesiones en paralelo, no tool calls por run.
- `maxPendingToolCalls` (default 16) es concurrencia de tool calls simultáneas dentro de una ronda, no un techo de rondas totales — un agente puede agotar 16, terminar, y arrancar otras 16 sin límite de repeticiones.
- Ni el `AGENTS.md`/`SOUL.md` de JARVIS ni de Hue tienen ninguna regla de techo de tool calls.

Conclusión: lo que hacía falta no es un parámetro de configuración, es una **regla de comportamiento con enforcement duro** — se descartó resolverlo solo con una instrucción en el prompt (`AGENTS.md`) porque eso es una sugerencia al modelo, no una garantía; el mismo tipo de regla blanda (silencio de proceso) ya mostró zonas grises en la investigación de la sección 7. Se optó por el sistema de **plugin hooks** de OpenClaw, que corre in-process y no depende de que el modelo coopere.

### Arquitectura de hooks — qué hook sirve para qué

Investigado y confirmado empíricamente contra el gateway real (no solo lectura de docs):

- **`before_tool_call`**: dispara antes de cada tool call individual. Único hook con esa granularidad — confirmado que `before_agent_run` dispara **una sola vez al inicio del run**, no se re-dispara entre rondas de inferencia posteriores (verificado con un plugin de prueba logueando timestamps: en un run de 5 rondas de inferencia encadenadas, `before_agent_run` disparó una vez, con gaps de 1.9–2.5s entre rondas donde el hook no se enteró de nada). Esto descartó de entrada un diseño de un solo hook a nivel de ronda.
- **`api.runContext`**: estado in-process scoped al run (`setRunContext`/`getRunContext`/`clearRunContext`), se limpia automáticamente al terminar el run. Es la pieza usada para contar tool calls sin depender de leer session files.
- **`before_tool_call` con `{ block: true }`**: bloquea una tool call individual de forma terminal, sin latencia (síncrono, in-process, antes de que la tool llegue al runtime). No mata el loop por sí solo — el modelo recibe "bloqueada" y puede intentar otra cosa.
- **`before_agent_reply`**: se evaluó como mecanismo para inyectar una pregunta sintética de pausa, pero **no dispara en runs interactivos, solo en cron** (confirmado en implementación real, no solo en pruebas aisladas). Esto tumbó el diseño original de "antes_tool_call bloquea + before_agent_reply pregunta" tal como se había planeado.

### Diseño final implementado

1. **Contador por run**: `api.runContext` incrementado en cada `before_tool_call`.
2. **Límite: 10 tool calls por run.** Elegido con margen sobre el comportamiento normal observado (sesiones legítimas de 4–5 tool calls) pero bastante antes del caso problemático real (16).
3. **Bloqueo de la tool call 11** con `{ block: true }`. Confirmado con evidencia real que esto es el corte efectivo: `before_agent_reply` no aplicó (ver arriba), pero el bloqueo repetido en `before_tool_call` es incondicional y sincrónico — no existe ningún path donde el modelo ejecute una tool call adicional mientras el `runId` siga vivo. Guard `if (pausedRuns.has(runId)) return` evita que reintentos del modelo (probando tools distintas tras cada bloqueo) dupliquen el estado de pausa.
4. **El LLM, no el plugin, escribe el mensaje de pausa.** Dado que `before_agent_reply` no aplica, el mensaje que le pregunta a Diego si continuar o resumir lo escribe el propio modelo al recibir la tool bloqueada — no es una respuesta sintética inyectada por sistema. Confirmado empíricamente que el corte de gasto **no depende de esto**: si el modelo no escribe texto claro (o genera texto vacío), el bloqueo se mantiene igual, `checkRunLimiterPause` se dispara incondicionalmente en `state: 'final'` sin importar si hubo `deltaText`, y el RPC sigue siendo la fuente de verdad. La única consecuencia de que el modelo no coopere es una UX rara (silencio en el chat + notificación sin contexto visible), nunca una falla en el corte de gasto.
5. **Detección del lado del PWA — nunca por texto.** Se evaluaron tres opciones para que el PWA sepa que un mensaje es "la pausa" sin parsear el contenido: (a) RPC estructurado (`api.registerGatewayMethod`), (b) header JSON embebido en el texto, (c) combinación de ambas. Se descartó (b) explícitamente por decisión de diseño — un contrato máquina-a-máquina embebido en el mismo campo que lee el humano es acoplamiento evitable, y el patrón de RPC custom ya existe en producción en otros plugins del proyecto (`googlemeet.status`, `memory-wiki.status`). Implementado: `run-limiter.status(sessionKey)` devuelve `{ paused, runId?, expiresAt? }` consultando estado en memoria. El PWA llama a este RPC en cada `chat` event con `state: 'final'`; si `paused: true`, dispara `Notification.requestPermission()` (si no se pidió antes) + `new Notification(...)`. Elegido notificación de navegador (no solo modal in-chat) porque el caso real que preocupa es enterarse aunque la pestaña esté en otro workspace — suficiente con la Notification API simple, sin necesidad de Service Worker + Push API, dado el uso real (Omarchy/Hyprland, navegador siempre corriendo en algún workspace, nunca cerrado del todo).
6. **Timeout de 5 minutos sobre el estado de pausa**, no sobre el run. Verificado de punta a punta con timestamps reales sobre el mismo `runId` (no como prueba aislada): bloqueo → `agent_end` (el run murió solo, 2.858s después del bloqueo) → 5 minutos de silencio → timeout limpia `pausedRuns` en el milisegundo exacto de `expiresAt` → RPC vuelve a `paused: false`.

### Hueco conocido, documentado con honestidad

**El timeout limpia estado de UI, no corta gasto activo — son dos cosas distintas y el mecanismo las separa correctamente, pero vale la pena no confundirlas.** El corte de gasto real ya ocurrió en el bloqueo de `before_tool_call` (sincrónico, incondicional, confirmado); el timeout solo evita que la señal de "hay una pausa pendiente" quede eternamente activa si nadie responde.

El hueco real, identificado explícitamente: si el modelo entrara en un loop de reintentos con tools distintas (todas bloqueadas) que durara más de 5 minutos, el timeout limpiaría `pausedRuns` mientras el run sigue técnicamente vivo (bloqueado, no gastando, pero sin que el PWA lo sepa vía el RPC). El bloqueo de tool calls seguiría activo igual (`toolCallCounts` persiste hasta `agent_end`, independiente de `pausedRuns`), así que **no hay pérdida de protección de gasto**, solo pérdida de la señal de notificación. En la práctica esto no se observó — los modelos probados siempre desistieron con texto en menos de dos bloqueos consecutivos — pero el mecanismo no tiene defensa programática contra ese caso teórico. Queda anotado como mejora futura si alguna vez se vuelve real: límite de reintentos bloqueados, o mensaje sintético de fallback en `agent_end` si `pausedRuns` tiene la entrada pero no se produjo texto.

**Otro límite de diseño, intencional y no un bug**: el contador es por `runId`, no acumulado por sesión. Si el timeout vence (o Diego responde) y arranca un run nuevo, el contador vuelve a cero. Es el comportamiento buscado — un freno por tramo de trabajo, no un techo acumulado de toda la sesión — pero significa que el mecanismo no protege contra el patrón de reiniciar runs repetidamente en sucesión.

### Precedente para el resto de la Suite

Si el mismo patrón ("¿esto puede entrar en una racha larga sin freno?") aparece en Huginn o en Ygg — por ejemplo si algún agente de esos proyectos también hace tool calls encadenadas — este es el mecanismo de referencia a replicar: contador vía `runContext` en `before_tool_call`, bloqueo incondicional al límite, RPC estructurado para la señal (nunca parseo de texto), notificación de navegador para el aviso fuera de la pestaña activa.

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
- [x] ~~Control de nivel de thinking en StatusBar~~ → completado, ver sección 7 (mecanismo real: sessions.patch, requiere client.mode "ui" y scope operator.admin)
- [x] ~~Resolver `tts.speak` no disponible en el gateway instalado (2026.6.2)~~ → resuelto, se adopta `tts.convert` + endpoint de media con proxy, ver sección 7
- [x] ~~Investigar consumo excesivo de tokens en el PWA (30x vs terminal, luego 12.7x residual)~~ → resuelto en dos partes: bug real de `role: "toolResult"` sin filtrar (contenido crudo de herramientas inflando el historial reenviado) + bug de métrica del StatusBar (acumulado histórico mostrado como costo puntual). El residual de 12.7x no era un bug, era estado de cache del provider (frío vs cálido), confirmado con experimento de matriz canal×cache. Ver sección 7, capítulo final
- [ ] Manejar sesiones "ocupadas" en la UI — detectado en pruebas de Fase 6: si la primera sesión del listado corresponde a la consola TUI y está en uso, `chat.send` desde el PWA queda encolado sin respuesta (no es un bug, la sesión está legítimamente ocupada por otro cliente). Falta indicar esto visualmente o deshabilitar sesiones ocupadas en `SessionList`
- [ ] Definir proxy de producción para `/__openclaw__/*` — en dev ya lo resuelve `vite.config.ts`, en producción hace falta un reverse proxy equivalente (ver hallazgo de CORS en sección 7)

---

## 12. Fuera de alcance en esta fase (explícito)

- Input por voz / micrófono
- Clonación de voz (ElevenLabs u otro)
- Notificaciones push
- Aprobaciones de exec desde el PWA (decisión consciente, ver sección 10 — la consola TUI cubre este caso en paralelo)
- Gateway en la nube (fase lejana, sin fecha)
