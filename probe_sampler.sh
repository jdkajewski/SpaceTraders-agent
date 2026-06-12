#!/bin/bash
cd "$(dirname "$0")"
export SPACETRADERS_PLAYER_AGENT_TOKEN=$(cat .tok2)
while true; do
  sleep 1800
  node probe_util.mjs --csv >> probe_util.csv 2>/dev/null
done
