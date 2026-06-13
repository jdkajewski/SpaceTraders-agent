// Trade execution engine. Drives a ship through buy/navigate/sell steps with
// fuel management, flight-mode selection, slippage-aware buying, and real-time
// arrival waiting. Shares the rate limiter in st.mjs.
//
// Usage:
//   node trade.mjs run '{"ship":"SPACEJAM-DK-2-13","steps":[...]}'
// Step kinds:
//   {"go":"X1-PP30-A4","mode":"CRUISE"}        navigate (auto-refuels first)
//   {"buy":"ADVANCED_CIRCUITRY","units":80,"maxPx":4600}
//   {"sell":"MICROPROCESSORS"}                  sell all of a symbol (or "ALL")
//   {"refuel":true}
import { api } from './st.mjs';

const SYSTEM = 'X1-PP30';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function getShip(sym) { return (await api('GET', `/my/ships/${sym}`)).data; }

async function ensureDocked(sym, shipState) {
  let ship = shipState ?? (await getShip(sym));
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitArrival(sym, ship);
  if (ship.nav.status !== 'DOCKED') {
    await api('POST', `/my/ships/${sym}/dock`);
    ship = await getShip(sym);
  }
  return ship;
}

async function ensureOrbit(sym) {
  const ship = await getShip(sym);
  if (ship.nav.status === 'DOCKED') await api('POST', `/my/ships/${sym}/orbit`);
}

async function waitArrival(sym, ship) {
  for (;;) {
    ship = ship ?? (await getShip(sym));
    if (ship.nav.status !== 'IN_TRANSIT') return ship;
    const arrivalMs = Date.parse(ship.nav.route.arrival);
    const waitMs = arrivalMs - Date.now();
    if (waitMs > 0) { log(`${sym} in transit -> ${ship.nav.route.destination.symbol}, ETA ${Math.ceil(waitMs/1000)}s`); await sleep(Math.min(waitMs + 1500, 60000)); }
    ship = await getShip(sym);
    if (ship.nav.status !== 'IN_TRANSIT') return ship;
  }
}

async function refuel(sym) {
  let ship = await ensureDocked(sym);
  if (ship.fuel.capacity === 0) return ship;            // probes
  if (ship.fuel.current >= ship.fuel.capacity) return ship;
  try {
    const r = await api('POST', `/my/ships/${sym}/refuel`);
    log(`${sym} refueled -> ${r.data.fuel.current}/${r.data.fuel.capacity}`);
    return await getShip(sym);
  } catch (e) { log(`${sym} refuel skipped: ${e.message}`); return ship; }
}

async function setMode(sym, mode) {
  const ship = await getShip(sym);
  if (ship.nav.flightMode === mode) return;
  await api('PATCH', `/my/ships/${sym}/nav`, { flightMode: mode });
}

async function navigate(sym, dest, mode = 'CRUISE') {
  let ship = await getShip(sym);
  if (ship.nav.waypointSymbol === dest && ship.nav.status !== 'IN_TRANSIT') { log(`${sym} already at ${dest}`); return ship; }
  await refuel(sym);
  // try the requested mode, then downgrade on insufficient-fuel (handles coords/rounding drift)
  const ladder = mode === 'BURN' ? ['BURN', 'CRUISE', 'DRIFT'] : mode === 'CRUISE' ? ['CRUISE', 'DRIFT'] : ['DRIFT'];
  for (let i = 0; i < ladder.length; i++) {
    const m = ladder[i];
    await setMode(sym, m);
    await ensureOrbit(sym);
    try {
      const r = await api('POST', `/my/ships/${sym}/navigate`, { waypointSymbol: dest });
      log(`${sym} -> ${dest} (${m}) fuel=${r.data.fuel.current} ETA ${r.data.nav.route.arrival}`);
      return await waitArrival(sym, await getShip(sym));
    } catch (e) {
      // [RULE: idempotent-nav] transit→arrival race: ship arrives between our status read and the POST → API 400
      // "located at the destination". Treat as success (we're already there) instead of throwing/crashing.
      if (/located at the destination/i.test(e.message)) { log(`${sym} already at ${dest} (arrived mid-call)`); return await getShip(sym); }
      if (/requires \d+ more fuel/.test(e.message) && i < ladder.length - 1) {
        log(`${sym} ${m} short on fuel for ${dest}, downgrading to ${ladder[i + 1]}`);
        continue;
      }
      throw e;
    }
  }
}

// Derive the system from the waypoint symbol (X1-PP30-A4 → X1-PP30) so buy/sell work in ANY system
// (home or a jumped-to expansion system), not just the hardcoded SYSTEM. Home behavior is unchanged.
const sysOf = (wp) => wp.split('-').slice(0, 2).join('-');
async function marketGood(wp, symbol) {
  const m = (await api('GET', `/systems/${sysOf(wp)}/waypoints/${wp}/market`)).data;
  return m.tradeGoods?.find((g) => g.symbol === symbol);
}

async function buy(sym, symbol, units, maxPx) {
  let ship = await ensureDocked(sym);
  const wp = ship.nav.waypointSymbol;
  let bought = 0, spent = 0;
  while (bought < units) {
    const g = await marketGood(wp, symbol);
    if (!g) { log(`${sym} ${symbol} not sold at ${wp}`); break; }
    if (maxPx && g.purchasePrice > maxPx) { log(`${sym} ${symbol} px ${g.purchasePrice} > max ${maxPx}, stop (bought ${bought})`); break; }
    const space = ship.cargo.capacity - ship.cargo.units;
    const lot = Math.min(g.tradeVolume, units - bought, space);
    if (lot <= 0) { if (space <= 0) log(`${sym} ${symbol} buy stalled: cargo FULL (${ship.cargo.units}/${ship.cargo.capacity})`); break; }
    const r = await api('POST', `/my/ships/${sym}/purchase`, { symbol, units: lot });
    bought += lot; spent += r.data.transaction.totalPrice; ship = (await getShip(sym));
    log(`${sym} bought ${lot} ${symbol} @ ${r.data.transaction.pricePerUnit} (cargo ${ship.cargo.units}/${ship.cargo.capacity})`);
    if (lot < g.tradeVolume) break;
  }
  return { bought, spent };
}

async function sell(sym, symbol) {
  let ship = await ensureDocked(sym);
  const wp = ship.nav.waypointSymbol;
  const items = symbol === 'ALL' ? ship.cargo.inventory.map((i) => i.symbol) : [symbol];
  let got = 0;
  for (const it of items) {
    let inv = ship.cargo.inventory.find((i) => i.symbol === it);
    while (inv && inv.units > 0) {
      const g = await marketGood(wp, it);
      if (!g) { log(`${sym} ${it} not bought at ${wp} (keep ${inv.units})`); break; }
      const lot = Math.min(g.tradeVolume, inv.units);
      const r = await api('POST', `/my/ships/${sym}/sell`, { symbol: it, units: lot });
      got += r.data.transaction.totalPrice; ship = await getShip(sym);
      log(`${sym} sold ${lot} ${it} @ ${r.data.transaction.pricePerUnit} (+${r.data.transaction.totalPrice})`);
      inv = ship.cargo.inventory.find((i) => i.symbol === it);
      if (lot < g.tradeVolume) break;
    }
  }
  return { got };
}

async function transfer(fromSym, toSym, symbol, units) {
  // both ships must be co-located (same waypoint), in orbit or docked
  await ensureOrbit(fromSym); await ensureOrbit(toSym);
  const r = await api('POST', `/my/ships/${fromSym}/transfer`, { tradeSymbol: symbol, units, shipSymbol: toSym });
  log(`${fromSym} -> ${toSym} transferred ${units} ${symbol}`);
  return r.data;
}

async function deliver(sym, contractId, tradeSymbol, units) {
  await ensureDocked(sym);
  const r = await api('POST', `/my/contracts/${contractId}/deliver`, { shipSymbol: sym, tradeSymbol, units });
  const d = r.data.contract.terms.deliver[0];
  log(`${sym} delivered ${units} ${tradeSymbol} (${d.unitsFulfilled}/${d.unitsRequired})`);
  return r.data;
}

async function fulfill(sym, contractId) {
  const r = await api('POST', `/my/contracts/${contractId}/fulfill`);
  log(`${sym} FULFILLED ${contractId} credits=${r.data.agent.credits}`);
  return r.data;
}

// Jump a ship through a BUILT jump gate to a CONNECTED gate waypoint in another system.
// Authoritative v2 mechanic: POST /my/ships/{sym}/jump { waypointSymbol }. The ship must be IN ORBIT;
// a single unit of ANTIMATTER is auto-purchased+consumed from the market (a credit cost, returned in
// `transaction`); a cooldown then applies to the ship. Returns the full data block (nav/cooldown/
// transaction/agent) so the caller can learn the antimatter price + honor the cooldown.
async function jump(sym, destGateWp) {
  const ship = await getShip(sym);
  if (ship.nav.status === 'DOCKED') { await api('POST', `/my/ships/${sym}/orbit`); }
  else if (ship.nav.status === 'IN_TRANSIT') await waitArrival(sym, ship);
  const r = await api('POST', `/my/ships/${sym}/jump`, { waypointSymbol: destGateWp });
  const cost = r.data.transaction?.totalPrice;
  const cd = r.data.cooldown?.remainingSeconds;
  log(`${sym} JUMPED → ${destGateWp} (antimatter ${cost ?? '?'}cr, cooldown ${cd ?? '?'}s, credits ${r.data.agent?.credits})`);
  return r.data;
}

async function runPlan(plan) {
  const sym = plan.ship;
  let totalSpent = 0, totalGot = 0;
  for (const step of plan.steps) {
    if (step.go) await navigate(sym, step.go, step.mode);
    else if (step.buy) { const r = await buy(sym, step.buy, step.units ?? 9999, step.maxPx); totalSpent += r.spent; }
    else if (step.sell) { const r = await sell(sym, step.sell); totalGot += r.got; }
    else if (step.refuel) await refuel(sym);
    else if (step.transfer) await transfer(sym, step.to, step.transfer, step.units);
    else if (step.deliver) await deliver(sym, step.contract, step.deliver, step.units);
    else if (step.fulfill) await fulfill(sym, step.fulfill);
  }
  log(`${sym} PLAN DONE spent=${totalSpent} got=${totalGot} net=${totalGot - totalSpent}`);
  return { sym, totalSpent, totalGot, net: totalGot - totalSpent };
}

export { runPlan, navigate, buy, sell, refuel, transfer, deliver, fulfill, getShip, jump };

async function runPlans(plans) {
  const results = await Promise.allSettled(plans.map((p) => runPlan(p)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') log(`OK ${plans[i].ship} net=${r.value.net}`);
    else log(`FAIL ${plans[i].ship}: ${r.reason?.message} ${r.reason?.data ? JSON.stringify(r.reason.data) : ''}`);
  });
  const net = results.reduce((a, r) => a + (r.status === 'fulfilled' ? r.value.net : 0), 0);
  log(`ALL PLANS DONE total net=${net}`);
  return net;
}
export { runPlans };

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [, , cmd, arg] = process.argv;
  if (cmd === 'run') runPlan(JSON.parse(arg)).catch((e) => { log('ERR', e.message, e.data ? JSON.stringify(e.data) : ''); process.exit(1); });
  else if (cmd === 'runmany') runPlans(JSON.parse(arg)).catch((e) => { log('ERR', e.message, e.data ? JSON.stringify(e.data) : ''); process.exit(1); });
  else { console.error('usage: node trade.mjs run <planJson> | runmany <plansJson>'); process.exit(1); }
}
