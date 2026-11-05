/**
 * Code that runs inside the employer's page. Kept as plain JS strings so the
 * worker doesn't need DOM typings. Every field found gets a stable
 * `data-cf-key` derived from its name/id/label so a later visit (the submit
 * step) addresses exactly the same fields.
 */

export const EXTRACT = String.raw`(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const textOf = (el) => clean(el ? el.innerText || el.textContent : "");
  const score = (f) => f.querySelectorAll("input,select,textarea").length + (f.querySelector("input[type=file]") ? 20 : 0) + (f.querySelector("input[type=email]") ? 10 : 0);
  const forms = [...document.querySelectorAll("form")].sort((a, b) => score(b) - score(a));
  const root = forms[0] && score(forms[0]) >= 3 ? forms[0] : document.body;

  const near = (el, max) => {
    let c = el.parentElement;
    for (let i = 0; i < max && c && c !== document.body; i++, c = c.parentElement) {
      const l = c.querySelector("label, legend, [class*='label'], [class*='question'], h3, h4");
      if (l && !l.contains(el) && !l.querySelector("input,select,textarea") && textOf(l)) return textOf(l);
    }
    return "";
  };
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && textOf(l)) return textOf(l);
    }
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = clean(lb.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(" "));
      if (t) return t;
    }
    const al = el.getAttribute("aria-label");
    if (al && clean(al)) return clean(al);
    const wrap = el.closest("label");
    if (wrap && textOf(wrap)) return textOf(wrap);
    return near(el, 4) || clean(el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "");
  };
  const groupLabel = (el) => {
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (lg && textOf(lg)) return textOf(lg); }
    const rg = el.closest("[role=radiogroup],[role=group]");
    if (rg) {
      const lb = rg.getAttribute("aria-labelledby");
      if (lb) { const t = clean(lb.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(" ")); if (t) return t; }
      if (rg.getAttribute("aria-label")) return clean(rg.getAttribute("aria-label"));
    }
    return near(el, 5) || el.name || "";
  };
  const isReq = (el, label) => el.required || el.getAttribute("aria-required") === "true" || /\*/.test(label);
  const strip = (l) => clean(l.replace(/\*/g, " ").replace(/\(required\)/i, ""));

  const counts = new Map();
  const mkKey = (type, base) => {
    const k = type + ":" + clean(String(base)).toLowerCase().slice(0, 80);
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    return n > 1 ? k + "#" + n : k;
  };

  const fields = [];
  const seenGroups = new Set();
  for (const el of root.querySelectorAll("input, select, textarea")) {
    const t = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "search", "password"].includes(t)) continue;
    if (el.disabled) continue;
    if (t === "radio" || t === "checkbox") {
      const group = el.name ? [...root.querySelectorAll('input[type="' + t + '"][name="' + CSS.escape(el.name) + '"]')] : [el];
      if (el.name) { if (seenGroups.has(t + ":" + el.name)) continue; seenGroups.add(t + ":" + el.name); }
      if (!group.some((g) => vis(g) || [...(g.labels || [])].some(vis))) continue;
      const optLabel = (g) => clean((g.labels && g.labels[0] && textOf(g.labels[0])) || g.getAttribute("aria-label") || g.value);
      if (t === "checkbox" && group.length === 1) {
        const raw = optLabel(el) || labelFor(el);
        const key = mkKey("checkbox", el.name || el.id || raw);
        el.setAttribute("data-cf-key", key);
        fields.push({ key, label: strip(raw), type: "checkbox", required: isReq(el, raw) });
      } else {
        const raw = groupLabel(el);
        const type = t === "radio" ? "radio" : "checkbox_group";
        const key = mkKey(type, el.name || raw);
        group.forEach((g) => g.setAttribute("data-cf-key", key));
        fields.push({ key, label: strip(raw), type, required: group.some((g) => g.required || g.getAttribute("aria-required") === "true") || /\*/.test(raw), options: group.map(optLabel) });
      }
      continue;
    }
    if (t !== "file" && !vis(el)) continue;
    if (el.readOnly && t !== "file") continue;
    const raw = labelFor(el);
    const type = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : t === "file" ? "file" : el.getAttribute("role") === "combobox" ? "combobox" : ["email", "tel", "url", "number", "date"].includes(t) ? t : "text";
    const key = mkKey(type, el.name || el.id || raw);
    el.setAttribute("data-cf-key", key);
    const f = { key, label: strip(raw), type, required: isReq(el, raw) };
    if (type === "select") f.options = [...el.options].filter((o) => o.value !== "" && !/^(select|choose|please select|--)/i.test(o.text.trim())).map((o) => clean(o.text));
    if (type === "file") f.accept = el.getAttribute("accept");
    fields.push(f);
  }

  // Custom dropdowns (Workday and others): a button that opens a listbox.
  for (const el of root.querySelectorAll('button[aria-haspopup="listbox"], [role="combobox"][aria-haspopup="listbox"]:not(input)')) {
    if (!vis(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    const raw = labelFor(el);
    const key = mkKey("listbox", el.getAttribute("name") || el.id || el.getAttribute("data-automation-id") || raw);
    el.setAttribute("data-cf-key", key);
    fields.push({ key, label: strip(raw), type: "listbox", required: el.getAttribute("aria-required") === "true" || /\*/.test(raw), options: [] });
  }

  const captcha = !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], iframe[src*="hcaptcha.com"][src*="checkbox"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha:not([data-size="invisible"]) iframe');
  const password = [...document.querySelectorAll("input[type=password]")].some(vis);
  return { fields, captcha, password, title: document.title };
})()`;

/** Find "Apply" buttons/links on a job page that doesn't show the form yet. */
export const FIND_APPLY = String.raw`(() => {
  const re = /^\s*(apply\b[\w\s'’-]{0,30}|i'?m interested|interested\?|start (your |an )?application|submit (an |your )?(application|cv|resume)|send (your )?(cv|resume)|quick apply|تقدم[\s\S]{0,15}|قدم الآن|التقديم[\s\S]{0,15})\s*$/i;
  const bad = /\b(linkedin|indeed|with google|with facebook|sign in|log in|filter|search|save|share|alert)\b/i;
  const label = (e) => (e.innerText || e.getAttribute("aria-label") || e.getAttribute("title") || e.value || "").replace(/\s+/g, " ").trim();
  const seen = new Set();
  const els = [...document.querySelectorAll("a, button, [role=button], input[type=button], input[type=submit]")].filter((e) => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const t = label(e);
    const href = e.getAttribute("href") || "";
    const ok = (re.test(t) && !bad.test(t)) || (/\/apply(\b|\/|\?|$)/i.test(href) && t.length < 40 && !bad.test(t));
    if (!ok || seen.has(href + t)) return false;
    seen.add(href + t);
    return true;
  });
  // "Apply Manually" (Workday) first, then the shortest "Apply" / "Apply now".
  const rank = (e) => (/apply manually/i.test(label(e)) ? -100 : 0) + label(e).length;
  els.sort((a, b) => rank(a) - rank(b));
  els.forEach((e, i) => e.setAttribute("data-cf-apply", String(i)));
  return els.length;
})()`;

/** Read back what is actually in each field. */
export const READBACK = String.raw`((keys) => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const out = {};
  for (const key of keys) {
    const els = [...document.querySelectorAll('[data-cf-key="' + CSS.escape(key) + '"]')];
    if (!els.length) { out[key] = null; continue; }
    const el = els[0];
    const t = (el.getAttribute("type") || el.tagName).toLowerCase();
    const lab = (g) => clean((g.labels && g.labels[0] && (g.labels[0].innerText || g.labels[0].textContent)) || g.getAttribute("aria-label") || g.value);
    if (t === "file") out[key] = el.files ? [...el.files].map((f) => f.name) : [];
    else if (t === "radio") out[key] = (els.find((g) => g.checked) && lab(els.find((g) => g.checked))) || "";
    else if (t === "checkbox" && els.length === 1) out[key] = el.checked;
    else if (t === "checkbox") out[key] = els.filter((g) => g.checked).map(lab);
    else if (el.tagName === "SELECT") out[key] = el.selectedOptions[0] ? clean(el.selectedOptions[0].text) : "";
    else if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") out[key] = clean(el.innerText || el.textContent);
    else out[key] = el.value;
  }
  return out;
})`;

/** Index of the radio/checkbox option whose label matches the wanted text. */
export const OPTION_INDEX = String.raw`(([key, wanted]) => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const els = [...document.querySelectorAll('[data-cf-key="' + CSS.escape(key) + '"]')];
  const lab = (g) => clean((g.labels && g.labels[0] && (g.labels[0].innerText || g.labels[0].textContent)) || g.getAttribute("aria-label") || g.value);
  return els.findIndex((g) => lab(g) === clean(wanted));
})`;

/** Tag the form's submit button. */
export const FIND_SUBMIT = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const forms = [...document.querySelectorAll("form")].filter((f) => f.querySelector("[data-cf-key]"));
  const scope = forms[0] || document.body;
  let cands = [...scope.querySelectorAll("button[type=submit], input[type=submit]")].filter(vis);
  if (!cands.length) {
    const re = /^\s*(submit( application)?|apply|send( application)?|complete application|إرسال|تقديم)\s*$/i;
    cands = [...scope.querySelectorAll("button, [role=button], input[type=button]")].filter((e) => vis(e) && re.test((e.innerText || e.value || "").trim()));
  }
  const el = cands[cands.length - 1];
  if (!el) return false;
  el.setAttribute("data-cf-submit", "1");
  return true;
})()`;

/** After pressing Submit: what does the page say now? */
export const OUTCOME = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const body = (document.body && document.body.innerText) || "";
  const ok = /thank(s| you)[\s\S]{0,160}(appl|interest|submi)|application (has been |was |is )?(received|submitted|sent|complete)|we('ve| have) received your application|successfully (submitted|applied|sent)|your application (is complete|is on its way|has been sent)|شكرا[\s\S]{0,60}(تقديم|طلب)|تم (استلام|إرسال|تقديم)/i;
  const m = body.match(ok);
  const errs = [...document.querySelectorAll('[aria-invalid="true"], .error, .errors, .field-error, .invalid-feedback, [class*="error-message"], [role=alert]')]
    .filter((e) => vis(e) && (e.innerText || "").trim().length > 1)
    .map((e) => (e.innerText || "").trim().slice(0, 120))
    .slice(0, 6);
  const challenge = [...document.querySelectorAll('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"], iframe[src*="hcaptcha.com"][src*="challenge"]')].some(vis);
  const submitStill = !!document.querySelector("[data-cf-submit]") && vis(document.querySelector("[data-cf-submit]"));
  return { confirmed: !!m, confirmation: m ? body.slice(Math.max(0, m.index - 40), m.index + 200).replace(/\s+/g, " ").trim() : "", errors: errs, challenge, submitStill };
})()`;

/** Interstitial "are you human" pages (Cloudflare, Akamai, PerimeterX, DataDome, Imperva). */
export const BOT_CHECK = String.raw`(() => {
  const t = (document.title || "") + " " + ((document.body && document.body.innerText) || "").slice(0, 3000);
  return /just a moment|attention required|verify (that )?you are (a )?human|are you a robot|checking (if the site connection is secure|your browser)|press (&|and) hold|pardon our interruption|access (to this page has been )?denied|request unsuccessful|unusual traffic|security check|enable javascript and cookies to continue/i.test(t)
    || !!document.querySelector("#challenge-form, #cf-challenge-running, #px-captcha, [id^=sec-if-cpt], iframe[src*='captcha-delivery.com']");
})()`;

/** Sign-in screen: tag the username, password, submit and "switch to sign in" elements. */
export const LOGIN_INFO = String.raw`(() => {
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const txt = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  document.querySelectorAll("[data-cf-login]").forEach((e) => e.removeAttribute("data-cf-login"));
  const pw = [...document.querySelectorAll("input[type=password]")].filter(vis);
  const body = ((document.body && document.body.innerText) || "").slice(0, 6000);
  const verification = /verification code|one[- ]time (pass)?code|enter the code|security code|two[- ](step|factor)|authenticator app|verify your (email|identity|account)|we('ve| have) sent (you )?(a|an) (code|email)/i.test(body);
  const errors = [...document.querySelectorAll('[role=alert], .error, [class*="error"], [data-automation-id*="error"]')].filter(vis).map(txt).filter((t) => t.length > 3 && t.length < 200).slice(0, 4);
  if (!pw.length) return { passwords: 0, createMode: false, canSwitch: false, hasUser: false, hasSubmit: false, verification, errors };
  const scope = pw[0].closest("form") || pw[0].closest("[role=dialog]") || document.body;
  const createRe = /create (an |your )?account|register|sign ?up|join/i;
  const submits = [...scope.querySelectorAll('button, [role=button], input[type=submit]')].filter(vis);
  const submit = submits.find((e) => /^(sign ?in|log ?in|login|continue|next|submit)$/i.test(txt(e))) || submits.find((e) => (e.getAttribute("type") || "") === "submit" && !createRe.test(txt(e)));
  const createMode = pw.length >= 2 || (!submit && submits.some((e) => createRe.test(txt(e))));
  const sw = [...document.querySelectorAll('a, button, [role=button]')].filter(vis).find((e) => e !== submit && /^(sign ?in|log ?in|already have an account\??( sign ?in)?|i already have an account|existing (user|candidate).*)$/i.test(txt(e)));
  const inputs = [...scope.querySelectorAll("input")].filter((e) => vis(e) && ["email", "text", ""].includes((e.getAttribute("type") || "").toLowerCase()));
  const user = inputs.find((e) => /user|email|login|mail|account/i.test([e.name, e.id, e.getAttribute("autocomplete"), e.getAttribute("aria-label"), e.placeholder, e.getAttribute("data-automation-id")].join(" "))) || inputs[0];
  if (user) user.setAttribute("data-cf-login", "user");
  pw[0].setAttribute("data-cf-login", "pass");
  if (submit) submit.setAttribute("data-cf-login", "submit");
  if (sw) sw.setAttribute("data-cf-login", "switch");
  return { passwords: pw.length, createMode, canSwitch: !!sw, hasUser: !!user, hasSubmit: !!submit, verification, errors };
})()`;

/** Wizard navigation on the current step: is there a Next, a final Submit, or neither? */
export const FIND_NAV = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const txt = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  document.querySelectorAll("[data-cf-next]").forEach((e) => e.removeAttribute("data-cf-next"));
  const btns = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')].filter((e) => vis(e) && !e.disabled && e.getAttribute("aria-disabled") !== "true");
  // "Next" is unambiguous; "Continue"/"Review" only count when the page clearly shows steps,
  // because on some sites "Continue" is the final submit.
  const strongNext = /^(next|save (and|&) continue|save (and|&) next|next step|التالي)$/i;
  const weakNext = /^(continue|proceed|review|متابعة)$/i;
  const body = ((document.body && document.body.innerText) || "").slice(0, 8000);
  const stepped = /\bstep \d+ of \d+\b|\b\d+ of \d+ steps\b|الخطوة \d+/i.test(body) || !!document.querySelector('[aria-current="step"], [role=progressbar], [data-automation-id*="progressBar"], [class*="stepper"], [class*="progress-step"]');
  const submitRe = /^(submit( (application|my application))?|apply|send( application)?|complete( application)?|finish|إرسال|تقديم)$/i;
  const wdNext = (e) => /^(bottom-navigation-next-button|pageFooterNextButton)$/.test(e.getAttribute("data-automation-id") || "");
  const next = btns.find((e) => !submitRe.test(txt(e)) && (strongNext.test(txt(e)) || wdNext(e) || (stepped && weakNext.test(txt(e)))));
  const submit = btns.find((e) => submitRe.test(txt(e)));
  if (next) next.setAttribute("data-cf-next", "1");
  return { next: !!next, submit: !!submit };
})()`;

/** Visible options of an open listbox. */
export const LISTBOX_OPTIONS = String.raw`(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('[role=listbox] [role=option], [role=option]')].filter(vis).map((o) => (o.innerText || o.textContent || "").replace(/\s+/g, " ").trim()).filter((t) => t && !/^(select one|select|none)$/i.test(t)).slice(0, 80);
})()`;

/** Choose a radio/checkbox option by its label like a person would (DOM click fires the page's own handlers). */
export const CHOOSE = String.raw`(([key, wanted, on]) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const els = [...document.querySelectorAll('[data-cf-key="' + CSS.escape(key) + '"]')];
  const lab = (g) => norm((g.labels && g.labels[0] && (g.labels[0].innerText || g.labels[0].textContent)) || g.getAttribute("aria-label") || g.value);
  const w = norm(wanted);
  let i = els.findIndex((g) => lab(g) === w);
  if (i < 0) i = els.findIndex((g) => lab(g).startsWith(w) || w.startsWith(lab(g)));
  if (i < 0 && els.length === 1) i = 0;
  if (i < 0) return { index: -1, checked: false };
  const el = els[i];
  const want = on !== false;
  if (el.checked !== want) {
    el.scrollIntoView({ block: "center" });
    (el.labels && el.labels[0] && getComputedStyle(el).opacity === "0" ? el.labels[0] : el).click();
    if (el.checked !== want) el.click();
  }
  return { index: i, checked: el.checked === want };
})`;

/** Set a native <select> by visible text and fire the events frameworks listen to. */
export const SET_SELECT = String.raw`(([key, wanted]) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const el = document.querySelector('[data-cf-key="' + CSS.escape(key) + '"]');
  if (!el || el.tagName !== "SELECT") return false;
  const w = norm(wanted);
  const opts = [...el.options];
  const o = opts.find((x) => norm(x.text) === w) || opts.find((x) => norm(x.text).startsWith(w)) || opts.find((x) => norm(x.value) === w);
  if (!o) return false;
  el.value = o.value;
  o.selected = true;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})`;

/** What the page actually has for a field — saved with a failure so it can be fixed precisely. */
export const FIELD_DEBUG = String.raw`((key) => {
  const els = [...document.querySelectorAll('[data-cf-key="' + CSS.escape(key) + '"]')];
  if (!els.length) return { found: false };
  const el = els[0];
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const wrap = el.closest("fieldset, .form-group, [class*='field'], [class*='question'], div") || el.parentElement;
  return {
    found: true,
    count: els.length,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type"),
    role: el.getAttribute("role"),
    visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
    opacity: cs.opacity,
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    value: el.tagName === "SELECT" ? (el.selectedOptions[0] ? el.selectedOptions[0].text : "") : (el.type === "radio" || el.type === "checkbox") ? els.filter((g) => g.checked).map((g) => g.value) : (el.value ?? el.innerText),
    options: el.tagName === "SELECT" ? [...el.options].slice(0, 40).map((o) => o.text.trim() + (o.value ? " [" + o.value + "]" : "")) : els.slice(0, 20).map((g) => ((g.labels && g.labels[0] && g.labels[0].innerText) || g.value || "").trim()),
    html: (wrap ? wrap.outerHTML : el.outerHTML).replace(/\s+/g, " ").slice(0, 1500),
  };
})`;

/** A styled dropdown often keeps a real <select> next to it; set that one by visible text. */
export const SET_NEARBY_SELECT = String.raw`(([key, wanted]) => {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const el = document.querySelector('[data-cf-key="' + CSS.escape(key) + '"]');
  if (!el) return false;
  let c = el.parentElement, sel = null;
  for (let i = 0; i < 4 && c && !sel; i++, c = c.parentElement) sel = c.querySelector("select");
  if (!sel) return false;
  const w = norm(wanted);
  const o = [...sel.options].find((x) => norm(x.text) === w) || [...sel.options].find((x) => norm(x.text).startsWith(w));
  if (!o) return false;
  sel.value = o.value; o.selected = true;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})`;

/** The id of the popup a dropdown controls, if it says so. */
export const POPUP_ID = String.raw`((key) => {
  const el = document.querySelector('[data-cf-key="' + CSS.escape(key) + '"]');
  return el ? (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").split(/\s+/)[0] : "";
})`;
