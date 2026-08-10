// React hook: decodes an audio Blob (from the gateway's assistant-media endpoint — tts.convert
// + media ticket), plays via AudioContext + AudioBufferSourceNode, exposes real-time audioLevel
// from an AnalyserNode connected to the buffer source. NOT MediaStreamSource — that is mic
// capture (useAudioVolume, future phase).
//
// Contract (DESIGN_DECISIONS.md sección 6):
//   audioBlob === null → audioLevel de reposo (bajo, con jitter mínimo para que no se vea muerto)
//   audioBlob llega     → decodifica, reproduce, por frame lee frequencyData → audioLevel real
//                           al terminar (o fallar) → vuelve a reposo y dispara onEnded

import { useEffect, useRef, useState } from 'react'

export interface AudioPlaybackResult {
  audioLevel: number // 0..1
}

// Valor de reposo: base baja + jitter chico para que el canvas no se vea muerto.
const IDLE_BASE = 0.05
const IDLE_JITTER = 0.03
// Throttle de setState: el oído/canvas no necesita 60fps; 15fps alcanza y evita un re-render storm.
const EMIT_INTERVAL_MS = 66

// Volumen promedio desde frequencyData (byte magnitudes 0..255), con curva de boost:
// el promedio crudo de voz TTS queda bajo (~0.05-0.2) y parecería reposo; la curva
// potencia 0.6 + ganancia lo lleva a un rango visible sin saturar.
// ─── Bridge módulo-nivel para corte externo (Alt+X) ─────────────────────────────
// Igual que el bridge de enqueue: los handlers globales no pueden llamar hooks;
// el hook registra un listener y useSessionAudioState invoca stopActiveAudio().
type StopListener = () => void
const stopListeners = new Set<StopListener>()

/** Registra el listener de corte; devuelve unsubscribe. */
export function onAudioStopRequest(listener: StopListener): () => void {
  stopListeners.add(listener)
  return () => { stopListeners.delete(listener) }
}

/** Corta la reproducción actual SIN disparar onEnded (el dueño de la cola ya desenrolla). */
export function stopActiveAudio(): void {
  for (const listener of stopListeners) listener()
}

function volumeFromAnalyser(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i]
  const avg = sum / data.length / 255
  return Math.min(1, Math.pow(avg, 0.6) * 1.8)
}

export function useAudioPlayback(
  audioBlob: Blob | null,
  onEnded?: () => void,
): AudioPlaybackResult {
  const [audioLevel, setAudioLevel] = useState(IDLE_BASE)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const playingRef = useRef(false)
  // Fuente activa: expuesta para que el corte externo (Alt+X) la pare sincrónicamente.
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  // Flag de corte: invalida la decodificación/reproducción asíncrona en vuelo.
  const stoppedRef = useRef(false)
  const onEndedRef = useRef(onEnded)
  onEndedRef.current = onEnded

  // rAF loop: corre toda la vida del hook; lee el analyser si hay reproducción en curso,
  // si no devuelve el valor de reposo con jitter. setState throttleado a ~15fps.
  useEffect(() => {
    let raf: number
    let lastEmit = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - lastEmit < EMIT_INTERVAL_MS) return
      lastEmit = now
      const analyser = analyserRef.current
      const level = analyser && playingRef.current
        ? volumeFromAnalyser(analyser)
        : Math.min(1, IDLE_BASE + Math.random() * IDLE_JITTER)
      setAudioLevel(level)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Reproducción: arranca/stoppera cuando cambia audioBlob. Cada fragmento es un Blob
  // distinto (texto distinto → audio distinto), así que el cambio de prop re-dispara.
  useEffect(() => {
    const blob = audioBlob
    if (!blob) return
    let cancelled = false
    let source: AudioBufferSourceNode | null = null
    stoppedRef.current = false

    async function play() {
      if (!blob) return // narrowing de la prop dentro del closure (no fluye desde el effect)
      try {
        if (!ctxRef.current) {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (!Ctor) throw new Error('AudioContext no soportado')
          ctxRef.current = new Ctor()
        }
        const ctx = ctxRef.current
        if (ctx.state === 'suspended') void ctx.resume()

        const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer())
        if (cancelled || stoppedRef.current) return

        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source = ctx.createBufferSource()
        sourceRef.current = source
        source.buffer = audioBuffer
        source.connect(analyser)
        analyser.connect(ctx.destination)
        source.onended = () => {
          sourceRef.current = null
          analyserRef.current = null
          playingRef.current = false
          onEndedRef.current?.()
        }
        source.start()
        analyserRef.current = analyser
        playingRef.current = true
      } catch (err) {
        console.error('[audio] fallo de reproducción:', err)
        analyserRef.current = null
        playingRef.current = false
        // Avanzar la cola igual aunque falle la reproducción — no bloquear el pipeline.
        // (si hubo corte externo, el dueño de la cola ya desenrolló por su cuenta)
        if (!stoppedRef.current) onEndedRef.current?.()
      }
    }
    void play()

    return () => {
      cancelled = true
      stoppedRef.current = true
      sourceRef.current = null
      if (source) {
        source.onended = null // el stop() no debe contar como "terminó" (ya se avanzó la cola)
        try { source.stop() } catch { /* ya terminó */ }
      }
      analyserRef.current = null
      playingRef.current = false
    }
  }, [audioBlob])

  // Corte externo (Alt+X): para la fuente activa al instante, sin disparar onEnded.
  // Sincrónico vía bridge de módulo para que el corte sea inmediato, no al próximo render.
  useEffect(() => {
    return onAudioStopRequest(() => {
      stoppedRef.current = true
      const source = sourceRef.current
      if (source) {
        source.onended = null
        try { source.stop() } catch { /* ya terminó */ }
        sourceRef.current = null
      }
      analyserRef.current = null
      playingRef.current = false
    })
  }, [])

  return { audioLevel }
}
