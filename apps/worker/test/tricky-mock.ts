/** A form that behaves like the hard parts of real portals (SuccessFactors-style). */
export const TRICKY_HTML = String.raw`<!doctype html><html><head><title>Apply – Tricky Co</title>
<style>
.opt input{position:absolute;opacity:0;width:1px;height:1px} .opt label{display:inline-block;padding:6px 12px;border:1px solid #888;margin:2px;cursor:pointer}
.cb{position:relative;display:inline-block} .cb .icon{position:absolute;inset:0;background:transparent}
[role=listbox]{border:1px solid #999} .hidden{display:none}
</style></head><body>
<form id="f" method="post" action="/tricky/submit" enctype="multipart/form-data">
  <label for="fn">First Name *</label><input id="fn" name="first_name" required>
  <label for="em">Email *</label><input id="em" name="email" type="email" required>
  <label for="cv">Resume *</label><input id="cv" name="resume" type="file" required>
  <div id="personal"></div>
  <label for="ctry">Country *</label>
  <select id="ctry" name="country" required><option value="">Select…</option><option value="EG">Egypt</option><option value="SA">Saudi&nbsp;Arabia</option></select>
  <fieldset><legend>Are you currently studying here? *</legend>
    <span class="opt"><input type="radio" id="st1" name="studying" value="Y" required><label for="st1">Yes</label></span>
    <span class="opt"><input type="radio" id="st2" name="studying" value="N"><label for="st2">No</label></span>
  </fieldset>
  <label id="ic-l">Institution Country *</label>
  <span class="cb"><input id="ic" name="inst_country" role="combobox" aria-labelledby="ic-l" aria-required="true" autocomplete="off"><span class="icon"></span></span>
  <ul role="listbox" id="ic-list" class="hidden"><li role="option">Egypt</li><li role="option">Saudi Arabia</li><li role="option">Jordan</li></ul>
  <label for="hobby">Favourite sport</label><select id="hobby" name="hobby"><option value="">Select…</option><option>Chess</option></select>
  <button type="submit">Submit Application</button>
</form>
<script>
function renderPersonal(keep) {
  // Re-rendered from scratch (like a server round-trip): earlier values are lost.
  document.getElementById("personal").innerHTML =
    '<label for="ms">Marital Status *</label><select id="ms" name="marital" required><option value="">Select…</option><option>Single</option><option>Married</option></select>';
}
renderPersonal();
document.getElementById("ctry").addEventListener("change", () => setTimeout(renderPersonal, 200));
const ic = document.getElementById("ic"), list = document.getElementById("ic-list");
document.querySelector(".cb .icon").addEventListener("click", () => list.classList.remove("hidden"));
ic.addEventListener("focus", () => list.classList.remove("hidden"));
ic.addEventListener("input", () => { list.classList.remove("hidden"); [...list.children].forEach(o => o.style.display = o.textContent.toLowerCase().includes(ic.value.toLowerCase()) ? "" : "none"); });
list.querySelectorAll("[role=option]").forEach(o => o.addEventListener("click", () => { ic.value = o.textContent; list.classList.add("hidden"); }));
</script></body></html>`;
