// The API, written as a plain function: (Request) -> Response.
// It takes its dependencies (storage, password, clock) as arguments, so the tests can
// run it with an in-memory store and the Netlify function can run it with Netlify Blobs.

import { validateApplication } from "../public/js/core.js";
import { checkPassword, signToken, verifyToken } from "./auth.js";

const MAX_BODY_CHARS = 20_000;
const ID_PATTERN = /^\/api\/applications\/([A-Za-z0-9-]{1,64})$/;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) throw new HttpError(413, "That request is too large.");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body;
}

function cleanOrThrow(body) {
  const result = validateApplication(body);
  if (!result.ok) throw new HttpError(400, "Please fix the highlighted fields.", { errors: result.errors });
  return result.value;
}

/**
 * @param {object} deps
 * @param {{list(): Promise<object[]>, get(id): Promise<object|null>, set(id, v): Promise<void>, delete(id): Promise<void>}} deps.store
 * @param {string|undefined} deps.password   the owner password (APP_PASSWORD)
 * @param {() => number} [deps.now]          clock in ms, injectable for tests
 * @param {number} [deps.failDelayMs]        pause after a wrong password to slow down guessing
 */
export function createHandler({ store, password, now = Date.now, failDelayMs = 400 }) {
  return async function handle(req) {
    try {
      const path = new URL(req.url).pathname.replace(/\/+$/, "");
      const method = req.method.toUpperCase();

      if (!password) {
        throw new HttpError(503, "The server isn't set up yet. Add an APP_PASSWORD environment variable.");
      }

      if (path === "/api/login") {
        if (method !== "POST") throw new HttpError(405, "Use POST.");
        const body = await readJson(req);
        if (!checkPassword(body.password, password)) {
          await sleep(failDelayMs);
          throw new HttpError(401, "Incorrect password.");
        }
        return json(200, { token: signToken(password, now()) });
      }

      // Everything below needs a valid token.
      const header = req.headers.get("authorization") || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!verifyToken(token, password, now())) throw new HttpError(401, "Please sign in.");

      if (path === "/api/applications") {
        if (method === "GET") return json(200, await store.list());
        if (method === "POST") {
          const value = cleanOrThrow(await readJson(req));
          const stamp = new Date(now()).toISOString();
          const record = { id: crypto.randomUUID(), ...value, created_at: stamp, updated_at: stamp };
          await store.set(record.id, record);
          return json(201, record);
        }
        throw new HttpError(405, "Use GET or POST.");
      }

      const match = path.match(ID_PATTERN);
      if (match) {
        const id = match[1];
        const existing = await store.get(id);
        if (!existing) throw new HttpError(404, "Application not found.");

        if (method === "PUT") {
          const value = cleanOrThrow(await readJson(req));
          const record = {
            id,
            ...value,
            created_at: existing.created_at,
            updated_at: new Date(now()).toISOString(),
          };
          await store.set(id, record);
          return json(200, record);
        }
        if (method === "DELETE") {
          await store.delete(id);
          return json(200, { ok: true });
        }
        throw new HttpError(405, "Use PUT or DELETE.");
      }

      throw new HttpError(404, "Not found.");
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, ...err.extra });
      console.error("Unexpected error:", err);
      return json(500, { error: "Something went wrong on the server." });
    }
  };
}
