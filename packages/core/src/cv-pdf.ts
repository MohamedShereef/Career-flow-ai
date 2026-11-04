/**
 * ATS-friendly PDF rendering: single column, real text (no images or tables),
 * standard section headings, standard fonts. Parsers read it top to bottom.
 */
import PDFDocument from "pdfkit";

export interface CvDocument {
  name: string;
  headline: string | null;
  contact: string[];
  summary: string | null;
  highlights: string[];
  experiences: Array<{ title: string; employer: string; location: string | null; dates: string; bullets: string[] }>;
  qualifications: string[];
  skills: string[];
}

const INK = "#111827";
const MUTED = "#4b5563";
const ACCENT = "#0e6b62";

/** Helvetica's built-in encoding is WinAnsi; replace characters it can't draw. */
const clean = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/•/g, "-")
    .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ]/g, "");

function render(build: (doc: PDFKit.PDFDocument) => void, title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 54, right: 54 }, info: { Title: title, Creator: "CareerFlow AI" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

function heading(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(ACCENT).text(text.toUpperCase(), { characterSpacing: 0.6 });
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).lineWidth(0.6).strokeColor("#d1d5db").stroke();
  doc.moveDown(0.4);
}

export function renderCvPdf(cv: CvDocument): Promise<Buffer> {
  return render((doc) => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(clean(cv.name));
    if (cv.headline) doc.font("Helvetica").fontSize(12).fillColor(ACCENT).text(clean(cv.headline));
    if (cv.contact.length) doc.moveDown(0.2).font("Helvetica").fontSize(9.5).fillColor(MUTED).text(clean(cv.contact.join("  |  ")));

    if (cv.summary) {
      heading(doc, "Professional Summary");
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(clean(cv.summary), { lineGap: 1.5, align: "left" });
    }
    if (cv.highlights.length) {
      heading(doc, "Key Achievements");
      doc.list(cv.highlights.map(clean), { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
    }
    if (cv.experiences.length) {
      heading(doc, "Professional Experience");
      for (const e of cv.experiences) {
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(clean(`${e.title} - ${e.employer}`), { continued: false });
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(clean([e.location, e.dates].filter(Boolean).join("  |  ")));
        doc.moveDown(0.2);
        if (e.bullets.length) {
          doc.font("Helvetica").fontSize(10).fillColor(INK);
          doc.list(e.bullets.map(clean), { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
        }
        doc.moveDown(0.5);
      }
    }
    if (cv.qualifications.length) {
      heading(doc, "Education & Certifications");
      doc.font("Helvetica").fontSize(10).fillColor(INK);
      doc.list(cv.qualifications.map(clean), { bulletRadius: 1.5, textIndent: 10, lineGap: 1.5 });
    }
    if (cv.skills.length) {
      heading(doc, "Skills");
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(clean(cv.skills.join(", ")), { lineGap: 1.5 });
    }
  }, `${cv.name} - CV`);
}

export function renderLetterPdf(opts: { name: string; contact: string[]; date: string; recipient: string; body: string }): Promise<Buffer> {
  return render((doc) => {
    doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(clean(opts.name));
    if (opts.contact.length) doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(clean(opts.contact.join("  |  ")));
    doc.moveDown(1.5);
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(clean(opts.date));
    doc.moveDown(0.8).text(clean(opts.recipient));
    doc.moveDown(1);
    for (const p of opts.body.split(/\n{2,}/)) doc.text(clean(p), { lineGap: 2, align: "left" }).moveDown(0.8);
    doc.moveDown(0.5).text("Sincerely,").moveDown(0.3).font("Helvetica-Bold").text(clean(opts.name));
  }, `${opts.name} - Cover letter`);
}

