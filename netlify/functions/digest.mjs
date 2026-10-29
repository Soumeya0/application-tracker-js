// Scheduled Netlify Function: emails the daily digest.
// Cron runs in UTC: 12:00 UTC is 8:00 AM Toronto in summer (7:00 AM in winter).
import nodemailer from "nodemailer";
import { runDigest } from "../../server/digest.js";
import { blobStore } from "../../server/blobStore.js";

export default async () => {
  const env = process.env;
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });

  const result = await runDigest({
    store: blobStore(),
    env,
    sendMail: (message) => transport.sendMail(message),
  });
  console.log("Digest result:", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0 12 * * *" };
