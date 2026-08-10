// ASCII canvas: animated character matrix with three states —
// REPOSO: apagado, mutación lenta, glitch raro.
// PROCESANDO: mutación rápida, más glitch, ámbar intermedio.
// HABLANDO: densidad ligada a audioLevel (0..1), brillo pleno con picos calientes.
// Un solo tono ámbar — la jerarquía es solo brillo/intensidad.

import { useEffect, useRef } from 'react'

export type CanvasState = 'reposo' | 'procesando' | 'hablando'

interface AsciiCanvasProps {
  state?: CanvasState
  audioLevel?: number // 0..1
  speedMs?: number
}

const CHARS = '01&$%{}#@!*A0O'

function hash(a: number, b: number, c: number): number {
  let x = (a * 374761393 + b * 668265263 + c * 1274126177) >>> 0
  x = ((x ^ (x >>> 13)) * 1103515245) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

export default function AsciiCanvas({ state = 'reposo', audioLevel = 0, speedMs = 260 }: AsciiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const levelRef = useRef(audioLevel)
  levelRef.current = audioLevel
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const elOrNull = canvasRef.current
    if (!elOrNull) return
    const el: HTMLCanvasElement = elOrNull
    const ctx = el.getContext('2d')!
    let timer: ReturnType<typeof setTimeout>

    function draw() {
      const w = el.clientWidth
      const h = el.clientHeight
      if (el.width !== w) el.width = w
      if (el.height !== h) el.height = h
      ctx.fillStyle = '#060402'
      ctx.fillRect(0, 0, w, h)
      const cell = 20
      const cols = Math.ceil(w / cell)
      const rows = Math.ceil(h / cell)
      ctx.font = '13px "IBM Plex Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const st = stateRef.current
      const level = levelRef.current
      const P =
        st === 'procesando'
          ? { speedMul: 0.5, blockGate: 4, glitchDiv: 5 }
          : st === 'hablando'
            ? { speedMul: 0.45, blockGate: 3 + Math.round(level * 7), glitchDiv: 9 }
            : { speedMul: 1.6, blockGate: 3, glitchDiv: 21 }
      const t = Math.floor(Date.now() / (speedMs * P.speedMul))
      const gt = Math.floor(Date.now() / 120)
      const glitchOn = hash(gt, 13, 7) % P.glitchDiv === 0
      const gRow1 = glitchOn ? hash(gt, 1, 1) % rows : -1
      const gRow2 = glitchOn && hash(gt, 2, 2) % 3 === 0 ? hash(gt, 3, 3) % rows : -1
      const gShift = (hash(gt, 4, 4) % 5) - 2
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const glitched = r === gRow1 || r === gRow2
          const base = hash(c, r, 0)
          const seed = hash(c, r, base % 5 === 0 ? t : Math.floor(t / 7))
          const k = seed % 31
          const dx = glitched ? gShift * 6 : 0
          const x = c * cell + cell / 2 + dx
          const y = r * cell + cell / 2
          if (k < P.blockGate) {
            const cv = seed % 100
            // brillo por estado — mismo tono, distinta intensidad
            ctx.fillStyle =
              st === 'hablando'
                ? (cv < 30 ? '#ffd27a' : cv < 72 ? '#ffb000' : '#8a5f14')
                : st === 'procesando'
                  ? (cv < 18 ? '#ffd27a' : cv < 58 ? '#c07f10' : '#6e4f1e')
                  : (cv < 12 ? '#ffb000' : cv < 55 ? '#8a5f14' : '#4a3312')
            ctx.fillRect(c * cell + 2 + dx, r * cell + 2, cell - 4, cell - 4)
            if (glitched) {
              ctx.globalAlpha = 0.4
              ctx.fillStyle = '#ffd27a'
              ctx.fillRect(c * cell + 2 + dx + 3, r * cell + 2, cell - 4, cell - 4)
              ctx.globalAlpha = 1
            }
            if (seed % 4 === 0) {
              ctx.fillStyle = '#060402'
              ctx.fillText(CHARS[seed % CHARS.length], x, y + 1)
            }
          } else if (k < 11) {
            const bright = seed % 17 === 0
            ctx.fillStyle = bright ? (st === 'hablando' ? '#ffd27a' : '#c07f10') : '#2e2008'
            const ch = glitched ? CHARS[(seed + gt) % CHARS.length] : CHARS[seed % CHARS.length]
            ctx.fillText(ch, x, y + 1)
            if (glitched && seed % 3 === 0) {
              ctx.globalAlpha = 0.35
              ctx.fillStyle = '#a87832'
              ctx.fillText(ch, x - 4, y + 1)
              ctx.globalAlpha = 1
            }
          } else if (glitched && seed % 6 === 0) {
            ctx.fillStyle = '#2e2008'
            ctx.fillText(CHARS[(seed + gt) % CHARS.length], x, y + 1)
          }
        }
      }
      if (glitchOn) {
        ctx.globalAlpha = 0.05
        ctx.fillStyle = '#ffd27a'
        ctx.fillRect(0, (gRow1 >= 0 ? gRow1 : 0) * cell, w, 2)
        ctx.globalAlpha = 1
      }
      timer = setTimeout(draw, 100)
    }
    draw()
    return () => clearTimeout(timer)
  }, [speedMs])

  const dotClass =
    state === 'hablando' ? 'bg-amber-hi' : state === 'procesando' ? 'bg-amber-mid' : 'bg-amber'

  return (
    <div className="relative min-h-0 flex-1">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      <div className="oc-bevel-sm absolute bottom-3 left-4 flex items-center gap-2.5 border border-line-hi bg-bg px-3 py-1 font-mono text-[11px] tracking-[2px]">
        <span className={`oc-blink inline-block size-[7px] shadow-[0_0_6px_rgb(255_176_0/0.5)] ${dotClass}`} />
        <span className="text-amber uppercase">{state}</span>
      </div>
      <div className="absolute right-4 bottom-3 border border-line bg-bg px-3 py-1 font-mono text-[10px] tracking-wider text-faint">
        matriz reactiva · audioLevel: {state === 'hablando' ? audioLevel.toFixed(2) : '—'}
      </div>
    </div>
  )
}
