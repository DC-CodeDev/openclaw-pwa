# AGENTS.md — OpenClaw PWA

React 19 + Vite 6 + TypeScript (strict) + Zustand 5 + Tailwind v4 PWA that speaks **directly** to the
OpenClaw Gateway over WebSocket (Gateway Protocol v4). No REST, no proxy, no backend of its own —
the Gateway is the backend. UI is a retro-futurist amber terminal aesthetic (single amber hue,
hierarchy by brightness).

> **Read `DESIGN_DECISIONS.md` before touching protocol code.** It is the source of truth for
> protocol corrections discovered against the real server. `openclaw-pwa-frontend.md` is the
> *original* spec and contains errors that were later corrected (documented in DESIGN_DECISIONS §7) —
> never trust it over DESIGN_DECISIONS.md. Repo docs and all source comments/UI strings are in
> Spanish (rioplatense: "creá", "enviá", "elegí"); keep new UI strings and comments in Spanish.

## Commands

```bash
npm run dev        # vite dev server (needs .env — see below, app throws at import without it)
npm run build      # tsc -b && vite build — typecheck is part of build
npm run preview    # serve the built dist/
npx tsc -b         # typecheck only
node openclaw-handshake-probe.mjs  # disposable handshake probe; Node >= 20; gateway must be running
```

- **No test framework, no lint, no CI** are configured. Don't invent test/lint commands.
- `tsconfig.app.json` sets `noUnusedLocals`/`noUnusedParameters` — any unused import or variable
  **fails `npm run build`**.
- Imports must use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions`) — do not strip them.

## Environment (required, gitignored)

`.env` at repo root (mode 600, gitignored) provides exactly two vars, read via
`import.meta.env`:

- `GATEWAY_URL` — e.g. `ws://127.0.0.1:18789` (port confirmed in gateway config + systemd unit)
- `GATEWAY_TOKEN` — the gateway auth token (48 chars)

`vite.config.ts` sets `envPrefix: ['VITE_', 'GATEWAY_']` so both prefixes work.
`src/vite-env.d.ts` types them. **`gatewayInstance.ts` throws at module load if `GATEWAY_URL` is
missing** — no graceful fallback. Never commit the real `.env`; there is no `.env.example`.

The token also lives in `~/.openclaw/openclaw.json` → `gateway.auth.token` (the probe script reads
it from there). The browser never needs the raw token once paired: the server issues a
`deviceToken` (persisted in IndexedDB) that takes precedence on reconnects.

## Architecture & data flow

```
src/
├── protocol/     # Gateway Protocol v4 client
│   ├── client.ts           # GatewayClient: connect/handshake, req/res correlation, events,
│   │                       #   watchdog, reconnection per DESIGN_DECISIONS §8
│   ├── frames.ts           # frame types + GatewayError (carries server error code + details)
│   ├── handshake.ts        # challenge → v3 signing payload → connect frame → hello-ok
│   ├── device.ts           # Ed25519 keypair (WebCrypto) + IndexedDB persistence + signing
│   ├── methods.ts          # typed RPC helpers — one function per gateway method, no logic/state
│   └── gatewayInstance.ts  # module-level singleton; never `new GatewayClient()` elsewhere
├── store/        # Zustand stores (all plain sync state)
│   ├── session.ts          # connectionState, active sessionKey/agentId, sessions[], agents[]
│   ├── messages.ts         # transcript for active session + streaming via `chat` events
│   ├── tools.ts            # tool call records (two adapters, see below)
│   └── usage.ts            # STUB — token usage (sessions.usage) not yet wired
├── hooks/
│   ├── useGateway.ts       # the orchestrator: connection lifecycle + createNewSession/selectSession/send
│   ├── useStreaming.ts     # STUB (empty)
│   ├── useAudioPlayback.ts # STUB — decode audioBase64 → AudioContext → audioLevel
│   └── useSessionAudioState.ts # STUB — FIFO TTS fragment queue → AsciiCanvas state machine
└── components/
    ├── AppFrame.tsx        # HUD frame (corner brackets, glass/CRT overlay)
    ├── ChatView.tsx        # the real app: sidebar + header + message list + Composer + Ctrl+G
    ├── Composer.tsx        # text input (Enter sends, Shift+Enter newline)
    ├── SessionList.tsx     # sessions sidebar
    ├── AgentSwitcher.tsx   # Ctrl+G overlay
    ├── ToolCard.tsx        # tool call card (collapsed by default)
    └── (StatusBar, TextChatPanel, ModeToggle, AsciiCanvas — NOT imported anywhere; audio-mode scaffolding, see "Phase status")
```

**Data flow:** component → `useGateway()` hook → `methods.ts` helpers → `gatewayClient.call()`
→ WebSocket → gateway. Server events flow back: `gatewayClient.on(...)` subscriptions registered
at **module-load side-effect** in the store files (messages.ts, tools.ts, session.ts) mutate
Zustand stores; React components subscribe to stores directly. There is no event bus beyond this.

**Key rule:** `createNewSession` / `selectSession` / `send` live in `useGateway.ts`, not in the
stores — they coordinate two stores plus async protocol calls. Stores stay synchronous.

## Protocol gotchas (all confirmed against the real server — do not "fix" these)

- `chat.send` param is **`message`**, not `content`. `sessions.create` returns **`key`**, not
  `sessionKey`. `sessions.messages.subscribe` takes **`key`** (and optional `agentId`), not
  `sessionKey`. **`sessions.usage` also takes `key`** (confirmed 2026-08-08 — `sessionKey` is
  rejected with INVALID_REQUEST). `sessions.create` returns `{ ok, key, sessionId,
  entry: { sessionId, sessionFile, updatedAt }, runStarted }` — `updatedAt` is nested in `entry`
  and flattened onto `Session.updatedAt` by methods.ts.
- **`sessions.list` items have NO `startedAt`** (confirmed 2026-08-08) — only `updatedAt` (epoch
  ms). Use `updatedAt` for any "session date/time" display. The status bar shows the active
  session's last-activity time from it. `sessions.usage` returns per-session totals at
  `sessions[0].usage.totalTokens` (may be `null`), aggregate at `totals.totalTokens` — the status
  bar counter uses `sessions[0].usage.totalTokens`.
- **`sessions.create` rejects `idempotencyKey`** (strict schema) — side-effect methods like
  `chat.send` need one (`crypto.randomUUID()`), `sessions.create` must NOT send it.
- Streaming arrives via **`chat` events** (`deltaText` at top level, `runId` = message id,
  `state: 'streaming'` → `'final'`/`'aborted'`/`'error'`, `replace: true` = non-prefix replace).
  `session.message` events carry **no streaming content** — they only notify transcript changes.
- `client.id`/`client.mode` are **closed enums**. Valid pair: `webchat`/`webchat` (used in
  handshake.ts). The old spec's `"mode": "operator"` fails validation (`operator` is a role, not a mode).
- `sessions.list` only includes `derivedTitle`/`lastMessagePreview` if you pass
  `includeDerivedTitles: true` / `includeLastMessage: true`. **Never parse a session `key` for
  display** — its grammar is `agent:<agentId>:<routing-path>` where the tail is an opaque routing
  marker (`dashboard:<uuid>`, `telegram:direct:<peerId>`, ...). Use `derivedTitle` (server-resolved).
- Message `content` is **`string | ContentBlock[]`**. Extended-thinking sessions produce arrays of
  `{type: "thinking"|"text"|"tool_use"|"tool_result"}` blocks. `extractText()` in useGateway.ts /
  tools.ts filters to `text` blocks only; `thinking`/`tool_use`/`tool_result` are dropped from
  display. A crash ("Objects are not valid as a React child") from rendering these raw is how this
  was discovered — the ErrorBoundary in App.tsx is the safety net, not the fix.
- `chat.history`, `sessions.list`, `agents.list` responses may be a plain array **or** wrapped
  (`{messages:[...]}`, `{sessions:[...]}`, `{agents:[...]}`) — methods.ts normalizes both; keep that.
- Tool calls have **two lifecycle stages with two adapters** (store/tools.ts):
  - *Live*: `session.tool` events (phase `start`→`update`→`result`, keyed by `toolCallId`,
    stream field must be `"tool"`). **Ephemeral** — lost forever if you weren't subscribed.
  - *Durable*: `tool_use`/`tool_result` content blocks in `chat.history`, settled by
    `extractToolRecordsFromHistory()`. `setSessionRecords()` **replaces** all live state.
  - Some agents (e.g. J.A.R.V.I.S.) **never emit `session.tool`** — that's expected, not a bug.
    A fallback adapter triggers on `chat` `state === 'final'`: it waits **1.5s** (transcript write
    delay) then reloads `chat.history` and replaces messages + tool records. The 1.5s is deliberate.
  - Tolerate field-name variants when parsing blocks: type `tool_use|toolCall|tool_call|tooluse`,
    id `id|call_id|toolCallId|toolUseId|tool_call_id|tool_use_id`, args `input|arguments|args`
    (see `isToolUseType`/`getToolUseId`/`getToolArgs`).
  - Tool status derivation (matches Control UI): `phase !== 'result'` → running; `isError` or
    result `is_error`/status `/error|fail/i` or finite `exitCode !== 0` → error; else done.
  - `session.tool` args are **sanitized server-side** (secrets redacted) — don't expect full detail.
- TTS (`ttsSpeak` in methods.ts): the PWA calls `tts.speak` on demand — `messages.tts.auto` is
  globally `off` by design (see DESIGN_DECISIONS §3). The Azure key never reaches the browser.

## Handshake & reconnection (protocol/client.ts, handshake.ts, device.ts)

- Handshake: server sends `connect.challenge` → client builds **v3 signing payload** with exact
  field order `v3|<deviceId>|<clientId>|<clientMode>|<role>|<scopes.join(",")>|<signedAtMs>|<token>|<nonce>|<platform>|<deviceFamily>`
  (all lowercase fields, `|`-joined; `deviceFamily` is `''` for web) → Ed25519 sign → send
  `connect` frame. **The token used in `auth.token` must also appear in the payload.**
- Device identity: `deviceId = sha256(raw public key bytes)` hex; `publicKey`/`signature` are
  base64url. Keypair generated once, persisted as JWK in IndexedDB (`openclaw-pwa` DB, `device`
  store, keys `privateKeyJwk`/`publicKeyJwk`/`deviceToken`), cached at module level. **Losing the
  keypair = re-pairing** (loopback `127.0.0.1` auto-approves; remote needs `openclaw devices approve`).
- Keepalive is **passive**: server sends WS control `ping` every 25s, browser auto-pongs. There is
  **no client ping RPC**; don't use `health` for that (heavy). `tickIntervalMs` from hello-ok
  policy drives a client-side watchdog: no frames for 60s → close `4000` and reconnect.
- Reconnect rules (do not change casually):
  - `PAIRING_REQUIRED` (error code or close `1008`) → **never retry in a loop**; each attempt
    creates a new pairing request and risks approving the wrong one. Set `pairing_required` state,
    show "APROBAR DISPOSITIVO — openclaw devices approve", wait for manual action.
  - `AUTH_DEVICE_TOKEN_MISMATCH`/`AUTH_TOKEN_MISMATCH` → `clearDeviceToken()` + one-shot 250ms
    fast retry (budget: `usedFastRetry`), then standard backoff.
  - `UNAVAILABLE` → honor `details.retryAfterMs` if present, else backoff.
  - Backoff: 1s → 2s → 4s → … cap 30s. RPC timeout 30s.
  - `visibilitychange` → on return to visible, reconnect immediately if not connected (browser
    freezes background tabs and silently kills the WS with close 1006).

## Conventions & patterns

- **Spanish** UI strings and comments (rioplatense). Commit messages in Spanish, prefixed style
  (`feat(fase-2): …`, `chore: …`). Do NOT commit unless explicitly asked.
- **Singleton**: always import `gatewayClient` from `protocol/gatewayInstance.ts`; never
  instantiate `GatewayClient` elsewhere.
- **Store event wiring at module import** (top-level `gatewayClient.on(...)` in session.ts,
  messages.ts, tools.ts). Unsubscribe intentionally omitted — lifetime = app lifetime.
- **Circular imports** between session.ts ↔ messages.ts ↔ tools.ts are intentional and safe: stores
  reference each other only inside function bodies, never at module init (ES live bindings).
- All protocol calls go through `methods.ts` helpers — don't write raw method-name strings in
  components/hooks.
- Zustand usage: selectors `useStore((s) => s.field)`; cross-store reads via
  `useSessionStore.getState()` (avoids stale closures — see `send()` in useGateway.ts).
- Streaming messages are keyed by `runId`; tool records link to messages via `runId`.
- UI styling: Tailwind v4 CSS-first config in `src/theme.css` (`@theme` tokens `bg`/`panel`/
  `line`/`ink`/`dim`/`faint`/`amber*`; custom utilities `oc-blink`, `oc-bevel`, `oc-bevel-sm`,
  `oc-glow`, `oc-glass`). No `tailwind.config.js`. Font: IBM Plex Mono loaded from Google Fonts
  in index.html (network dependency at runtime).

## Phase status — known stubs & dead scaffolding

Wired and working end-to-end: handshake/pairing/reconnect, session list + create/select, agent
switcher (Ctrl+G), chat streaming, tool cards (durable adapter path confirmed with real agent).

**Not implemented (do not assume they work):** `useStreaming.ts`, `useAudioPlayback.ts`,
`useSessionAudioState.ts` (all empty/stub returns), `store/usage.ts` (empty store). Components
`ModeToggle.tsx`, `AsciiCanvas.tsx`, `TextChatPanel.tsx`, `StatusBar.tsx` are **imported nowhere** —
audio-mode scaffolding from the design phase. The audio path (`tts.speak` → decode → AnalyserNode
→ `audioLevel` → AsciiCanvas states REPOSO/PROCESANDO/HABLANDO) is specified in DESIGN_DECISIONS
§4–6 but not built. There is also **no service worker/manifest** (`vite-plugin-pwa` not in
dependencies) — "PWA" is aspirational.

## References

- `DESIGN_DECISIONS.md` — closed design decisions + real-server protocol corrections (§7 is the
  protocol correction log; §8 reconnection; §3 TTS/Azure; §4–6 audio mode).
- `openclaw-pwa-frontend.md` — original spec (contains known errors; cross-check against DESIGN_DECISIONS).
- `OpenClaw Terminal Design/handoff/README.md` — visual design tokens/utilities reference.
- `openclaw-handshake-probe.mjs` — disposable Node probe (reference implementation for handshake
  + signing; `probe`/`openclaw-probe` are the client id/mode it uses, distinct from the PWA's
  `webchat`/`webchat`).
