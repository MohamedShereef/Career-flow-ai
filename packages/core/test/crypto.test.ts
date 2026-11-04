import { describe, expect, it } from "vitest";
import { decrypt, encrypt, keyedHash } from "../src/crypto";
import { hashPassword, passwordProblems, verifyPassword } from "../src/password";
import { employerKey, normalizeQuestion } from "../src/normalize";
import { sniffMime } from "../src/services/documents";

describe("crypto", () => {
  it("round-trips and binds to AAD", () => {
    const c = encrypt("SAR 25,000 monthly", "u1");
    expect(c).not.toContain("25,000");
    expect(decrypt(c, "u1")).toBe("SAR 25,000 monthly");
    expect(() => decrypt(c, "u2")).toThrow();
  });
  it("detects tampering", () => {
    const c = encrypt("secret");
    const parts = c.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."))).toThrow();
  });
  it("supports key rotation via previous key", () => {
    const c = encrypt("old");
    const current = process.env.APP_ENCRYPTION_KEY!;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.APP_ENCRYPTION_KEY_PREVIOUS = current;
    try {
      expect(decrypt(c)).toBe("old");
    } finally {
      process.env.APP_ENCRYPTION_KEY = current;
      delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
    }
  });
  it("keyed hash is stable and purpose-scoped", () => {
    expect(keyedHash("a", "x")).toBe(keyedHash("a", "x"));
    expect(keyedHash("a", "x")).not.toBe(keyedHash("a", "y"));
  });
});

describe("passwords", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct horse 42");
    expect(await verifyPassword("correct horse 42", h)).toBe(true);
    expect(await verifyPassword("wrong horse 42", h)).toBe(false);
  });
  it("rejects weak passwords", () => {
    expect(passwordProblems("short1")).toBeTruthy();
    expect(passwordProblems("onlyletterslong")).toBeTruthy();
    expect(passwordProblems("letters and 123")).toBeNull();
  });
});

describe("normalization", () => {
  it("normalizes employer names", () => {
    expect(employerKey("FCC Construcción S.A.")).toBe("fcc construccion");
    expect(employerKey("Saudi Entertainment Ventures (SEVEN) Co.")).toBe("saudi entertainment ventures seven");
  });
  it("equates trivially different question wordings", () => {
    expect(normalizeQuestion("Are you legally authorised to work in Saudi Arabia? *")).toBe(
      normalizeQuestion("are you legally authorized to work in saudi arabia"),
    );
  });
  it("sniffs file types by content", () => {
    expect(sniffMime(Buffer.from("%PDF-1.7 ..."))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("not a pdf"))).toBeNull();
  });
});
