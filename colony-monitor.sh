#!/bin/bash
# Watches the mining colony: extraction/refine/feed events + first ferry + throughput. ~50 min.
cd "$(dirname "$0")"
TOK=$(cat .tok2)
OUT="colony-monitor.$(date +%Y%m%d-%H%M%S).log"
echo "$OUT" > .colony_log
echo "ts | extracts | refines | feeds | ferryRev | ship1 | tender12" > "$OUT"
for i in $(seq 1 24); do
  node -e '
    const fs=require("fs");
    let ex=0,rf=0,fd=0,rev=0;
    try{const ls=fs.readFileSync("mine-history.jsonl","utf8").trim().split("\n").map(JSON.parse).filter(x=>Date.parse(x.t)>Date.parse("2026-06-11T04:48:00Z"));
      for(const e of ls){if(e.ev==="extract")ex++;else if(e.ev==="refine")rf++;else if(e.ev==="feed"){fd++;rev+=e.revenue||0;}}}catch{}
    const ts=new Date().toLocaleTimeString("en-US",{hour12:false});
    process.stdout.write(`${ts} | ex=${ex} rf=${rf} fd=${fd} rev=${rev} `);
  ' >> "$OUT"
  for s in 1 12; do
    curl -s --max-time 15 -H "Authorization: Bearer $TOK" "https://api.spacetraders.io/v2/my/ships/SPACEJAM-DK-2-$s" 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>c&&(d+=c)).on("end",()=>{try{const x=JSON.parse(d).data;process.stdout.write(`| '$s':${x.nav.status[0]}@${x.nav.waypointSymbol.slice(-3)} ${x.cargo.units}/${x.cargo.capacity} `);}catch{process.stdout.write("| '$s':? ");}})' >> "$OUT"
  done
  echo "" >> "$OUT"
  sleep 150
done
echo "DONE" >> "$OUT"
