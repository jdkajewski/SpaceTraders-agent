#!/bin/bash
# Overnight cooldown experiment.
# Q: does a 1-hour market cooldown yield a better cr/hr than constantly running?
# Flow: 60m baseline constant-run -> drain gate haulers + graceful STOP -> API market snap
#       -> 60m cooldown (bot OFF) -> API market snap -> 60m gate-priority run -> report.
# totalNet (run-stats.json) persists across restarts, so the two 60m running windows are comparable.

cd /Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files || exit 1

BASELINE_MIN=${BASELINE_MIN:-60}
PAUSE_MIN=${PAUSE_MIN:-60}
RUN_MIN=${RUN_MIN:-60}
DRAIN_MAX_MIN=${DRAIN_MAX_MIN:-12}

TOK="$(cat .tok2)"
OUT=experiment.out
REPORT=experiment_report.md
ENVLINE='MIN_NET=1200 CONTRACT_MIN_MARGIN_PCT=0.04 GATE_SUPPLY=1 GATE_CREDIT_FLOOR=900000 GATE_CREDIT_RESUME_GAP=250000 GATE_HAULERS=12,13 GATE_MAX_SUPPLIERS=2 GATE_MAX_PRICE=FAB_MATS:3900,ADVANCED_CIRCUITRY:12500 GATE_PROTECT=1 CONTRACT_AVOID_GATE_PRODUCER=1 CONTRACT_BEST_SHIP=1 INPUT_FEED=0 MINE_FEED=1 MINE_TRANSPORT=14,29 MINE_FUNNEL=28 MINE_BATCH=30 MINE_FUEL_RESERVE=20 MINE_ORE_RESERVE=0 MINE_CLOG_AT=0 FILL_BIAS=1 FILL_BIAS_EPS=0.10 DEBUG_CONTRACT=1'

log(){ echo "[$(date -u +%H:%M:%S)Z] $*" | tee -a "$OUT"; }
net(){ node -e 'try{console.log(require("./run-stats.json").totalNet)}catch(e){console.log(0)}'; }
credits(){ node -e 'try{console.log(require("./bot-status.json").credits)}catch(e){console.log(0)}'; }
gaterem(){ node -e 'try{const g=require("./bot-status.json").gate.remaining;console.log((g.FAB_MATS||0)+(g.ADVANCED_CIRCUITRY||0))}catch(e){console.log(-1)}'; }
gatedet(){ node -e 'try{const g=require("./bot-status.json").gate.remaining;console.log("FAB="+(g.FAB_MATS||0)+" ADV="+(g.ADVANCED_CIRCUITRY||0))}catch(e){console.log("?")}'; }
botpid(){ pgrep -f "node bot2.mjs" | head -1; }

launch_bot(){
  rm -f STOP
  LOG="bot2.$(date +%Y%m%d-%H%M%S).log"; echo "$LOG" > .current_log
  SPACETRADERS_PLAYER_AGENT_TOKEN="$TOK" env $ENVLINE nohup node bot2.mjs > "$LOG" 2>&1 &
  sleep 10
  log "launched bot pid=$(botpid) log=$LOG"
}
stop_bot(){
  log "graceful STOP (touch STOP)"
  touch STOP
  for i in $(seq 1 30); do [ -z "$(botpid)" ] && break; sleep 3; done
  local p; p=$(botpid)
  if [ -n "$p" ]; then log "still up after 90s, kill $p"; kill "$p"; sleep 3; fi
  log "bot stopped (pid now '$(botpid)')"
}
hours_between(){ node -e "console.log(((($2)-($1))/3600).toFixed(3))"; }
rate(){ node -e "const d=($2)-($1),h=(($4)-($3))/3600;console.log(h>0?Math.round(d/h):0)"; }

log "================ OVERNIGHT COOLDOWN EXPERIMENT START ================"
log "params: baseline=${BASELINE_MIN}m pause=${PAUSE_MIN}m run=${RUN_MIN}m drainMax=${DRAIN_MAX_MIN}m"

# Ensure bot is up for the baseline.
if [ -z "$(botpid)" ]; then log "bot not running -> launching for baseline"; launch_bot; else log "bot already running pid=$(botpid)"; fi

# ---------- PHASE A: BASELINE constant-run ----------
B_T0=$(date +%s); B_NET0=$(net); B_CR0=$(credits); B_G0=$(gaterem)
log "BASELINE start: net=$B_NET0 credits=$B_CR0 gateRem=$B_G0 ($(gatedet))"
sleep $((BASELINE_MIN*60))
B_T1=$(date +%s); B_NET1=$(net); B_CR1=$(credits); B_G1=$(gaterem)
R_CONSTANT=$(rate "$B_NET0" "$B_NET1" "$B_T0" "$B_T1")
log "BASELINE end:   net=$B_NET1 credits=$B_CR1 gateRem=$B_G1 ($(gatedet))  => R_constant=${R_CONSTANT} cr/hr  gateDelivered=$((B_G0-B_G1))"

# ---------- PHASE B: DRAIN gate haulers, then STOP ----------
log "DRAIN: waiting up to ${DRAIN_MAX_MIN}m for gate haulers 12/13 to deliver held FAB"
for i in $(seq 1 $((DRAIN_MAX_MIN*2))); do
  DRAINING=$(node -e 'try{const s=require("./bot-status.json").ships;const h=s.filter(x=>/(^|-)(12|13)$/.test(String(x.ship)));const busy=h.filter(x=>/SUPPLY_GATE|FAB/.test(x.doing||""));console.log(busy.length)}catch(e){console.log(0)}')
  [ "$DRAINING" = "0" ] && { log "DRAIN: gate haulers clear after $((i*30))s"; break; }
  sleep 30
done
STOP_NET=$(net); STOP_CR=$(credits); STOP_G=$(gaterem)
log "STOP point: net=$STOP_NET credits=$STOP_CR gateRem=$STOP_G ($(gatedet))"
stop_bot

# ---------- PHASE C: market snapshot (depleted), cooldown, snapshot (rested) ----------
log "snapshot DEPLETED market (bot off, fresh API read) -> snap_pause_start.json"
SPACETRADERS_PLAYER_AGENT_TOKEN="$TOK" node snap_markets.mjs snap_pause_start.json 2>>"$OUT"
log "COOLDOWN: bot OFF for ${PAUSE_MIN}m"
sleep $((PAUSE_MIN*60))
log "snapshot RESTED market (fresh API read) -> snap_pause_end.json"
SPACETRADERS_PLAYER_AGENT_TOKEN="$TOK" node snap_markets.mjs snap_pause_end.json 2>>"$OUT"

# ---------- PHASE D: relaunch gate-priority, run ----------
launch_bot
R_T0=$(date +%s); R_NET0=$(net); R_CR0=$(credits); R_G0=$(gaterem)
log "POST-COOLDOWN run start: net=$R_NET0 credits=$R_CR0 gateRem=$R_G0 ($(gatedet))"
sleep $((RUN_MIN*60))
R_T1=$(date +%s); R_NET1=$(net); R_CR1=$(credits); R_G1=$(gaterem)
R_POSTCOOL=$(rate "$R_NET0" "$R_NET1" "$R_T0" "$R_T1")
log "POST-COOLDOWN run end:   net=$R_NET1 credits=$R_CR1 gateRem=$R_G1 ($(gatedet))  => R_postcool=${R_POSTCOOL} cr/hr  gateDelivered=$((R_G0-R_G1))"

# ---------- PHASE E: report ----------
log "computing market diff"
DIFF=$(node market_diff.mjs snap_pause_start.json snap_pause_end.json 2>>"$OUT")
echo "$DIFF" | tee -a "$OUT"

VERDICT=$(node -e "const a=$R_CONSTANT,b=$R_POSTCOOL;const d=b-a;const p=a?Math.round(d/a*100):0;console.log((d>0?'COOLDOWN BETTER':'CONSTANT BETTER OR EQUAL')+' (postcool '+b+' vs constant '+a+' cr/hr, '+(d>=0?'+':'')+p+'%)')")
log "VERDICT: $VERDICT"

{
  echo "# Overnight Cooldown Experiment — Report"
  echo "_Generated $(date -u +%Y-%m-%dT%H:%M:%SZ)_"
  echo
  echo "**Question:** does a 1-hour market cooldown yield a better cr/hr than constantly running?"
  echo
  echo "## Result"
  echo "- **R_constant (60m constant run):** ${R_CONSTANT} cr/hr"
  echo "- **R_postcool (60m run after 1h cooldown):** ${R_POSTCOOL} cr/hr"
  echo "- **Verdict:** ${VERDICT}"
  echo
  echo "## cr/hr detail"
  echo "| window | net start | net end | credits start->end | gate delivered |"
  echo "|---|---|---|---|---|"
  echo "| baseline ${BASELINE_MIN}m | ${B_NET0} | ${B_NET1} | ${B_CR0}->${B_CR1} | $((B_G0-B_G1)) |"
  echo "| post-cooldown ${RUN_MIN}m | ${R_NET0} | ${R_NET1} | ${R_CR0}->${R_CR1} | $((R_G0-R_G1)) |"
  echo
  echo "## Market cooldown (depleted at stop vs rested after ${PAUSE_MIN}m off)"
  echo '```'
  echo "$DIFF"
  echo '```'
  echo
  echo "## Caveats"
  echo "- The post-cooldown window is front-loaded: a rested market + any held inventory dumped on restart inflate its first hour. A multi-cycle test would be more conclusive."
  echo "- Gate buying is gated by the 900k floor / 1.15M resume hysteresis; if credits sat in the deadband, gate units may be ~0 in a window regardless of cooldown."
  echo "- totalNet is realized profit (run-stats.json); inventory in flight at a boundary shifts the realized number into the next window."
} > "$REPORT"

cp "$REPORT" ~/Desktop/SpaceTraders/context/ 2>/dev/null
log "report written -> $REPORT (+ copied to Desktop). bot pid=$(botpid)"
log "================ EXPERIMENT DONE ================"
