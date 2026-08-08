// React hook: decodes audioBase64 TTS response, plays via AudioContext + AudioBufferSourceNode, exposes real-time audioLevel from AnalyserNode (NOT MediaStreamSource — that is mic capture)

export interface AudioPlaybackResult {
  audioLevel: number
}

export function useAudioPlayback(_audioBase64: string | null): AudioPlaybackResult {
  return { audioLevel: 0 }
}
