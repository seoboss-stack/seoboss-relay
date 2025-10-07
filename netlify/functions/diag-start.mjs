// netlify/functions/diag-start.mjs
export default async (req) => {
  const now = new Date().toISOString();
  const n8n = process.env.N8N_JOB_WEBHOOK_URL || null;
  const secretSet = !!(process.env.FORWARD_SECRET || '');
  const supaUrl = process.env.SUPABASE_URL ? 'set' : 'missing';

  return new Response(
    JSON.stringify({
      ok: true,
      marker: 'diag-start@v1',
      now,
      env: {
        N8N_JOB_WEBHOOK_URL: n8n,
        FORWARD_SECRET_set: secretSet,
        SUPABASE_URL: supaUrl
      }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
};
