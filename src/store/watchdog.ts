// Pure turn silence watchdog — no Zustand/React/gateway deps.
// Fires onFire() after `timeoutMs` of silence. Every reschedule() call resets the clock.
// cancel() stops it permanently; start() re-arms it from zero.

export class TurnWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private _active = false
  private readonly ms: number
  private readonly onFire: () => void

  constructor(timeoutMs: number, onFire: () => void) {
    this.ms = timeoutMs
    this.onFire = onFire
  }

  start(): void {
    this.cancel()
    this._active = true
    this.arm()
  }

  // Reset the deadline without changing active state.
  // No-op if the watchdog is not running (already fired or never started).
  reschedule(): void {
    if (!this._active) return
    this.arm()
  }

  cancel(): void {
    this._active = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  get active(): boolean {
    return this._active
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this._active = false
      this.onFire()
    }, this.ms)
  }
}
