import { sb } from "./_supabase.mjs";

export async function errlog({
  shop = "",
  route = "",
  status = 0,
  message = "",
  detail = "",
  client_id = "",
  level = "error",
}) {
  try {
    const supa = sb();
    await supa.from("function_errors").insert([
      {
        shop,
        client_id,
        level,
        http_status: status,
        message: message?.slice(0, 512) || "",
        detail: detail ? JSON.stringify(detail).slice(0, 2000) : null,
        stack: null,
      },
    ]);
  } catch (e) {
    console.error("[errlog] failed to record error:", e);
  }
}
