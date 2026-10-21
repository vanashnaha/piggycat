// =====================================================================
// Piggycat — POST /.netlify/functions/roll-coat
// ---------------------------------------------------------------------
// Server-authoritative weekly coat roll.
//
// Why server-side? The 7-day cooldown and the tier odds must not be
// trustable to the browser — a user could otherwise edit localStorage
// or the page code and roll forever / force Super Rare coats.
//
// Flow:
//   1. Verify the caller's Supabase JWT (GET /auth/v1/user).
//   2. Read the caller's one `pets` row with the service role key.
//   3. Enforce the 7-day cooldown from pets.last_roll_at.
//   4. Roll the tier + coat colours here, on the server.
//   5. Insert the coat into `coats`, update pets.last_roll_at and the
//      pets.state jsonb wardrobe mirror, return the coat.
//
// Required env vars (Netlify → Site settings → Environment variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service role key bypasses RLS — it must NEVER reach the browser.
// =====================================================================

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Tier odds (percent). Super Rare is deliberately a 2-in-100 event and,
// when it hits, its colours are rolled from the FULL colour space —
// totally random, outside the Piggycat genome's normal palettes.
const TIER_ODDS = [
  { tier: 'Super Rare', upTo: 2 },
  { tier: 'Legendary', upTo: 7 },
  { tier: 'Epic', upTo: 15 },
  { tier: 'Rare', upTo: 30 },
  { tier: 'Uncommon', upTo: 55 },
  { tier: 'Standard', upTo: 100 }
];

const PALETTE = ['#f7f1e3', '#ffffff', '#ffe8d6', '#ffd6dd', '#d8f3dc', '#d0ebff', '#fff3b0', '#dee2e6', '#e9b44c', '#d4a373'];
const PATCHES = ['#8a9a94', '#e9b44c', '#e88aa0', '#7fb069', '#74c0fc', '#b197fc', '#ffa94d', '#868e96'];
const PADS = ['#e88aa0', '#f9c5d1', '#e07a4a'];
const NAMES = ['Cloud', 'Berry', 'Meadow', 'Dusk', 'Honey', 'Pudding', 'Comet', 'Petal'];

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}
function fail(statusCode, message) { return json(statusCode, { error: message }); }

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomHex() {
  // Totally random #rrggbb — used only for Super Rare coats.
  return '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
}
function coatId() {
  return 'COAT-' + Math.random().toString(36).slice(2, 8).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();
}

function rollCoat() {
  const r = Math.random() * 100;
  const { tier } = TIER_ODDS.find(t => r < t.upTo);
  const sup = tier === 'Super Rare';
  const wild = () => (sup ? randomHex() : pick(PALETTE.concat(PATCHES)));
  return {
    id: coatId(),
    name: (sup ? '✦ Mirage ' : tier + ' ') + pick(NAMES) + ' Coat',
    tier,
    base: sup ? randomHex() : pick(PALETTE),
    patch: wild(),
    patch2: wild(),
    earL: sup ? randomHex() : pick(PATCHES),
    earR: sup ? randomHex() : pick(PATCHES),
    tail: sup ? randomHex() : pick(PATCHES),
    eye: '#1a1a1a',
    pad: sup ? randomHex() : pick(PADS),
    source: sup ? 'Weekly roll — totally random Super Rare (server)' : 'Weekly roll (server)',
    tradeable: ['Rare', 'Epic', 'Legendary', 'Super Rare'].includes(tier),
    createdAt: Date.now()
  };
}

// Minimal Supabase REST helper (service role; bypasses RLS by design).
function rest(env, path, opts = {}) {
  return fetch(env.url + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: env.serviceKey,
      Authorization: 'Bearer ' + env.serviceKey,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed — use POST.');

  const env = {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  };
  if (!env.url || !env.serviceKey) {
    return fail(500, 'Server not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables.');
  }

  // 1) Verify the caller's JWT.
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return fail(401, 'Missing Authorization bearer token. Please sign in.');
  let user;
  try {
    const who = await fetch(env.url + '/auth/v1/user', {
      headers: { apikey: env.serviceKey, Authorization: 'Bearer ' + token }
    });
    if (!who.ok) return fail(401, 'Invalid or expired session. Please sign in again.');
    user = await who.json();
  } catch (e) {
    return fail(502, 'Could not reach the auth service. Try again shortly.');
  }
  if (!user || !user.id) return fail(401, 'Invalid session. Please sign in again.');

  try {
    // 2) The caller's one Piggycat. (pets.user_id is UNIQUE — one per user.)
    const petRes = await rest(env, `pets?user_id=eq.${user.id}&select=*`, {
      headers: { Accept: 'application/vnd.pgrst.object+json' }
    });
    if (petRes.status === 406 || petRes.status === 404) {
      return fail(404, 'No Piggycat found for this account yet — open the app once while signed in so she can be adopted first.');
    }
    if (!petRes.ok) return fail(502, 'Could not load your Piggycat.');
    const pet = await petRes.json();

    // 3) Cooldown, enforced here — not in the browser.
    const lastMs = pet.last_roll_at ? Date.parse(pet.last_roll_at) : (pet.state && pet.state.lastRandomizeAt) || 0;
    const now = Date.now();
    if (lastMs && now < lastMs + WEEK_MS) {
      return json(429, {
        error: 'Weekly roll already used.',
        next_roll_at: new Date(lastMs + WEEK_MS).toISOString()
      });
    }

    // 4) Roll on the server.
    const coat = rollCoat();
    const isSuper = coat.tier === 'Super Rare';
    const nowIso = new Date(now).toISOString();

    // 5a) Record the coat as its own tradeable row.
    const coatRes = await rest(env, 'coats', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        owner_id: user.id,
        tier: coat.tier,
        coat,
        is_super_rare: isSuper,
        serial: coat.id, // the client-facing coat ID doubles as its unique serial
        trade_status: 'owned'
      })
    });
    if (!coatRes.ok) return fail(502, 'Rolled a ' + coat.tier + ' coat but could not record it. Your weekly roll was NOT used up — try again.');

    // 5b) Stamp the cooldown and mirror the coat into pets.state so the
    //     client's jsonb save and the server agree.
    const state = (pet.state && typeof pet.state === 'object') ? pet.state : {};
    const wardrobe = Array.isArray(state.wardrobe) ? state.wardrobe : [];
    wardrobe.unshift(coat);
    state.wardrobe = wardrobe.slice(0, 60);
    state.currentCoatId = coat.id;
    state.lastRandomizeAt = now;
    const upd = await rest(env, `pets?user_id=eq.${user.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_roll_at: nowIso, state, updated_at: nowIso })
    });
    if (!upd.ok) return fail(502, 'Coat recorded (' + coat.id + ') but the weekly lock could not be saved. Please contact support before rolling again.');

    return json(200, {
      coat,
      tier: coat.tier,
      last_roll_at: nowIso,
      next_roll_at: new Date(now + WEEK_MS).toISOString()
    });
  } catch (e) {
    return fail(500, 'Unexpected roll error: ' + (e && e.message ? e.message : 'unknown'));
  }
};
