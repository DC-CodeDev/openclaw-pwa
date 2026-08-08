// Chat container: connection banner, message list with streaming cursor, and Composer.
// Minimal styling — functional scaffold only; visual design phase comes later.

import { useEffect, useRef } from 'react'
import { useGateway } from '../hooks/useGateway.ts'
import Composer from './Composer.tsx'

const CONNECTION_LABELS: Record<string, string> = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  reconnecting: 'Reconectando…',
  pairing_required:
    'Se requiere aprobar el dispositivo — ejecutá: openclaw devices approve',
}

export default function ChatView() {
  const { connectionState, messages, send } = useGateway()
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new message or new delta
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isConnected = connectionState === 'connected'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        fontFamily: 'monospace',
        fontSize: 14,
        background: '#111',
        color: '#ddd',
        padding: 16,
        boxSizing: 'border-box',
        gap: 8,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 16 }}>OpenClaw</strong>
        <span
          style={{
            fontSize: 12,
            color:
              connectionState === 'connected'
                ? '#4f4'
                : connectionState === 'pairing_required'
                  ? '#f44'
                  : '#fa0',
          }}
        >
          {CONNECTION_LABELS[connectionState] ?? connectionState}
        </span>
      </div>

      {/* Message list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {messages.length === 0 && isConnected && (
          <span style={{ color: '#555', fontStyle: 'italic' }}>
            Enviá un mensaje para empezar.
          </span>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            <span
              style={{
                color: msg.role === 'user' ? '#7af' : '#fa7',
                fontWeight: 'bold',
                marginRight: 6,
              }}
            >
              {msg.role === 'user' ? 'Vos:' : 'Agente:'}
            </span>
            <span style={{ opacity: msg.isStreaming ? 0.85 : 1, whiteSpace: 'pre-wrap' }}>
              {msg.text}
              {msg.isStreaming && (
                <span style={{ opacity: 0.6, animation: 'blink 1s step-end infinite' }}>
                  {' ▋'}
                </span>
              )}
            </span>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <Composer onSend={send} connectionState={connectionState} />
    </div>
  )
}
