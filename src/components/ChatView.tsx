// Chat container: SessionList sidebar + header + message list + Composer.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGateway } from '../hooks/useGateway.ts'
import { useSessionAudioState, stopAudioPlayback } from '../hooks/useSessionAudioState.ts'
import { useSessionStore } from '../store/session.ts'
import { useToolsStore } from '../store/tools.ts'
import { sessionsPatch, runLimiterSetLimit } from '../protocol/methods.ts'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import Composer from './Composer.tsx'
import SessionList from './SessionList.tsx'
import AgentSwitcher from './AgentSwitcher.tsx'
import ModeToggle from './ModeToggle.tsx'
import AsciiCanvas from './AsciiCanvas.tsx'
import ToolCard from './ToolCard.tsx'
import StatusBar from './StatusBar.tsx'
import WaitingIndicator from './WaitingIndicator.tsx'
import type { SessionItem } from './SessionList.tsx'
import type { AgentItem } from './AgentSwitcher.tsx'
import type { Session } from '../protocol/methods.ts'

// Extract a human-readable command hint from raw tool args, for ToolCard's `command` prop.
function formatArgs(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  if (typeof a.command === 'string') return a.command
  if (typeof a.cmd === 'string') return a.cmd
  if (typeof a.file_path === 'string') return a.file_path
  if (typeof a.path === 'string') return a.path
  if (typeof a.query === 'string') return `${name}: ${a.query}`
  const str = JSON.stringify(args)
  return str === '{}' ? undefined : str
}

const CONNECTION_LABELS: Record<string, string> = {
  disconnected: 'DESCONECTADO',
  connecting: 'CONECTANDO…',
  reconnecting: 'RECONECTANDO…',
  connected: 'CONECTADO',
  pairing_required: 'PAIRING REQUERIDO',
}

const CONNECTION_COLORS: Record<string, string> = {
  connected: 'text-amber',
  pairing_required: 'text-amber-hi',
}

function toSessionItem(s: Session): SessionItem {
  const name =
    s.derivedTitle ||
    (s.agentId && s.kind ? `${s.agentId} · ${s.kind}` : s.agentId ?? s.kind ?? '—')
  const time = s.updatedAt ? formatSessionTime(s.updatedAt) : ''
  return { key: s.key, name, time, running: s.status === 'running' }
}

function formatSessionTime(epochMs: number): string {
  const d = new Date(epochMs)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })
}

// Status bar label for the active session's last activity — more context than the sidebar time.
function formatStatusTime(epochMs: number): string {
  const d = new Date(epochMs)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const time = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `hoy ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `ayer ${time}`
  return `${d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' })} ${time}`
}

// e.g. 58000 → "58K/1M", 15891 → "15.9K/1M", 900 → "900/1M"
function formatContextTokens(n: number): string {
  if (n < 1000) return `${n}/1M`
  const k = n / 1000
  return `${(k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, ''))}K/1M`
}

export default function ChatView() {
  const {
    connectionState,
    sessionKey,
    sessions,
    agents,
    activeAgentId,
    agentDisplayName,
    messages,
    waitingForResponse,
    silenceWarning,
    contextEstimate,
    send,
    createNewSession,
    selectSession,
    setActiveAgent,
  } = useGateway()

  const pairingRequestId = useSessionStore((s) => s.pairingRequestId)
  const [copied, setCopied] = useState(false)
  const [clipboardFailed, setClipboardFailed] = useState(false)

  const toolRecords = useToolsStore((s) => s.records)

  // Infraestructura de audio (Fase 6): cola TTS + audioLevel real. Alimentada por el flujo real
  // de mensajes (store/messages.ts encola el texto del turno completado cuando uiMode === 'audio').
  const uiMode = useSessionStore((s) => s.uiMode)
  const audio = useSessionAudioState()

  const handleCopyApproveCommand = useCallback(() => {
    if (!pairingRequestId) return
    const cmd = `openclaw devices approve ${pairingRequestId}`
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true)
      setClipboardFailed(false)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      setClipboardFailed(true)
    })
  }, [pairingRequestId])

  const setToolCallLimit = useCallback(async (limit: number): Promise<void> => {
    await runLimiterSetLimit(gatewayClient, limit)
  }, [])

  // Override de thinking de la sesión activa (StatusBar). null limpia el override.
  // Lanza el error para que el StatusBar revierta el select y lo marque como fallido.
  const setThinking = useCallback(async (level: string | null): Promise<void> => {
    const activeKey = useSessionStore.getState().sessionKey
    if (!activeKey) return
    try {
      await sessionsPatch(gatewayClient, activeKey, { thinkingLevel: level })
      // Optimistic: reflejar el override en el store y reconciliar con el gateway.
      useSessionStore.setState((s) => ({
        sessions: s.sessions.map((row) =>
          row.key === activeKey ? { ...row, thinkingLevel: level ?? undefined } : row,
        ),
      }))
      useSessionStore.getState().loadSessions().catch(() => {})
    } catch (err) {
      console.error('[thinking] sessions.patch falló:', err)
      throw err
    }
  }, [])

  // Group tool records by runId for O(1) lookup when rendering after each message.
  const toolsByRunId = useMemo(() => {
    const map = new Map<string, typeof toolRecords>()
    for (const r of toolRecords) {
      if (!r.runId) continue
      const bucket = map.get(r.runId) ?? []
      bucket.push(r)
      map.set(r.runId, bucket)
    }
    return map
  }, [toolRecords])

  const bottomRef = useRef<HTMLDivElement>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Ctrl+G: toggle AgentSwitcher. Skip if focus is in a textarea (Composer).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'g') return
      if (document.activeElement?.tagName === 'TEXTAREA') return
      e.preventDefault()
      setSwitcherOpen((prev) => !prev)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Alt+X: cortar toda reproducción de audio en curso y vaciar la cola TTS pendiente.
  // Mismo guard que Ctrl+G: no interceptar combinaciones que el usuario podría querer
  // escribir en el textarea del Composer (p. ej. AltGr+X en layouts que lo usan).
  // No-op si no hay audio sonando ni fragmentos encolados (no hace nada visible).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key !== 'x') return
      if (document.activeElement?.tagName === 'TEXTAREA') return
      e.preventDefault()
      stopAudioPlayback()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const isConnected = connectionState === 'connected'
  const hasSession = !!sessionKey

  // Filter sessions by active agent. Sessions without agentId (server doesn't populate it in
  // sessions.list) are treated as "unknown owner" and always shown alongside matching ones.
  const filteredSessions = activeAgentId
    ? sessions.filter((s) => s.agentId == null || s.agentId === activeAgentId)
    : sessions
  const sessionItems: SessionItem[] = filteredSessions.map(toSessionItem)

  // Status bar data: active agent display name, token counter, and last-activity time.
  // sessions.list has no startedAt (confirmed real shape) — updatedAt is last activity.
  const activeSession = sessions.find((s) => s.key === sessionKey)
  const statusTime = activeSession?.updatedAt
    ? formatStatusTime(activeSession.updatedAt)
    : undefined

  // model may be a string or an object {primary: "..."} depending on the Gateway version.
  const agentItems: AgentItem[] = agents.map((a) => {
    let desc = ''
    if (typeof a.model === 'string') desc = a.model
    else if (a.model && typeof a.model === 'object') {
      const m = a.model as Record<string, unknown>
      desc = typeof m.primary === 'string' ? m.primary : ''
    }
    if (!desc && typeof a.description === 'string') desc = a.description
    return { id: a.id, name: typeof a.name === 'string' ? a.name : a.id, desc }
  })

  return (
    <div className="flex h-full min-w-0 flex-1 font-mono text-sm text-ink">
      {/* Sidebar */}
      <SessionList
        sessions={sessionItems}
        activeKey={sessionKey}
        onSelect={(key) => { void selectSession(key) }}
        onNew={() => { void createNewSession() }}
      />

      {/* Main content: messages + Composer + StatusBar stacked in a column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
        {/* Header */}
        <header className="flex items-center gap-4 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="oc-glow text-[15px] font-semibold tracking-[2px] text-amber">J.A.R.V.I.S</span>
            <span className="text-[9px] tracking-[1px] text-dim hidden sm:inline">Just A Rather Very Intelligent System</span>
            <span className="oc-blink inline-block h-4 w-[9px] bg-amber shadow-[0_0_8px_rgb(255_176_0/0.5)]" />
          </div>
          <span className="text-[10px] tracking-[2px] text-faint">◤ ENLACE GW</span>
          <ModeToggle />
          {/* Active agent badge */}
          {activeAgentId && (
            <button
              onClick={() => setSwitcherOpen(true)}
              className="cursor-pointer border border-line-hi px-2 py-0.5 text-[10px] text-amber tracking-widest hover:border-amber"
            >
              {activeAgentId.toUpperCase()}
            </button>
          )}
          {connectionState === 'pairing_required' ? (
            <div className="ml-auto flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={handleCopyApproveCommand}
                disabled={!pairingRequestId}
                className="oc-bevel-sm flex items-center gap-2 border border-amber-hi bg-[#1a0800] px-3 py-[5px] font-mono text-[11px] tracking-widest text-amber-hi transition-colors hover:bg-[#2a1000] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                title={pairingRequestId ? `openclaw devices approve ${pairingRequestId}` : 'Esperando requestId del gateway...'}
              >
                <span className="oc-blink inline-block size-[7px] bg-amber-hi shadow-[0_0_6px_rgb(255_150_0/0.7)]" />
                {copied ? 'COPIADO ✓' : 'COPIAR COMANDO'}
              </button>
              {clipboardFailed && pairingRequestId ? (
                <code className="select-all cursor-text rounded border border-amber-hi/30 bg-black/40 px-2 py-[3px] font-mono text-[9px] text-amber-hi/80 tracking-wide">
                  openclaw devices approve {pairingRequestId}
                </code>
              ) : pairingRequestId ? (
                <span className="text-[9px] text-amber-hi/50 font-mono tracking-wide">
                  approve {pairingRequestId.slice(0, 8)}…
                </span>
              ) : null}
            </div>
          ) : (
            <span
              className={`ml-auto flex items-center gap-2 text-[11px] tracking-widest ${CONNECTION_COLORS[connectionState] ?? 'text-dim'}`}
            >
              <span className="inline-block size-[7px] bg-current shadow-[0_0_6px_rgb(255_176_0/0.4)]" />
              {CONNECTION_LABELS[connectionState] ?? connectionState}
            </span>
          )}
        </header>

        {/* Modo Audio: AsciiCanvas consume audioLevel real + máquina de estados (sección 4) */}
        {uiMode === 'audio' ? (
          <AsciiCanvas state={audio.state.toLowerCase() as 'reposo' | 'procesando' | 'hablando'} audioLevel={audio.audioLevel} />
        ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 pt-5 pb-3">
            {messages.length === 0 && isConnected && !hasSession && (
              <span className="text-faint">
                {activeAgentId
                  ? 'Seleccioná o creá una sesión desde el panel izquierdo. █'
                  : 'Elegí un agente con Ctrl+G para empezar. █'}
              </span>
            )}
            {messages.length === 0 && isConnected && hasSession && (
              <span className="text-faint">Enviá un mensaje para empezar. █</span>
            )}

            {messages.map((msg) => (
              <Fragment key={msg.id}>
                <div className={`flex gap-3.5${msg.role === 'user' ? ' -mx-5 px-5 py-1.5 bg-panel' : ''}`}>
                  <div
                    className={`w-[88px] flex-none pt-px text-right text-xs ${
                      msg.role === 'user' ? 'text-dim' : 'text-amber'
                    }`}
                  >
                    {msg.role === 'user' ? 'Diego ❯' : (agentDisplayName ?? 'openclaw')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className={`leading-relaxed whitespace-pre-wrap ${
                        msg.role === 'user' ? 'text-ink-soft' : 'text-ink'
                      }`}
                    >
                      {msg.text}
                      {msg.isStreaming && (
                        <span className="oc-blink ml-0.5 inline-block h-3.5 w-2 -translate-y-px bg-amber shadow-[0_0_6px_rgb(255_176_0/0.5)] align-middle" />
                      )}
                    </span>
                  </div>
                </div>
                {/* Tool cards associated with this message — live (runId from session.tool) or settled (from history) */}
                {toolsByRunId.get(msg.id)?.map((r) => (
                  <div key={r.id} className="pl-[102px]">
                    <ToolCard
                      name={r.name}
                      command={formatArgs(r.name, r.args)}
                      state={r.status}
                      result={r.output}
                    />
                  </div>
                ))}
              </Fragment>
            ))}

            {/* Placeholder de respuesta pendiente: la cruz se ensambla mientras el
                agente genera (visible durante tool calls, desaparece con el 1er delta) */}
            {waitingForResponse && (
              <div className="flex gap-3.5">
                <div className="w-[88px] flex-none pt-px text-right text-xs text-amber">
                  {agentDisplayName ?? 'openclaw'}
                </div>
                <div className="min-w-0 flex-1">
                  <WaitingIndicator />
                </div>
              </div>
            )}

            {/* Aviso de silencio: 45s sin actividad — watchdog disparó. Puede ser que la
                sesión esté ocupada por otro cliente o que la tarea tarde más de lo esperado.
                Si llega una respuesta tardía, este aviso desaparece automáticamente. */}
            {silenceWarning && (
              <div className="flex gap-3.5">
                <div className="w-[88px] flex-none pt-px text-right text-xs text-dim">⚠</div>
                <div className="min-w-0 flex-1">
                  <span className="text-[10px] leading-relaxed tracking-[2px] text-dim">
                    SIN RESPUESTA EN 45s — la sesión puede estar ocupada por otro cliente.
                    El mensaje llegará cuando la sesión quede libre.
                  </span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>
        )}

        <Composer onSend={send} connectionState={connectionState} hasSession={hasSession} />

        {/* Status bar: connection, active agent, session key, tokens, last activity + thinking */}
        <StatusBar
          connectionState={connectionState}
          agent={agentDisplayName ?? activeAgentId ?? '—'}
          sessionKey={sessionKey ?? ''}
          tokens={contextEstimate != null ? formatContextTokens(contextEstimate) : undefined}
          sessionTime={statusTime}
          thinking={activeSession ? {
            level: activeSession.thinkingLevel ?? null,
            def: activeSession.thinkingDefault ?? null,
            options: activeSession.thinkingOptions ??
              activeSession.thinkingLevels?.map((l) => l.id) ?? [],
          } : undefined}
          onThinkingChange={setThinking}
          onToolCallLimitChange={setToolCallLimit}
          onOpenAgents={() => setSwitcherOpen(true)}
        />
      </div>

      {/* Agent switcher overlay */}
      <AgentSwitcher
        open={switcherOpen}
        agents={agentItems}
        activeId={activeAgentId}
        onPick={(id) => setActiveAgent(id)}
        onClose={() => setSwitcherOpen(false)}
      />
    </div>
  )
}
