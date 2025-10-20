// netlify/functions/billing-allow.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  try {
    // Accept secret via query OR header (header avoids zsh/URL encoding issues)
    const u = new URL(req.url);
    const token = u.searchParams.get('token') || req.headers.get('x-seoboss-forward-secret') || '';
    if (token !== (process.env.FORWARD_SECRET || '')) return json({ error: 'Unauthorized' }, 401);

    let body = {};
    try {
      body = await req.json();
    } catch (e) {
      body = {};
    }

    const shop   = String(body.shop || '').toLowerCase().trim();
    const action = String(body.action || '').toLowerCase().trim();   // e.g. keyword_basic | keyword_ai
    const units  = Number.isFinite(+body.cost_units) ? +body.cost_units : 1;
    if (!shop || !action) return json({ error: 'Missing shop or action' }, 400);

    const supa = sb();
    const { data: planRow, error: pErr } =
      await supa.from('billing_plans').select('*').eq('shop', shop).maybeSingle();
    if (pErr) return json({ error: 'plan_read_failed', detail: pErr.message }, 500);
    if (!planRow || !planRow.active) return json({ error: 'billing_inactive' }, 402);

    // Per-action caps: 0 or missing => not included in plan
    const capMap = planRow.caps_json || {};
    const capRaw = capMap[action];
    const perActionCap = Number.isFinite(+capRaw) ? +capRaw : 0;
    if (perActionCap <= 0) {
      return json({ error: 'feature_not_in_plan', action, cap: perActionCap }, 402);
    }

    // Count this month's completed usage for this action
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const { count, error: cErr } = await supa
      .from('jobs')
      .select('job_id', { count: 'exact', head: true })
      .eq('shop', shop)
      .eq('status', 'done')
      .eq('action', action)
      .gte('created_at', monthStart.toISOString());
    if (cErr) return json({ error: 'count_failed', detail: cErr.message }, 500);

    const used = count ?? 0;
    if (used + units > perActionCap) {
      return json({ error: 'over_cap_action', action, used, cap: perActionCap }, 402);
    }

    return json({ ok: true, action, used, cap: perActionCap }, 200);
  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
