import { randomBytes } from "node:crypto";
console.log(`APP_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`APP_HASH_KEY=${randomBytes(32).toString("base64url")}`);
console.log("\nStore these in Vercel AND Railway (same values). Losing APP_ENCRYPTION_KEY makes encrypted data unreadable — keep a copy in a password manager.");
