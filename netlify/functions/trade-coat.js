// =====================================================================
// Piggycat — POST /.netlify/functions/trade-coat
// ---------------------------------------------------------------------
// Cross-user trading of Super Rare coats.
//
//   { "action": "create", "coat_id": "COAT-…", "coat": { … } }
//       The signed-in owner lists ONE of their Super Rare coats.
//       Creates a row in `trades` with a random PC-TRADE-… code and
//       marks the coat as listed. Returns { code, trade_id }.
//
//   { "action": "redeem", "code": "PC-TRADE-…" }
//       A DIFFERENT signed-in user redeems the code: the coat's
//       ownership transfers to them and the trade is marked redeemed.
//
// A Piggycat NEVER transfers. `pets` rows are never read for transfer
// and never change owner here — only a coat, and only a Super Rare one.
// pets.state wardrobe mirrors are updated best-effort after the coat
// row itself has moved, so the canonical record is the `coats` table.
//
// Note on "atomic-ish": Postgres via REST has no multi-table
// transaction from here, so updates are sequential and CHECKED — the
// trade row is claimed first with a status=eq.open guard (only one
// redeemer can win), then the coat row moves with an owner guard, and
// the trade claim is rolled back if the coat move fails.
//
// Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// =====================================================================

const crypto = require('crypto');

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}
function fail(statusCode, message) { return json(statusCode, { error: message }); }

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
async function getOne(env, path) {
  const r = await rest(env, path, { headers: { Accept: 'application/vnd.pgrst.object+json' } });
  if (r.status === 406 || r.status === 404) return null;
  if (!r.ok) throw new Error('Supabase read failed (' + r.status + ')');
  return r.json();
}

// Best-effort wardrobe mirror inside pets.state jsonb. Never fatal:
// the `coats` table is the source of truth for ownership.
async function mirrorWardrobe(env, userId, mutate) {
  try {
    const pet = await getOne(env, `pets?user_id=eq.${userId}&select=state`);
    if (!pet || !pet.state || typeof pet.state !== 'object') return;
    const state = pet.state;
    state.wardrobe = mutate(Array.isArray(state.wardrobe) ? state.wardrobe : [], state);
    await rest(env, `pets?user_id=eq.${userId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ state, updated_at: new Date().toISOString() })
    });
  } catch (e) { /* mirror only — ignore */ }
}

async function verifyUser(env, event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  const who = await fetch(env.url + '/auth/v1/user', {
    headers: { apikey: env.serviceKey, Authorization: 'Bearer ' + token }
  });
  if (!who.ok) return null;
  const user = await who.json();
  return user && user.id ? user : null;
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

  let user;
  try { user = await verifyUser(env, event); } catch (e) { return fail(502, 'Could not reach the auth service.'); }
  if (!user) return fail(401, 'Invalid or missing session. Please sign in.');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return fail(400, 'Request body must be JSON.'); }

  try {
    // ---------------- CREATE: list a Super Rare coat ----------------
    if (body.action === 'create') {
      const coatId = typeof body.coat_id === 'string' ? body.coat_id.trim() : '';
      if (!coatId) return fail(400, 'Missing coat_id.');

      // The coat may exist only in the owner's pets.state mirror (e.g.
      // rolled in the offline edition). If so, register it first — but
      // only if the supplied coat really is Super Rare and not already
      // registered to someone else.
      let coatRow = await getOne(env, `coats?serial=eq.${encodeURIComponent(coatId)}&select=*`);
      if (!coatRow) {
        const supplied = body.coat && typeof body.coat === 'object' ? body.coat : null;
        if (!supplied || supplied.tier !== 'Super Rare' || supplied.id !== coatId) {
          return fail(404, 'Coat not found. Only a Super Rare coat from your own wardrobe can be listed.');
        }
        const ins = await rest(env, 'coats', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            owner_id: user.id, tier: 'Super Rare', coat: supplied,
            is_super_rare: true, serial: coatId, trade_status: 'owned'
          })
        });
        if (!ins.ok) return fail(502, 'Could not register that coat for trading.');
        coatRow = (await ins.json())[0];
      }

      if (coatRow.owner_id !== user.id) return fail(403, 'That coat does not belong to you.');
      if (!coatRow.is_super_rare || coatRow.tier !== 'Super Rare') {
        return fail(400, 'Only Super Rare coats can be traded. That refusal is intentional.');
      }
      if (coatRow.trade_status === 'listed') {
        const open = await getOne(env, `trades?coat_id=eq.${coatRow.id}&status=eq.open&select=*`);
        if (open) return json(200, { code: open.code, trade_id: open.id, already_listed: true });
        return fail(409, 'That coat is already listed for trade.');
      }

      const code = 'PC-TRADE-' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const tr = await rest(env, 'trades', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ code, coat_id: coatRow.id, from_user: user.id, status: 'open' })
      });
      if (!tr.ok) return fail(502, 'Could not create the trade.');
      const trade = (await tr.json())[0];

      const mark = await rest(env, `coats?id=eq.${coatRow.id}&owner_id=eq.${user.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ trade_status: 'listed', updated_at: new Date().toISOString() })
      });
      if (!mark.ok) return fail(502, 'Trade created but the coat could not be marked listed. Code: ' + code);

      return json(200, { code, trade_id: trade.id, coat_id: coatRow.id });
    }

    // ---------------- REDEEM: claim a listed coat -------------------
    if (body.action === 'redeem') {
      const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
      if (!code) return fail(400, 'Missing trade code.');

      const trade = await getOne(env, `trades?code=eq.${encodeURIComponent(code)}&select=*`);
      if (!trade) return fail(404, 'That trade code was not found.');
      if (trade.status !== 'open') return fail(409, 'That trade has already been ' + trade.status + '.');
      if (trade.from_user === user.id) return fail(400, 'You cannot redeem your own trade — a Piggycat coat trade needs a second person.');

      const coatRow = await getOne(env, `coats?id=eq.${trade.coat_id}&select=*`);
      if (!coatRow) return fail(404, 'The traded coat no longer exists.');
      if (coatRow.owner_id !== trade.from_user || coatRow.trade_status !== 'listed') {
        return fail(409, 'That coat is no longer available for trade.');
      }

      // Claim the trade first — the status=eq.open guard means only one
      // redeemer can succeed, everyone else gets an empty result back.
      const nowIso = new Date().toISOString();
      const claim = await rest(env, `trades?id=eq.${trade.id}&status=eq.open`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'redeemed', to_user: user.id, redeemed_at: nowIso })
      });
      if (!claim.ok) return fail(502, 'Could not claim that trade.');
      const claimed = await claim.json();
      if (!claimed.length) return fail(409, 'That trade was just redeemed by someone else.');

      // Move the coat (guarded by its current owner). If this fails,
      // release the trade claim so the coat can be traded again.
      const move = await rest(env, `coats?id=eq.${coatRow.id}&owner_id=eq.${trade.from_user}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ owner_id: user.id, trade_status: 'owned', updated_at: nowIso })
      });
      const moved = move.ok ? await move.json() : [];
      if (!moved.length) {
        await rest(env, `trades?id=eq.${trade.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'open', to_user: null, redeemed_at: null })
        });
        return fail(409, 'The coat could not be transferred — the trade has been re-opened.');
      }

      // Mirrors (best-effort): out of the giver's wardrobe, into yours.
      await mirrorWardrobe(env, trade.from_user, (wardrobe, state) => {
        const next = wardrobe.filter(w => w && w.id !== coatRow.serial);
        if (state.currentCoatId === coatRow.serial && next.length) state.currentCoatId = next[0].id;
        return next;
      });
      await mirrorWardrobe(env, user.id, (wardrobe) => {
        if (!wardrobe.some(w => w && w.id === coatRow.serial)) wardrobe.unshift(coatRow.coat);
        return wardrobe.slice(0, 60);
      });

      return json(200, { coat: coatRow.coat, from_user: trade.from_user, redeemed_at: nowIso });
    }

    return fail(400, 'Unknown action. Use "create" or "redeem".');
  } catch (e) {
    return fail(500, 'Unexpected trade error: ' + (e && e.message ? e.message : 'unknown'));
  }
};
