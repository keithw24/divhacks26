#!/bin/sh
# Fast refresh for routing/safety: last ~48h of 311 + crashes, plus film and events.
# Does not reload NYPD complaints (those feeds are not hourly).
set -eu

HOURLY=1 INGEST_ONLY=lights,collisions,film python scripts/ingest_safety_layers.py
python scripts/ingest_events.py
