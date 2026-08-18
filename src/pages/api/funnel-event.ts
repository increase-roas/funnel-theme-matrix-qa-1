import type { APIRoute } from "astro";
type RuntimeEnv = Record<string, any>;
const sha256 = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.trim().toLowerCase())))).map(byte => byte.toString(16).padStart(2, "0")).join("");
const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 2_000) : "";
const ok = async (response: Promise<Response>) => { const result = await response; if (!result.ok) throw new Error("Integration delivery failed."); return result; };
const sameOrigin = (origin: string | null, requestUrl: string) => {
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(requestUrl).origin; } catch { return false; }
};
const base64Url = (value: Uint8Array | string) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
async function googleAccessToken(env: RuntimeEnv): Promise<string> {
  const email = text(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const pem = String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? "").trim().replace(/\\n/g, "\n");
  if (!email || !pem) throw new Error("Google service account is not configured.");
  const body = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
  const keyBytes = Uint8Array.from(atob(body), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + base64Url(JSON.stringify({ iss: email, scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const tokenResponse = await ok(fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + base64Url(signature) }) }));
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) throw new Error("Google access token was not returned.");
  return token.access_token;
}
async function deliverMeta(payload: any, fields: Record<string, unknown>, request: Request, env: RuntimeEnv) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_ACCESS_TOKEN) throw new Error("Meta is not configured.");
  const user_data: Record<string, unknown> = { external_id: [await sha256(text(payload.lead_uuid))] };
  if (payload.meta?.fbp) user_data.fbp = text(payload.meta.fbp);
  if (payload.meta?.fbc) user_data.fbc = text(payload.meta.fbc);
  const clientIp = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const userAgent = request.headers.get("user-agent");
  if (clientIp) user_data.client_ip_address = clientIp;
  if (userAgent) user_data.client_user_agent = userAgent;
  if (fields.email) user_data.em = [await sha256(text(fields.email))];
  if (fields.phone) user_data.ph = [await sha256(text(fields.phone).replace(/\D/g, ""))];
  if (fields.firstName) user_data.fn = [await sha256(text(fields.firstName))];
  if (fields.lastName) user_data.ln = [await sha256(text(fields.lastName))];
  const { fields: _privateFields, ...safeData } = payload.data ?? {};
  const event = { event_name: text(payload.event_name), event_time: Math.floor(Date.now() / 1000), event_id: text(payload.event_id), action_source: "website", event_source_url: text(payload.page_url), user_data, custom_data: { ...safeData, form_field_names: Object.keys(fields), step_key: text(payload.step_key), page_path: text(payload.page_path), ...(payload.attribution ?? {}) } };
  const version = /^v\d+\.\d+$/.test(text(env.META_GRAPH_API_VERSION)) ? text(env.META_GRAPH_API_VERSION) : "v26.0";
  await ok(fetch(`https://graph.facebook.com/${version}/${env.META_PIXEL_ID}/events`, { method: "POST", headers: { authorization: `Bearer ${env.META_CAPI_ACCESS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ data: [event] }) }));
}
async function deliverGhl(payload: any, fields: Record<string, unknown>, env: RuntimeEnv) {
  if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) throw new Error("GHL is not configured.");
  await ok(fetch("https://services.leadconnectorhq.com/contacts/upsert", { method: "POST", headers: { authorization: `Bearer ${env.GHL_API_KEY}`, version: "2021-04-15", accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: text(fields.firstName), lastName: text(fields.lastName), email: text(fields.email), phone: text(fields.phone), postalCode: text(fields.zip || fields.postalCode), source: "Site Launchpad funnel", tags: ["site-launchpad", "funnel-lead"], customFields: [{ key: "lead_uuid", fieldValue: text(payload.lead_uuid) }], createNewIfDuplicateAllowed: false }) }));
}
async function deliverSheet(payload: any, fields: Record<string, unknown>, env: RuntimeEnv) {
  if (!env.GOOGLE_SHEETS_ID || !env.FUNNEL_DB) throw new Error("Google Sheet is not configured.");
  const requestedTitle = text(env.FUNNEL_SHEET_TAB);
  if (!requestedTitle) throw new Error("Google Sheet funnel tab is not configured.");
  const token = await googleAccessToken(env);
  const spreadsheetBase = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEETS_ID)}`;
  const loadSheets = async () => {
    const metadata = await ok(fetch(spreadsheetBase + "?fields=sheets.properties(sheetId,title,gridProperties.rowCount)", { headers: { authorization: `Bearer ${token}` } }));
    return ((await metadata.json() as any)?.sheets ?? []).map((entry: any) => entry?.properties);
  };
  let sheet = (await loadSheets()).find((properties: any) => text(properties?.title) === requestedTitle);
  if (!sheet) {
    const created = await fetch(spreadsheetBase + ":batchUpdate", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title: requestedTitle } } }] }) });
    if (created.ok) sheet = ((await created.json() as any)?.replies ?? [])[0]?.addSheet?.properties;
    if (!sheet) sheet = (await loadSheets()).find((properties: any) => text(properties?.title) === requestedTitle);
  }
  const sheetId = Number(sheet?.sheetId);
  const sheetTitle = text(sheet?.title);
  const gridRows = Number(sheet?.gridProperties?.rowCount);
  if (!Number.isInteger(sheetId) || !sheetTitle || !Number.isInteger(gridRows) || gridRows < 1) throw new Error("Google Sheet metadata is invalid.");
  const sheetNamespace = text(env.GOOGLE_SHEETS_ID) + ":" + String(sheetId);
  const deliveryKey = "google-sheets:" + sheetNamespace + ":" + text(payload.event_id);
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  const existingRange = encodeURIComponent("'" + escapedTitle + "'!A:K");
  const existing = await ok(fetch(spreadsheetBase + "/values/" + existingRange + "?majorDimension=ROWS", { headers: { authorization: `Bearer ${token}` } }));
  const rows = (await existing.json() as { values?: unknown[][] }).values ?? [];
  if (rows.some(row => text(row[1]) === text(payload.event_id))) return;

  let assignment = await env.FUNNEL_DB.prepare("SELECT sheet_row, status FROM sheet_delivery_rows WHERE delivery_key = ?").bind(deliveryKey).first();
  if (!assignment) {
    await env.FUNNEL_DB.prepare("INSERT OR IGNORE INTO sheet_delivery_counters (sheet_id, next_row) VALUES (?, ?)").bind(sheetNamespace, rows.length + 1).run();
    await env.FUNNEL_DB.prepare("UPDATE sheet_delivery_counters SET next_row = CASE WHEN next_row < ? THEN ? ELSE next_row END WHERE sheet_id = ?").bind(rows.length + 1, rows.length + 1, sheetNamespace).run();
    const allocated = await env.FUNNEL_DB.prepare("UPDATE sheet_delivery_counters SET next_row = next_row + 1 WHERE sheet_id = ? RETURNING next_row - 1 AS sheet_row").bind(sheetNamespace).first();
    const allocatedRow = Number(allocated?.sheet_row);
    if (!Number.isInteger(allocatedRow) || allocatedRow < 1) throw new Error("Google Sheet row allocation failed.");
    await env.FUNNEL_DB.prepare("INSERT OR IGNORE INTO sheet_delivery_rows (delivery_key, event_id, sheet_id, sheet_row, status, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)").bind(deliveryKey, text(payload.event_id), sheetNamespace, allocatedRow, new Date().toISOString()).run();
    assignment = await env.FUNNEL_DB.prepare("SELECT sheet_row, status FROM sheet_delivery_rows WHERE delivery_key = ?").bind(deliveryKey).first();
  }
  const sheetRow = Number(assignment?.sheet_row);
  if (!Number.isInteger(sheetRow) || sheetRow < 1) throw new Error("Google Sheet row assignment is invalid.");
  if (sheetRow > gridRows) {
    await ok(fetch(spreadsheetBase + ":batchUpdate", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: Math.max(1000, sheetRow - gridRows) } }] }) }));
  }
  const rowRange = encodeURIComponent("'" + escapedTitle + "'!A" + sheetRow + ":K" + sheetRow);
  const values = [[new Date().toISOString(), text(payload.event_id), text(payload.lead_uuid), text(fields.firstName), text(fields.lastName), text(fields.email), text(fields.phone), text(fields.zip || fields.postalCode), text(payload.page_url), JSON.stringify(payload.attribution ?? {}), JSON.stringify(payload.data?.answers ?? {})]];
  await ok(fetch(spreadsheetBase + "/values/" + rowRange + "?valueInputOption=RAW", { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ majorDimension: "ROWS", values }) }));
  await env.FUNNEL_DB.prepare("UPDATE sheet_delivery_rows SET status = 'delivered', updated_at = ? WHERE delivery_key = ? AND sheet_row = ?").bind(new Date().toISOString(), deliveryKey, sheetRow).run();
}
async function deliverAlert(payload: any, fields: Record<string, unknown>, env: RuntimeEnv) {
  if (!env.ALERT_WEBHOOK_URL) return;
  await ok(fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: text(payload.event_id), leadUuid: text(payload.lead_uuid), pageUrl: text(payload.page_url), fields, answers: payload.data?.answers ?? {}, attribution: payload.attribution ?? {} }) }));
}
async function ensureTables(env: RuntimeEnv) {
  if (!env.FUNNEL_DB) throw new Error("FUNNEL_DB is not configured.");
  await env.FUNNEL_DB.prepare("CREATE TABLE IF NOT EXISTS funnel_leads (lead_uuid TEXT PRIMARY KEY, first_event_id TEXT NOT NULL, first_url TEXT NOT NULL, original_query_string TEXT NOT NULL, fbc TEXT, fbp TEXT, ip_address TEXT, user_agent TEXT, email_hash TEXT, phone_hash TEXT, first_name_hash TEXT, last_name_hash TEXT, created_at TEXT NOT NULL)").run();
  await env.FUNNEL_DB.prepare("CREATE TABLE IF NOT EXISTS downstream_conversions (external_id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, lead_uuid TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT)").run();
  await env.FUNNEL_DB.prepare("CREATE TABLE IF NOT EXISTS sheet_delivery_counters (sheet_id TEXT PRIMARY KEY, next_row INTEGER NOT NULL)").run();
  await env.FUNNEL_DB.prepare("CREATE TABLE IF NOT EXISTS sheet_delivery_rows (delivery_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, sheet_id TEXT NOT NULL, sheet_row INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL, UNIQUE(sheet_id, sheet_row))").run();
}
async function storeOriginalLead(payload: any, fields: Record<string, unknown>, request: Request, env: RuntimeEnv) {
  await ensureTables(env);
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const userAgent = request.headers.get("user-agent") || "";
  await env.FUNNEL_DB.prepare("INSERT OR IGNORE INTO funnel_leads (lead_uuid, first_event_id, first_url, original_query_string, fbc, fbp, ip_address, user_agent, email_hash, phone_hash, first_name_hash, last_name_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(text(payload.lead_uuid), text(payload.event_id), text(payload.original?.first_url || payload.page_url), text(payload.original?.original_query_string), text(payload.meta?.fbc), text(payload.meta?.fbp), ip, userAgent, fields.email ? await sha256(text(fields.email)) : "", fields.phone ? await sha256(text(fields.phone).replace(/\D/g, "")) : "", fields.firstName ? await sha256(text(fields.firstName)) : "", fields.lastName ? await sha256(text(fields.lastName)) : "", new Date().toISOString()).run();
}
export const POST: APIRoute = async ({ request, locals }) => {
  if (Number(request.headers.get("content-length") || 0) > 65_536) return new Response(null, { status: 413 });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return new Response(null, { status: 415 });
  const origin = request.headers.get("origin");
  if (!sameOrigin(origin, request.url)) return new Response(null, { status: 403 });
  const payload = await request.json().catch(() => null) as any;
  if (!payload || !/^[0-9a-f-]{36}$/i.test(text(payload.event_id)) || !/^[0-9a-f-]{36}$/i.test(text(payload.lead_uuid))) return new Response(null, { status: 400 });
  const env = ((locals as any).runtime?.env ?? {}) as RuntimeEnv;
  const fields = payload.data?.fields && typeof payload.data.fields === "object" ? payload.data.fields as Record<string, unknown> : {};
  if (Object.keys(fields).length > 0) {
    try { await storeOriginalLead(payload, fields, request, env); }
    catch { return new Response(null, { status: 502 }); }
  }
  const deliveries: Promise<unknown>[] = [deliverMeta(payload, fields, request, env)];
  if (Object.keys(fields).length > 0) deliveries.push(deliverGhl(payload, fields, env), deliverSheet(payload, fields, env), deliverAlert(payload, fields, env));
  const results = await Promise.allSettled(deliveries);
  return new Response(null, { status: results.every(result => result.status === "fulfilled") ? 202 : 502 });
};
