import { logFnError } from "./log.mjs";

export const handler = async (event) => {
  await logFnError({
    fn: "log-smoke",
    message: "hello from smoke test",
    request_id: event.headers?.["x-nf-request-id"] || ""
  });
  console.log("[log-smoke] wrote a row");
  return { statusCode: 200, body: "ok" };
};
