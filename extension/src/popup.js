const $ = (id) => document.getElementById(id);
const show = (id) => { for (const x of ["link", "ready"]) $(x).classList.toggle("hidden", x !== id); };
const say = (text, cls = "muted") => { $("msg").className = cls; $("msg").textContent = text; };
const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, r));

async function init() {
  const { server, token } = await chrome.storage.local.get(["server", "token"]);
  if (!server || !token) { $("server").value = server || ""; return show("link"); }
  show("ready");
  const p = await send({ type: "ping" });
  $("who").textContent = p.ok ? `Linked to ${p.email} · ${new URL(server).host}` : p.error;
}
$("save").onclick = async () => {
  let server = $("server").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  if (!/^https?:\/\//.test(server)) server = `https://${server}`;
  if (!token.startsWith("cfx_")) return say("The link code starts with cfx_.", "err");
  const granted = await chrome.permissions.request({ origins: [`${new URL(server).origin}/*`] });
  if (!granted) return say("Chrome needs permission to reach your CareerFlow address.", "err");
  await chrome.storage.local.set({ server, token });
  const p = await send({ type: "ping" });
  if (!p.ok) { await chrome.storage.local.remove(["token"]); return say(p.error, "err"); }
  say(`Linked to ${p.email}.`, "ok");
  init();
};
$("fill").onclick = async () => {
  say("Filling…");
  const r = await send({ type: "fill" });
  if (!r.ok) return say(r.error, "err");
  say(`${r.job}: filled ${r.filled} of ${r.total}.${r.problems?.length ? ` Fill yourself: ${r.problems.join(" · ")}` : ""} Now tick any robot check and press Submit.`, r.problems?.length ? "muted" : "ok");
};
$("unlink").onclick = async () => { await chrome.storage.local.remove(["token"]); say("Unlinked."); init(); };
init();
