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

    // plan row (or defaults)
    const { data: planRow } = await supa.from('billing_plans').select('*').eq('shop', shop).maybeSingle();
    const plan = planRow?.plan || 'starter';
    const active = !!planRow?.active;
    const monthly_cap = planRow?.monthly_cap ?? 25;
    const caps_json = planRow?.caps_json ?? {};

    // usage this month – articles only for v1 (count rows w/ action='article' or legacy null)
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
      status: active ? 'active' : 'inactive',
      plan,
      used_this_month: count ?? 0,
      monthly_cap,
      caps_json
    }, 200);
  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
