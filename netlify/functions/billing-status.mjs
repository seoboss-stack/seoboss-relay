// netlify/functions/billing-status.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';

function getShop(req){
  const u = new URL(req.url);
  return (u.searchParams.get('shop') || req.headers.get('x-shopify-shop-domain') || '').toLowerCase();
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET')     return json({ error: 'GET only' }, 405);

  try {
    const shop = getShop(req);
    if (!shop) return json({ error: 'Missing shop' }, 400);

    const supa = sb();

    // ── Plan row (source of truth for caps/flags)
    const { data: planRow } =
      await supa.from('billing_plans').select('*').eq('shop', shop).maybeSingle();

    const plan       = planRow?.plan || 'starter';
    const active     = !!planRow?.active;
    const caps_json  = planRow?.caps_json || {};
    const bonus_cap  = planRow?.bonus_cap ?? 0;
    const base_cap   = planRow?.monthly_cap ?? 25;
    const monthly_cap = base_cap + bonus_cap;

    // Trial state
    const now = new Date();
    const trialUntil = planRow?.trial_expires_at ? new Date(planRow.trial_expires_at) : null;
    const inTrial = !!(trialUntil && trialUntil > now);
    const status  = active ? (inTrial ? 'trial' : 'active') : 'inactive';
    const trial_days_left = inTrial ? Math.ceil((trialUntil - now) / (24*60*60*1000)) : 0;

    // ── Usage (prefer the v2 view; graceful fallback if missing)
    let used_articles_this_month = 0;
    let used_kw_basic_this_month = 0;
    let used_kw_ai_this_month    = 0;
    let used_units_this_month    = 0;
    let last_job_done_at         = null;

    // Try v2 analytics view
    const { data: v2, error: v2err } = await supa
      .from('billing_plans_with_usage_v2')
      .select('used_articles_this_month, used_kw_basic_this_month, used_kw_ai_this_month, used_units_this_month, last_job_done_at')
      .eq('shop', shop)
      .maybeSingle();

    if (!v2err && v2) {
      used_articles_this_month = v2.used_articles_this_month ?? 0;
      used_kw_basic_this_month = v2.used_kw_basic_this_month ?? 0;
      used_kw_ai_this_month    = v2.used_kw_ai_this_month ?? 0;
      used_units_this_month    = v2.used_units_this_month ?? 0;
      last_job_done_at         = v2.last_job_done_at ?? null;
    } else {
      // Fallback: legacy article count for this month
      const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
      const { count } = await supa
        .from('jobs')
        .select('job_id', { count: 'exact', head: true })
        .eq('shop', shop)
        .eq('status', 'done')
        .or('action.eq.article,action.is.null')
        .gte('created_at', start.toISOString());
      used_articles_this_month = count ?? 0;
      // keywords remain 0 if v2 view is absent
    }

    // Convenience aggregate for the UI
    const used_keywords_this_month = (used_kw_basic_this_month + used_kw_ai_this_month) | 0;

    return json({
      // plan / status
      status,                      // 'trial' | 'active' | 'inactive'
      plan,
      monthly_cap,                 // effective: base + bonus
      caps_json,
      trial_expires_at: planRow?.trial_expires_at || null,
      trial_days_left,

      // usage (explicit keys for pills)
      used_articles_this_month,
      used_kw_basic_this_month,
      used_kw_ai_this_month,
      used_keywords_this_month,
      used_units_this_month,
      last_job_done_at
    }, 200);

  } catch (e) {
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
