import io, hashlib, struct, threading, json, base64
import numpy as np, soundfile as sf
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse

app = FastAPI(title="Kokoro TTS")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

VALID_VOICES = {
    'af_heart','af_bella','af_nicole','af_sky',
    'am_michael','am_adam',
    'bf_emma','bf_isabella',
    'bm_fable','bm_george',
}
_pipelines, _lock = {}, threading.Lock()
_cache, _order = {}, []               # ck -> WAV bytes (for /tts, /tts-stream)
_timed_cache, _timed_order = {}, []   # ck -> JSON payload bytes (for /tts-timed)

def _get_pipeline(lang_code):
    if lang_code in _pipelines: return _pipelines[lang_code]
    with _lock:
        if lang_code not in _pipelines:
            from kokoro import KPipeline
            _pipelines[lang_code] = KPipeline(lang_code=lang_code)
    return _pipelines[lang_code]

def _cache_put(ck, wav):
    if ck not in _cache: _order.append(ck)
    _cache[ck] = wav
    while len(_order) > 256: _cache.pop(_order.pop(0), None)

def _timed_put(ck, payload):
    if ck not in _timed_cache: _timed_order.append(ck)
    _timed_cache[ck] = payload
    while len(_timed_order) > 256: _timed_cache.pop(_timed_order.pop(0), None)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/tts")
def tts(
    text:  str   = Query(..., max_length=500),
    voice: str   = Query("af_heart"),
    speed: float = Query(1.0, ge=0.5, le=2.0),
):
    if voice not in VALID_VOICES: voice = "af_heart"
    ck = hashlib.md5(f"{voice}|{speed:.2f}|{text}".encode()).hexdigest()
    if ck in _cache:
        return Response(content=_cache[ck], media_type="audio/wav",
                        headers={"Cache-Control":"public, max-age=86400",
                                 "Access-Control-Allow-Origin":"*"})
    pipeline = _get_pipeline(voice[0])
    chunks = [a for _,_,a in pipeline(text, voice=voice, speed=speed) if a is not None and len(a)]
    if not chunks: return Response(status_code=204)
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(chunks) if len(chunks)>1 else chunks[0], 24000, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()
    _cache_put(ck, wav)
    return Response(content=wav, media_type="audio/wav",
                    headers={"Cache-Control":"public, max-age=86400",
                             "Access-Control-Allow-Origin":"*"})

@app.get("/tts-timed")
def tts_timed(
    text:  str   = Query(..., max_length=500),
    voice: str   = Query("af_heart"),
    speed: float = Query(1.0, ge=0.5, le=2.0),
):
    # Same audio as /tts, plus per-word timestamps from Kokoro's own token
    # output (result.tokens[].start_ts/.end_ts) so the client can highlight
    # exactly in sync instead of estimating linearly. Additive endpoint —
    # /tts and /tts-stream are unchanged, so an old client keeps working.
    if voice not in VALID_VOICES:
        voice = "af_heart"
    ck = hashlib.md5(f"{voice}|{speed:.2f}|{text}".encode()).hexdigest()
    _hdrs = {"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400"}
    if ck in _timed_cache:   # repeat request → serve instantly, no re-synthesis
        return Response(content=_timed_cache[ck], media_type="application/json", headers=_hdrs)
    pipeline = _get_pipeline(voice[0])
    raw_chunks, words, offset = [], [], 0.0
    for result in pipeline(text, voice=voice, speed=speed):
        audio = result.audio
        if audio is None or len(audio) == 0:
            continue
        for t in (getattr(result, "tokens", None) or []):
            st, en, tx = getattr(t, "start_ts", None), getattr(t, "end_ts", None), getattr(t, "text", None)
            if st is not None and en is not None and tx:
                words.append([tx, round(offset + float(st), 3), round(offset + float(en), 3)])
        raw_chunks.append(audio)
        offset += len(audio) / 24000.0
    if not raw_chunks:
        return Response(status_code=204)
    combined = np.concatenate(raw_chunks) if len(raw_chunks) > 1 else raw_chunks[0]
    buf = io.BytesIO()
    sf.write(buf, combined, 24000, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()
    _cache_put(ck, wav)   # keep /tts cache warm too (same key)
    payload = json.dumps({"audio": base64.b64encode(wav).decode("ascii"), "words": words})
    _timed_put(ck, payload)
    return Response(content=payload, media_type="application/json", headers=_hdrs)

@app.get("/tts-stream")
def tts_stream(
    text:  str   = Query(..., max_length=500),
    voice: str   = Query("af_heart"),
    speed: float = Query(1.0, ge=0.5, le=2.0),
):
    if voice not in VALID_VOICES: voice = "af_heart"
    ck = hashlib.md5(f"{voice}|{speed:.2f}|{text}".encode()).hexdigest()

    # Fast path: already cached — serve as one chunk (instant)
    if ck in _cache:
        data = _cache[ck]
        def yield_cached():
            yield struct.pack(">I", len(data)) + data
        return StreamingResponse(yield_cached(), media_type="application/octet-stream",
                                 headers={"Access-Control-Allow-Origin":"*",
                                          "Cache-Control":"no-cache","X-Accel-Buffering":"no"})

    pipeline = _get_pipeline(voice[0])
    raw_chunks = []  # accumulate float32 arrays for post-synthesis caching

    def generate():
        for _, _, audio in pipeline(text, voice=voice, speed=speed):
            if audio is None or len(audio) == 0:
                continue
            raw_chunks.append(audio)
            buf = io.BytesIO()
            sf.write(buf, audio, 24000, format="WAV", subtype="PCM_16")
            data = buf.getvalue()
            yield struct.pack(">I", len(data)) + data
        # After all chunks streamed: cache the assembled full WAV
        if raw_chunks:
            combined = np.concatenate(raw_chunks) if len(raw_chunks) > 1 else raw_chunks[0]
            cbuf = io.BytesIO()
            sf.write(cbuf, combined, 24000, format="WAV", subtype="PCM_16")
            _cache_put(ck, cbuf.getvalue())

    return StreamingResponse(generate(), media_type="application/octet-stream",
                             headers={"Access-Control-Allow-Origin":"*",
                                      "Cache-Control":"no-cache","X-Accel-Buffering":"no"})
