import { sb, json, CORS } from './_lib/_supabase.mjs';

function getShop(req){
  const u = new URL(req.url);
  return (u.searchParams.get('shop')
       || req.headers.get('x-shopify-shop-domain')
       || req.headers.get('x-shop')     // allow proxy header
       || '').toLowerCase();
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status:204, headers: CORS });
  if (req.method !== 'GET')     return json({ error:'GET only' }, 405);

  try {
    const shop = getShop(req);
    if (!shop) return json({ error:'Missing shop' }, 400);
    const supa = sb();

    // ---------- PLAN LOOKUP (unchanged) ----------
    const { data: planRow, error: planErr } =
      await supa.from('billing_plans').select('*').eq('shop', shop).maybeSingle();
    if (planErr) return json({ error:'plan_lookup_failed', detail: planErr.message }, 500);

    const plan         = planRow?.plan || 'starter';
    const active       = !!planRow?.active;
    const caps_json    = planRow?.caps_json || {};
    const bonus_cap    = planRow?.bonus_cap ?? 0;
    const base_cap     = planRow?.monthly_cap ?? 25;
    const monthly_cap  = base_cap + bonus_cap;

    // trial
    const now = new Date();
    const trialUntil = planRow?.trial_expires_at ? new Date(planRow.trial_expires_at) : null;
    const inTrial = !!(trialUntil && trialUntil > now);
    const status  = active ? (inTrial ? 'trial' : 'active') : 'inactive';
    const trial_days_left = inTrial ? Math.ceil((trialUntil - now) / (24*60*60*1000)) : 0;

    // ---------- USAGE (prefer view, fallback to jobs) ----------
    let used_articles_this_month = 0;
    let used_kw_basic_this_month = 0;
    let used_kw_ai_this_month    = 0;
    let used_units_this_month    = 0;

    // Try your v2 view first (yesterday’s addition)
    // Expect columns like: used_articles_this_month, used_kw_basic_this_month, used_kw_ai_this_month, used_units_this_month
    const { data: v2, error: v2Err } =
      await supa.from('billing_plans_with_usage').select('*').eq('shop', shop).maybeSingle();

    if (!v2Err && v2) {
      used_articles_this_month = v2.used_articles_this_month ?? 0;
      used_kw_basic_this_month = v2.used_kw_basic_this_month ?? 0;
      used_kw_ai_this_month    = v2.used_kw_ai_this_month ?? 0;
      used_units_this_month    = v2.used_units_this_month ?? 0;
    } else {
      // Fallback: compute from jobs (current UTC month)
      const monthStart = new Date();
      monthStart.setUTCDate(1); monthStart.setUTCHours(0,0,0,0);
      const since = monthStart.toISOString();

      // Articles (legacy null treated as article)
      {
        const { count, error } = await supa
          .from('jobs')
          .select('job_id', { count:'exact', head:true })
          .eq('shop', shop).eq('status', 'done')
          .or('action.eq.article,action.is.null')
          .gte('created_at', since);
        if (error) return json({ error:'count_failed_articles', detail:error.message }, 500);
        used_articles_this_month = count || 0;
      }

      // Keywords basic (search + buyer + questions)
      {
        const { count, error } = await supa
          .from('jobs')
          .select('job_id', { count:'exact', head:true })
          .eq('shop', shop).eq('status', 'done')
          .in('action', ['keyword_search','keyword_buyer','keyword_questions'])
          .gte('created_at', since);
        if (error) return json({ error:'count_failed_kw_basic', detail:error.message }, 500);
        used_kw_basic_this_month = count || 0;
      }

      // Keywords AI
      {
        const { count, error } = await supa
          .from('jobs')
          .select('job_id', { count:'exact', head:true })
          .eq('shop', shop).eq('status', 'done')
          .eq('action', 'keyword_ai')
          .gte('created_at', since);
        if (error) return json({ error:'count_failed_kw_ai', detail:error.message }, 500);
        used_kw_ai_this_month = count || 0;
      }

      // Units sum (optional)
      {
        const { data: rows, error } = await supa
          .from('jobs')
          .select('cost_units')
          .eq('shop', shop).eq('status', 'done')
          .gte('created_at', since);
        if (error) return json({ error:'units_sum_failed', detail:error.message }, 500);
        used_units_this_month = (rows || []).reduce((a,r)=>a+(r?.cost_units||0), 0);
      }
    }

    // Back-compat: your original "used_this_month" equals article count
    const used_this_month = used_articles_this_month;

    // ---------- RESPONSE (additive; won’t break anything) ----------
    return json({
      status, plan,
      monthly_cap,
      caps_json,
      trial_expires_at: planRow?.trial_expires_at || null,
      trial_days_left,

      // original field you already returned:
      used_this_month,

      // NEW: explicit usage breakdown (good for dashboards too)
      used_articles_this_month,
      used_kw_basic_this_month,
      used_kw_ai_this_month,
      used_units_this_month,

      // NEW: UI-friendly objects (what your pills read)
      caps: {
        article: monthly_cap,
        keyword_basic: caps_json.keyword_basic ?? 0
      },
      usage: {
        article: used_articles_this_month,
        keyword_basic: used_kw_basic_this_month
      }
    }, 200);

  } catch (e) {
    return json({ error:'internal', detail:String(e) }, 500);
  }
};
