#!/bin/bash
# Fresh-start relaunch for agent UPRISING (new game, reset 2026-06-14), system X1-DB23.
# Strategy subsystems are ARMED but credit-floored so they self-engage progressively as capital grows:
#   trade+contracts (now) → gate supply (>300k) → mining colony (>500k) → AUTO_EXPAND (after gate built).
# Role pins are intentionally EMPTY so managers self-assign ships as the fleet is bought.
cd "$(dirname "$0")"
node --check bot2.mjs || exit 1
node --check expansion.mjs || exit 1
# [GREENFIELD] auto cold-start: detect system, build data files, buy+place probes 1:1 (idempotent/self-skipping).
SPACETRADERS_PLAYER_AGENT_TOKEN="$(tr -d '[:space:]' < .tok2)" node greenfield.mjs || echo "greenfield step warned (continuing)"
GF_SYS="$(cat .greenfield-system 2>/dev/null)"
GF_NEG="$(cat .greenfield-negotiator 2>/dev/null)"
rm -f STOP
NEWLOG="uprising.$(date +%Y%m%d-%H%M%S).log"
echo "$NEWLOG" > .current_log
SPACETRADERS_PLAYER_AGENT_TOKEN="$(tr -d '[:space:]' < .tok2)" \
SYSTEM="${GF_SYS:-X1-DB23}" \
TRADE_FIRST=0 FLEET_SCALE=1 FLEET_SCALE_MS=60000 FLEET_HAULER_MIN=350000 \
FLEET_TARGET_TRADERS=8 FLEET_MAX_HAULERS=4 \
NEGOTIATOR="${GF_NEG:-UPRISING-2}" \
GOODS_CUSHION=12000 GOODS_CUSHION_PER_SHIP=8000 RESERVE_CONCURRENCY=2 FLEET_SCALE_FLOOR=40000 \
MIN_NET=600 \
CONTRACT_MIN_MARGIN_PCT=0.03 CONTRACT_AUTOFORCE_MINS=20 \
GATE_SUPPLY=1 GATE_HAULERS=18 GATE_CREDIT_FLOOR=900000 GATE_CREDIT_RESUME=1500000 GATE_MAX_SUPPLIERS=3 GATE_PROTECT=1 GATE_MAX_PRICE="FAB_MATS:1900,ADVANCED_CIRCUITRY:6800" \
GATE_FUEL_CARGO=1 FUEL_CARGO=1 \
INPUT_FEED=1 INPUT_FEEDERS=1F \
FEED_FOCUS_MATERIALS="FAB_MATS,ADVANCED_CIRCUITRY" FEED_RESERVE_MATERIALS=FAB_MATS FEED_MAX_LOSS_PER_UNIT=30 FEED_RESERVE_INPUTS=1 FEED_SECOND_LEVEL=1 \
MINE_FEED=0 MINE_EXPAND=0 MINE_MIGRATE=0 \
MINE_FUEL_RESERVE=20 MINE_ORE_RESERVE=0 \
REPAIR=1 \
AUTO_EXPAND=1 EXPAND_CREDIT_FLOOR=400000 EXPAND_AUTOBUY=1 EXPAND_BUY_FLOOR=700000 \
  EXPAND_MAX_BUY_TRADERS=8 EXPAND_MAX_BUY_PROBES=40 EXPAND_OUTPOST_PROBES=4 EXPAND_OUTPOST_TRADERS=4 \
  EXPAND_SCAN_TTL_MS=240000 \
DEBUG_CONTRACT=0 \
nohup node bot2.mjs > "$NEWLOG" 2>&1 &
echo "relaunched UPRISING PID $! → $NEWLOG"
