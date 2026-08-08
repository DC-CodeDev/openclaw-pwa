// React hook: FIFO queue of TTS text fragments, drives AsciiCanvas state machine (REPOSO | PROCESANDO | HABLANDO), calls tts.speak per fragment, chains playback via useAudioPlayback

export type AudioState = 'REPOSO' | 'PROCESANDO' | 'HABLANDO'

export interface SessionAudioStateResult {
  state: AudioState
  audioLevel: number
}

export function useSessionAudioState(): SessionAudioStateResult {
  return { state: 'REPOSO', audioLevel: 0 }
}
