export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" } };
  }

  const fwd = event.headers["x-seoboss-forward-secret"] || "";
  if (!process.env.FORWARD_SECRET || fwd !== process.env.FORWARD_SECRET) {
    return { statusCode: 401, body: "forbidden" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, service: "vault" })
  };
};
