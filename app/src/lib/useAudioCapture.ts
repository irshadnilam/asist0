/**
 * Hook for capturing microphone audio as PCM 16kHz 16-bit mono.
 *
 * AudioContext runs at 16kHz — the browser handles resampling from the
 * mic's native rate. The worklet (capture-processor.js) simply converts
 * float32 → int16 and posts ArrayBuffer chunks to the main thread.
 */

import { useCallback, useRef, useState } from 'react'

interface UseAudioCaptureOptions {
  /** Called with each PCM chunk (ArrayBuffer, int16 LE, 16kHz mono) */
  onChunk: (pcm: ArrayBuffer) => void
}

export function useAudioCapture({ onChunk }: UseAudioCaptureOptions) {
  const [isCapturing, setIsCapturing] = useState(false)
  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const onChunkRef = useRef(onChunk)
  onChunkRef.current = onChunk

  const start = useCallback(async () => {
    if (ctxRef.current) return // already running

    const ctx = new AudioContext({ sampleRate: 16000 })
    ctxRef.current = ctx

    await ctx.audioWorklet.addModule('/capture-processor.js')

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    })
    streamRef.current = stream

    const source = ctx.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(ctx, 'pcm-recorder-processor')
    workletRef.current = worklet

    source.connect(worklet)

    worklet.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        onChunkRef.current(e.data)
      }
    }

    setIsCapturing(true)
  }, [])

  const stop = useCallback(() => {
    if (workletRef.current) {
      workletRef.current.disconnect()
      workletRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop()
      }
      streamRef.current = null
    }
    if (ctxRef.current) {
      ctxRef.current.close()
      ctxRef.current = null
    }
    setIsCapturing(false)
  }, [])

  return { start, stop, isCapturing }
}
