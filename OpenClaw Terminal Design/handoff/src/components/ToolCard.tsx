// Tool card: renders live tool call invocations and results from session.tool stream events.

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
  return (
    <div className="max-w-[640px] border border-line bg-panel font-mono [clip-path:polygon(9px_0,100%_0,100%_calc(100%-9px),calc(100%-9px)_100%,0_100%,0_9px)]">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-1.5 text-[11px] tracking-[1.5px]">
        <span className="text-dim">◢ TOOL</span>
        <span className="text-amber">{name}</span>
        <span className={`ml-auto ${STATE_CLASS[state]}`}>
          ■ {state}
          {state === 'running' && <span className="oc-blink">▮</span>}
        </span>
      </div>
      {command && <div className="px-3 pt-2 text-[12.5px] text-dim">$ {command}</div>}
      {result && (
        <pre className="m-0 px-3 pt-1.5 pb-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
          {result}
        </pre>
      )}
    </div>
  )
}
