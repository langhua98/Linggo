import io
import struct
import hashlib
import threading
import numpy as np
import soundfile as sf
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

app = FastAPI(title="Kokoro TTS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

VALID_VOICES = {'af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_fable', 'bm_george'}

_pipelines: dict = {}
_lock = threading.Lock()

def _get_pipeline(lang_code: str):
    if lang_code in _pipelines:
        return _pipelines[lang_code]
    with _lock:
        if lang_code not in _pipelines:
            from kokoro import KPipeline
            _pipelines[lang_code] = KPipeline(lang_code=lang_code)
    return _pipelines[lang_code]

# In-process LRU: md5(voice|speed|text) → WAV bytes
_cache: dict = {}
_cache_order: list = []
_CACHE_MAX = 256

def _cache_get(k):
    return _cache.get(k)

def _cache_put(k, v):
    if k not in _cache:
        _cache_order.append(k)
    _cache[k] = v
    while len(_cache_order) > _CACHE_MAX:
        _cache.pop(_cache_order.pop(0), None)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/tts")
def tts(
    text:  str   = Query(..., max_length=500),
    voice: str   = Query("af_heart"),
    speed: float = Query(1.0, ge=0.5, le=2.0),
):
    if voice not in VALID_VOICES:
        voice = "af_heart"

    ck = hashlib.md5(f"{voice}|{speed:.2f}|{text}".encode()).hexdigest()
    cached = _cache_get(ck)
    if cached:
        return Response(content=cached, media_type="audio/wav",
                        headers={"Cache-Control": "public, max-age=86400"})

    lang_code = voice[0]  # 'a' = American, 'b' = British
    pipeline = _get_pipeline(lang_code)

    chunks = []
    for _, _, audio in pipeline(text, voice=voice, speed=speed):
        if audio is not None and len(audio) > 0:
            chunks.append(audio)

    if not chunks:
        return Response(status_code=204)

    samples = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

    buf = io.BytesIO()
    sf.write(buf, samples, 24000, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()

    _cache_put(ck, wav)
    return Response(content=wav, media_type="audio/wav",
                    headers={"Cache-Control": "public, max-age=86400"})

@app.get("/tts-stream")
def tts_stream(
    text:  str   = Query(..., max_length=500),
    voice: str   = Query("af_heart"),
    speed: float = Query(1.0, ge=0.5, le=2.0),
):
    if voice not in VALID_VOICES:
        voice = "af_heart"

    lang_code = voice[0]  # 'a' = American, 'b' = British
    pipeline = _get_pipeline(lang_code)

    # Yield each phoneme chunk as soon as the generator produces it, so the
    # client hears the first audio in ~200-500 ms instead of waiting for the
    # whole sentence to synthesize. Each chunk = 4-byte big-endian length + WAV.
    def generate():
        for _, _, audio in pipeline(text, voice=voice, speed=speed):
            if audio is None or len(audio) == 0:
                continue
            buf = io.BytesIO()
            sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
            wav = buf.getvalue()
            yield struct.pack(">I", len(wav)) + wav

    return StreamingResponse(generate(), media_type="application/octet-stream")
