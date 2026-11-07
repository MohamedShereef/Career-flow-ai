/*
 * CareerFlow form filler — runs in the employer's page (content script) when the user clicks
 * "Fill this application". It reads the form with the same reader CareerFlow's server uses
 * (window.__cfExtract, generated from page-scripts.ts), fills each field with the answer the user
 * reviewed, and shows a small panel. It never presses Submit and never touches robot checks:
 * the user does those.
 */
(() => {
  if (window.__cfFill) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const loose = (s) => clean(s).toLowerCase().replace(/[’'`]s\b/g, "s").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\b(\w{3,})s\b/g, "$1").trim();
  const digits = (s) => String(s ?? "").replace(/\D/g, "");
  const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const byKey = (key) => [...document.querySelectorAll(`[data-cf-key="${CSS.escape(key)}"]`)];

  function setValue(el, v) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    el.dispatchEvent(new Event("blur", { bubbles: false }));
  }
  const same = (a, b) => {
    const x = clean(a).toLowerCase(), y = clean(b).toLowerCase();
    if (x === y || loose(a) === loose(b)) return true;
    const dx = digits(a), dy = digits(b);
    return dx.length >= 4 && dx === dy || (dx.length >= 8 && dy.length >= 8 && dx.slice(-9) === dy.slice(-9));
  };
  function optionLabel(o) { return clean(o.innerText || o.textContent || o.getAttribute("aria-label") || o.value); }
  function pickFrom(options, want) {
    const list = options.filter((o) => optionLabel(o));
    return list.find((o) => clean(optionLabel(o)).toLowerCase() === clean(want).toLowerCase())
      || list.find((o) => loose(optionLabel(o)) === loose(want))
      || (/^(yes|y|true)$/i.test(want) ? list.find((o) => /^\s*yes\b/i.test(optionLabel(o))) : null)
      || (/^(no|n|false)$/i.test(want) ? list.find((o) => /^\s*no\b/i.test(optionLabel(o))) : null)
      || (list.filter((o) => loose(optionLabel(o)).includes(loose(want))).length === 1 ? list.find((o) => loose(optionLabel(o)).includes(loose(want))) : null);
  }
  function popupOf(el) {
    const ids = [el.getAttribute("aria-controls"), el.getAttribute("aria-owns")].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
    for (const id of ids) { const p = document.getElementById(id); if (p) return p; }
    return null;
  }
  async function chooseInList(el, want) {
    el.scrollIntoView({ block: "center" });
    el.click();
    await sleep(500);
    let pop = popupOf(el);
    let options = [...(pop || document).querySelectorAll("[role=option]")].filter((o) => !pop ? vis(o) : true);
    if (!options.length && (el.tagName === "INPUT" && !el.readOnly)) {
      setValue(el, want.slice(0, 4));
      el.focus();
      await sleep(900);
      pop = popupOf(el);
      options = [...(pop || document).querySelectorAll("[role=option]")].filter((o) => !pop ? vis(o) : true);
    }
    const opt = pickFrom(options, want);
    if (!opt) { document.body.click(); return false; }
    opt.scrollIntoView({ block: "nearest" });
    opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    opt.click();
    await sleep(400);
    return true;
  }
  const b64ToFile = (f) => {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.filename, { type: f.mimeType || "application/pdf" });
  };

  async function fillOne(field, answer, files) {
    const els = byKey(field.key);
    const el = els[0];
    if (!el) return "field not found";
    const v = answer.value;
    switch (field.type) {
      case "file": {
        const list = (answer.file || []).map((f) => files[f.documentId]).filter(Boolean);
        if (!list.length) return "file not available";
        if (el.tagName !== "INPUT") return "upload button — attach it yourself";
        const dt = new DataTransfer();
        for (const f of el.multiple ? list : list.slice(0, 1)) dt.items.add(b64ToFile(f));
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(1200);
        return el.files.length ? "" : "the page didn't take the file";
      }
      case "radio": {
        const r = els.find((g) => same((g.labels && g.labels[0] && g.labels[0].innerText) || g.getAttribute("aria-label") || g.value, String(v)))
          || els.find((g) => loose((g.labels && g.labels[0] && g.labels[0].innerText) || g.value).includes(loose(String(v))));
        if (!r) return `option "${v}" not found`;
        (r.labels && r.labels[0] && !vis(r) ? r.labels[0] : r).click();
        await sleep(150);
        return r.checked ? "" : "the page didn't keep the choice";
      }
      case "checkbox": {
        if (el.checked !== !!v) ((el.labels && el.labels[0] && !vis(el)) ? el.labels[0] : el).click();
        await sleep(100);
        return el.checked === !!v ? "" : "the page didn't keep the tick";
      }
      case "checkbox_group": {
        for (const want of Array.isArray(v) ? v : [v]) {
          const c = els.find((g) => same((g.labels && g.labels[0] && g.labels[0].innerText) || g.value, want));
          if (c && !c.checked) ((c.labels && c.labels[0] && !vis(c)) ? c.labels[0] : c).click();
        }
        return "";
      }
      case "select": {
        const o = pickFrom([...el.options], String(v));
        if (!o) return `option "${v}" not in the list`;
        setValue(el, o.value);
        return "";
      }
      case "combobox":
      case "listbox": {
        if (same(el.value || el.innerText, String(v))) return "";
        return (await chooseInList(el, String(v))) ? "" : `option "${v}" not found in the list`;
      }
      default: {
        if (v == null) return "";
        if (same(el.value, String(v))) return "";
        setValue(el, String(v));
        await sleep(400);
        // Kept as written, or as the site formats it ("30,999" for 30999).
        if (same(el.value, String(v))) return "";
        // Fields that keep only a picked suggestion (city / address autocompletes).
        const first = String(v).split(/[,،]/)[0].trim();
        if (first.length >= 3 && el.tagName === "INPUT") {
          el.focus();
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          desc.set.call(el, first);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(900);
          const pop = popupOf(el);
          const opts = [...(pop || document).querySelectorAll("[role=option], .pac-item")].filter(vis);
          const opt = opts.find((o) => clean(optionLabel(o)).toLowerCase() === clean(String(v)).toLowerCase()) || opts.find((o) => loose(optionLabel(o)).startsWith(loose(first)));
          if (opt) {
            opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            opt.click();
            await sleep(500);
            if (clean(el.value)) return "";
          }
        }
        return "the page didn't keep it — type it yourself";
      }
    }
  }

  // ── Panel ──
  function panel() {
    let host = document.getElementById("careerflow-panel");
    if (!host) {
      host = document.createElement("div");
      host.id = "careerflow-panel";
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
      document.documentElement.appendChild(host);
      host.attachShadow({ mode: "open" });
    }
    return host.shadowRoot;
  }
  function render(state) {
    const root = panel();
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const todo = state.items.filter((i) => i.problem);
    root.innerHTML = `
      <style>
        .box{font:13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;width:340px;max-height:70vh;overflow:auto;background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:12px}
        h3{margin:0 0 6px;font-size:14px} .muted{color:#64748b} .ok{color:#15803d} .warn{color:#b45309}
        ul{margin:6px 0;padding-left:16px} li{margin:3px 0} button{font:inherit;cursor:pointer;border:1px solid #cbd5e1;background:#f8fafc;border-radius:6px;padding:2px 8px}
        .primary{background:#4f46e5;color:#fff;border-color:#4f46e5;padding:6px 10px} .row{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px}
      </style>
      <div class="box">
        <h3>CareerFlow · ${esc(state.title)}</h3>
        <div class="${todo.length ? "warn" : "ok"}">${state.status}</div>
        ${todo.length ? `<div class="muted" style="margin-top:6px">Please fill these yourself:</div><ul>${todo.map((i, n) => `<li><b>${esc(i.label)}</b>: ${esc(Array.isArray(i.value) ? i.value.join(", ") : i.value ?? "")} <button data-copy="${n}">Copy</button><br><span class="muted">${esc(i.problem)}</span></li>`).join("")}</ul>` : ""}
        <div class="muted" style="margin-top:6px">Check the form, tick any “Verify you are human” box, then press the site's Submit button yourself.</div>
        <div class="row"><button data-act="sent" class="primary">I submitted it</button><button data-act="close">Close</button></div>
      </div>`;
    root.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => { const i = todo[Number(b.getAttribute("data-copy"))]; navigator.clipboard.writeText(String(Array.isArray(i.value) ? i.value.join(", ") : i.value ?? "")); b.textContent = "Copied"; }));
    root.querySelector('[data-act="close"]').addEventListener("click", () => document.getElementById("careerflow-panel")?.remove());
    root.querySelector('[data-act="sent"]').addEventListener("click", () => window.__cfReportSent && window.__cfReportSent("button"));
  }

  // ── Notice when the employer's page confirms the application ──
  const CONFIRM = /thank you for (your )?appl|application (has been |was )?(received|submitted|sent)|successfully (submitted|applied)|we('|’)ve received your application|your application is complete/i;
  function watchForConfirmation(onSent) {
    let done = false;
    const check = () => {
      if (done) return;
      const t = (document.body && document.body.innerText) || "";
      if (CONFIRM.test(t.slice(0, 20000))) { done = true; onSent(t.match(CONFIRM)[0]); }
    };
    const mo = new MutationObserver(() => check());
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    const iv = setInterval(check, 2000);
    setTimeout(() => { mo.disconnect(); clearInterval(iv); }, 30 * 60 * 1000);
  }

  window.__cfFill = async function fill(data, files, report) {
    window.__cfReportSent = (how) => report({ applicationId: data.applicationId, how });
    const read = window.__cfExtract();
    const fields = read.fields;
    const items = [];
    for (const a of data.answers) {
      const f = fields.find((x) => x.key === a.key) || fields.find((x) => loose(x.label) === loose(a.label)) || fields.find((x) => loose(x.label).startsWith(loose(a.label).slice(0, 25)) && a.label.length > 8);
      if (!f) { items.push({ label: a.label, value: a.file ? a.file.map((x) => x.filename).join(", ") : a.value, problem: "not found on this page" }); continue; }
      let problem = "";
      try { problem = await fillOne(f, a, files); } catch (e) { problem = String(e && e.message || e).slice(0, 80); }
      items.push({ label: a.label, value: a.file ? a.file.map((x) => x.filename).join(", ") : a.value, problem });
    }
    const filled = items.filter((i) => !i.problem).length;
    const state = { title: `${data.jobTitle} · ${data.company}`, status: `Filled ${filled} of ${items.length} answers${read.captcha ? " · robot check on the page" : ""}.`, items };
    render(state);
    watchForConfirmation((text) => report({ applicationId: data.applicationId, how: "page", confirmation: text }));
    return { filled, total: items.length, problems: items.filter((i) => i.problem).map((i) => `${i.label}: ${i.problem}`) };
  };
})();
