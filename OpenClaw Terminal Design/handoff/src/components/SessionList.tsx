// Session list sidebar: sessions from sessions.list, switch active, create new.

export interface SessionItem {
  key: string
  name: string
  time: string // display-ready, e.g. "14:02" / "ayer"
}

interface SessionListProps {
  sessions: SessionItem[]
  activeKey: string | null
  onSelect: (key: string) => void
  onNew: () => void
}

export default function SessionList({ sessions, activeKey, onSelect, onNew }: SessionListProps) {
  return (
    <aside className="flex w-56 flex-none flex-col border-r border-line bg-panel-2 font-mono">
      <div className="flex items-center justify-between px-3.5 pt-3 pb-2.5">
        <span className="text-[11px] tracking-[2px] text-dim">◢ SESIONES</span>
        <button
          onClick={onNew}
          className="oc-bevel-sm cursor-pointer border border-line-hi px-2 py-0.5 text-[11px] text-amber hover:bg-[#1a1106] hover:text-amber-hi"
        >
          + nueva
        </button>
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto">
        {sessions.map((s) => {
          const active = s.key === activeKey
          return (
            <button
              key={s.key}
              onClick={() => onSelect(s.key)}
              className={`flex cursor-pointer items-baseline gap-2 border-l-2 py-[7px] pr-3.5 pl-2.5 text-left hover:bg-[#140d05] ${
                active ? 'border-amber bg-[#140d05]' : 'border-transparent'
              }`}
            >
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'text-ink' : 'text-dim'}`}>
                {s.name}
              </span>
              <span className="flex-none text-[10px] text-faint">{s.time}</span>
            </button>
          )
        })}
      </div>
      {/* medidor LED decorativo */}
      <div className="flex items-center gap-1 border-t border-line px-3.5 py-2.5">
        <span className="h-[5px] w-2.5 bg-amber" />
        <span className="h-[5px] w-2.5 bg-amber" />
        <span className="h-[5px] w-2.5 bg-amber-mid" />
        <span className="h-[5px] w-2.5 bg-line-hi" />
        <span className="h-[5px] w-2.5 border border-line" />
        <span className="h-[5px] w-2.5 border border-line" />
        <span className="ml-auto text-[10px] text-faint">v0.5.0</span>
      </div>
    </aside>
  )
}
