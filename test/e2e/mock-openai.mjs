// Minimal OpenAI-compatible mock for local end-to-end tests.
import http from "node:http";
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const name = j.response_format?.json_schema?.name;
    const user = j.messages?.[1]?.content ?? "";
    let out;
    if (name === "cv_extraction") {
      out = { fullName: "Mohamed Test", headline: "Senior Materials & Procurement Engineer", summary: "Procurement engineer in construction.", email: null, phone: "+966 50 123 4567", linkedinUrl: null, city: "Riyadh", nationality: null, yearsExperience: 9,
        experiences: [{ employer: "Example Contracting Co.", title: "Senior Materials & Procurement Engineer", location: "Riyadh", startDate: "2017-10", endDate: null, isCurrent: true, description: "Ran MEP tenders\nNegotiated subcontracts" },
                      { employer: "Older Co", title: "Procurement Engineer", location: "Cairo", startDate: "2015-01", endDate: "2017-09", isCurrent: false, description: "Purchased materials" }],
        qualifications: [{ kind: "certification", name: "PMP", issuer: "PMI", state: "held", obtainedOn: null }, { kind: "certification", name: "CIPS", issuer: null, state: "in_progress", obtainedOn: null }],
        skills: ["Negotiation", "Tendering", "SAP MM"], highlights: [{ category: "achievement", statement: "Replaced critical-material suppliers without delaying the schedule", numericValue: null, unit: null }], warnings: ["Older Co start month assumed"] };
    } else if (name === "employer_vetting") {
      const big = /giga|neom|fcc/i.test(user);
      out = { employerType: big ? "client_developer" : "small_contractor", scale: big ? "large" : "small", pifAffiliated: big ? "yes" : "no", summary: big ? "Giga-project developer." : "Small local fit-out firm.", redFlags: [], confidence: 0.8 };
    } else if (name === "job_match") {
      const good = /JOB: Senior Procurement/i.test(user);
      out = { score: good ? 84 : 35, eligibility: "eligible", factors: [{ factor: "Relevant experience", score: good ? 90 : 30, explanation: good ? "Direct MEP procurement experience" : "Different focus" }], summary: good ? "Strong fit for MEP procurement." : "Weak fit.", rejectionReasons: good ? [] : ["Seniority mismatch"], roleFamily: "procurement" };
    } else {
      const ids = [...user.matchAll(/"experienceId":"([0-9a-f-]{36})"/g)].map((m) => m[1]);
      out = { headline: "Senior Procurement Engineer – MEP", summary: "Procurement engineer focused on MEP tenders. Managed a SAR 900M budget.", experiences: ids.map((id) => ({ experienceId: id, bullets: ["Ran MEP tenders end to end", "Negotiated subcontracts with key vendors"] })),
        highlightIds: [], skills: ["Negotiation", "Tendering"], matchedRequirements: ["MEP tendering"], gaps: ["SAP certification"], changes: ["Led with MEP experience"], coverLetter: "I am excited to apply.\n\nI bring hands-on tendering experience." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "mock-model", choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 400 } }));
  });
}).listen(4010, () => console.log("mock ai on 4010"));

// Mock SAP SuccessFactors career site (RSS + job pages) for discovery tests.
const LONG = "Lead procurement of MEP packages including tendering, bid evaluation, negotiation and award for a giga-project. ".repeat(6);
const POSTINGS = [
  { id: "1000001", title: "Senior Procurement Engineer - MEP (Riyadh, SA)" },
  { id: "1000002", title: "Procurement Officer (Riyadh, SA)" },
  { id: "1000003", title: "Quantity Surveyor (Riyadh, SA)" },
];
http.createServer((req, res) => {
  const base = "http://localhost:4011";
  if (req.url.startsWith("/services/rss/job/")) {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(`<?xml version="1.0"?><rss><channel>${POSTINGS.map((p) => `<item><title><![CDATA[${p.title}]]></title><link>${base}/job/${p.id}/</link><description><![CDATA[<p>${LONG}</p>]]></description><pubDate>Mon, 03 Nov 2026 08:00:00 GMT</pubDate></item>`).join("")}</channel></rss>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><body><span class="jobdescription"><p>${LONG}</p></span></div></body></html>`);
}).listen(4011, () => console.log("mock careers site on 4011"));
