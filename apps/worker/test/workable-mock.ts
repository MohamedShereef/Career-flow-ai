/** A form that behaves like Workable's apply page (React-style inputs, masks, address suggestions, CA_ questions). */
export const WORKABLE_HTML = String.raw`<!doctype html><html><head><title>Apply – Qiddiya-like</title>
<style>.sugg{border:1px solid #999;margin:0;padding:0;list-style:none}.sugg li{padding:4px;cursor:pointer}.hidden{display:none}</style></head><body>
<form id="f" method="post" action="/workable/submit" enctype="multipart/form-data">
  <div><label for="firstname">First name *</label><input id="firstname" name="firstname" required></div>
  <div><label for="email">Email *</label><input id="email" name="email" type="email" required></div>
  <div><label for="resume">Resume *</label><input id="resume" name="resume" type="file" required></div>
  <div><label for="phone">Phone *</label>
    <div class="styles--phone"><button type="button" aria-label="Country">🇸🇦 +966</button><input id="phone" name="phone" type="tel" required></div></div>
  <div><label for="address">Address *</label><input id="address" name="address" autocomplete="off" required>
    <ul id="addr-sugg" class="sugg hidden" role="listbox"></ul></div>
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
  // Address: only a picked suggestion is kept.
  const ad = document.getElementById("address"), list = document.getElementById("addr-sugg");
  let picked = false;
  ad.addEventListener("input", () => {
    picked = false;
    const q = ad.value.trim().toLowerCase();
    const all = ["Riyadh, Saudi Arabia", "Riyadh Al Khabra, Saudi Arabia", "Jeddah, Saudi Arabia"];
    const hits = q.length >= 3 ? all.filter((x) => x.toLowerCase().startsWith(q.slice(0, 3))) : [];
    list.innerHTML = hits.map((x) => '<li role="option">' + x + "</li>").join("");
    list.classList.toggle("hidden", !hits.length);
  });
  list.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    ad.value = li.textContent; picked = true; list.classList.add("hidden");
  });
  // Dropdown: opens on click; picking sets the visible box and the hidden value.
  const cb = document.getElementById("input_CA_50968_input"), lb = document.getElementById("input_CA_50968_listbox"), hold = document.querySelector('[name="CA_50968"]');
  cb.addEventListener("click", () => { lb.classList.remove("hidden"); cb.setAttribute("aria-expanded", "true"); });
  lb.addEventListener("click", (e) => { const li = e.target.closest("li"); if (!li) return; cb.value = li.textContent; hold.value = li.textContent; lb.classList.add("hidden"); cb.setAttribute("aria-expanded", "false"); });
  // Stray keys typed while focus sits elsewhere must not reach this field (would corrupt it).
  ad.addEventListener("blur", () => setTimeout(() => { if (!picked) ad.value = ""; list.classList.add("hidden"); }, 150));
</script></body></html>`;
