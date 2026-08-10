# OpenClaw — capa visual v2 (ámbar retrofuturista)

Identidad: terminal ámbar monocroma sobre negro cálido — un solo color, toda la
jerarquía por brillo/intensidad. Marco HUD angular (esquinas biseladas via
clip-path, corner brackets, etiquetas de riel), overlay sutil de vidrio/CRT.
Tipografía: IBM Plex Mono (se mantiene — carácter técnico correcto; una fuente
seven-segment mataría la legibilidad en lectura larga).

Texto de mensajes: #ecc06a sobre #060402 (~11:1). El ámbar pleno #ffb000 queda
reservado a titulares, acentos y estados activos, no a párrafos.

## Instalación

1. \`theme.css\` → \`src/\`, importar en \`main.tsx\` (incluye \`@import "tailwindcss"\`).
2. Fuente en \`index.html\`:
   \`<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">\`
3. Copiar los \`.tsx\` sobre \`src/components/\`. ChatView y Composer conservan la
   lógica actual intacta; solo cambia markup/clases.
4. Nuevo: \`AppFrame.tsx\` — envolvé el layout raíz con \`<AppFrame>\` para el marco
   HUD + overlay de vidrio (el overlay es pointer-events-none, no interfiere).

## Tokens

bg-bg / bg-panel / bg-panel-2 · border-line / border-line-hi · text-ink /
text-ink-soft / text-dim / text-faint · amber / amber-hi / amber-mid ·
utilidades: oc-blink, oc-bevel, oc-bevel-sm, oc-glow, oc-glass.

## Props (sin cambios de API respecto a v1)

- ModeToggle: { mode, onChange }
- StatusBar: { connectionState, agent, sessionKey, tokens?, onOpenAgents? }
- SessionList: { sessions, activeKey, onSelect, onNew }
- AgentSwitcher: { open, agents, activeName, onPick, onClose }
- ToolCard: { name, command?, state, result? }
- AsciiCanvas: { state?: 'reposo'|'procesando'|'hablando', audioLevel?: 0..1, speedMs? }
  — misma mecánica de estados/glitch que antes; solo cambió la paleta a brillo ámbar.
