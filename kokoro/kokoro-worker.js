// Kokoro TTS Web Worker — runs WASM inference off the main thread.
// On phones a single sentence can take many seconds of pure compute;
// doing that on the main thread freezes the whole page.
import { KokoroTTS, env } from '/Linggo/kokoro/kokoro.web.js';

env.wasmPaths = '/Linggo/kokoro/ort/';

let tts = null;
let queue = Promise.resolve(); // serialize: concurrent session.run is unsafe

async function handle(msg) {
  try {
    if (msg.type === 'load') {
      tts = await KokoroTTS.from_pretrained('kokoro', {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: p => {
          if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
            self.postMessage({ type: 'progress', progress: p.progress || 0 });
          }
        }
      });
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'synth') {
      const audio = await tts.generate(msg.text, { voice: msg.voice, speed: msg.speed });
      self.postMessage(
        { type: 'audio', id: msg.id, rate: audio.sampling_rate, samples: audio.audio },
        [audio.audio.buffer]
      );
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) });
  }
}

self.onmessage = (e) => { queue = queue.then(() => handle(e.data)); };
