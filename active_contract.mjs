// One-shot: print the active (accepted, unfulfilled) contract's good + progress as JSON.
// Usage: SPACETRADERS_PLAYER_AGENT_TOKEN=... node active_contract.mjs
import { getAllContracts } from './st.mjs';
try {
  const cs = await getAllContracts();
  const active = (cs || []).find((c) => c.accepted && !c.fulfilled);
  if (!active) { console.log(JSON.stringify({ active: false })); }
  else {
    const d = (active.terms?.deliver || [])[0] || {};
    console.log(JSON.stringify({ active: true, id: active.id, good: d.tradeSymbol, dest: d.destinationSymbol, fulfilled: d.unitsFulfilled, required: d.unitsRequired }));
  }
} catch (e) { console.log(JSON.stringify({ error: e.message })); }
