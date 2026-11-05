/**
 * A single-page mock of a Workday-style candidate portal:
 * job page → Apply → "Apply Manually" → Create Account (switch to Sign In) →
 * Step 1 (My Information, custom dropdown) → Step 2 (resume upload + question) →
 * Step 3 (Review) → Submit → confirmation.
 */
export const PORTAL_USER = { email: "m@example.com", password: "portal-pass-1" };

export const PORTAL_HTML = String.raw`<!doctype html><html><head><title>Purchasing Team Leader – Acme Portal</title>
<style>.hidden{display:none} [role=listbox]{border:1px solid #999;padding:4px} li{list-style:none;padding:2px;cursor:pointer}</style></head>
<body><div id="app"></div>
<script>
const app = document.getElementById("app");
const state = { step: "job", first: "", last: "", country: "", phone: "", auth: "", resume: "" };
function listbox(id, label, options, required) {
  return '<label id="' + id + '-l">' + label + (required ? ' *' : '') + '</label>' +
    '<button type="button" id="' + id + '" aria-haspopup="listbox" aria-labelledby="' + id + '-l"' + (required ? ' aria-required="true"' : '') + '>' + (state[id] || 'Select One') + '</button>' +
    '<ul role="listbox" id="' + id + '-list" class="hidden">' + options.map(o => '<li role="option">' + o + '</li>').join('') + '</ul>';
}
function wireListbox(id) {
  const b = document.getElementById(id), l = document.getElementById(id + "-list");
  b.onclick = () => l.classList.toggle("hidden");
  l.querySelectorAll("[role=option]").forEach(o => o.onclick = () => { state[id] = o.textContent; b.textContent = o.textContent; l.classList.add("hidden"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") l.classList.add("hidden"); });
}
function nav(label, auto) { return '<div>Step ' + ({ info: 1, exp: 2, review: 3 })[state.step] + ' of 3</div><button type="button" data-automation-id="' + auto + '" id="nav">' + label + '</button>'; }
function render() {
  const s = state.step;
  if (s === "job") app.innerHTML = '<h1>Purchasing Team Leader</h1><p>Lead purchasing for HVAC projects.</p><button id="apply">Apply</button><div id="modal"></div>';
  if (s === "choose") app.innerHTML = '<div role="dialog"><button id="autofill">Autofill with Resume</button><button id="manual">Apply Manually</button></div>';
  if (s === "create") app.innerHTML = '<h2>Create Account</h2><form onsubmit="return false"><label for="ce">Email Address *</label><input id="ce" type="email"><label for="cp">Password *</label><input id="cp" type="password"><label for="cp2">Verify New Password *</label><input id="cp2" type="password"><button id="create" type="submit">Create Account</button></form><button id="toSignIn">Sign In</button>';
  if (s === "signin") app.innerHTML = '<h2>Sign In</h2><form id="sf" onsubmit="return false"><label for="se">Email Address *</label><input id="se" type="email" autocomplete="email"><label for="sp">Password *</label><input id="sp" type="password"><button id="signin" type="submit">Sign In</button><div id="err" role="alert"></div></form>';
  if (s === "info") app.innerHTML = '<h2>My Information</h2><form onsubmit="return false"><label for="fn">Given Name(s) *</label><input id="fn" name="legalName--firstName" required value="' + state.first + '"><label for="ln">Family Name *</label><input id="ln" name="legalName--lastName" required value="' + state.last + '">' + listbox("country", "Country", ["Egypt", "Saudi Arabia", "United Arab Emirates"], true) + '<label for="ph">Phone Number *</label><input id="ph" name="phone" type="tel" required value="' + state.phone + '"><div id="err" role="alert"></div></form>' + nav("Save and Continue", "bottom-navigation-next-button");
  if (s === "exp") app.innerHTML = '<h2>My Experience</h2><form onsubmit="return false"><label for="rs">Resume/CV *</label><input id="rs" type="file" data-automation-id="file-upload-input-ref">' + listbox("auth", "Are you legally authorized to work in Saudi Arabia?", ["Yes", "No"], true) + '<div id="err" role="alert"></div></form>' + nav("Save and Continue", "bottom-navigation-next-button");
  if (s === "review") app.innerHTML = '<h2>Review</h2><p>' + state.first + ' ' + state.last + ' · ' + state.country + ' · ' + state.resume + '</p><button type="button" data-automation-id="bottom-navigation-next-button" id="nav">Submit</button>';
  if (s === "done") app.innerHTML = '<h1>Application Submitted</h1><p>Thank you for applying. Your application has been submitted.</p>';
  bind();
}
function bind() {
  const on = (id, f) => { const e = document.getElementById(id); if (e) e.onclick = f; };
  on("apply", () => { state.step = "choose"; render(); });
  on("manual", () => { state.step = "create"; render(); });
  on("toSignIn", () => { state.step = "signin"; render(); });
  on("create", () => alert("should not create"));
  on("signin", async () => {
    const r = await fetch("/portal/login", { method: "POST", body: JSON.stringify({ e: document.getElementById("se").value, p: document.getElementById("sp").value }) });
    if (r.ok) { state.step = "info"; render(); } else document.getElementById("err").textContent = "Invalid email or password";
  });
  if (state.step === "info") {
    wireListbox("country");
    on("nav", () => {
      state.first = document.getElementById("fn").value; state.last = document.getElementById("ln").value; state.phone = document.getElementById("ph").value;
      if (!state.first || !state.last || !state.country || !state.phone) { document.getElementById("err").textContent = "Errors found: complete required fields"; return; }
      state.step = "exp"; render();
    });
  }
  if (state.step === "exp") {
    wireListbox("auth");
    on("nav", () => {
      const f = document.getElementById("rs").files[0];
      if (!f || !state.auth) { document.getElementById("err").textContent = "Errors found: complete required fields"; return; }
      state.resume = f.name; state.step = "review"; render();
    });
  }
  if (state.step === "review") on("nav", async () => {
    await fetch("/portal/submit", { method: "POST", body: JSON.stringify({ first: state.first, last: state.last, country: state.country, phone: state.phone, auth: state.auth, resume: state.resume }) });
    state.step = "done"; render();
  });
}
render();
</script></body></html>`;
