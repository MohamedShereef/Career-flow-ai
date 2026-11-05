import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiDecisions, applications, cvTailorings, gmailIntegrations, jobs, processedEmails, submissionEvidence, submissionLedger } from "@careerflow/db";
import { setAiTransportForTests } from "../src/ai";
import { AppError } from "../src/errors";
import * as gmail from "../src/services/gmail";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);
afterEach(() => setAiTransportForTests(null));

type Msg = gmail.MailHeader & { body: string };

function fakeSource(msgs: Msg[], opened: { n: number }) {
  const factory: gmail.MailSourceFactory = async ({ appPassword }) => {
    if (appPassword !== "abcdefghijklmnop") throw new AppError("gmail_auth", "Google rejected the login.");
    opened.n++;
    return {
      async list(cursor) {
        return { uidValidity: "7", headers: msgs.filter((m) => cursor.uidValidity !== "7" || m.uid > cursor.lastUid) };
      },
      async text(uid) {
        return msgs.find((m) => m.uid === uid)!.body;
      },
      async close() {},
    };
  };
  return factory;
}

const msg = (uid: number, from: string, name: string, subject: string, body: string, bulk = false): Msg => ({ uid, messageId: `<m${uid}-${crypto.randomUUID()}@x>`, from: { address: from, name }, subject, date: new Date(), bulk, body });

async function appFor(userId: string, company: string, title: string, status: "submitted_unverified" | "prepared" = "submitted_unverified") {
  const db = testDb();
  const [job] = await db.insert(jobs).values({ externalId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(), title, companyName: company, employerKey: company.toLowerCase(), sourceUrl: "https://x", applyUrl: "https://x" }).returning();
  const [a] = await db.insert(applications).values({ userId, jobId: job!.id, employerKey: company.toLowerCase(), status }).returning();
  void cvTailorings;
  return a!;
}

describe("gmail tracking", () => {
  it("only accepts a real app password, checked with Google first", async () => {
    const { user } = await makeUser();
    const opened = { n: 0 };
    await expect(gmail.connect(testDb(), user.id, { email: "me@gmail.com", appPassword: "MyGmail-Pass123" }, fakeSource([], opened))).rejects.toMatchObject({ code: "invalid_app_password" });
    await expect(gmail.connect(testDb(), user.id, { email: "me@gmail.com", appPassword: "zzzz zzzz zzzz zzzz" }, fakeSource([], opened))).rejects.toMatchObject({ code: "gmail_auth" });
    expect(await gmail.status(testDb(), user.id)).toBeNull();
    await gmail.connect(testDb(), user.id, { email: "Me@Gmail.com", appPassword: "abcd efgh ijkl mnop" }, fakeSource([], opened));
    const [row] = await testDb().select().from(gmailIntegrations).where(eq(gmailIntegrations.userId, user.id));
    expect(row!.googleEmail).toBe("me@gmail.com");
    expect(row!.appPasswordEnc).not.toContain("abcdefgh"); // encrypted
  });

  it("reads only job emails, confirms receipts, flags interviews, and never processes an email twice", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const roshn = await appFor(user.id, "ROSHN", "Senior Procurement Manager");
    const seven = await appFor(user.id, "Saudi Entertainment Ventures", "Procurement Lead", "prepared");
    const msgs = [
      msg(1, "no-reply@roshn.sa", "ROSHN Careers", "Thank you for applying – Senior Procurement Manager", "We have received your application for Senior Procurement Manager."),
      msg(2, "news@shop.com", "Shop", "Big sale this weekend", "Buy now", true),
      msg(3, "jobalerts-noreply@linkedin.com", "LinkedIn", "Job alert: 30 new procurement jobs", "jobs", true),
      msg(4, "talent@seven.sa", "SEVEN Talent", "Interview invitation – Procurement Lead", "We'd like to invite you to an interview on 12 November 2026 at 10:00 AM Riyadh time. Please confirm."),
      msg(5, "friend@gmail.com", "Ahmed", "Dinner?", "Are you free?"),
    ];
    const prompts: string[] = [];
    setAiTransportForTests(async (req) => {
      prompts.push(req.user);
      const interview = /Interview invitation/.test(req.user);
      return {
        model: "test-model", inputTokens: 1, outputTokens: 1,
        content: JSON.stringify(interview
          ? { classification: "interview_invitation", employer: "Saudi Entertainment Ventures", jobTitle: "Procurement Lead", summary: "Interview invitation for 12 Nov 2026 10:00; asks you to confirm.", times: ["2026-11-12T10:00:00+03:00"], actionNeeded: true, confidence: 0.9 }
          : { classification: "application_receipt", employer: "ROSHN", jobTitle: "Senior Procurement Manager", summary: "ROSHN confirms your application for Senior Procurement Manager was received.", times: [], actionNeeded: false, confidence: 0.95 }),
      };
    });
    const opened = { n: 0 };
    const source = fakeSource(msgs, opened);
    await gmail.connect(db, user.id, { email: "me@gmail.com", appPassword: "abcdefghijklmnop" }, source);

    const r = await gmail.sync(db, user.id, { source });
    expect(r).toMatchObject({ seen: 5, relevant: 2, classified: 2, matched: 2 });
    expect(prompts).toHaveLength(2); // the sale, the job alert and the personal email were never sent to the AI

    const [a1] = await db.select().from(applications).where(eq(applications.id, roshn.id));
    expect(a1!.status).toBe("confirmed_by_email");
    const ev = await db.select().from(submissionEvidence).where(eq(submissionEvidence.applicationId, roshn.id));
    expect(ev[0]).toMatchObject({ kind: "email_receipt", level: "email" });
    const [a2] = await db.select().from(applications).where(eq(applications.id, seven.id));
    expect(a2!.status).toBe("interview");

    const list = await gmail.recentJobEmails(db, user.id);
    const inv = list.find((x) => x.e.classification === "interview_invitation")!;
    expect(inv.e.proposedTimes).toEqual(["2026-11-12T10:00:00+03:00"]);
    expect(inv.e.actionNeeded).toBe(true);
    const stored = await db.select().from(processedEmails).where(eq(processedEmails.userId, user.id));
    expect(JSON.stringify(stored)).not.toContain("We'd like to invite you"); // body never stored

    // Receipt for an application the user sent manually also records it in the ledger.
    const [l] = await db.select().from(submissionLedger).where(and(eq(submissionLedger.userId, user.id), eq(submissionLedger.applicationId, roshn.id)));
    expect(l!.state).toBe("submitted");

    // Next run: nothing new is read or classified again.
    const r2 = await gmail.sync(db, user.id, { source });
    expect(r2).toMatchObject({ seen: 0, classified: 0 });
    const ai = await db.select().from(aiDecisions).where(and(eq(aiDecisions.userId, user.id), eq(aiDecisions.stage, "email_classification")));
    expect(ai).toHaveLength(2);
  });

  it("marks the connection when Google rejects the app password later", async () => {
    const { user } = await makeUser();
    const db = testDb();
    const ok = fakeSource([], { n: 0 });
    await gmail.connect(db, user.id, { email: "me@gmail.com", appPassword: "abcdefghijklmnop" }, ok);
    const revoked: gmail.MailSourceFactory = async () => { throw new AppError("gmail_auth", "Google rejected the login."); };
    await expect(gmail.sync(db, user.id, { source: revoked })).rejects.toMatchObject({ code: "gmail_auth" });
    expect((await gmail.status(db, user.id))!.status).toBe("revoked");
  });
});
