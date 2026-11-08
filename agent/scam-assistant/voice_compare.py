import io
import secrets

import gradio as gr
import requests
import soundfile as sf

TEXT = (
    "This request has strong signs of a scam. "
    "Do not share your verification code or move your money; "
    "hang up and call your bank using the number on your card."
)

VOICES = ["Leo.Neutral", "Ray.Neutral", "Jason.Neutral"]


def generate(text):
    if not text.strip():
        raise gr.Error("Enter a sample warning first.")

    outputs = []
    for voice in VOICES:
        try:
            response = requests.post(
                "http://127.0.0.1:9002/v1/audio/synthesize",
                data={
                    "text": text,
                    "language": "en-US",
                    "voice": f"Magpie-Multilingual.EN-US.{voice}",
                },
                timeout=120,
            )
            response.raise_for_status()
            audio, rate = sf.read(
                io.BytesIO(response.content), dtype="float32"
            )
            outputs.append((rate, audio))
        except Exception as exc:
            raise gr.Error(f"Could not generate {voice}: {exc}")
    return tuple(outputs)


with gr.Blocks(title="Tony — Voice Comparison") as demo:
    gr.Markdown(
        "# Choose Tony's voice\n"
        "Generate the same warning with three voices, then play each one."
    )
    text = gr.Textbox(
        value=TEXT,
        label="Sample warning",
        lines=4,
        max_length=1000,
    )
    button = gr.Button("Generate all three", variant="primary")
    players = [
        gr.Audio(label=voice, type="numpy", interactive=False)
        for voice in VOICES
    ]
    button.click(
        generate,
        inputs=text,
        outputs=players,
        concurrency_limit=1,
    )

password = secrets.token_urlsafe(12)
print("\nUsername: demo", flush=True)
print(f"Password: {password}\n", flush=True)

demo.queue().launch(
    server_name="127.0.0.1",
    server_port=7861,
    share=True,
    auth=("demo", password),
)
