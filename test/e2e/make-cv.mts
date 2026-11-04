import { writeFileSync } from "node:fs";
import { renderCvPdf } from "../../packages/core/src/cv-pdf";
const pdf = await renderCvPdf({ name: "Mohamed Test", headline: "Senior Materials & Procurement Engineer", contact: ["Riyadh", "+966 50 123 4567"],
  summary: "Procurement engineer with experience in construction tenders, supplier negotiation and materials management across large projects in Saudi Arabia and Egypt.",
  highlights: ["Replaced critical-material suppliers without delaying the schedule"],
  experiences: [{ title: "Senior Materials & Procurement Engineer", employer: "Example Contracting Co.", location: "Riyadh", dates: "Oct 2017 - Present", bullets: ["Ran MEP tenders", "Negotiated subcontracts"] }],
  qualifications: ["PMP, PMI", "CIPS (in progress)"], skills: ["Negotiation", "Tendering", "SAP MM"] });
writeFileSync(process.argv[2] ?? "/tmp/real-cv.pdf", pdf);
