#!/bin/bash
cd "$(dirname "$0")"
for i in $(seq 1 40); do
  echo "===== $(date '+%H:%M:%S') ====="
  node mon3.mjs 2>&1
  echo
  sleep 180
done
