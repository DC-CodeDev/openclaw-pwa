// Mode toggle: switches between Text mode (ChatView) and Audio mode (AsciiCanvas).

export type UiMode = 'text' | 'audio'

interface ModeToggleProps {
  mode: UiMode
  onChange: (mode: UiMode) => void
}

export default function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const cell = (m: UiMode, extra = '') =>
    `${extra} cursor-pointer px-4 py-[5px] font-mono text-[11px] tracking-widest transition-colors ${
      mode === m ? 'bg-amber text-bg' : 'bg-transparent text-dim hover:text-ink'
    }`

  return (
    <div className="oc-bevel-sm flex border border-line-hi" role="tablist" aria-label="Modo de interacción">
      <button role="tab" aria-selected={mode === 'text'} className={cell('text')} onClick={() => onChange('text')}>
        TXT
      </button>
      <button role="tab" aria-selected={mode === 'audio'} className={cell('audio', 'border-l border-line-hi')} onClick={() => onChange('audio')}>
        AUD
      </button>
    </div>
  )
}
