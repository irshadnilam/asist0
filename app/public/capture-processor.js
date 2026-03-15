/**
 * PCM recorder worklet — simple float32 → int16 conversion.
 *
 * AudioContext runs at 16kHz so the browser handles resampling.
 * This worklet just converts each process() block to PCM int16 LE
 * and posts the ArrayBuffer (with transfer) to the main thread.
 */

class PCMRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    if (inputs.length > 0 && inputs[0].length > 0) {
      const inputChannel = inputs[0][0]
      if (inputChannel) {
        const pcm16 = new Int16Array(inputChannel.length)
        for (let i = 0; i < inputChannel.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputChannel[i]))
          pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        }
        this.port.postMessage(pcm16.buffer, [pcm16.buffer])
      }
    }
    return true
  }
}

registerProcessor('pcm-recorder-processor', PCMRecorderProcessor)
