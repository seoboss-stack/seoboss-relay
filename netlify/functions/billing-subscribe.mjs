import { sb, json, CORS } from './_lib/_supabase.mjs';
import { errlog } from './_lib/_errlog.mjs';

// Accept whatever the UI sends, normalize to an internal key
const PLAN_ALIASES = {
  trial: 'trial',
  starter: 'starter',
  basic: 'starter',
  pro: 'pro',
  growth: 'pro',
  scale: 'scale',
  boss: 'scale',
};

const PLAN_DEFAULTS = {
  trial:   { articles: 10,  keyword_basic: 20,  keyword_buyer: 10,  keyword_questions: 10,  keyword_ai: 0 },
  starter: { articles: 30,  keyword_basic: 30,  keyword_buyer: 20,  keyword_questions: 20,  keyword_ai: 0 },
  pro:     { articles: 60,  keyword_basic: 60,  keyword_buyer: 40,  keyword_questions: 40,  keyword_ai: 10 },
  scale:   { articles: 120, keyword_basic: 120, keyword_buyer: 80,  keyword_questions: 80,  keyword_ai: 30 },
};

function normalizePlan(p) {
  const key = (p || 'starter').toLowerCase().trim();
  return PLAN_ALIASES[key] || 'starter';
}

function capsFor(planKey) {
  const p = PLAN_DEFAULTS[planKey] || PLAN_DEFAULTS.starter;
  return {
    monthly_cap: p.articles, // legacy/global, align with article cap
    caps_json: {
      article: p.articles,
      keyword_basic: p.keyword_basic,
      keyword_buyer: p.keyword_buyer,
      keyword_questions: p.keyword_questions,
      keyword_ai: p.keyword_ai,
    },
  };
}

function normShop(s){
  return String(s)
    .trim().toLowerCase()
    .replace(/^https?:\/\//,'')
    .replace(/[?#].*$/,'')
    .replace(/\/.*/,'')
    .replace(/:\d+$/,'')
    .replace(/\.shopify\.com$/i, '.myshopify.com');
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  const request_id = req.headers.get('x-request-id') || '';

  let body = {};
  try {
    body = await req.json().catch(() => ({}));

    const u = new URL(req.url);
    const rawShop   = u.searchParams.get('shop') || body.shop || '';
    const shop      = normShop(rawShop);
    const requested = (body.plan || 'starter').toLowerCase().trim();
    const planKey   = normalizePlan(requested);
    const trialDays = Number.isFinite(+body.trial_days) ? Math.max(0, +body.trial_days) : 0;

    if (!shop) return json({ error: 'Missing shop' }, 400);

    const supa = sb();

    if (planKey === 'trial') {
      // Store as starter while trial is active
      const { monthly_cap, caps_json } = capsFor('starter');
      const until = new Date(Date.now() + (trialDays || 3) * 86400 * 1000);

      const payload = {
        shop,
        plan: 'starter',
        active: true,
        monthly_cap,
        caps_json,
        trial_started_at: new Date().toISOString(),
        trial_expires_at: until.toISOString(),
      };

      const { data, error } = await supa
        .from('billing_plans')
        .upsert(payload, { onConflict: 'shop' })
        .select()
        .maybeSingle();

      if (error) {
        await errlog({
          shop,
          route: '/billing-subscribe',
          status: 500,
          message: 'Upsert failed (trial)',
          detail: error.message,
          request_id,
          code: 'E_DB_WRITE',
        });
        return json({ error: 'db_upsert_failed', detail: error.message }, 500);
      }

      return json({
        ok: true,
        row: data, // ← echo back what the DB actually has
        confirmation_url: `/apps/engine/thanks?plan=trial&trial_until=${encodeURIComponent(until.toISOString())}`,
      }, 200);
    }

    // Regular paid plan
    const { monthly_cap, caps_json } = capsFor(planKey);

    const payload = {
      shop,
      plan: planKey,
      active: true,
      monthly_cap,
      caps_json,
      trial_started_at: null,
      trial_expires_at: null,
    };

    const { data, error } = await supa
      .from('billing_plans')
      .upsert(payload, { onConflict: 'shop' })
      .select()
      .maybeSingle();

    if (error) {
      await errlog({
        shop,
        route: '/billing-subscribe',
        status: 500,
        message: 'Upsert failed (paid)',
        detail: error.message,
        request_id,
        code: 'E_DB_WRITE',
      });
      return json({ error: 'db_upsert_failed', detail: error.message }, 500);
    }

    return json({
      ok: true,
      row: data, // ← echo the row for visibility
      confirmation_url: `/apps/engine/thanks?plan=${encodeURIComponent(planKey)}`,
    }, 200);

  } catch (e) {
    await errlog({
      shop: body?.shop || '',
      route: '/billing-subscribe',
      status: 500,
      message: 'Failed to update billing plan',
      detail: e.stack || String(e),
      request_id,
      code: 'E_EXCEPTION',
    });
    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
