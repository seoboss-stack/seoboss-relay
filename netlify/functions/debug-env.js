exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      PUBLIC_HMAC_KEY: process.env.PUBLIC_HMAC_KEY || "(missing)",
      FORWARD_SECRET: process.env.FORWARD_SECRET || "(missing)"
    })
  };
};
