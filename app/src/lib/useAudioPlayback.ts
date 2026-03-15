/**
 * Hook for playing back PCM audio from the Gemini Live API.
 *
 * Uses the `pcm-player` npm package which accumulates PCM samples and
 * flushes them as AudioBufferSourceNode on a timer interval.
 * No AudioWorklet needed — simple and battle-tested.
 *
 * Gemini native-audio outputs PCM int16 LE at 24kHz mono.
 */

import { useCallback, useRef } from 'react'
import PCMPlayer from 'pcm-player'

const PLAYBACK_SAMPLE_RATE = 24000
const FLUSH_TIME = 100 // ms — how often accumulated samples are scheduled for playback

export function useAudioPlayback() {
  const playerRef = useRef<PCMPlayer | null>(null)

  /**
   * Lazily create the PCMPlayer instance.
   * Must be called during a user gesture (click/tap) so the browser
   * allows AudioContext creation without autoplay restrictions.
   */
  const ensurePlayer = useCallback((): PCMPlayer => {
    if (playerRef.current) return playerRef.current

    const player = new PCMPlayer({
      inputCodec: 'Int16',
      channels: 1,
      sampleRate: PLAYBACK_SAMPLE_RATE,
      flushTime: FLUSH_TIME,
      fftSize: 2048,
    })

    // Default gain is 0.1 — set to full volume
    player.volume(1.0)

    playerRef.current = player
    return player
  }, [])

  /**
   * Feed raw PCM data for playback.
   * @param pcmBuffer - ArrayBuffer of PCM int16 LE audio (24kHz mono)
   */
  const play = useCallback(
    (pcmBuffer: ArrayBuffer) => {
      const player = ensurePlayer()

      // Resume AudioContext if it was suspended (browser autoplay policy)
      if (player.audioCtx?.state === 'suspended') {
        void player.continue()
      }

      player.feed(pcmBuffer)
    },
    [ensurePlayer],
  )

  /**
   * Clear buffered audio (on interrupt — user starts talking).
   * Resets the sample buffer so queued agent audio is discarded.
   */
  const stop = useCallback(() => {
    const player = playerRef.current
    if (!player) return

    // Access internal properties via any-cast — pcm-player's types are
    // too restrictive but the source code exposes these as plain fields.
    const p = player as unknown as {
      samples: Float32Array
      startTime: number
      audioCtx: AudioContext | null
    }

    // Clear accumulated samples that haven't been flushed yet
    p.samples = new Float32Array()
    // Reset startTime to current so next flush doesn't try to catch up
    if (p.audioCtx) {
      p.startTime = p.audioCtx.currentTime
    }
  }, [])

  /** Full teardown — destroy player and AudioContext */
  const destroy = useCallback(() => {
    if (playerRef.current) {
      try {
        playerRef.current.destroy()
      } catch {
        // ignore errors during teardown
      }
      playerRef.current = null
    }
  }, [])

  return { play, stop, destroy, ensureInit: ensurePlayer }
}
