"""Phone bridge: LiveKit call audio -> partner's listen() -> spoken warning back into the call."""
import asyncio
import logging
import sys

import numpy as np
from scipy.signal import resample_poly
from livekit import rtc
from livekit.agents import JobContext, WorkerOptions, cli

sys.path.insert(0, "/home/ubuntu/scam-assistant")
import pipeline as call_demo  # frozen copy

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("scam-guard")

IN_RATE = 16000      # audio rate we request from LiveKit (what the ASR wants)
OUT_RATE = 48000     # audio rate we publish warnings at
STEP_SECONDS = 0.5   # how much new audio to hand listen() per call


async def play_warning(source, rate, audio):
    """Send Magpie's warning audio into the call in 20 ms frames."""
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if int(rate) != OUT_RATE:
        g = np.gcd(int(rate), OUT_RATE)
        audio = resample_poly(audio, OUT_RATE // g, int(rate) // g)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    step = OUT_RATE // 50
    for i in range(0, len(pcm), step):
        piece = pcm[i:i + step]
        if len(piece) < step:
            piece = np.pad(piece, (0, step - len(piece)))
        await source.capture_frame(rtc.AudioFrame(
            data=piece.tobytes(), sample_rate=OUT_RATE,
            num_channels=1, samples_per_channel=step,
        ))


async def entrypoint(ctx: JobContext):
    tasks = set()
    source = rtc.AudioSource(OUT_RATE, 1)

    async def analyze(track, who):
        log.info("Listening to %s", who)
        stream = rtc.AudioStream(track, sample_rate=IN_RATE, num_channels=1)
        state, last_status, seen = None, "", 0
        pending, busy = [], None

        async def process(chunk):
            nonlocal state, last_status, seen
            try:
                state, _hist, _warns, audio, status = await asyncio.to_thread(
                    call_demo.listen, (IN_RATE, chunk), state)
            except Exception:
                log.exception("Pipeline error")
                return
            if status != last_status:
                log.info("Status: %s", status)
                last_status = status
            if state and len(state["history"]) > seen:
                seen = len(state["history"])
                log.info("Heard: %s", state["history"][-1])
            if isinstance(audio, tuple):
                log.warning("WARNING SPOKEN: %s", state["warnings"][-1])
                await play_warning(source, *audio)

        async for event in stream:
            pending.append(np.frombuffer(event.frame.data, dtype=np.int16).copy())
            if busy is not None and not busy.done():
                continue  # keep collecting while the last chunk is processed
            if sum(len(p) for p in pending) < IN_RATE * STEP_SECONDS:
                continue
            chunk = np.concatenate(pending)
            pending = []
            busy = asyncio.create_task(process(chunk))

    @ctx.room.on("track_subscribed")
    def on_track(track, publication, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            t = asyncio.create_task(analyze(track, participant.identity))
            tasks.add(t)
            t.add_done_callback(tasks.discard)

    log.info("Joining room %s", ctx.room.name)
    await ctx.connect()
    track = rtc.LocalAudioTrack.create_audio_track("scam-guard", source)
    await ctx.room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    log.info("Ready: warning track published")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
