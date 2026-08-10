// Status bar: active agent, sessionKey and token usage. Thin, quiet, always at the bottom.

import type { ConnectionState } from '../protocol/client.ts'

interface StatusBarProps {
  connectionState: ConnectionState
  agent: string
  sessionKey: string
  tokens?: string // e.g. "12.4k tok"
  onOpenAgents?: () => void
}

const LABELS: Record<string, string> = {
  connected: 'CONECTADO',
  connecting: 'CONECTANDO…',
  reconnecting: 'RECONECTANDO…',
  disconnected: 'DESCONECTADO',
  pairing_required: 'APROBAR DISPOSITIVO',
}

export default function StatusBar({ connectionState, agent, sessionKey, tokens, onOpenAgents }: StatusBarProps) {
  const connClass =
    connectionState === 'connected' ? 'text-amber'
    : connectionState === 'pairing_required' ? 'text-amber-hi'
    : 'text-dim'

  const sk = sessionKey.length > 14 ? `${sessionKey.slice(0, 7)}…${sessionKey.slice(-4)}` : sessionKey

  return (
    <footer className="flex items-center gap-[18px] border-t border-line bg-panel-2 px-4 py-1.5 font-mono text-[11px] text-dim">
      <span className={connClass}>● {LABELS[connectionState] ?? connectionState}</span>
      <span className="text-faint">◢</span>
      <span>
        agent:<span className="text-amber">{agent}</span>
      </span>
      <span className="text-faint">◢</span>
      <span title={sessionKey}>{sk}</span>
      {tokens && <span className="ml-auto">{tokens}</span>}
      {onOpenAgents && (
        <button onClick={onOpenAgents} className={`cursor-pointer font-mono text-[11px] text-dim hover:text-amber-hi ${tokens ? '' : 'ml-auto'}`}>
          ctrl+G agentes
        </button>
      )}
    </footer>
  )
}
