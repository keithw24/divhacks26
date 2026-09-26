#!/bin/sh
set -eu

python scripts/ingest_nypd.py
python scripts/ingest_safety_layers.py
python scripts/ingest_events.py
