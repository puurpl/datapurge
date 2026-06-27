// First-party analytics proxy (Cloudflare Pages Function). Server-side only.
const INSTANCE = "https://analytics.tun0.xyz";
export async function onRequest(context) {
  const { request } = context;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/stats/js/")) {
    const res = await fetch(INSTANCE + path.slice("/stats".length), { cf: { cacheTtl: 21600, cacheEverything: true } });
    const out = new Response(res.body, res); out.headers.set("cache-control","public, max-age=21600"); return out;
  }
  if (path === "/stats/api/event") {
    const fwd = new Request(INSTANCE + "/api/event", request);
    fwd.headers.delete("cookie");
    const ip = request.headers.get("CF-Connecting-IP"); if (ip) fwd.headers.set("X-Forwarded-For", ip);
    return fetch(fwd);
  }
  return new Response("Not found", { status: 404 });
}
