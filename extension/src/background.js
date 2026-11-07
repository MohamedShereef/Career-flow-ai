// CareerFlow extension: talks to your CareerFlow server with the link code from Settings → Chrome extension.
const get = () => chrome.storage.local.get(["server", "token"]);
async function api(path, init = {}) {
  const { server, token } = await get();
  if (!server || !token) throw new Error("Link the extension first (open it and paste the code from CareerFlow).");
  const res = await fetch(`${server}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("The link code is no longer valid. Create a new one in CareerFlow → Settings.");
  return res;
}
const toB64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
};

async function fillActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("Open the employer's application page first.");
  const r = await api(`/api/extension/handoff?url=${encodeURIComponent(tab.url)}`);
  if (r.status === 404) throw new Error("No CareerFlow application matches this page. Start the application in CareerFlow, then open its employer link.");
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `CareerFlow answered ${r.status}`);
  const data = await r.json();
  const files = {};
  for (const a of data.answers) for (const f of a.file || []) {
    if (files[f.documentId]) continue;
    const fr = await api(`/api/extension/files/${f.documentId}`);
    if (fr.ok) { const blob = await fr.blob(); files[f.documentId] = { filename: f.filename, mimeType: blob.type, base64: await toB64(blob) }; }
  }
  // Read every frame, fill only the one that holds the form.
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["extract.js", "filler.js"] });
  const counts = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => (window.__cfExtract ? window.__cfExtract().fields.length : 0) });
  const best = counts.sort((a, b) => (b.result || 0) - (a.result || 0))[0];
  if (!best || !best.result) throw new Error("No application form found on this page. Open the form (press the site's Apply button) and try again.");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [best.frameId] },
    args: [data, files],
    func: (d, f) => window.__cfFill(d, f, (m) => chrome.runtime.sendMessage({ type: "sent", ...m, url: location.href })),
  });
  return { job: `${data.jobTitle} · ${data.company}`, ...(res?.result || {}) };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "fill") { fillActiveTab().then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message })); return true; }
  if (msg.type === "ping") { api("/api/extension/ping").then(async (r) => reply(r.ok ? { ok: true, ...(await r.json()) } : { ok: false, error: `CareerFlow answered ${r.status}` }), (e) => reply({ ok: false, error: e.message })); return true; }
  if (msg.type === "sent") {
    api("/api/extension/sent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationId: msg.applicationId, url: msg.url, confirmation: msg.confirmation || (msg.how === "button" ? "You pressed “I submitted it”" : "") }) })
      .then(() => chrome.action.setBadgeText({ text: "✓" }))
      .catch(() => chrome.action.setBadgeText({ text: "!" }));
  }
  return false;
});
