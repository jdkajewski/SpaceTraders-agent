// Rate-limited SpaceTraders API helper for manual fleet operations.
// Usage: node st.mjs <command> [args...]
// Token is read from SPACETRADERS_PLAYER_AGENT_TOKEN.

const TOKEN = process.env.SPACETRADERS_PLAYER_AGENT_TOKEN;
const BASE = 'https://api.spacetraders.io/v2';
if (!TOKEN) {
  console.error('Missing SPACETRADERS_PLAYER_AGENT_TOKEN');
  process.exit(1);
}

// ---- Rate limiter: token bucket, ~2 req/s with a tiny burst, 429-aware ----
const REFILL_PER_SEC = 2;
const CAPACITY = 2;
let tokens = CAPACITY;
let last = Date.now();
let blockedUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function take() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    if (blockedUntil > now) {
      await sleep(blockedUntil - now);
      continue;
    }
    tokens = Math.min(CAPACITY, tokens + ((now - last) / 1000) * REFILL_PER_SEC);
    last = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / REFILL_PER_SEC) * 1000));
  }
}

let reqCount = 0;
const NET_RETRIES = 8;   // transient network failures (internet down, reset, timeout, DNS) → retry with backoff
export async function api(method, path, body) {
  // eslint-disable-next-line no-constant-condition
  for (let attempt = 0; ; attempt++) {
    await take();
    reqCount++;
    let res, text;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const retry = (data?.error?.data?.retryAfter ?? 1) * 1000;
        blockedUntil = Date.now() + retry + 50;
        continue;
      }
      text = await res.text();
    } catch (netErr) {
      // fetch() itself rejected → no HTTP response (internet down / ECONNRESET / ETIMEDOUT / DNS). These are
      // transient: back off (capped exponential) and retry so a brief outage doesn't abort the trip. After
      // NET_RETRIES we throw a tagged error; the worker loop will simply retry the cycle next pass.
      if (attempt < NET_RETRIES) {
        const wait = Math.min(15000, 500 * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      const e = new Error(`${method} ${path} -> network error after ${attempt} retries: ${netErr.message}`);
      e.status = 0; e.network = true;
      throw e;
    }
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const code = json?.error?.code;
      // Surface but let caller decide; throw with structured info.
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error?.message ?? text}`);
      err.status = res.status;
      err.code = code;
      err.data = json?.error?.data;
      if ((res.status >= 500 || res.status === 408) && attempt < 4) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
    return json;
  }
}

export async function getAllShips() {
  const ships = [];
  let page = 1;
  for (;;) {
    const r = await api('GET', `/my/ships?limit=20&page=${page}`);
    ships.push(...r.data);
    if (ships.length >= r.meta.total) break;
    page++;
  }
  return ships;
}

export async function getAllContracts() {
  const out = [];
  let page = 1;
  for (;;) {
    const r = await api('GET', `/my/contracts?limit=20&page=${page}`);
    out.push(...r.data);
    if (out.length >= r.meta.total) break;
    page++;
  }
  return out;
}

export function reqStats() { return { reqCount }; }

// ---- CLI ----
import { pathToFileURL } from 'node:url';
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
const [, , cmd, ...args] = process.argv;
async function main() {
  switch (cmd) {
    case 'agent': {
      const r = await api('GET', '/my/agent');
      console.log(JSON.stringify(r.data, null, 2));
      break;
    }
    case 'snapshot': {
      const [agent, ships, contracts] = await Promise.all([
        api('GET', '/my/agent').then((r) => r.data),
        getAllShips(),
        getAllContracts()
      ]);
      const out = { agent, ships, contracts, at: new Date().toISOString() };
      process.stdout.write(JSON.stringify(out));
      console.error(`\n[snapshot] credits=${agent.credits} ships=${ships.length} contracts=${contracts.length} reqs=${reqCount}`);
      break;
    }
    case 'get': {
      const r = await api('GET', args[0]);
      console.log(JSON.stringify(r.data ?? r, null, 2));
      break;
    }
    default:
      console.error('commands: agent | snapshot | get <path>');
      process.exit(1);
  }
}
if (isMain && cmd) main().catch((e) => { console.error('ERR', e.message, e.data ? JSON.stringify(e.data) : ''); process.exit(1); });
