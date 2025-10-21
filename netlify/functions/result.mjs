// netlify/functions/result.mjs
import { sb, json, CORS } from './_lib/_supabase.mjs';
import { errlog } from './_lib/_errlog.mjs';  // ✅ ADD THIS

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  // ✅ ADD THIS - Extract request_id early
  const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') || '';

  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    // prefer App Proxy-supplied shop, fallback to header
    const shop =
      searchParams.get('shop') ||
      req.headers.get('x-shopify-shop-domain') ||
      '';

    if (!jobId || !shop) {
      return json({ error: 'Missing jobId or shop' }, 400);
    }

    const supa = sb();
    const { data, error } = await supa
      .from('jobs')
      .select('*')
      .eq('job_id', jobId)
      .eq('shop', shop.toLowerCase())
      .single();

    // ✅ ADD THIS - Log DB query failures (but NOT 404s - those are expected)
    if (error) {
      // Supabase returns PGRST116 for "not found" - this is expected, don't log it
      if (error.code !== 'PGRST116') {
        await errlog({
          shop: shop.toLowerCase(),
          route: '/result',
          status: 500,
          message: 'Failed to query job status',
          detail: `jobId: ${jobId}, error: ${error.message}`,
          request_id,
          code: 'E_DB_READ'
        });
      }
      return json({ error: 'Not found' }, 404);
    }

    if (!data) return json({ error: 'Not found' }, 404);

    return json({
      jobId,
      shop,
      status: data.status,
      result: data.result_json ?? null,
      error: data.error_text ?? null,
      updatedAt: data.updated_at,
    });

  } catch (e) {
    // ✅ REPLACE console.error - Use errlog
    const { searchParams } = new URL(req.url);
    const shop = searchParams.get('shop') || '';
    const jobId = searchParams.get('jobId') || '';

    await errlog({
      shop: shop.toLowerCase(),
      route: '/result',
      status: 500,
      message: 'Uncaught exception in result endpoint',
      detail: `jobId: ${jobId}, error: ${e.stack || String(e)}`,
      request_id,
      code: 'E_EXCEPTION'
    });

    return json({ error: 'internal', detail: String(e) }, 500);
  }
};
