// Single-owner authentication: one password (APP_PASSWORD) -> a signed, expiring token.
// Tokens are signed with a key derived from the password, so changing the password
// signs everyone out. No third-party libraries needed.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const signingKey = (password) =>
  createHash("sha256").update(`application-tracker-token-key:${password}`).digest();

const sign = (payload, password) =>
  createHmac("sha256", signingKey(password)).update(payload).digest("base64url");

/** Compares two secrets in constant time (hashing first so the lengths always match). */
export function checkPassword(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string" || !expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function signToken(password, nowMs = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: nowMs + TOKEN_LIFETIME_MS })).toString("base64url");
  return `${payload}.${sign(payload, password)}`;
}

export function verifyToken(token, password, nowMs = Date.now()) {
  if (typeof token !== "string" || !password) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;

  const [payload, signature] = parts;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(payload, password));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > nowMs;
  } catch {
    return false;
  }
}
