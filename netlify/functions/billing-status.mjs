import { sb, json, CORS } from './_lib/_supabase.mjs';

function getShop(req){
  const u = new URL(req.url);
  return (u.searchParams.get('shop') || req.headers.get('x-shopify-shop-domain') || '').toLowerCase();
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
  if (req.method !== 'GET')     return json({ error:'GET only' }, 405);

  try {
    const shop = getShop(req);
    if (!shop) return json({ error:'Missing shop' }, 400);

    const supa = sb();

    const { data: planRow } =
      await supa.from('billing_plans').select('*').eq('shop', shop).maybeSingle();

    const plan       = planRow?.plan || 'starter';
    const active     = !!planRow?.active;
    const caps_json  = planRow?.caps_json || {};
    const bonus_cap  = planRow?.bonus_cap ?? 0;     // optional column we added
    const base_cap   = planRow?.monthly_cap ?? 25;
    const monthly_cap = base_cap + bonus_cap;       // effective cap

    // trial window
    const now = new Date();
    const trialUntil = planRow?.trial_expires_at ? new Date(planRow.trial_expires_at) : null;
    const inTrial = !!(trialUntil && trialUntil > now);
    const status  = active ? (inTrial ? 'trial' : 'active') : 'inactive';
    const trial_days_left = inTrial ? Math.ceil((trialUntil - now) / (24*60*60*1000)) : 0;

    // usage this month – articles (legacy null treated as 'article')
    const start = new Date(); start.setDate(1); start.setHours(0,0,0,0);
    const { count, error } = await supa
      .from('jobs')
      .select('job_id', { count: 'exact', head: true })
      .eq('shop', shop)
      .eq('status', 'done')
      .or('action.eq.article,action.is.null')
      .gte('created_at', start.toISOString());
    if (error) return json({ error:'count_failed', detail: error.message }, 500);

    return json({
      status,                    // 'trial' | 'active' | 'inactive'
      plan,
      used_this_month: count ?? 0,
      monthly_cap,               // base + bonus (effective)
      caps_json,                 // includes keyword caps (0 = not in plan)
      trial_expires_at: planRow?.trial_expires_at || null,
      trial_days_left
    }, 200);
  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
