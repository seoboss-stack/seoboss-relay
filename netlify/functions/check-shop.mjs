export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
    const { shop = '' } = JSON.parse(event.body || '{}');
    const ok = typeof shop === 'string' && /\.myshopify\.com$/i.test(shop);
    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ ok, shop })
    };
  } catch (e) {
    return { statusCode: 500, body: e?.message || 'error' };
  }
};
