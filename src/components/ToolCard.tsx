// Tool card: renders live tool call invocations and results from session.tool stream events.
// Collapsed by default — click header to expand/collapse.

import { useState } from 'react'

export type ToolState = 'running' | 'done' | 'error'

interface ToolCardProps {
  name: string
  command?: string
  state: ToolState
  result?: string
}

const STATE_CLASS: Record<ToolState, string> = {
  running: 'text-amber-mid',
  done: 'text-amber',
  error: 'text-amber-hi',
}

export default function ToolCard({ name, command, state, result }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false)

  const truncated = command
    ? command.length > 72 ? command.slice(0, 72) + '…' : command
    : undefined

  return (
    <div className="max-w-[640px] border border-line bg-panel font-mono [clip-path:polygon(9px_0,100%_0,100%_calc(100%-9px),calc(100%-9px)_100%,0_100%,0_9px)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[11px] tracking-[1.5px] hover:bg-line/40 text-left"
      >
        <span className="text-dim">◢ TOOL</span>
        <span className="text-amber">{name}</span>
        {!expanded && truncated && (
          <span className="min-w-0 flex-1 truncate text-dim opacity-60 ml-1">
            {truncated}
          </span>
        )}
        <span className={`ml-auto flex-none ${STATE_CLASS[state]}`}>
          {state === 'running' && <span className="oc-blink">▮ </span>}
          ■ {state}
        </span>
        <span className="flex-none text-dim ml-1">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <>
          {command && (
            <div className="border-t border-line px-3 pt-2 text-[12.5px] text-dim">$ {command}</div>
          )}
          {result && (
            <pre className="m-0 px-3 pt-1.5 pb-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
              {result}
            </pre>
          )}
          {!command && !result && (
            <div className="border-t border-line px-3 py-2 text-[11px] text-faint">sin detalle</div>
          )}
        </>
      )}
    </div>
  )
}
