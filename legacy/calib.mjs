// Empirical calibration of travel fuel + time. Navigates a ship one leg,
// captures REAL fuel.consumed and arrival-departure duration, compares to the
// three repo models. Productive legs only (repositions ship for trading).
import { api } from './st.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYS = 'X1-PP30';
async function ship(s){return (await api('GET',`/my/ships/${s}`)).data;}
async function wp(w){return (await api('GET',`/systems/${SYS}/waypoints/${w}`)).data;}
function dist(a,b){return Math.round(Math.hypot(a.x-b.x,a.y-b.y));}

function models(d){
  return {
    roi:    {fuel: Math.max(1,Math.round(d/5)),  cruiseTime: 50+d},
    travel: {fuel: Math.max(1,Math.round(d*1)),  cruiseTimeFactor:'dist*1.0/speed+15'},
    real:   {cruiseFuel: Math.max(1,Math.round(d)), burnFuel: Math.max(1,2*Math.round(d))},
  };
}

const [shipSym, dest, mode='CRUISE'] = process.argv.slice(2);
(async () => {
  let s = await ship(shipSym);
  const origin = await wp(s.nav.waypointSymbol);
  const target = await wp(dest);
  const d = dist(origin, target);
  console.log(`LEG ${s.nav.waypointSymbol} -> ${dest}  dist=${d}  mode=${mode}  speed=${s.engine.speed}  fuel=${s.fuel.current}/${s.fuel.capacity}`);
  console.log('model predictions:', JSON.stringify(models(d)));
  if (s.nav.status === 'DOCKED') await api('POST',`/my/ships/${shipSym}/orbit`);
  if (s.nav.flightMode !== mode) await api('PATCH',`/my/ships/${shipSym}/nav`,{flightMode:mode});
  const r = await api('POST',`/my/ships/${shipSym}/navigate`,{waypointSymbol:dest});
  const dep = Date.parse(r.data.nav.route.departureTime);
  const arr = Date.parse(r.data.nav.route.arrival);
  const durS = Math.round((arr-dep)/1000);
  const fuelConsumed = r.data.fuel.consumed?.amount;
  console.log(`>>> ACTUAL: fuelConsumed=${fuelConsumed}  durationS=${durS}  (fuel ${r.data.fuel.current}/${r.data.fuel.capacity})`);
  // derive coefficients
  const timeMult = ((durS - 15) * s.engine.speed) / Math.max(1,d);
  const fuelPerDist = fuelConsumed / Math.max(1,d);
  console.log(`>>> DERIVED: time = round(dist * ${timeMult.toFixed(2)} / speed) + 15 ;  fuel/dist = ${fuelPerDist.toFixed(3)}`);
})().catch(e=>{console.error('ERR',e.message,e.data?JSON.stringify(e.data):'');process.exit(1);});
