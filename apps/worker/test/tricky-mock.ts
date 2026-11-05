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
  <label id="rel-l">Religion *</label>
  <div id="rel" role="combobox" tabindex="0" aria-haspopup="listbox" aria-controls="rel-pop" aria-labelledby="rel-l" aria-required="true" style="border:1px solid #999;padding:4px;width:200px">No Selection</div>
  <select name="religion" id="rel-native" style="display:none"><option value="">No Selection</option><option value="ISL">Islam</option><option value="CHR">Christianity</option></select>
  <ul role="listbox" id="rel-pop" class="hidden"><li role="option">Islam</li><li role="option">Christianity</li></ul>
  <div class="paginatedPicklistContainer">
    <input aria-label="Highest Education Level" autocomplete="off" type="text" placeholder="No Selection" value="No Selection" aria-owns="edu-list" role="combobox" aria-required="true" id="edu" size="20">
    <input type="hidden" name="education" id="edu-val">
    <ul role="listbox" id="edu-list"></ul>
  </div>
  <div class="lvl-wrap">
    <span id="lvl" role="combobox" aria-haspopup="listbox" aria-controls="lvl-pop" aria-label="Seniority Level" aria-required="true">Select</span>
    <button type="button" id="lvl-toggle" aria-label="open list">▼</button>
    <input type="hidden" name="seniority" id="lvl-val">
  </div>
  <ul role="listbox" id="lvl-pop" class="hidden"><li role="option">Mid</li><li role="option">Senior</li><li role="option">Lead</li></ul>
  <div class="paginatedPicklistContainer">
    <input aria-label="Nationality" autocomplete="off" type="text" placeholder="No Selection" value="No Selection" aria-owns="nat-list" role="combobox" aria-required="true" id="nat" size="20">
    <input type="hidden" name="nationality" id="nat-val">
    <ul role="listbox" id="nat-list"></ul>
  </div>
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
// Nationality picklist worded by country ("Egypt"), not demonym ("Egyptian").
const COUNTRIES = ["Egypt", "Eritrea", "Estonia", "Saudi Arabia", "Jordan"];
const nat = document.getElementById("nat"), natList = document.getElementById("nat-list"), natVal = document.getElementById("nat-val");
let natChosen = "";
nat.addEventListener("keyup", () => setTimeout(() => {
  const q = nat.value.toLowerCase();
  natList.innerHTML = COUNTRIES.filter((x) => x.toLowerCase().includes(q)).map((x) => '<li role="option">' + x + '</li>').join("");
  natList.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", () => { natChosen = li.textContent; nat.value = li.textContent; natVal.value = li.textContent; natList.innerHTML = ""; }));
}, 300));
nat.addEventListener("blur", () => setTimeout(() => { if (nat.value !== natChosen) { nat.value = "No Selection"; natVal.value = ""; } }, 150));
// SuccessFactors paginated picklist: options come from the "server" only on real key presses;
// leaving without choosing from the list resets it to "No Selection".
const EDU = ["Diploma", "Bachelor's Degree", "Master's Degree", "Doctorate"];
const edu = document.getElementById("edu"), eduList = document.getElementById("edu-list"), eduVal = document.getElementById("edu-val");
let eduChosen = "";
edu.addEventListener("keyup", () => setTimeout(() => {
  const q = edu.value.toLowerCase();
  eduList.innerHTML = EDU.filter((x) => x.toLowerCase().includes(q)).map((x) => '<li role="option">' + x + '</li>').join("");
  eduList.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", () => { eduChosen = li.textContent; edu.value = li.textContent; eduVal.value = li.textContent; eduList.innerHTML = ""; }));
}, 400));
edu.addEventListener("blur", () => setTimeout(() => { if (edu.value !== eduChosen) { edu.value = "No Selection"; eduVal.value = ""; } }, 150));
// A widget only its own small toggle button opens; none of the built-in methods work on it.
document.getElementById("lvl-toggle").addEventListener("click", () => document.getElementById("lvl-pop").classList.remove("hidden"));
document.querySelectorAll("#lvl-pop [role=option]").forEach((o) => o.addEventListener("click", () => {
  document.getElementById("lvl").textContent = o.textContent; document.getElementById("lvl-val").value = o.textContent; document.getElementById("lvl-pop").classList.add("hidden");
}));
// Religion: like a SuccessFactors picklist that ignores option clicks but accepts type-ahead + Enter.
const rel = document.getElementById("rel"), relPop = document.getElementById("rel-pop"), relNative = document.getElementById("rel-native");
let typed = "";
rel.addEventListener("click", () => relPop.classList.remove("hidden"));
rel.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const o = [...relPop.children].find((x) => x.textContent.toLowerCase().startsWith(typed.toLowerCase()));
    if (o) { rel.textContent = o.textContent; relNative.value = [...relNative.options].find((x) => x.text === o.textContent).value; }
    typed = ""; relPop.classList.add("hidden");
  } else if (e.key.length === 1) { typed += e.key; clearTimeout(rel._t); rel._t = setTimeout(() => (typed = ""), 1000); }
});
list.querySelectorAll("[role=option]").forEach(o => o.addEventListener("click", () => { ic.value = o.textContent; list.classList.add("hidden"); }));
</script></body></html>`;
