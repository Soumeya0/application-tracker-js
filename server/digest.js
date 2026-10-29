// Daily digest: find what needs attention and email it.
// Dependencies are passed in so the logic can be tested without a real inbox.

import { buildDigest, todayISO } from "../public/js/core.js";

/**
 * @param {object} deps
 * @param {{list(): Promise<object[]>}} deps.store
 * @param {Record<string, string|undefined>} deps.env
 * @param {(message: object) => Promise<unknown>} deps.sendMail
 * @param {Date} [deps.now]
 * @returns {Promise<{sent: boolean, reason?: string, count?: number}>}
 */
export async function runDigest({ store, env, sendMail, now = new Date() }) {
  const user = env.GMAIL_USER;
  const to = env.DIGEST_TO || user;
  if (!user || !env.GMAIL_APP_PASSWORD || !to) {
    return { sent: false, reason: "email-not-configured" };
  }

  const today = todayISO(env.DIGEST_TZ || "America/Toronto", now);
  const digest = buildDigest(await store.list(), today);

  if (digest.items.length === 0 && env.DIGEST_ALWAYS !== "true") {
    return { sent: false, reason: "nothing-due", count: 0 };
  }

  await sendMail({
    from: `Application Tracker <${user}>`,
    to,
    subject: digest.subject,
    text: digest.text,
    html: digest.html,
  });
  return { sent: true, count: digest.items.length };
}
