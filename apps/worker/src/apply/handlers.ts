import { AppError, autoapply, employerLink, queue, settings, tailor } from "@careerflow/core";
import { applications, automationSettings } from "@careerflow/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Handler, HandlerContext } from "../handlers";
import { NonRetryableError } from "../handlers";
import { closeSession, fill, materialize, openForm, openSession, screenshot, submit, type Files, type Session } from "./engine";

/** Systems that need an account/login before applying: the user applies there with the prepared CV. */
const ACCOUNT_SYSTEMS = new Set(["workday", "successfactors", "oracle"]);

function nextLocalMidnight(tz: string) {
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offset = now.getTime() - local.getTime();
  const m = new Date(local);
  m.setHours(24, 5, 0, 0);
  return new Date(m.getTime() + offset);
}

async function quota(ctx: HandlerContext, userId: string, kind: "submissions" | "inspections") {
  const s = await settings.getSettings(ctx.db, userId);
  const limit = kind === "submissions" ? s.maxSubmissionsPerDay : s.maxInspectionsPerDay;
  const ok = await settings.consumeDailyQuota(ctx.db, userId, kind, limit, settings.localDay(s.timezone));
  return { ok, resumeAt: nextLocalMidnight(s.timezone), limit };
}

async function loadFiles(ctx: HandlerContext, s: Session, app: { tailoredCvDocumentId: string | null; coverLetterDocumentId: string | null }): Promise<Files> {
  const get = async (id: string | null) => (id ? autoapply.loadFile(ctx.db, id).then((f) => ({ bytes: f.bytes, filename: f.doc.filename })) : null);
  return { cv: await materialize(s, await get(app.tailoredCvDocumentId)), cover_letter: await materialize(s, await get(app.coverLetterDocumentId)) };
}

const prepare: Handler = async (ctx) => {
  const applicationId = String(ctx.task.payload.applicationId);
  const { app, job, ctx: planCtx } = await autoapply.loadContext(ctx.db, applicationId);
  if (app.status !== "processing") return { skipped: `status ${app.status}` };

  let startUrl = autoapply.applyUrlFor(app, job);
  // Job boards often show robot checks and don't host the form: look for the employer's own posting first.
  if (autoapply.isJobBoardUrl(startUrl)) {
    const found = await employerLink.findEmployerLink(ctx.db, job).catch(() => null);
    if (found) {
      const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
      await autoapply.useEmployerLink(ctx.db, app.id, found.url, `Found this job on ${job.companyName}'s own site (${host(found.url)}) — applying there instead of ${host(startUrl)}.`);
      startUrl = found.url;
    }
  }
  const ats = autoapply.atsFromUrl(startUrl);
  if (ats === "linkedin") {
    await autoapply.recordBlocker(ctx.db, app.id, { kind: "job_board", detail: "LinkedIn link — CareerFlow doesn't automate LinkedIn" }, ctx.task.id);
    return { blocked: "linkedin" };
  }
  if (ACCOUNT_SYSTEMS.has(ats)) {
    await autoapply.recordBlocker(ctx.db, app.id, { kind: "login_required", detail: `${ats} requires a candidate account` }, ctx.task.id);
    return { blocked: "login_required" };
  }

  const q = await quota(ctx, app.userId, "inspections");
  if (!q.ok) {
    await ctx.db.update(applications).set({ statusReason: `Daily limit of ${q.limit} application forms reached — continues tomorrow.`, updatedAt: new Date() }).where(eq(applications.id, app.id));
    await queue.enqueue(ctx.db, { kind: "application.prepare", userId: app.userId, payload: ctx.task.payload, runAt: q.resumeAt, maxAttempts: 2, timeoutSeconds: 600 });
    return { deferred: q.resumeAt.toISOString() };
  }

  const s = await openSession();
  try {
    const { snapshot, page, form } = await openForm(s, startUrl, ats);
    ctx.log("apply.form", { applicationId, url: snapshot.url, fields: snapshot.fields.length, blockers: snapshot.blockers.map((b) => b.kind) });
    // Where did following the links end up?
    const landed = autoapply.atsFromUrl(snapshot.url);
    if (landed === "linkedin") {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "job_board", detail: `Ended on LinkedIn (${snapshot.url})` }, ctx.task.id);
      return { blocked: "linkedin" };
    }
    if (ACCOUNT_SYSTEMS.has(landed) && snapshot.blockers.length) {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "login_required", detail: `Employer uses ${landed} (${snapshot.url})` }, ctx.task.id);
      return { blocked: "login_required" };
    }
    if (snapshot.blockers[0]?.kind === "form_missing" && landed === "job_board") {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "job_board", detail: snapshot.blockers[0].detail }, ctx.task.id);
      return { blocked: "job_board" };
    }
    if (snapshot.blockers.length) {
      const b = snapshot.blockers[0]!;
      if (b.kind === "navigation_timeout") throw new Error(b.detail); // retry later
      await autoapply.recordBlocker(ctx.db, app.id, b, ctx.task.id);
      return { blocked: b.kind };
    }

    const plan = await autoapply.planAnswers(ctx.db, planCtx, snapshot);
    if (plan.missing.length) {
      await autoapply.askMissing(ctx.db, planCtx, plan.missing);
      await autoapply.recordWaitingForAnswers(ctx.db, app.id, plan.missing.length);
      return { waiting: plan.missing.length };
    }

    const files = await loadFiles(ctx, s, app);
    const problems = await fill(form, page, plan.answers, files);
    if (problems.length) {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: problems.join(" | ") }, ctx.task.id);
      return { blocked: "fill_failed", problems };
    }
    const shot = await screenshot(page);
    const optional = snapshot.fields.filter((f) => !f.required && !plan.answers.some((a) => a.key === f.key)).length;
    const preview = await autoapply.savePreview(ctx.db, { applicationId: app.id, url: snapshot.url, atsKind: ats, answers: plan.answers, screenshot: shot, skippedOptional: optional });
    const auto = await autoapply.maybeAutoApprove(ctx.db, preview.id);
    return { previewId: preview.id, answers: plan.answers.length, autoApproved: auto };
  } catch (err) {
    if (err instanceof AppError && ["ai_auth", "ai_rate_limited"].includes(err.code)) throw err;
    if (err instanceof AppError) throw new NonRetryableError(err.userMessage);
    throw err;
  } finally {
    await closeSession(s);
  }
};

const submitHandler: Handler = async (ctx) => {
  const applicationId = String(ctx.task.payload.applicationId);
  const approvalId = String(ctx.task.payload.approvalId);
  let approved;
  try {
    approved = await autoapply.loadApproved(ctx.db, applicationId, approvalId);
  } catch (err) {
    throw new NonRetryableError(err instanceof Error ? err.message : String(err));
  }
  const { app, job } = await autoapply.loadContext(ctx.db, applicationId);
  if (app.status !== "processing") return { skipped: `status ${app.status}` };

  const q = await quota(ctx, app.userId, "submissions");
  if (!q.ok) {
    await ctx.db.update(applications).set({ statusReason: `Daily limit of ${q.limit} submissions reached — sends tomorrow.`, updatedAt: new Date() }).where(eq(applications.id, app.id));
    await queue.enqueue(ctx.db, { kind: "application.submit", userId: app.userId, payload: ctx.task.payload, runAt: q.resumeAt, maxAttempts: 3, timeoutSeconds: 600 });
    return { deferred: q.resumeAt.toISOString() };
  }

  const s = await openSession();
  let clicked = false;
  try {
    const { snapshot, page, form } = await openForm(s, approved.data.url || autoapply.applyUrlFor(app, job), approved.data.atsKind);
    if (snapshot.blockers.length) {
      const b = snapshot.blockers[0]!;
      if (b.kind === "navigation_timeout") throw new Error(b.detail);
      await autoapply.recordBlocker(ctx.db, app.id, b, ctx.task.id);
      return { blocked: b.kind };
    }
    // The form must be the one that was approved: same fields, no new required ones.
    const answers = approved.data.answers;
    const gone = answers.filter((a) => !snapshot.fields.some((f) => f.key === a.key));
    const added = snapshot.fields.filter((f) => f.required && !answers.some((a) => a.key === f.key));
    if (gone.length || added.length) {
      await ctx.db.update(applications).set({ status: "processing", checkpoint: "queued_prepare", statusReason: "The employer changed the form — preparing a new version for your review.", updatedAt: new Date() }).where(eq(applications.id, app.id));
      await queue.enqueue(ctx.db, { kind: "application.prepare", userId: app.userId, payload: { applicationId }, dedupeKey: `apply:prepare:${applicationId}`, maxAttempts: 2, timeoutSeconds: 600 });
      return { formChanged: { gone: gone.map((a) => a.label), added: added.map((f) => f.label) } };
    }
    await autoapply.verifyBeforeSubmit(ctx.db, applicationId, approvalId, answers);

    const files = await loadFiles(ctx, s, app);
    const problems = await fill(form, page, answers, files);
    if (problems.length) {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: problems.join(" | ") }, ctx.task.id);
      return { blocked: "fill_failed", problems };
    }

    // Point of no return: from here a crash must never cause an automatic resubmit.
    await ctx.checkpoint({ irreversible: true, stage: "submit_clicked", at: new Date().toISOString() });
    await autoapply.reserveSubmission(ctx.db, applicationId, approvalId);
    clicked = true;
    const r = await submit(form, page);
    await autoapply.recordOutcome(ctx.db, { applicationId, approvalId, outcome: r.outcome, url: r.url, summary: r.summary, screenshot: r.screenshot, errors: r.errors });
    return { outcome: r.outcome };
  } catch (err) {
    if (clicked) {
      await autoapply.recordOutcome(ctx.db, { applicationId, approvalId, outcome: "uncertain", url: autoapply.applyUrlFor(app, job), summary: `Error after Submit: ${String(err).slice(0, 200)}` }).catch(() => undefined);
      return { outcome: "uncertain" };
    }
    if (err instanceof AppError) {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: err.userMessage }, ctx.task.id).catch(() => undefined);
      throw new NonRetryableError(err.userMessage);
    }
    throw err;
  } finally {
    await closeSession(s);
  }
};

/** Autopilot: pick the best new matches, tailor the CV and prepare the application. */
const autopilotRun: Handler = async (ctx) => {
  const users = await ctx.db
    .select({ userId: automationSettings.userId, batch: automationSettings.maxBatchSize })
    .from(automationSettings)
    .where(and(eq(automationSettings.autopilotEnabled, true), isNotNull(automationSettings.automationConsentAt)));
  const out: Record<string, unknown> = {};
  for (const u of users) {
    try {
      const [inflight] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(applications)
        .where(and(eq(applications.userId, u.userId), inArray(applications.status, ["processing", "awaiting_approval"])));
      const slots = Math.max(0, u.batch - (inflight?.n ?? 0));
      if (!slots) {
        out[u.userId] = { skipped: "batch full" };
        continue;
      }
      const picks = await autoapply.autopilotCandidates(ctx.db, u.userId, slots);
      let started = 0;
      for (const p of picks) {
        try {
          const t = await tailor.tailorCv(ctx.db, u.userId, { jobTitle: p.j.title, companyName: p.j.companyName, jobDescription: p.j.description!, includeCoverLetter: true, jobId: p.j.id });
          await autoapply.startAutoApply(ctx.db, u.userId, { jobId: p.j.id, tailoringId: t.id, origin: "autopilot" });
          started++;
        } catch (err) {
          if (err instanceof AppError && ["ai_auth", "ai_rate_limited", "no_consent"].includes(err.code)) throw err;
          ctx.log("autopilot.skip", { jobId: p.j.id, error: String(err).slice(0, 200) });
        }
      }
      out[u.userId] = { started, considered: picks.length };
    } catch (err) {
      out[u.userId] = { error: String(err).slice(0, 200) };
    }
  }
  return out;
};

/** An inbox question was answered: continue every application that was only waiting for answers. */
const resume: Handler = async (ctx) => ({ resumed: await autoapply.resumeWaiting(ctx.db, String(ctx.task.userId ?? ctx.task.payload.userId)) });

export const applyHandlers: Record<string, Handler> = {
  "application.resume": resume,
  "application.prepare": prepare,
  "application.submit": submitHandler,
  "autopilot.run": autopilotRun,
};
