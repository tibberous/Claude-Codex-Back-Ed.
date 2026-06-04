#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
faster_whisper_stream.py — host-side STT driver for CBE's
'faster-whisper-stream' realtime provider.

Reads raw PCM s16le 16kHz mono from stdin (piped from ffmpeg dshow by
extension.js → createFasterWhisperStreamSession), runs faster-whisper with a
sliding-window + webrtcvad voiced-frame gate, and emits JSON-line transcripts
to stdout:

    {"type":"partial","text":"..."}
    {"type":"final","text":"..."}

On stdin EOF (host called close()) the script does ONE final transcribe over
whatever's in the buffer, emits a final, and exits 0.

Usage (called by extension.js):
    python faster_whisper_stream.py [<model_dir>]

Args:
    model_dir   Optional CTranslate2 model download root. Defaults to None
                (faster-whisper picks ~/.cache/huggingface).

Env vars:
    CBE_FW_MODEL    model size: tiny.en (default), base.en, small.en, medium.en
    CBE_FW_DEVICE   cpu (default) | cuda
    CBE_FW_COMPUTE  int8 (default cpu) | float16 (cuda)

Dependencies (installed by extension.js's _ensureFasterWhisperVenv into
repo-root/venv-whisper/):
    faster-whisper, webrtcvad, numpy

Note: faster-whisper auto-downloads the CT2 model on first WhisperModel(...)
call. First-run latency is dominated by that download — extension.js shows a
VSCode progress notification for the venv bootstrap, but model download
itself is silent. Trade-off: tiny.en is ~75MB and downloads in seconds.
"""
import json
import os
import sys
import time

# ---------------------------------------------------------------------------
# Config (env-overridable)
# ---------------------------------------------------------------------------
MODEL_SIZE = os.environ.get("CBE_FW_MODEL", "tiny.en")
DEVICE     = os.environ.get("CBE_FW_DEVICE", "cpu")
COMPUTE    = os.environ.get("CBE_FW_COMPUTE", "int8" if DEVICE == "cpu" else "float16")

SAMPLE_RATE    = 16000
FRAME_MS       = 30                                 # webrtcvad supports 10/20/30ms
FRAME_BYTES    = SAMPLE_RATE * 2 * FRAME_MS // 1000  # 960 bytes
WINDOW_S       = 5.0                                # rolling window for transcription
STEP_S         = 0.5                                # transcribe every 500ms
VAD_AGGRESSIVENESS = 2                              # 0 (lenient) - 3 (strict)
VOICED_RATIO_THRESHOLD = 0.30                       # skip if mostly silence

# How many "no-new-text" transcribes before we commit the tail as final
# (rough utterance-boundary heuristic without a real endpoint detector).
SILENCE_COMMIT_STEPS = 4   # ~2s of silence = utterance boundary


def _emit(kind, text):
    """Write one JSON-line to stdout and flush."""
    try:
        sys.stdout.write(json.dumps({"type": kind, "text": text}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _eprint(msg):
    """Mirror to stderr so extension.js trace() captures it."""
    try:
        sys.stderr.write("[faster_whisper_stream] " + msg + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def main():
    # Argv: optional model_dir at argv[1]. We strip our own flag handling so
    # extension.js can pass a single positional path.
    model_dir = None
    args = sys.argv[1:]
    if args and not args[0].startswith("-"):
        model_dir = args[0]

    try:
        import numpy as np
        import webrtcvad
        from faster_whisper import WhisperModel
    except ImportError as e:
        _eprint("missing dependency: " + str(e))
        _eprint("Expected venv at repo-root/venv-whisper/ to have faster-whisper + webrtcvad + numpy installed.")
        sys.exit(2)

    _eprint("loading model={} device={} compute_type={} model_dir={}".format(
        MODEL_SIZE, DEVICE, COMPUTE, model_dir or "default"))
    try:
        model = WhisperModel(
            MODEL_SIZE,
            device=DEVICE,
            compute_type=COMPUTE,
            download_root=model_dir,
        )
    except Exception as e:
        _eprint("WhisperModel init failed: " + str(e))
        sys.exit(3)

    vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
    _eprint("ready — reading PCM from stdin")

    # Audio buffer (raw bytes); we slice the last WINDOW_S into each transcribe
    # call so the model sees the most recent context without re-paying for the
    # whole utterance every step.
    buf = bytearray()
    last_transcribe_t = 0.0
    last_emitted_text = ""
    silence_steps = 0

    # Set stdin to binary mode + small read chunks for low latency.
    try:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    except Exception:
        pass

    try:
        while True:
            chunk = sys.stdin.buffer.read(FRAME_BYTES)
            if not chunk:
                break
            buf.extend(chunk)
            # Trim to WINDOW_S so memory stays bounded.
            max_bytes = int(SAMPLE_RATE * 2 * WINDOW_S)
            if len(buf) > max_bytes:
                del buf[:len(buf) - max_bytes]

            now = time.time()
            if now - last_transcribe_t < STEP_S:
                continue
            last_transcribe_t = now

            # Need at least 4 vad frames (120ms) to do anything useful.
            n_frames = len(buf) // FRAME_BYTES
            if n_frames < 4:
                continue

            # Voice activity gate — skip if mostly silence (reduces model
            # cycles + prevents hallucinated text on background noise).
            voiced = 0
            for i in range(n_frames):
                try:
                    if vad.is_speech(bytes(buf[i*FRAME_BYTES:(i+1)*FRAME_BYTES]), SAMPLE_RATE):
                        voiced += 1
                except Exception:
                    pass
            voiced_ratio = voiced / n_frames if n_frames else 0.0
            if voiced_ratio < VOICED_RATIO_THRESHOLD:
                # Silence — if we have an un-committed tail, count up; commit
                # on extended silence to make finals feel snappy.
                silence_steps += 1
                if silence_steps >= SILENCE_COMMIT_STEPS and last_emitted_text:
                    _emit("final", last_emitted_text)
                    last_emitted_text = ""
                    buf.clear()   # start fresh after commit
                    silence_steps = 0
                continue

            # Voiced — reset silence counter and transcribe.
            silence_steps = 0
            audio = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0
            try:
                segments, _info = model.transcribe(
                    audio,
                    language="en",
                    beam_size=1,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
                txt = "".join(s.text for s in segments).strip()
            except Exception as e:
                _eprint("transcribe failed: " + str(e))
                continue

            if txt and txt != last_emitted_text:
                last_emitted_text = txt
                _emit("partial", txt)

    except KeyboardInterrupt:
        pass
    except Exception as e:
        _eprint("loop crash: " + str(e))
    finally:
        # Final transcribe on whatever audio is left in the buffer (the host
        # called close() → stdin EOF → we land here).
        emitted_final = False
        if len(buf) > FRAME_BYTES * 4:
            try:
                audio = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0
                segments, _info = model.transcribe(
                    audio,
                    language="en",
                    beam_size=1,
                    vad_filter=False,
                    condition_on_previous_text=False,
                )
                txt = "".join(s.text for s in segments).strip()
                if txt:
                    _emit("final", txt)
                    emitted_final = True
            except Exception as e:
                _eprint("final transcribe failed: " + str(e))
        # Even if the buffer was empty, emit whatever interim we last saw so
        # the host doesn't get a blank result on a real utterance.
        if not emitted_final and last_emitted_text:
            _emit("final", last_emitted_text)


if __name__ == "__main__":
    main()
