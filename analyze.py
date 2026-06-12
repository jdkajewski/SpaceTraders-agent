import json, csv, math, sys

D = '/Users/danielkajewski/.copilot/session-state/18a148a9-5032-4a86-9f91-34d8680cdcfd/files/'
markets = json.load(open(D+'markets.json'))
coords = {}
for row in csv.reader(open(D+'coords.csv')):
    if len(row) >= 3 and row[0]:
        coords[row[0]] = (float(row[1]), float(row[2]))

def dist(a, b):
    if a not in coords or b not in coords: return None
    (x1,y1),(x2,y2) = coords[a], coords[b]
    return math.hypot(x1-x2, y1-y2)

# Build per-good market entries
goods = {}  # symbol -> list of dict(wp,type,buy,sell,vol,supply,activity)
for wp, m in markets.items():
    for g in m.get('tradeGoods', []):
        goods.setdefault(g['symbol'], []).append({
            'wp': wp, 'type': g['type'],
            'buy': g['purchasePrice'], 'sell': g['sellPrice'],
            'vol': g['tradeVolume'], 'supply': g.get('supply'), 'activity': g.get('activity')
        })

def best_sell(sym, exclude=None):
    opts = [e for e in goods.get(sym, []) if e['wp'] != exclude]
    if not opts: return None
    return max(opts, key=lambda e: e['sell'])

def best_buy(sym):
    opts = goods.get(sym, [])
    if not opts: return None
    return min(opts, key=lambda e: e['buy'])

cmd = sys.argv[1] if len(sys.argv) > 1 else 'arb'

if cmd == 'arb':
    rows = []
    for sym, entries in goods.items():
        b = min(entries, key=lambda e: e['buy'])
        s = max(entries, key=lambda e: e['sell'])
        if s['sell'] <= b['buy']: continue
        if b['wp'] == s['wp']: continue
        margin = s['sell'] - b['buy']
        d = dist(b['wp'], s['wp'])
        vol = min(b['vol'], s['vol'])
        rows.append({
            'sym': sym, 'buyWp': b['wp'], 'buy': b['buy'], 'buyType': b['type'], 'buySupply': b['supply'],
            'sellWp': s['wp'], 'sell': s['sell'], 'sellType': s['type'],
            'margin': margin, 'pct': round(margin/b['buy']*100), 'vol': vol,
            'dist': round(d) if d else None, 'profitPerFill': margin*vol
        })
    rows.sort(key=lambda r: r['profitPerFill'], reverse=True)
    print(f"{'GOOD':22} {'BUY@':13}{'px':>6} {'SELL@':13}{'px':>6} {'marg':>6} {'%':>4} {'vol':>4} {'dist':>5} {'prof/fill':>9}")
    for r in rows[:30]:
        print(f"{r['sym']:22} {r['buyWp']:13}{r['buy']:>6} {r['sellWp']:13}{r['sell']:>6} {r['margin']:>6} {r['pct']:>3}% {r['vol']:>4} {str(r['dist']):>5} {r['profitPerFill']:>9}")

elif cmd == 'near':
    maxd = float(sys.argv[2]) if len(sys.argv) > 2 else 200
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 15
    cap = float(sys.argv[4]) if len(sys.argv) > 4 else 80
    FUEL_PX = 72
    def cruise_time(d): return round(d*25/speed)+15
    def burn_time(d): return round(d*12.5/speed)+15
    rows = []
    for sym, entries in goods.items():
        for b in entries:
            for s in entries:
                if s['sell'] <= b['buy']: continue
                d = dist(b['wp'], s['wp'])
                if d is None or d > maxd: continue
                vol = min(b['vol'], s['vol'])
                margin = s['sell'] - b['buy']
                # units movable per cycle: assume up to 2x tradeVolume before bad slippage, capped by hold
                units = min(cap, vol*2)
                cruise_fuel = max(1, round(d))           # per leg
                fuel_cycle = cruise_fuel * 2 * FUEL_PX   # out empty + back loaded (both ~d)
                gross = margin * units
                net = gross - fuel_cycle
                cyc_t = 2*cruise_time(d) + 30             # two legs + dock/txn overhead
                rows.append((net, sym, b, s, margin, vol, round(d), int(units), cruise_fuel, fuel_cycle, cyc_t, round(net/cyc_t*60)))
    rows.sort(reverse=True, key=lambda r: r[0])
    seen=set()
    print(f"speed={speed} cap={cap}  (units=min(cap,2*vol); fuel both legs CRUISE)")
    print(f"{'GOOD':18} {'BUY@':12}{'px':>6} {'SELL@':12}{'px':>6} {'marg':>5}{'un':>4}{'dist':>5}{'fuel/leg':>9}{'net/cyc':>9}{'cyc_s':>6}{'net/min':>8}")
    for net,sym,b,s,margin,vol,d,units,cf,fc,ct,npm in rows:
        if sym in seen: continue
        seen.add(sym)
        print(f"{sym:18} {b['wp']:12}{b['buy']:>6} {s['wp']:12}{s['sell']:>6} {margin:>5}{units:>4}{d:>5}{cf:>9}{net:>9}{ct:>6}{npm:>8}")
        if len(seen)>=22: break

elif cmd == 'sell':
    # Where to sell goods we already hold: args are symbol:units pairs
    for pair in sys.argv[2:]:
        sym, units = pair.split(':')
        s = best_sell(sym)
        if s:
            print(f"{sym:18} {units:>4} units -> sell @ {s['wp']:13} sellPx={s['sell']} vol={s['vol']} (est {int(units)*s['sell']})")
        else:
            print(f"{sym:18} no market buys it")

