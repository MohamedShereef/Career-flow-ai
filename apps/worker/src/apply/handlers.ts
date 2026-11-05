import { AppError, autoapply, employerLink, logins, queue, settings, tailor } from "@careerflow/core";
import { applications, automationSettings } from "@careerflow/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Handler, HandlerContext } from "../handlers";
import { NonRetryableError } from "../handlers";
import { closeSession, describeProblems, fill, goNext, materialize, navState, openForm, openSession, readStep, screenshot, submit, type Files, type Session } from "./engine";

/** Systems that need a candidate account: used only when the user saved a login for that portal. */
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

const MAX_STEPS = 12;
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
/** Multi-page forms: answers on step n>0 carry a "p<n>|" prefix so keys never collide across steps. */
const stepKey = (step: number, key: string) => (step ? `p${step}|${key}` : key);
const stepOf = (key: string) => { const m = key.match(/^p(\d+)\|/); return m ? Number(m[1]) : 0; };
const unstep = (a: autoapply.PlannedAnswer): autoapply.PlannedAnswer => ({ ...a, key: a.key.replace(/^p\d+\|/, "") });

function loginLookup(ctx: HandlerContext, userId: string, used: { id?: string }) {
  return async (host: string) => {
    const c = await logins.loginForHost(ctx.db, userId, host);
    if (!c) return null;
    used.id = c.id;
    return { username: c.username, password: c.password };
  };
}

async function reportLogin(ctx: HandlerContext, used: { id?: string }, outcome?: string) {
  if (!used.id || !outcome || outcome === "no_sign_in") return;
  await logins.recordLoginResult(ctx.db, used.id, outcome === "ok" ? "ok" : outcome === "verification_required" ? "verification_required" : "failed");
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
      const h = (u: string) => hostOf(u).replace(/^www\./, "") || u;
      await autoapply.useEmployerLink(ctx.db, app.id, found.url, `Found this job on ${job.companyName}'s own site (${h(found.url)}) — applying there instead of ${h(startUrl)}.`);
      startUrl = found.url;
    }
  }
  const ats = autoapply.atsFromUrl(startUrl);
  if (ats === "linkedin") {
    await autoapply.recordBlocker(ctx.db, app.id, { kind: "job_board", detail: "LinkedIn link — CareerFlow doesn't automate LinkedIn" }, ctx.task.id);
    return { blocked: "linkedin" };
  }
  if (ACCOUNT_SYSTEMS.has(ats) && !(await logins.loginForHost(ctx.db, app.userId, hostOf(startUrl)))) {
    await autoapply.recordBlocker(ctx.db, app.id, { kind: "login_required", detail: `${ats} requires a candidate account`, host: hostOf(startUrl) }, ctx.task.id);
    return { blocked: "login_required" };
  }

  const q = await quota(ctx, app.userId, "inspections");
  if (!q.ok) {
    await ctx.db.update(applications).set({ statusReason: `Daily limit of ${q.limit} application forms reached — continues tomorrow.`, updatedAt: new Date() }).where(eq(applications.id, app.id));
    await queue.enqueue(ctx.db, { kind: "application.prepare", userId: app.userId, payload: ctx.task.payload, runAt: q.resumeAt, maxAttempts: 2, timeoutSeconds: 900 });
    return { deferred: q.resumeAt.toISOString() };
  }

  const s = await openSession();
  const used: { id?: string } = {};
  try {
    const opened = await openForm(s, startUrl, ats, { login: loginLookup(ctx, app.userId, used) });
    const { snapshot, page } = opened;
    let form = opened.form;
    await reportLogin(ctx, used, opened.login?.outcome);
    ctx.log("apply.form", { applicationId, url: snapshot.url, fields: snapshot.fields.length, blockers: snapshot.blockers.map((b) => b.kind), login: opened.login?.outcome });
    const landed = autoapply.atsFromUrl(snapshot.url);
    if (landed === "linkedin") {
      await autoapply.recordBlocker(ctx.db, app.id, { kind: "job_board", detail: `Ended on LinkedIn (${snapshot.url})` }, ctx.task.id);
      return { blocked: "linkedin" };
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

    const files = await loadFiles(ctx, s, app);
    const all: autoapply.PlannedAnswer[] = [];
    let fields = snapshot.fields;
    let optional = 0;
    let steps = 1;
    for (let step = 0; ; step++) {
      steps = step + 1;
      const plan = await autoapply.planAnswers(ctx.db, planCtx, { ...snapshot, fields });
      if (plan.missing.length) {
        await autoapply.askMissing(ctx.db, planCtx, plan.missing);
        await autoapply.recordWaitingForAnswers(ctx.db, app.id, plan.missing.length);
        return { waiting: plan.missing.length, step };
      }
      const required = new Set(fields.filter((f) => f.required).map((f) => f.key));
      const { problems } = await fill(form, page, plan.answers, files, required);
      const blocking = problems.filter((p) => p.required);
      if (blocking.length) {
        await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: `${step ? `Step ${step + 1}: ` : ""}${describeProblems(blocking)}`, debug: blocking.map((b) => ({ label: b.label, wanted: b.wanted, debug: b.debug })) }, ctx.task.id, await screenshot(page).catch(() => null));
        return { blocked: "fill_failed", problems: blocking };
      }
      // Optional fields the page wouldn't take are left empty (and not part of what you approve).
      const dropped = new Set(problems.map((p) => p.key));
      if (dropped.size) ctx.log("apply.optional_skipped", { applicationId, fields: problems.map((p) => p.label) });
      all.push(...plan.answers.filter((a) => !dropped.has(a.key)).map((a) => ({ ...a, key: stepKey(step, a.key) })));
      optional += fields.filter((f) => !f.required && !plan.answers.some((a) => a.key === f.key)).length;

      const nav = await navState(form);
      if (!nav.next || nav.submit) break; // final step: the Submit button is here
      if (step + 1 >= MAX_STEPS) {
        await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: `More than ${MAX_STEPS} steps` }, ctx.task.id);
        return { blocked: "too_many_steps" };
      }
      const moved = await goNext(form, page);
      if (moved.submitted) {
        await autoapply.recordUnplannedSubmit(ctx.db, app.id, moved.submitted);
        return { outcome: "submitted_on_next" };
      }
      if (!moved.ok) {
        await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: `Step ${step + 1} wasn't accepted: ${moved.errors.join("; ")}` }, ctx.task.id);
        return { blocked: "step_rejected", errors: moved.errors };
      }
      const next = await readStep(page);
      form = next.form;
      fields = next.fields;
    }

    const shot = await screenshot(page);
    const preview = await autoapply.savePreview(ctx.db, { applicationId: app.id, url: startUrl, atsKind: ats, answers: all, screenshot: shot, skippedOptional: optional, steps });
    const auto = await autoapply.maybeAutoApprove(ctx.db, preview.id);
    return { previewId: preview.id, answers: all.length, steps, autoApproved: auto };
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
    await queue.enqueue(ctx.db, { kind: "application.submit", userId: app.userId, payload: ctx.task.payload, runAt: q.resumeAt, maxAttempts: 3, timeoutSeconds: 900 });
    return { deferred: q.resumeAt.toISOString() };
  }

  const reprepare = async (why: string) => {
    await ctx.db.update(applications).set({ status: "processing", checkpoint: "queued_prepare", statusReason: "The employer changed the form — preparing a new version for your review.", updatedAt: new Date() }).where(eq(applications.id, app.id));
    await queue.enqueue(ctx.db, { kind: "application.prepare", userId: app.userId, payload: { applicationId }, dedupeKey: `apply:prepare:${applicationId}`, maxAttempts: 2, timeoutSeconds: 900 });
    return { formChanged: why };
  };

  const s = await openSession();
  const used: { id?: string } = {};
  let clicked = false;
  try {
    const url = approved.data.url || autoapply.applyUrlFor(app, job);
    const opened = await openForm(s, url, approved.data.atsKind, { login: loginLookup(ctx, app.userId, used) });
    const { snapshot, page } = opened;
    let form = opened.form;
    await reportLogin(ctx, used, opened.login?.outcome);
    if (snapshot.blockers.length) {
      const b = snapshot.blockers[0]!;
      if (b.kind === "navigation_timeout") throw new Error(b.detail);
      await autoapply.recordBlocker(ctx.db, app.id, b, ctx.task.id);
      return { blocked: b.kind };
    }

    const answers = approved.data.answers;
    const lastStep = (approved.data.steps ?? Math.max(0, ...answers.map((a) => stepOf(a.key))) + 1) - 1;
    const files = await loadFiles(ctx, s, app);
    let fields = snapshot.fields;
    for (let step = 0; ; step++) {
      // Each step must be the one that was approved: same fields, no new required ones.
      const mine = answers.filter((a) => stepOf(a.key) === step).map(unstep);
      const gone = mine.filter((a) => !fields.some((f) => f.key === a.key));
      const added = fields.filter((f) => f.required && !mine.some((a) => a.key === f.key));
      if (gone.length || added.length) return await reprepare(`step ${step + 1}: gone ${gone.map((a) => a.label).join(", ")} added ${added.map((f) => f.label).join(", ")}`);

      const { problems } = await fill(form, page, mine, files, new Set(fields.filter((f) => f.required).map((f) => f.key)));
      const blocking = problems.filter((p) => p.required);
      if (blocking.length) {
        await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: describeProblems(blocking), debug: blocking.map((b) => ({ label: b.label, wanted: b.wanted, debug: b.debug })) }, ctx.task.id, await screenshot(page).catch(() => null));
        return { blocked: "fill_failed", problems: blocking };
      }
      const nav = await navState(form);
      if (!nav.next || nav.submit) {
        if (step !== lastStep) return await reprepare(`ended at step ${step + 1}, approved ${lastStep + 1}`);
        break;
      }
      if (step >= lastStep) return await reprepare("an extra step appeared");
      const moved = await goNext(form, page);
      if (!moved.ok) {
        await autoapply.recordBlocker(ctx.db, app.id, { kind: "fill_failed", detail: `Step ${step + 1} wasn't accepted: ${moved.errors.join("; ")}` }, ctx.task.id);
        return { blocked: "step_rejected" };
      }
      const next = await readStep(page);
      form = next.form;
      fields = next.fields;
    }
    await autoapply.verifyBeforeSubmit(ctx.db, applicationId, approvalId, answers);

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
      const left = await autoapply.autopilotStartsLeft(ctx.db, u.userId);
      const slots = Math.min(left, Math.max(0, u.batch - (inflight?.n ?? 0)));
      if (!slots) {
        out[u.userId] = { skipped: left ? "batch full" : "daily limit reached" };
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
          if (err instanceof AppError && ["ai_auth", "ai_rate_limited", "no_consent", "ai_no_credit"].includes(err.code)) throw err;
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
