/** Plain-text extraction from uploaded CVs (PDF via pdf.js, DOCX via mammoth). */
import { AppError } from "./errors";

export async function extractDocumentText(bytes: Buffer, mimeType: string): Promise<string> {
  let text = "";
  if (mimeType === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const out = await extractText(pdf, { mergePages: true });
    text = Array.isArray(out.text) ? out.text.join("\n") : out.text;
  } else if (mimeType.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else {
    throw new AppError("bad_type", "Only PDF and Word CVs can be read.");
  }
  text = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 200) {
    throw new AppError(
      "no_text",
      "This CV has almost no selectable text (it may be a scanned image). Upload a text-based PDF or a Word file.",
    );
  }
  return text.slice(0, 40_000);
}
