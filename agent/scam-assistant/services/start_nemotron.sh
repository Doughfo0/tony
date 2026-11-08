#!/bin/bash
set -e
unset VLLM_USE_FLASHINFER VLLM_ATTENTION_BACKEND
export VLLM_USE_FLASHINFER_SAMPLER=0
exec /home/ubuntu/scam-assistant/.venv/bin/vllm serve nvidia/Llama-3.1-Nemotron-Nano-8B-v1 --quantization fp8_per_tensor --gpu-memory-utilization 0.33 --max-model-len 8192 --max-num-seqs 4 --host 127.0.0.1 --port 8000
