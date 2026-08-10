// React hook: cola FIFO de fragmentos TTS + máquina de estados del AsciiCanvas.
// Pseudocódigo exacto de DESIGN_DECISIONS.md sección 5:
//
//   fragmentQueue.push(texto) → si !isSpeaking → procesarSiguienteFragmento()
//   procesarSiguienteFragmento():
//     → si cola vacía: estado = REPOSO; return
//     → isSpeaking = true; estado = PROCESANDO (generando audio)
//     → texto = shift(); ttsConvertAndFetch(texto) → Blob de audio
//     → estado = HABLANDO; useAudioPlayback reproduce; al terminar → recursión
//
// El flujo real de mensajes entra por el bridge módulo-nivel `enqueueAudioFragment()`:
// store/messages.ts lo llama cuando un turno del agente termina (state='final') en modo audio —
// mismo evento del streaming normal, el texto completo del mensaje se trata como un fragmento.

import { useCallback, useEffect, useRef, useState } from 'react'
import { gatewayClient } from '../protocol/gatewayInstance.ts'
import { ttsConvertAndFetch } from '../protocol/methods.ts'
import { useAudioPlayback, stopActiveAudio } from './useAudioPlayback.ts'

export type AudioState = 'REPOSO' | 'PROCESANDO' | 'HABLANDO'

type Phase = 'idle' | 'synth' | 'play'

export interface SessionAudioStateResult {
  state: AudioState
  audioLevel: number
}

// ─── Bridge módulo-nivel (sin React) ──────────────────────────────────────────
// Los stores no pueden llamar hooks; el hook registra un listener y messages.ts empuja
// fragmentos por esta vía cuando un turno del agente termina en modo audio.
type EnqueueListener = (text: string) => void
const enqueueListeners = new Set<EnqueueListener>()

/** Registra el listener del hook; devuelve unsubscribe. */
export function onAudioEnqueueRequest(listener: EnqueueListener): () => void {
  enqueueListeners.add(listener)
  return () => { enqueueListeners.delete(listener) }
}

/** Empuja un fragmento de texto a la cola TTS (llamado desde store/messages.ts). */
export function enqueueAudioFragment(text: string): void {
  for (const listener of enqueueListeners) listener(text)
}

// ─── Bridge módulo-nivel para corte global (atajo Alt+X) ──────────────────────
// ChatView no puede llamar hooks; el hook registra un listener y el handler del
// atajo llama stopAudioPlayback(), que corta la reproducción, vacía la cola y
// desenrolla el pipeline a REPOSO. No-op si no hay nada sonando ni encolado.
type StopListener = () => void
const stopListeners = new Set<StopListener>()

/** Registra el listener del hook; devuelve unsubscribe. */
export function onAudioStopRequest(listener: StopListener): () => void {
  stopListeners.add(listener)
  return () => { stopListeners.delete(listener) }
}

/** Corta toda reproducción de audio en curso y vacía la cola TTS pendiente. */
export function stopAudioPlayback(): void {
  for (const listener of stopListeners) listener()
}

export function useSessionAudioState(): SessionAudioStateResult {
  const queueRef = useRef<string[]>([])
  const busyRef = useRef(false)
  // Generación de corte: cada stop (Alt+X) la incrementa e invalida cualquier
  // síntesis en vuelo (el blob que termine de generarse se descarta, no se reproduce).
  const stopGenRef = useRef(0)
  // Resolvers que esperan el fin de la reproducción actual (despertados por onEnded).
  const waitersRef = useRef<Array<() => void>>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [audioPayload, setAudioPayload] = useState<Blob | null>(null)

  const { audioLevel } = useAudioPlayback(audioPayload, () => {
    waitersRef.current.splice(0).forEach((resolve) => resolve())
  })

  const procesarSiguienteFragmento = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    const gen = stopGenRef.current
    const texto = queueRef.current.shift()
    if (texto === undefined) {
      console.log('[dbg] state → REPOSO (cola vacía)')
      setPhase('idle')
      setAudioPayload(null)
      return
    }
    busyRef.current = true
    setPhase('synth') // PROCESANDO: tts.convert + fetch del audio en vuelo, aún sin audio

    try {
      const blob = await ttsConvertAndFetch(gatewayClient, texto)
      // Alt+X durante la síntesis: descartar el audio y desenrollar a REPOSO
      // (el finally se encarga de seguir con lo que haya quedado encolado, si algo).
      if (gen !== stopGenRef.current) {
        setPhase('idle')
        setAudioPayload(null)
        return
      }
      console.log('[audio] tts.convert + media fetch ok:', blob.type ?? '(sin tipo)', blob.size, 'bytes')
      setAudioPayload(blob)
      setPhase('play') // HABLANDO: useAudioPlayback reproduce
      // Esperar a que termine la reproducción antes de seguir con el próximo fragmento.
      await new Promise<void>((resolve) => waitersRef.current.push(resolve))
    } catch (err) {
      console.error('[audio] tts.convert falló:', err)
    } finally {
      busyRef.current = false
      void procesarSiguienteFragmento() // recursión: cola vacía → REPOSO, si no → próximo fragmento
    }
  }, [])

  // Suscripción al flujo real: turno del agente completo (state='final') + uiMode === 'audio'.
  useEffect(() => {
    return onAudioEnqueueRequest((texto) => {
      console.log('[dbg] ENQUEUE: queue=', queueRef.current.length, 'busy=', busyRef.current)
      queueRef.current.push(texto)
      if (!busyRef.current) void procesarSiguienteFragmento()
    })
  }, [procesarSiguienteFragmento])

  // Corte global (Alt+X): vacía la cola pendiente, invalida la síntesis en vuelo,
  // corta la reproducción actual y despierta el pipeline para que desenrolle a REPOSO.
  useEffect(() => {
    return onAudioStopRequest(() => {
      queueRef.current = []
      stopGenRef.current++
      stopActiveAudio()
      waitersRef.current.splice(0).forEach((resolve) => resolve())
    })
  }, [])

  const state: AudioState = phase === 'synth' ? 'PROCESANDO' : phase === 'play' ? 'HABLANDO' : 'REPOSO'

  return { state, audioLevel }
}
