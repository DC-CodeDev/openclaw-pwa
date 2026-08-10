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
      ? 'escribí un mensaje… (enter envía, shift+enter nueva línea)'
      : 'conectando al gateway…'

  return (
    <div className="flex items-end gap-3 border-t border-line px-5 py-3">
      <span className="oc-glow pb-2 font-semibold text-amber">❯</span>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={connectionState !== 'connected' || sending}
        placeholder={placeholder}
        rows={2}
        className="flex-1 resize-none bg-transparent py-2 font-mono text-sm leading-normal text-ink caret-amber outline-none placeholder:text-faint disabled:opacity-50"
      />
      <button
        onClick={() => void handleSend()}
        disabled={!canSend}
        className={`oc-bevel mb-1 flex-none border border-amber px-4 py-2 font-mono text-[11px] tracking-widest transition-colors ${
          canSend
            ? 'cursor-pointer bg-amber text-bg hover:bg-amber-hi'
            : 'bg-transparent text-faint'
        }`}
      >
        {sending ? '…' : 'ENVIAR ↵'}
      </button>
    </div>
  )
}
