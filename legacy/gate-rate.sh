#!/bin/bash
# Samples the LIVE construction API every 180s for ~33 min, logging FAB_MATS/ADV fulfilled
# so we can compute the true post-feeder fill rate. Output: gate-rate.<ts>.log
cd "$(dirname "$0")"
TOK=$(cat .tok2)
OUT="gate-rate.$(date +%Y%m%d-%H%M%S).log"
echo "$OUT" > .gaterate_log
echo "ts | FAB_MATS | ADV | total_fulfilled" > "$OUT"
for i in $(seq 1 12); do
  curl -s -H "Authorization: Bearer $TOK" \
    "https://api.spacetraders.io/v2/systems/X1-PP30/waypoints/X1-PP30-I63/construction" \
  | node -e 'let d="";process.stdin.on("data",c=>c&&(d+=c)).on("end",()=>{try{const r=JSON.parse(d).data;const m={};let tot=0;for(const x of r.materials){m[x.tradeSymbol]=x.fulfilled;tot+=x.fulfilled;}const ts=new Date().toLocaleTimeString("en-US",{hour12:false});console.log(`${ts} | ${m.FAB_MATS} | ${m.ADVANCED_CIRCUITRY} | ${tot}`);}catch(e){console.log(new Date().toLocaleTimeString()+" | ERR");}})' >> "$OUT"
  sleep 180
done
echo "DONE" >> "$OUT"
