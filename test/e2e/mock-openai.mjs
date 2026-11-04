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
    } else {
      const ids = [...user.matchAll(/"experienceId":"([0-9a-f-]{36})"/g)].map((m) => m[1]);
      out = { headline: "Senior Procurement Engineer – MEP", summary: "Procurement engineer focused on MEP tenders. Managed a SAR 900M budget.", experiences: ids.map((id) => ({ experienceId: id, bullets: ["Ran MEP tenders end to end", "Negotiated subcontracts with key vendors"] })),
        highlightIds: [], skills: ["Negotiation", "Tendering"], matchedRequirements: ["MEP tendering"], gaps: ["SAP certification"], changes: ["Led with MEP experience"], coverLetter: "I am excited to apply.\n\nI bring hands-on tendering experience." };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "mock-model", choices: [{ message: { content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 400 } }));
  });
}).listen(4010, () => console.log("mock ai on 4010"));
