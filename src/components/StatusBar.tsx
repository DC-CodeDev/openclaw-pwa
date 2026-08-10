// Status bar: active agent, sessionKey, token usage y control de thinking de la sesión activa.
// El control de thinking lee el override actual (session.thinkingLevel) y permite cambiarlo vía
// sessions.patch. Alerta visual (punto + ámbar pleno) cuando hay override distinto del default
// del modelo — evita el caso real de un Think:high pegado sin que el usuario se dé cuenta.

import { useEffect, useRef, useState } from 'react'
import type { ConnectionState } from '../protocol/client.ts'

const TOOL_LIMIT_OPTIONS = [10, 15, 20, 30, 40, 50]

export interface ThinkingInfo {
  level: string | null // override activo (null = sin override)
  def: string | null   // thinkingDefault del modelo
  options: string[]    // niveles válidos del gateway
}

interface StatusBarProps {
  connectionState: ConnectionState
  agent: string
  sessionKey: string
  tokens?: string // e.g. "12.4k tok"
  sessionTime?: string // display-ready, e.g. "hoy 14:02" — last activity of the active session
  thinking?: ThinkingInfo
  onThinkingChange?: (level: string | null) => Promise<void>
  onToolCallLimitChange?: (limit: number) => Promise<void>
  onOpenAgents?: () => void
}

const LABELS: Record<string, string> = {
  connected: 'CONECTADO',
  connecting: 'CONECTANDO…',
  reconnecting: 'RECONECTANDO…',
  disconnected: 'DESCONECTADO',
  pairing_required: 'APROBAR DISPOSITIVO',
}

// Fallback si la sesión no trae thinkingOptions/thinkingLevels (valores confirmados del gateway).
const FALLBACK_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export default function StatusBar({ connectionState, agent, sessionKey, tokens, sessionTime, thinking, onThinkingChange, onToolCallLimitChange, onOpenAgents }: StatusBarProps) {
  const connClass =
    connectionState === 'connected' ? 'text-amber'
    : connectionState === 'pairing_required' ? 'text-amber-hi'
    : 'text-dim'

  const sk = sessionKey.length > 14 ? `${sessionKey.slice(0, 7)}…${sessionKey.slice(-4)}` : sessionKey
  const rightAligned = tokens || sessionTime

  // ─── Thinking control ──────────────────────────────────────────────────────
  const overrideLevel = thinking?.level ?? null
  const options = (thinking?.options && thinking.options.length > 0 ? thinking.options : FALLBACK_LEVELS)
  // override activo y distinto del default del modelo → alerta
  const overridden = thinking != null && overrideLevel != null && overrideLevel !== thinking.def

  const [draft, setDraft] = useState<string | null>(overrideLevel)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    setDraft(overrideLevel)
    setFailed(false)
  }, [overrideLevel])

  // Cerrar el dropdown con click afuera o Escape.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false)
        return
      }
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
    }
  }, [open])

  const showThinking = thinking != null && sessionKey !== '' && onThinkingChange != null

  // ─── Tool call limit control ───────────────────────────────────────────────
  // Estado estrictamente local: arranca en 10 en cada carga del PWA, nunca persistido.
  // El plugin conserva el último valor recibido — recargar la página no lo resetea.
  const [toolLimit, setToolLimit] = useState(10)
  const [toolLimitSaving, setToolLimitSaving] = useState(false)
  const [toolLimitFailed, setToolLimitFailed] = useState(false)
  const [toolLimitOpen, setToolLimitOpen] = useState(false)
  const toolLimitRef = useRef<HTMLSpanElement>(null)
  const toolLimitElevated = toolLimit > 10
  const showToolLimit = sessionKey !== '' && onToolCallLimitChange != null

  useEffect(() => {
    if (!toolLimitOpen) return
    const onDoc = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setToolLimitOpen(false)
        return
      }
      if (toolLimitRef.current && !toolLimitRef.current.contains(e.target as Node)) setToolLimitOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onDoc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onDoc)
    }
  }, [toolLimitOpen])

  async function handleToolLimitSelect(value: number) {
    setToolLimit(value)
    setToolLimitSaving(true)
    setToolLimitFailed(false)
    try {
      await onToolCallLimitChange!(value)
    } catch (err) {
      console.error('[tool-limit] no se pudo cambiar el límite:', err)
      setToolLimitFailed(true)
    } finally {
      setToolLimitSaving(false)
    }
  }

  async function handleSelect(value: string) {
    const next = value === 'default' ? null : value
    const previous = draft
    setDraft(next)
    setSaving(true)
    try {
      await onThinkingChange!(next)
    } catch (err) {
      console.error('[thinking] no se pudo cambiar el nivel:', err)
      setDraft(previous) // el padre no cambió → revertir visualmente
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line bg-panel-2 px-3 py-1.5 font-mono text-[11px] text-dim sm:gap-x-[18px] sm:px-4">
      <span className={connClass}>● {LABELS[connectionState] ?? connectionState}</span>
      <span className="text-faint">◢</span>
      <span>
        agent:<span className="text-amber">{agent}</span>
      </span>
      {showThinking && (
        <span
          className={`flex items-center gap-1.5 ${overridden ? 'text-amber-hi' : ''}`}
          title={
            failed
              ? 'no se pudo aplicar el cambio (¿scope operator.admin aprobado?)'
              : overridden
                ? `override de thinking activo: ${overrideLevel} (default: ${thinking.def ?? '—'})`
                : 'nivel de thinking de la sesión'
          }
        >
          {overridden && <span className="oc-blink inline-block size-[6px] bg-amber-hi shadow-[0_0_6px_rgb(255_150_0/0.7)]" />}
          <span className={overridden ? 'text-amber-hi' : 'text-faint'}>think:</span>
          <span ref={wrapRef} className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              disabled={saving}
              aria-haspopup="listbox"
              aria-expanded={open}
              className={`oc-bevel-sm flex cursor-pointer items-center gap-1.5 border px-2 py-[3px] font-mono text-[10px] tracking-widest transition-colors disabled:opacity-50 ${
                overridden ? 'border-amber-hi text-amber-hi' : 'border-line-hi text-amber hover:border-amber'
              }`}
            >
              {saving ? '…' : (draft ?? 'default').toUpperCase()}
              <span className={`text-[8px] ${overridden ? 'text-amber-hi' : 'text-faint'}`}>{open ? '▲' : '▼'}</span>
            </button>
            {open && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 z-50 mb-1 w-44 border border-amber bg-panel shadow-[0_4px_16px_rgb(0_0_0/0.55)] [clip-path:polygon(10px_0,100%_0,100%_calc(100%-10px),calc(100%-10px)_100%,0_100%,0_10px)]"
              >
                <div className="border-b border-line px-2.5 py-1 text-[9px] tracking-[2px] text-faint">◢ THINKING LEVEL</div>
                <button
                  type="button"
                  role="option"
                  aria-selected={draft == null}
                  onClick={() => { setOpen(false); void handleSelect('default') }}
                  className={`flex w-full cursor-pointer items-baseline gap-2 px-2.5 py-[5px] text-left text-[11px] tracking-widest hover:bg-[#160e06] ${draft == null ? 'bg-[#140d05]' : ''}`}
                >
                  <span className="w-3 flex-none text-amber">{draft == null ? '▸' : '\u00A0'}</span>
                  <span className={draft == null ? 'text-amber' : 'text-dim'}>DEFAULT</span>
                  <span className="ml-auto text-[9px] tracking-normal text-faint">({thinking?.def ?? '—'})</span>
                </button>
                {options.map((lvl, i) => (
                  <button
                    key={lvl}
                    type="button"
                    role="option"
                    aria-selected={draft === lvl}
                    onClick={() => { setOpen(false); void handleSelect(lvl) }}
                    className={`flex w-full cursor-pointer items-baseline gap-2 px-2.5 py-[5px] text-left text-[11px] tracking-widest hover:bg-[#160e06] ${
                      draft === lvl ? 'bg-[#140d05]' : ''
                    } ${i === 0 ? 'border-t border-line' : ''}`}
                  >
                    <span className="w-3 flex-none text-amber">{draft === lvl ? '▸' : '\u00A0'}</span>
                    <span className={draft === lvl ? 'text-amber' : 'text-dim'}>{lvl.toUpperCase()}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        </span>
      )}
      {showToolLimit && (
        <span
          className={`flex items-center gap-1.5 ${toolLimitElevated ? 'text-amber-hi' : ''}`}
          title={
            toolLimitFailed
              ? 'no se pudo aplicar el cambio'
              : toolLimitElevated
                ? `límite de tool calls elevado: ${toolLimit} (default: 10)`
                : 'tool calls máximos por run'
          }
        >
          {toolLimitElevated && <span className="oc-blink inline-block size-[6px] bg-amber-hi shadow-[0_0_6px_rgb(255_150_0/0.7)]" />}
          <span className={toolLimitElevated ? 'text-amber-hi' : 'text-faint'}>calls:</span>
          <span ref={toolLimitRef} className="relative">
            <button
              type="button"
              onClick={() => setToolLimitOpen((v) => !v)}
              disabled={toolLimitSaving}
              aria-haspopup="listbox"
              aria-expanded={toolLimitOpen}
              className={`oc-bevel-sm flex cursor-pointer items-center gap-1.5 border px-2 py-[3px] font-mono text-[10px] tracking-widest transition-colors disabled:opacity-50 ${
                toolLimitElevated ? 'border-amber-hi text-amber-hi' : 'border-line-hi text-amber hover:border-amber'
              }`}
            >
              {toolLimitSaving ? '…' : toolLimit}
              <span className={`text-[8px] ${toolLimitElevated ? 'text-amber-hi' : 'text-faint'}`}>{toolLimitOpen ? '▲' : '▼'}</span>
            </button>
            {toolLimitOpen && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 z-50 mb-1 w-36 border border-amber bg-panel shadow-[0_4px_16px_rgb(0_0_0/0.55)] [clip-path:polygon(10px_0,100%_0,100%_calc(100%-10px),calc(100%-10px)_100%,0_100%,0_10px)]"
              >
                <div className="border-b border-line px-2.5 py-1 text-[9px] tracking-[2px] text-faint">◢ CALLS / RUN</div>
                {TOOL_LIMIT_OPTIONS.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    role="option"
                    aria-selected={toolLimit === opt}
                    onClick={() => { setToolLimitOpen(false); void handleToolLimitSelect(opt) }}
                    className={`flex w-full cursor-pointer items-baseline gap-2 px-2.5 py-[5px] text-left text-[11px] tracking-widest hover:bg-[#160e06] ${
                      toolLimit === opt ? 'bg-[#140d05]' : ''
                    }`}
                  >
                    <span className="w-3 flex-none text-amber">{toolLimit === opt ? '▸' : ' '}</span>
                    <span className={toolLimit === opt ? 'text-amber' : 'text-dim'}>{opt}</span>
                    {opt === 10 && <span className="ml-auto text-[9px] tracking-normal text-faint">def</span>}
                  </button>
                ))}
              </div>
            )}
          </span>
        </span>
      )}
      <span className="hidden text-faint sm:inline">◢</span>
      <span className="hidden sm:inline" title={sessionKey}>{sk}</span>
      {tokens && <span className="sm:ml-auto">{tokens}</span>}
      {sessionTime && (
        <span title="última actividad de la sesión" className={rightAligned ? '' : 'sm:ml-auto'}>
          <span className="text-faint">◢</span> {sessionTime}
        </span>
      )}
      {onOpenAgents && (
        <button onClick={onOpenAgents} className={`hidden cursor-pointer font-mono text-[11px] text-dim hover:text-amber-hi sm:inline-block ${rightAligned ? '' : 'sm:ml-auto'}`}>
          ctrl+G agentes
        </button>
      )}
    </footer>
  )
}
