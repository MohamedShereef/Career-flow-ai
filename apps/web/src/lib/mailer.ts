import "server-only";

/**
 * Transactional email (password reset). Uses Resend's HTTP API when
 * RESEND_API_KEY is set. Without it, development prints the link to the
 * server console; production refuses rather than silently dropping mail.
 */
export async function sendMail(to: string, subject: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") throw new Error("Email is not configured (RESEND_API_KEY).");
    console.info(`[dev-mail] to=${to} subject=${subject}\n${text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MAIL_FROM ?? "CareerFlow AI <no-reply@careerflow.app>", to, subject, text }),
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
}

export function appUrl() {
  return (process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")).replace(/\/$/, "");
}
