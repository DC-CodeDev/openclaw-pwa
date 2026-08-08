// Text input: Enter sends, Shift+Enter inserts newline. Disabled while not connected.

import { useRef, useState } from 'react'
import type { ConnectionState } from '../protocol/client.ts'

interface ComposerProps {
  onSend: (text: string) => Promise<void>
  connectionState: ConnectionState
}

export default function Composer({ onSend, connectionState }: ComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = connectionState === 'connected' && !sending && text.trim().length > 0

  async function handleSend() {
    const trimmed = text.trim()
    if (!canSend || !trimmed) return
    setSending(true)
    setText('')
    try {
      await onSend(trimmed)
    } catch (err) {
      console.error('[Composer] send failed:', err)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const placeholder =
    connectionState === 'connected'
      ? 'Escribí un mensaje… (Enter para enviar, Shift+Enter para nueva línea)'
      : 'Conectando al gateway…'

  return (
    <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid #333' }}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={connectionState !== 'connected' || sending}
        placeholder={placeholder}
        rows={2}
        style={{
          flex: 1,
          fontFamily: 'monospace',
          fontSize: 14,
          resize: 'none',
          padding: '6px 8px',
          background: '#1a1a1a',
          color: '#eee',
          border: '1px solid #444',
          borderRadius: 4,
        }}
      />
      <button
        onClick={() => void handleSend()}
        disabled={!canSend}
        style={{
          padding: '6px 16px',
          fontFamily: 'monospace',
          cursor: canSend ? 'pointer' : 'default',
          opacity: canSend ? 1 : 0.4,
        }}
      >
        {sending ? '…' : 'Enviar'}
      </button>
    </div>
  )
}
