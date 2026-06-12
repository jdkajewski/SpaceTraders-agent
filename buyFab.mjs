// One-off: buy a cheap FAB_MATS lot and deliver it to the gate. Run with bot2 STOPPED.
import { api } from './st.mjs';
const SYS = 'X1-PP30', SHIP = 'SPACEJAM-DK-2-12', GATE = 'X1-PP30-I63', PROD = 'X1-PP30-F51';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);

async function ship() { return (await api('GET', `/my/ships/${SHIP}`)).data; }
async function orbit() { try { await api('POST', `/my/ships/${SHIP}/orbit`); } catch {} }
async function dock() { try { await api('POST', `/my/ships/${SHIP}/dock`); } catch {} }
async function refuel() { try { const r = await api('POST', `/my/ships/${SHIP}/refuel`); log('refueled', r.data.fuel.current+'/'+r.data.fuel.capacity); } catch (e) { log('refuel skip', e.message); } }
async function navTo(wp) {
  await orbit();
  await api('PATCH', `/my/ships/${SHIP}/nav`, { flightMode: 'CRUISE' });
  const r = await api('POST', `/my/ships/${SHIP}/navigate`, { waypointSymbol: wp });
  const arr = new Date(r.data.nav.route.arrival).getTime();
  log(`-> ${wp} ETA ${Math.round((arr-Date.now())/1000)}s`);
  while (Date.now() < arr + 1500) { await sleep(5000); }
  log('arrived', wp);
}

(async () => {
  let s = await ship();
  log('start @', s.nav.waypointSymbol, 'fuel', s.fuel.current, 'cargo', s.cargo.units+'/'+s.cargo.capacity);
  if (s.nav.waypointSymbol !== PROD) { await navTo(PROD); }
  await dock(); await refuel();
  // buy one tradeVolume lot of FAB_MATS
  const mk = (await api('GET', `/systems/${SYS}/waypoints/${PROD}/market`)).data;
  const fab = (mk.tradeGoods||[]).find(g => g.symbol === 'FAB_MATS');
  const units = Math.min(fab.tradeVolume || 40, 43);
  log(`buying ${units} FAB_MATS @ ~${fab.purchasePrice}`);
  const buy = await api('POST', `/my/ships/${SHIP}/purchase`, { symbol: 'FAB_MATS', units });
  log('bought', buy.data.transaction.units, 'FAB_MATS for', buy.data.transaction.totalPrice, '| credits', buy.data.agent.credits);
  // haul to gate
  await refuel();
  await navTo(GATE);
  await dock();
  const held = (await ship()).cargo.inventory.find(i=>i.symbol==='FAB_MATS')?.units || 0;
  log('delivering', held, 'FAB_MATS to gate');
  const sup = await api('POST', `/systems/${SYS}/waypoints/${GATE}/construction/supply`, { shipSymbol: SHIP, tradeSymbol: 'FAB_MATS', units: held });
  const fabMat = sup.data.construction.materials.find(m=>m.tradeSymbol==='FAB_MATS');
  log('DELIVERED. gate FAB_MATS now', fabMat.fulfilled + '/' + fabMat.required);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
