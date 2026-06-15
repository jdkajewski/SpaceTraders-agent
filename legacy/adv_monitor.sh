#!/bin/bash
cd /Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files
OUT=adv_monitor.out
echo "=== ADV contract monitor started $(date -u +%H:%M:%S)Z (run ~60min, poll 5min) ===" > "$OUT"
DEADLINE=$(( $(date +%s) + 3600 ))
RESOLVED=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  LOG=$(cat .current_log)
  TS=$(date -u +%H:%M:%S)
  CR=$(node -e 'const j=require("./bot-status.json");console.log(j.credits, "FAB="+j.gate.remaining.FAB_MATS, "gateADV="+(j.gate.remaining.ADVANCED_CIRCUITRY||0), "paused="+j.gate.buyPaused)' 2>/dev/null)
  # most recent ADV contract evaluation line
  ADVLINE=$(grep -E "ADVANCED_CIRCUITRY (THIN|src|FORCE)|LAST-RESORT buy producer" "$LOG" | tail -1)
  # fulfillment / delivery signal (contract delivered & closed)
  FILLED=$(grep -iE "fulfill.*ADVANCED|ADVANCED.*fulfill|delivered .*ADVANCED_CIRCUITRY|contract .*(complete|fulfilled|done)" "$LOG" | tail -1)
  echo "[$TS] $CR | adv: ${ADVLINE:0:90}" >> "$OUT"
  if [ -n "$FILLED" ]; then echo "[$TS] >>> RESOLVED: $FILLED" >> "$OUT"; RESOLVED=1; break; fi
  sleep 300
done
if [ "$RESOLVED" -eq 0 ]; then echo "[$(date -u +%H:%M:%S)Z] >>> NOT RESOLVED after 60min — NUDGE NEEDED (CONTRACT_FORCE=ADVANCED_CIRCUITRY)" >> "$OUT"; fi
echo "=== monitor done $(date -u +%H:%M:%S)Z ===" >> "$OUT"
