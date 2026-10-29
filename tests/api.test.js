import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../server/handler.js";
import { checkPassword, signToken, verifyToken } from "../server/auth.js";
import { runDigest } from "../server/digest.js";

const PASSWORD = "correct horse battery staple";

function memoryStore() {
  const data = new Map();
  return {
    async list() { return [...data.values()]; },
    async get(id) { return data.get(id) ?? null; },
    async set(id, value) { data.set(id, value); },
    async delete(id) { data.delete(id); },
  };
}

function setup(options = {}) {
  const { now = () => Date.parse("2026-10-29T12:00:00Z") } = options;
  // An explicit `password: undefined` must stay undefined (not fall back to the default).
  const password = "password" in options ? options.password : PASSWORD;
  const store = memoryStore();
  const handle = createHandler({ store, password, now, failDelayMs: 0 });
  const call = async (method, path, { body, token } = {}) => {
    const res = await handle(
      new Request(`https://tracker.test${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    return { status: res.status, data: await res.json() };
  };
  const login = async () => (await call("POST", "/api/login", { body: { password: PASSWORD } })).data.token;
  return { store, call, login };
}

test("auth: password check and token round trip", () => {
  assert.equal(checkPassword(PASSWORD, PASSWORD), true);
  assert.equal(checkPassword("wrong", PASSWORD), false);
  assert.equal(checkPassword(undefined, PASSWORD), false);

  const token = signToken(PASSWORD, 1000);
  assert.equal(verifyToken(token, PASSWORD, 2000), true);
  assert.equal(verifyToken(token, "another password", 2000), false, "wrong key");
  assert.equal(verifyToken(token, PASSWORD, 1000 + 8 * 24 * 3600 * 1000), false, "expired");
  assert.equal(verifyToken(token + "x", PASSWORD, 2000), false, "tampered signature");
  assert.equal(verifyToken("garbage", PASSWORD, 2000), false);
  assert.equal(verifyToken("", PASSWORD, 2000), false);
});

test("api: refuses to run without a configured password", async () => {
  const { call } = setup({ password: undefined });
  const res = await call("POST", "/api/login", { body: { password: "anything" } });
  assert.equal(res.status, 503);
});

test("api: wrong password gets 401, right password gets a token", async () => {
  const { call } = setup();
  assert.equal((await call("POST", "/api/login", { body: { password: "nope" } })).status, 401);
  const ok = await call("POST", "/api/login", { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
});

test("api: every data route needs a token", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/applications")).status, 401);
  assert.equal((await call("POST", "/api/applications", { body: { company: "A", role: "B" } })).status, 401);
  assert.equal((await call("DELETE", "/api/applications/abc")).status, 401);
  assert.equal((await call("GET", "/api/applications", { token: "bad.token" })).status, 401);
});

test("api: create, list, update and delete an application", async () => {
  const { call, login } = setup();
  const token = await login();

  const created = await call("POST", "/api/applications", {
    token,
    body: { company: " Ciena ", role: "Co-op", status: "Applied", follow_up_date: "2026-11-02" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.company, "Ciena");
  assert.ok(created.data.id);

  const list = await call("GET", "/api/applications", { token });
  assert.equal(list.data.length, 1);

  const id = created.data.id;
  const updated = await call("PUT", `/api/applications/${id}`, {
    token,
    body: { company: "Ciena", role: "Co-op", status: "Interview" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, "Interview");
  assert.equal(updated.data.created_at, created.data.created_at, "created_at is preserved");

  assert.equal((await call("DELETE", `/api/applications/${id}`, { token })).status, 200);
  assert.equal((await call("GET", "/api/applications", { token })).data.length, 0);
});

test("api: validation errors, bad JSON, unknown ids and unknown routes", async () => {
  const { call, login } = setup();
  const token = await login();

  const invalid = await call("POST", "/api/applications", { token, body: { company: "", role: "" } });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.errors.company);

  assert.equal((await call("POST", "/api/applications", { token, body: "{not json" })).status, 400);
  assert.equal((await call("POST", "/api/applications", { token, body: "[1,2]" })).status, 400);
  assert.equal((await call("PUT", "/api/applications/missing", { token, body: { company: "A", role: "B" } })).status, 404);
  assert.equal((await call("GET", "/api/nothing", { token })).status, 404);
  assert.equal((await call("PATCH", "/api/applications", { token, body: {} })).status, 405);
});

test("api: oversized bodies are rejected", async () => {
  const { call, login } = setup();
  const token = await login();
  const res = await call("POST", "/api/applications", {
    token,
    body: { company: "A", role: "B", notes: "x".repeat(30_000) },
  });
  assert.equal(res.status, 413);
});

test("digest: sends only when something is due, and only when email is configured", async () => {
  const store = memoryStore();
  await store.set("1", { id: "1", company: "Late Inc", role: "Intern", status: "Applied", follow_up_date: "2026-10-27" });
  await store.set("2", { id: "2", company: "Calm Ltd", role: "Intern", status: "Applied", follow_up_date: "2027-03-01" });

  const sent = [];
  const sendMail = async (m) => sent.push(m);
  const now = new Date("2026-10-29T12:00:00Z");
  const env = { GMAIL_USER: "me@example.com", GMAIL_APP_PASSWORD: "pw", DIGEST_TZ: "America/Toronto" };

  assert.deepEqual(await runDigest({ store, env: {}, sendMail, now }), { sent: false, reason: "email-not-configured" });
  assert.equal(sent.length, 0);

  const result = await runDigest({ store, env, sendMail, now });
  assert.deepEqual(result, { sent: true, count: 1 });
  assert.equal(sent[0].to, "me@example.com");
  assert.match(sent[0].text, /Late Inc/);
  assert.ok(!sent[0].text.includes("Calm Ltd"));

  const quiet = memoryStore();
  const nothing = await runDigest({ store: quiet, env, sendMail, now });
  assert.equal(nothing.reason, "nothing-due");
  assert.equal(sent.length, 1);

  const always = await runDigest({ store: quiet, env: { ...env, DIGEST_ALWAYS: "true" }, sendMail, now });
  assert.equal(always.sent, true);
  assert.equal(sent.length, 2);
});
