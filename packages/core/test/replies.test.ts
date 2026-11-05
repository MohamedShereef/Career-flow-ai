import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applicationEvents, applications, jobs, processedEmails } from "@careerflow/db";
import { setAiTransportForTests } from "../src/ai";
import { AppError } from "../src/errors";
import * as gmail from "../src/services/gmail";
import * as profile from "../src/services/profile";
import * as replies from "../src/services/replies";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));

const inbox = (msgs: Array<gmail.MailHeader & { body: string }>): gmail.MailSourceFactory => async () => ({
  async list(cursor) {
    return { uidValidity: "1", headers: msgs.filter((m) => cursor.uidValidity !== "1" || m.uid > cursor.lastUid) };
  },
  async text(uid) {
    return msgs.find((m) => m.uid === uid)!.body;
  },
  async close() {},
});

describe("interview replies", () => {
  it("drafts a reply when an interview invite arrives, sends it only on request, once, in the same thread", async () => {
    const { user } = await makeUser();
    const db = testDb();
    await profile.updateProfile(db, user.id, { fullName: "Mohamed Shereef", phone: "+966 50 000 0000" });
    const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title: "Procurement Lead", companyName: "Red Sea Global", employerKey: "red sea global", sourceUrl: "https://x", applyUrl: "https://x" }).returning();
    const [app] = await db.insert(applications).values({ userId: user.id, jobId: job!.id, employerKey: "red sea global", status: "submitted_unverified" }).returning();

    const prompts: string[] = [];
    setAiTransportForTests(async (req) => {
      prompts.push(req.user);
      if (req.schemaName === "email_classification") {
        return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ classification: "interview_invitation", employer: "Red Sea Global", jobTitle: "Procurement Lead", summary: "Invites you to a video interview on 12 Nov at 10:00 and asks you to confirm.", times: ["2026-11-12T10:00:00+03:00"], actionNeeded: true, confidence: 0.9 }) };
      }
      return { model: "test-model", inputTokens: 1, outputTokens: 1, content: JSON.stringify({ body: "Dear Sara,\n\nThank you — I confirm the interview on Thursday 12 November 2026 at 10:00 (Riyadh time).\n\nBest regards,\nMohamed Shereef\n+966 50 000 0000" }) };
    });

    const source = inbox([{ uid: 1, messageId: "<abc123@redsea.example>", from: { address: "careers@redseaglobal.com", name: "Red Sea Global Careers" }, replyTo: "sara.hr@redseaglobal.com", subject: "Interview invitation – Procurement Lead", date: new Date(), bulk: false, body: "Dear Mohamed, we would like to invite you to an interview on 12 November 2026 at 10:00 AM Riyadh time. Please confirm. Sara" }]);
    await gmail.connect(db, user.id, { email: "me@gmail.com", appPassword: "abcdefghijklmnop" }, source);
    const r = await gmail.sync(db, user.id, { source });
    expect(r.updates.join(" ")).toMatch(/reply drafted/);

    const [e] = await db.select().from(processedEmails).where(eq(processedEmails.userId, user.id));
    expect(e!.rfcMessageId).toBe("<abc123@redsea.example>");
    const v = await replies.getForEmail(db, user.id, e!.id);
    expect(v.draft).toMatchObject({ status: "draft", toAddress: "sara.hr@redseaglobal.com", subject: "Re: Interview invitation – Procurement Lead", chosenTime: "2026-11-12T10:00:00+03:00" });
    expect(prompts.at(-1)).toContain("Chosen time: Thursday, 12 November 2026");

    const sent: Array<{ to: string; inReplyTo?: string | null; text: string }> = [];
    const sender: replies.MailSender = async (_c, mail) => {
      sent.push(mail);
      return { messageId: "<sent@x>" };
    };
    // A failing send keeps the draft and shows why.
    const broken: replies.MailSender = async () => {
      throw new AppError("send_failed", "Gmail didn't accept the email: test");
    };
    await expect(replies.sendDraft(db, user.id, v.draft!.id, null, broken)).rejects.toMatchObject({ code: "send_failed" });
    expect((await replies.getForEmail(db, user.id, e!.id)).draft).toMatchObject({ status: "draft", error: expect.stringContaining("didn't accept") });

    await replies.sendDraft(db, user.id, v.draft!.id, "Dear Sara,\n\nI confirm Thursday 12 November at 10:00 Riyadh time.\n\nMohamed", sender);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sara.hr@redseaglobal.com", inReplyTo: "<abc123@redsea.example>" });
    expect(sent[0]!.text).toContain("I confirm Thursday"); // the user's edit is what was sent
    await expect(replies.sendDraft(db, user.id, v.draft!.id, null, sender)).rejects.toMatchObject({ code: "not_sendable" });
    expect(sent).toHaveLength(1);

    const [a] = await db.select().from(applications).where(eq(applications.id, app!.id));
    expect(a!.status).toBe("interview");
    expect(a!.statusReason).toMatch(/Interview confirmed/);
    const evs = await db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, app!.id));
    expect(evs.map((x) => x.message).join(" ")).toMatch(/You replied to sara\.hr@redseaglobal\.com/);
    const [after] = await db.select().from(processedEmails).where(eq(processedEmails.id, e!.id));
    expect(after!.actionNeeded).toBe(false);
  });

  it("builds a Google Calendar link for the interview time", () => {
    const url = replies.calendarLink("Interview – Procurement Lead", "2026-11-12T10:00:00+03:00", 60);
    expect(url).toContain("dates=20261112T070000Z/20261112T080000Z");
    expect(url).toContain("text=Interview%20%E2%80%93%20Procurement%20Lead");
  });
});
