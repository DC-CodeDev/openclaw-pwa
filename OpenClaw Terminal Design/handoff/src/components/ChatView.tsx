// Chat container: connection banner, message list with streaming cursor, and Composer.

import { useEffect, useRef } from 'react'
import { useGateway } from '../hooks/useGateway.ts'
import Composer from './Composer.tsx'

const CONNECTION_LABELS: Record<string, string> = {
  disconnected: 'DESCONECTADO',
  connecting: 'CONECTANDO…',
  reconnecting: 'RECONECTANDO…',
  connected: 'CONECTADO',
  pairing_required: 'APROBAR DISPOSITIVO — openclaw devices approve',
}

const CONNECTION_COLORS: Record<string, string> = {
  connected: 'text-amber',
  pairing_required: 'text-amber-hi',
}

export default function ChatView() {
  const { connectionState, messages, send } = useGateway()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isConnected = connectionState === 'connected'

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg font-mono text-sm text-ink">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="oc-glow text-[15px] font-semibold tracking-[2px] text-amber">OPENCLAW</span>
          <span className="oc-blink inline-block h-4 w-[9px] bg-amber shadow-[0_0_8px_rgb(255_176_0/0.5)]" />
        </div>
        <span className="text-[10px] tracking-[2px] text-faint">◤ ENLACE GW</span>
        <span
          className={`ml-auto flex items-center gap-2 text-[11px] tracking-widest ${CONNECTION_COLORS[connectionState] ?? 'text-dim'}`}
        >
          <span className="inline-block size-[7px] bg-current shadow-[0_0_6px_rgb(255_176_0/0.4)]" />
          {CONNECTION_LABELS[connectionState] ?? connectionState}
        </span>
      </header>

      {/* Message list */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pt-5 pb-3">
        {messages.length === 0 && isConnected && (
          <span className="text-faint">Enviá un mensaje para empezar. █</span>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className="flex max-w-[860px] gap-3.5">
            <div
              className={`w-[88px] flex-none pt-px text-right text-xs ${
                msg.role === 'user' ? 'text-dim' : 'text-amber'
              }`}
            >
              {msg.role === 'user' ? 'vos ❯' : 'openclaw'}
            </div>
            <div className="min-w-0 flex-1">
              <span
                className={`leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user' ? 'text-ink-soft' : 'text-ink'
                }`}
              >
                {msg.text}
                {msg.isStreaming && (
                  <span className="oc-blink ml-0.5 inline-block h-3.5 w-2 -translate-y-px bg-amber align-middle shadow-[0_0_6px_rgb(255_176_0/0.5)]" />
                )}
              </span>
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <Composer onSend={send} connectionState={connectionState} />
    </div>
  )
}
