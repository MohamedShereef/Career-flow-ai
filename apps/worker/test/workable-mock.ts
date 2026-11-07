/** A form that behaves like Workable's apply page (React-style inputs, masks, address suggestions, CA_ questions). */
export const WORKABLE_HTML = String.raw`<!doctype html><html><head><title>Apply – Qiddiya-like</title>
<style>.sugg{border:1px solid #999;margin:0;padding:0;list-style:none}.sugg li{padding:4px;cursor:pointer}.hidden{display:none}</style></head><body>
<form id="f" method="post" action="/workable/submit" enctype="multipart/form-data">
  <div><label for="firstname">First name *</label><input id="firstname" name="firstname" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><span><strong>*</strong><span id="rs_label"><strong>Resume</strong></span></span>
    <div data-role="dropzone"><label for="input_files_rs"><svg><desc aria-hidden="true"><p>SVGs not supported by this browser.</p></desc></svg></label>
    <label tabindex="0" role="button" for="input_files_rs" id="description_input_rs">Choose file</label> <span>or drag and drop here</span>
    <input data-ui="resume" tabindex="-1" id="input_files_rs" name="resume" type="file" aria-labelledby="rs_label description_input_rs" accept=".pdf,.doc,.docx" required></div></div>
  <div><label for="phone">Phone *</label>
    <div class="styles--phone"><button type="button" aria-label="Country">🇸🇦 +966</button><input id="phone" name="phone" type="tel" required></div></div>
  <div id="addr-box"><label id="lab-a" for="address">Address *</label><input id="address" name="address" autocomplete="off" required>
    <ul id="addr-sugg" class="sugg hidden" role="listbox"></ul></div>
  <!-- As on Workable: address parts the page fills itself, hidden from people. Whatever is typed in them is
       appended to Address when you leave them. -->
  <div><span>City</span><input id="city" aria-hidden="true" tabindex="-1" name="city" type="text" style="width:42px"></div>
  <div><span>Postcode</span><input id="postcode" aria-hidden="true" tabindex="-1" name="postcode" type="text" style="width:42px"></div>
  <div><span>Country</span><input id="country" aria-hidden="true" tabindex="-1" name="country" type="text" style="width:42px"></div>
  <div class="styles--question"><span class="styles--title">Expected Salary</span><span>*</span>
    <div class="styles--control"><input id="CA_36432" name="CA_36432" inputmode="numeric" required></div></div>
  <div class="styles--question"><span class="styles--title">Are you willing to relocate within Saudi Arabia?</span><span>*</span>
    <div class="styles--control"><input id="CA_50967" name="CA_50967" required></div></div>
  <!-- Workable dropdown question, as on apply.workable.com: a read-only "Select an option…" box, a list it opens,
       and a visually hidden input holding the value for the form. -->
  <div data-ui="CA_50968" class="styles--2N29s" data-open="false" data-input-type="select">
    <span id="CA_50968_label" class="styles--title">Do you hold a valid Saudi Iqama?<span>*</span></span>
    <label class="styles--2bW8g"><div data-role="illustrated-input"><div class="styles--3qHIU">
      <input id="input_CA_50968_input" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-owns="input_CA_50968_listbox" aria-controls="input_CA_50968_listbox" aria-autocomplete="list" autocomplete="off" aria-labelledby="CA_50968_label" placeholder="Select an option…" type="text" value="" readonly="true">
    </div></div></label>
    <input name="CA_50968" required class="sr" style="position:absolute;width:1px;height:1px;opacity:0.01;border:0;padding:0" tabindex="-1">
    <ul id="input_CA_50968_listbox" role="listbox" class="hidden"><li role="option">Yes</li><li role="option">No</li></ul>
  </div>
  <button type="submit">Submit application</button>
</form>
<script>
  // Workable gives the resume input a fresh random id on every page load.
  (() => {
    const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const rnd = "Ab1" + Array.from({ length: 13 }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
    const inp = document.getElementById("input_files_rs");
    inp.id = "input_files_input_" + rnd;
    inp.setAttribute("aria-labelledby", rnd + "_label description_input_" + rnd);
    document.getElementById("rs_label").id = rnd + "_label";
    document.getElementById("description_input_rs").id = "description_input_" + rnd;
    document.querySelectorAll('label[for="input_files_rs"]').forEach((l) => l.setAttribute("for", "input_files_input_" + rnd));
    inp.removeAttribute("name"); // like Workable: no name on the file input; the page uploads it itself
    const got = document.createElement("input");
    got.type = "hidden"; got.name = "resume_name"; inp.after(got);
    inp.addEventListener("change", () => { got.value = inp.files[0] ? inp.files[0].name : ""; });
  })();
  // Phone: the country code lives on the button; the field keeps the national number, formatted.
  const ph = document.getElementById("phone");
  ph.addEventListener("input", () => {
    let d = ph.value.replace(/\D/g, "");
    if (d.startsWith("966")) d = d.slice(3);
    d = d.replace(/^0/, "").slice(0, 9);
    ph.value = [d.slice(0, 2), d.slice(2, 5), d.slice(5)].filter(Boolean).join(" ");
  });
  // Salary: digits only — anything else empties the field.
  const sal = document.getElementById("CA_36432");
  sal.addEventListener("input", () => { if (/\D/.test(sal.value)) sal.value = ""; });
  // Address: only a picked suggestion is kept. Handlers find the field by id at event time, because the
  // form below "re-renders" by reusing DOM nodes (as React does).
  const list = document.getElementById("addr-sugg");
  const adr = () => document.getElementById("address");
  let picked = false;
  document.addEventListener("input", (e) => {
    if (e.target.id !== "address") return;
    picked = false;
    const q = e.target.value.trim().toLowerCase();
    const all = ["Riyadh, Saudi Arabia", "Riyadh Al Khabra, Saudi Arabia", "Jeddah, Saudi Arabia"];
    const hits = q.length >= 3 ? all.filter((x) => x.toLowerCase().startsWith(q.slice(0, 3))) : [];
    list.innerHTML = hits.map((x) => '<li role="option">' + x + "</li>").join("");
    list.classList.toggle("hidden", !hits.length);
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    adr().value = li.textContent; picked = true; list.classList.add("hidden");
  });
  for (const id of ["city", "postcode", "country"]) {
    const part = document.getElementById(id);
    let typed = [];
    part.addEventListener("input", () => typed.push(part.value));
    part.addEventListener("blur", () => { if (typed.length) adr().value = [adr().value, ...typed].filter(Boolean).join(", "); typed = []; });
  }
  document.addEventListener("focusout", (e) => { if (e.target.id === "address") setTimeout(() => { if (!picked) adr().value = ""; list.classList.add("hidden"); }, 150); });
  // Dropdown: opens on click; picking sets the visible box and the hidden value.
  const cb = document.getElementById("input_CA_50968_input"), lb = document.getElementById("input_CA_50968_listbox"), hold = document.querySelector('[name="CA_50968"]');
  cb.addEventListener("click", () => { lb.classList.remove("hidden"); cb.setAttribute("aria-expanded", "true"); });
  lb.addEventListener("click", (e) => { const li = e.target.closest("li"); if (!li) return; cb.value = li.textContent; hold.value = li.textContent; lb.classList.add("hidden"); cb.setAttribute("aria-expanded", "false"); });

</script></body></html>`;
