export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
    const { shop = '' } = JSON.parse(event.body || '{}');

    // Your production n8n base (matches your setup)
    const base = process.env.N8N_ENGINE_BASE_URL || 'https://blogengine.ngrok.app/webhook/seoboss';
    const target = `${base}/api/shop/import-articles`;  // your importer path

    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'X-SEOBOSS-FORWARD-SECRET': process.env.FORWARD_SECRET || '',
        'X-Seoboss-Ts': String(Math.floor(Date.now()/1000)),
      },
      body: JSON.stringify({ shop })
    });

    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'text/plain' },
      body: text
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
