// Mode toggle: switches between Text mode (ChatView) and Audio mode (AsciiCanvas).
// Lee/escribe uiMode en el store de sesión — ambos modos comparten el mismo store,
// cambiar de modo nunca resetea nada (sección 2, DESIGN_DECISIONS.md).

import { useSessionStore, type UiMode } from '../store/session.ts'

export default function ModeToggle() {
  const mode = useSessionStore((s) => s.uiMode)
  const setMode = useSessionStore((s) => s.setUiMode)

  const cell = (m: UiMode, extra = '') =>
    `${extra} cursor-pointer px-4 py-[5px] font-mono text-[11px] tracking-widest transition-colors ${
      mode === m ? 'bg-amber text-bg' : 'bg-transparent text-dim hover:text-ink'
    }`

  return (
    <div className="oc-bevel-sm flex border border-line-hi" role="tablist" aria-label="Modo de interacción">
      <button role="tab" aria-selected={mode === 'texto'} className={cell('texto')} onClick={() => setMode('texto')}>
        TXT
      </button>
      <button role="tab" aria-selected={mode === 'audio'} className={cell('audio', 'border-l border-line-hi')} onClick={() => setMode('audio')}>
        AUD
      </button>
    </div>
  )
}
