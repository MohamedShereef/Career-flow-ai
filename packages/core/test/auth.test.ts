import { afterAll, describe, expect, it } from "vitest";
import * as auth from "../src/services/auth";
import { closeDb, makeUser, testDb } from "../../../test/helpers";

afterAll(closeDb);

describe("auth", () => {
  it("signs up, creates profile + settings, and returns a valid session", async () => {
    const u = await makeUser();
    const s = await auth.validateSession(testDb(), u.token);
    expect(s?.email).toBe(u.email);
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const u = await makeUser();
    await expect(auth.signUp(testDb(), { email: u.email.toUpperCase(), password: "another pass 1" }, { ip: "1.1.1.9" })).rejects.toMatchObject({
      code: "email_taken",
    });
  });

  it("uses a generic error for wrong password and unknown email", async () => {
    const u = await makeUser();
    await expect(auth.signIn(testDb(), { email: u.email, password: "wrong pass 99" }, { ip: "2.2.2.2" })).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(auth.signIn(testDb(), { email: "nobody@example.com", password: "wrong pass 99" }, { ip: "2.2.2.3" })).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("locks the account after repeated failures", async () => {
    const u = await makeUser();
    for (let i = 0; i < 8; i++) {
      await auth.signIn(testDb(), { email: u.email, password: "nope nope 1" }, { ip: `3.3.3.${i}` }).catch(() => undefined);
    }
    await expect(auth.signIn(testDb(), { email: u.email, password: u.password }, { ip: "3.3.4.1" })).rejects.toMatchObject({ code: "locked" });
  });

  it("rejects forged or revoked session tokens", async () => {
    const u = await makeUser();
    expect(await auth.validateSession(testDb(), "forged-token")).toBeNull();
    await auth.signOut(testDb(), u.token);
    expect(await auth.validateSession(testDb(), u.token)).toBeNull();
  });

  it("password reset is single-use and revokes existing sessions", async () => {
    const u = await makeUser();
    const r = await auth.requestPasswordReset(testDb(), u.email, { ip: "4.4.4.4" });
    expect(r?.token).toBeTruthy();
    expect(await auth.requestPasswordReset(testDb(), "ghost@example.com", { ip: "4.4.4.5" })).toBeNull();
    await auth.resetPassword(testDb(), r!.token, "brand new pass 7");
    expect(await auth.validateSession(testDb(), u.token)).toBeNull();
    await expect(auth.resetPassword(testDb(), r!.token, "another new 8")).rejects.toMatchObject({ code: "invalid_token" });
    const again = await auth.signIn(testDb(), { email: u.email, password: "brand new pass 7" }, { ip: "4.4.4.6" });
    expect(await auth.validateSession(testDb(), again.token)).not.toBeNull();
  });

  it("change password keeps only the fresh session", async () => {
    const u = await makeUser();
    const fresh = await auth.changePassword(testDb(), u.user.id, u.password, "changed pass 55");
    expect(await auth.validateSession(testDb(), u.token)).toBeNull();
    expect(await auth.validateSession(testDb(), fresh.token)).not.toBeNull();
  });
});
