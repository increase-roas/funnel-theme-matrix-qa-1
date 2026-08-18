const STORAGE_KEY = "launchpad_funnel_context_v1";
const ATTRIBUTION_KEYS = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","fbclid","gclid"];
function id() { return crypto.randomUUID(); }
function cookie(name) { return document.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(name + "="))?.slice(name.length + 1) || ""; }
function saveContext(context) { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context)); }
function readContext() {
  let stored = {};
  try { stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}"); } catch {}
  const params = new URLSearchParams(location.search);
  const attribution = { ...(stored.attribution || {}) };
  for (const key of ATTRIBUTION_KEYS) if (params.get(key)) attribution[key] = params.get(key);
  const fbp = cookie("_fbp") || stored.fbp || "";
  const fbc = cookie("_fbc") || stored.fbc || (attribution.fbclid ? "fb.1." + Date.now() + "." + attribution.fbclid : "");
  const context = { lead_uuid: stored.lead_uuid || id(), attribution, fbp, fbc, answers: stored.answers || {}, first_url: stored.first_url || location.href, original_query_string: stored.original_query_string ?? location.search };
  saveContext(context);
  return context;
}
const context = readContext();
async function loadPixel() {
  try {
    const response = await fetch("/api/funnel-config", { headers: { accept: "application/json" } });
    const config = response.ok ? await response.json() : {};
    if (!/^\d{8,20}$/.test(String(config.metaPixelId || ""))) return;
    if (typeof window.fbq !== "function") {
      const fbq = function(){ fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments); };
      fbq.queue = []; fbq.loaded = true; fbq.version = "2.0"; window.fbq = fbq;
      const script = document.createElement("script"); script.async = true; script.src = "https://connect.facebook.net/en_US/fbevents.js";
      document.head.appendChild(script);
    }
    window.fbq("init", String(config.metaPixelId));
  } catch {}
}
async function postEvent(payload) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      const response = await fetch("/api/funnel-event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), keepalive: true });
      if (response.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, Math.min(4000, 250 * (2 ** attempt))));
  }
  return false;
}
async function emit(kind, data = {}, destination = "") {
  const event_id = id();
  const tracking = window.__FUNNEL_TRACKING__ || {};
  const eventName = kind === "answer" ? (tracking.serverEvent || "LeadSurveyAnswer") : (tracking.browserEvent || "ViewContent");
  const payload = { event_id, event_name: eventName, browser_event: eventName, lead_uuid: context.lead_uuid, step_key: tracking.stepKey, page_path: location.pathname, page_url: location.href, original: { first_url: context.first_url, original_query_string: context.original_query_string }, attribution: context.attribution, meta: { fbp: context.fbp, fbc: context.fbc }, data };
  if (typeof window.fbq === "function") {
    const standard = ["PageView","ViewContent","Lead","CompleteRegistration","Purchase"].includes(payload.browser_event);
    const browserData = data.fields ? { form_complete: true, field_names: Object.keys(data.fields) } : data;
    window.fbq(standard ? "track" : "trackCustom", payload.browser_event, { ...browserData, step_key: payload.step_key, page_path: payload.page_path }, { eventID: event_id });
  }
  const delivered = await postEvent(payload);
  if (destination && (delivered || !data.fields)) location.assign(destination);
  if (!delivered && data.fields) {
    let error = document.querySelector("[data-funnel-error]");
    if (!error) { error = document.createElement("p"); error.dataset.funnelError = "true"; error.className = "funnel-error"; error.setAttribute("role", "alert"); document.querySelector("[data-funnel-form]")?.appendChild(error); }
    error.textContent = "We could not send your request yet. Please check your connection and try again.";
  }
}
function rememberAnswer(field, value) {
  if (!field) return;
  context.answers[field] = value;
  saveContext(context);
}
function startCountdown(root) {
  const output = root.querySelector("[data-countdown-value]");
  const end = Date.parse(root.dataset.endsAt || "");
  if (!output || !Number.isFinite(end)) { if (output) output.textContent = "Offer active"; return; }
  const update = () => {
    const remaining = Math.max(0, end - Date.now());
    const days = Math.floor(remaining / 86400000);
    const hours = Math.floor((remaining % 86400000) / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    output.textContent = (days ? days + "d " : "") + [hours, minutes, seconds].map(value => String(value).padStart(2, "0")).join(":");
    return remaining;
  };
  update();
  const timer = window.setInterval(() => { if (update() <= 0) window.clearInterval(timer); }, 1000);
}
async function start() {
  await loadPixel();
  emit("view");
  document.querySelectorAll("[data-countdown]").forEach(startCountdown);
  document.querySelectorAll("[data-survey-question]").forEach(root => root.addEventListener("click", event => {
    const button = event.target.closest("[data-answer]");
    if (!button) return;
    root.querySelectorAll("[data-answer]").forEach(node => node.dataset.selected = String(node === button));
    rememberAnswer(root.dataset.field, button.dataset.answer);
    if (root.dataset.autoAdvance !== "false") emit("answer", { field: root.dataset.field, value: button.dataset.answer, answers: context.answers }, root.dataset.destination || "");
  }));
  document.querySelectorAll("[data-funnel-form]").forEach(form => form.addEventListener("submit", event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const answerField = form.dataset.answerField;
    if (answerField) {
      rememberAnswer(answerField, values[answerField]);
      emit("answer", { field: answerField, value: values[answerField], answers: context.answers }, form.dataset.destination || "");
      return;
    }
    emit("answer", { fields: values, answers: context.answers }, form.dataset.destination || "");
  }));
}
start();
