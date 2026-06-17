// CORS ist KEINE Sicherheitskontrolle (Plan A.2.5): stoppt nur fremde Browserseiten,
// nicht curl/Server/Headless. Wird trotzdem auf die erlaubten Origins gesetzt, damit
// die PWA sauber spricht — nicht als Abuse-Schutz.

export function corsHeaders(env, origin) {
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || "");
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, CF-Turnstile-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (allow) h["Access-Control-Allow-Origin"] = allow;
  return h;
}

export function preflight(env, origin) {
  return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
}
