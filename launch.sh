#!/usr/bin/env bash
# Thin wrapper — eigentliche Logik liegt in launch.js (cross-platform)
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node launch.js "$@"
