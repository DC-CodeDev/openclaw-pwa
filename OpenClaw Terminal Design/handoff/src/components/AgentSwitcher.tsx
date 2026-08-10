// Agent switcher (Ctrl+G): lists agents via agents.list, switches active agent.

import { useEffect } from 'react'

export interface AgentItem {
  name: string
  desc: string
}

interface AgentSwitcherProps {
  open: boolean
  agents: AgentItem[]
  activeName: string
  onPick: (name: string) => void
  onClose: () => void
}

export default function AgentSwitcher({ open, agents, activeName, onPick, onClose }: AgentSwitcherProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bg/85 pt-[14vh] font-mono"
      onClick={onClose}
    >
      <div
        className="w-[420px] border border-amber bg-panel [clip-path:polygon(12px_0,100%_0,100%_calc(100%-12px),calc(100%-12px)_100%,0_100%,0_12px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <span className="text-[11px] tracking-[2px] text-dim">◢ AGENTES</span>
          <span className="text-[10px] text-faint">esc para cerrar</span>
        </div>
        {agents.map((a) => (
          <button
            key={a.name}
            onClick={() => { onPick(a.name); onClose() }}
            className={`flex w-full cursor-pointer items-baseline gap-2.5 px-4 py-2.5 text-left hover:bg-[#160e06] ${
              a.name === activeName ? 'bg-[#140d05]' : ''
            }`}
          >
            <span className="text-amber">{a.name === activeName ? '▸' : '\u00a0'}</span>
            <span className="text-[13px] text-ink">{a.name}</span>
            <span className="ml-auto text-[11px] text-dim">{a.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
