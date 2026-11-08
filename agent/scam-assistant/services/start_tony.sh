#!/bin/bash
set -e
cd /home/ubuntu/scam-guard
source .venv/bin/activate
set -a
source .env
set +a
exec /home/ubuntu/scam-guard/.venv/bin/python phone_agent.py dev
