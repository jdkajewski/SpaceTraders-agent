#!/bin/bash
T="$(cat /Users/danielkajewski/.copilot/session-state/61cb64bb-cedf-4243-8fbe-92bc9067e2e3/files/.tok)"
MON="monitor.$(date +%Y%m%d-%H%M%S).log"
echo "ts | running | credits | runNet | lanes | committed | gateFAB | gateADV | errors" > "$MON"
echo "$MON" > .monitor_log
for i in $(seq 1 60); do
  RUN=$(pgrep -f "bot2.mjs" >/dev/null && echo UP || echo DOWN)
  ST=$(python3 -c "import json; d=json.load(open('bot-status.json')); print(d.get('credits'),d.get('runNet'),d.get('lanesRun'),d.get('committed'))" 2>/dev/null)
  GATE=$(curl -s "https://api.spacetraders.io/v2/systems/X1-PP30/waypoints/X1-PP30-I63/construction" -H "Authorization: Bearer $T" | python3 -c "import json,sys; m={x['tradeSymbol']:f\"{x['fulfilled']}/{x['required']}\" for x in json.load(sys.stdin).get('data',{}).get('materials',[])}; print(m.get('FAB_MATS','?'),m.get('ADVANCED_CIRCUITRY','?'))" 2>/dev/null)
  ERR=$(grep -icE "error|throw|unhandled" "$(cat .current_log)" 2>/dev/null)
  echo "$(date +%H:%M:%S) | $RUN | $ST | $GATE | err=$ERR" >> "$MON"
  sleep 120
done
