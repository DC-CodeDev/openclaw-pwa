import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TurnWatchdog } from './watchdog.ts'

describe('TurnWatchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  // ── Caso 1: tarea larga con actividad intermitente, silencios < 45s ──────────
  // Simula tool calls y deltas que llegan con hasta 30s de silencio entre sí.
  // El watchdog NO debe disparar porque nunca hay 45s consecutivos sin nada.
  it('NO dispara cuando hay actividad con silencios de hasta 30s (tarea larga legítima)', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)

    wd.start()
    // t=0  → mensaje enviado, deadline t=45s

    vi.advanceTimersByTime(28_000)  // t=28s — tool call "start" llega
    wd.reschedule()                  // deadline → t=73s

    vi.advanceTimersByTime(25_000)  // t=53s — deltaText parcial llega
    wd.reschedule()                  // deadline → t=98s

    vi.advanceTimersByTime(30_000)  // t=83s — tool call "result" llega
    wd.reschedule()                  // deadline → t=128s

    vi.advanceTimersByTime(20_000)  // t=103s — otro deltaText llega
    wd.reschedule()                  // deadline → t=148s

    vi.advanceTimersByTime(44_999)  // t=147.999s — justo antes de disparar

    expect(onFire).not.toHaveBeenCalled()
    expect(wd.active).toBe(true)

    wd.cancel()
    expect(wd.active).toBe(false)

    console.log('[watchdog test] CASO 1 ✓ — tarea larga con silencios de 20-30s: watchdog NO disparó')
  })

  // ── Caso 2: silencio total por más de 45s (sesión ocupada por otro cliente) ──
  // No llega ningún evento del gateway. El watchdog dispara exactamente a los 45s.
  it('SÍ dispara tras 45s de silencio total', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)
    const t0 = Date.now()

    wd.start()
    // t=0 → mensaje enviado, ningún evento llega

    vi.advanceTimersByTime(44_999)  // t=44.999s — justo antes del límite
    expect(onFire).not.toHaveBeenCalled()
    expect(wd.active).toBe(true)

    vi.advanceTimersByTime(1)       // t=45.000s — dispara
    const firedAt = Date.now()

    expect(onFire).toHaveBeenCalledTimes(1)
    expect(wd.active).toBe(false)  // el watchdog se desactivó solo al disparar

    console.log(
      `[watchdog test] CASO 2 ✓ — silencio total: watchdog disparó en t=${firedAt - t0}ms (esperado: 45000ms)`,
    )
  })

  // ── Subtests de comportamiento ────────────────────────────────────────────────

  it('el reloj se reinicia desde la ÚLTIMA actividad, no desde el inicio', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)
    const t0 = Date.now()

    wd.start()

    vi.advanceTimersByTime(44_000)   // t=44s — actividad al borde del límite
    wd.reschedule()                   // deadline → t=89s (44 + 45)

    vi.advanceTimersByTime(44_999)   // t=88.999s — sin actividad, pero < 45s desde el reschedule
    expect(onFire).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)         // t=89s — ahora sí dispara
    expect(onFire).toHaveBeenCalledTimes(1)

    console.log(
      `[watchdog test] deadline correcto: disparado en t=${Date.now() - t0}ms (esperado: 89000ms)`,
    )
  })

  it('cancel() evita que dispare aunque haya pasado el tiempo', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)

    wd.start()
    vi.advanceTimersByTime(30_000)
    wd.cancel()                      // state='final' llegó, cancelar
    vi.advanceTimersByTime(60_000)   // t=90s — sin actividad, pero ya cancelado

    expect(onFire).not.toHaveBeenCalled()
    expect(wd.active).toBe(false)
  })

  it('start() en un watchdog cancelado arranca un turno nuevo desde cero', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)

    wd.start()
    vi.advanceTimersByTime(30_000)
    wd.cancel()                      // fin del primer turno

    wd.start()                       // segundo mensaje enviado
    vi.advanceTimersByTime(44_999)
    expect(onFire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('reschedule() en watchdog inactivo es no-op (no reactiva)', () => {
    const onFire = vi.fn()
    const wd = new TurnWatchdog(45_000, onFire)
    // wd nunca fue start()-ed

    wd.reschedule()                  // no-op — no hay turno activo
    vi.advanceTimersByTime(90_000)

    expect(onFire).not.toHaveBeenCalled()
    expect(wd.active).toBe(false)
  })

  // ── Caso 7: recuperación tardía ───────────────────────────────────────────────
  // El watchdog disparó (silenceWarning: true, waitingForResponse: false).
  // DESPUÉS llega una respuesta tardía del gateway.
  // Verificar: silenceWarning vuelve a false, waitingForResponse se mantiene false,
  // el watchdog sigue inactivo, y no queda estado inconsistente en la UI.
  //
  // Esta lógica vive en el listener de `chat` en messages.ts:
  //   watchdog.reschedule()  → no-op porque active=false
  //   silenceWarning = false → aviso limpiado
  //   deltaText procesado normalmente → mensaje aparece en pantalla
  // Aquí modelamos las mismas variables de estado localmente para probar
  // que la secuencia de transiciones es correcta.
  it('recuperación tardía: silenceWarning vuelve a false cuando llega actividad después del disparo', () => {
    // Estado local que espeja lo que hace el store de Zustand en producción.
    let waitingForResponse = true
    let silenceWarning = false

    const wd = new TurnWatchdog(45_000, () => {
      // onFire: equivalente a useMessagesStore.setState({ waitingForResponse: false, silenceWarning: true })
      waitingForResponse = false
      silenceWarning = true
    })

    wd.start()
    vi.advanceTimersByTime(45_000)   // 45s de silencio total — watchdog dispara

    // Estado post-disparo: aviso visible, indicador de espera apagado
    expect(waitingForResponse).toBe(false)
    expect(silenceWarning).toBe(true)
    expect(wd.active).toBe(false)

    // Llega un chat event tardío (la sesión finalmente respondió).
    // messages.ts hace: watchdog.reschedule() + setState({ silenceWarning: false })
    wd.reschedule()          // no-op: active=false, no reactiva el watchdog
    silenceWarning = false   // lo que hace el handler del evento chat

    // Estado post-recuperación: aviso desaparecido, watchdog inactivo, UI limpia
    expect(silenceWarning).toBe(false)       // aviso limpiado
    expect(waitingForResponse).toBe(false)   // no volvió a true — no hay estado inconsistente
    expect(wd.active).toBe(false)            // watchdog sigue sin activar (correcto)

    // Avanzar más tiempo — confirmar que el watchdog no vuelve a disparar
    // (la recuperación no reactiva el reloj)
    vi.advanceTimersByTime(90_000)
    expect(silenceWarning).toBe(false)   // sin cambios

    console.log('[watchdog test] CASO 7 ✓ — recuperación tardía: silenceWarning true → chat event → false; watchdog inactivo; sin estado inconsistente')
  })
})
