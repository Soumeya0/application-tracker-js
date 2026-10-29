// Two interchangeable data sources with the same four methods: list, create, update, remove.
//   - remote: the real thing, talking to the Netlify Functions API (owner only, saved in the cloud)
//   - local:  a demo that keeps sample data in this browser only, so anyone can try the app

import { addDays } from "./core.js";

export class ApiError extends Error {
  constructor(message, fieldErrors = {}) {
    super(message);
    this.fieldErrors = fieldErrors;
  }
}

// Browsers can block localStorage (private windows, strict settings), so never assume it works.
export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore: the app still works for this session */
  }
}
export function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---------- remote ----------

export async function login(password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || "Could not sign in.");
  return data.token;
}

export function createRemoteStore({ getToken, onSignedOut }) {
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          authorization: `Bearer ${getToken()}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError("Can't reach the server. Check your connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      onSignedOut();
      throw new ApiError("Your session ended. Please sign in again.");
    }
    if (!res.ok) throw new ApiError(data.error || "Request failed.", data.errors);
    return data;
  }

  return {
    list: () => call("GET", "/api/applications"),
    create: (value) => call("POST", "/api/applications", value),
    update: (id, value) => call("PUT", `/api/applications/${encodeURIComponent(id)}`, value),
    remove: (id) => call("DELETE", `/api/applications/${encodeURIComponent(id)}`),
  };
}

// ---------- local demo ----------

const DEMO_KEY = "application-tracker-demo-v1";

function sampleData(today) {
  const row = (company, role, status, extra = {}) => ({
    company,
    role,
    status,
    applied_date: "",
    deadline: "",
    follow_up_date: "",
    response_date: "",
    url: "",
    notes: "",
    ...extra,
  });
  // Dates are relative to today so the urgency highlighting always has something to show.
  return [
    row("Northwind Labs", "Software Engineering Intern", "Wishlist", {
      deadline: addDays(today, 2),
      notes: "Tailor the resume to their backend focus.",
    }),
    row("Maple Systems", "Backend Co-op", "Applied", {
      applied_date: addDays(today, -9),
      follow_up_date: addDays(today, -2),
      notes: "Recruiter said to check back after a week.",
    }),
    row("Bluebird Health", "Full-Stack Intern", "Interview", {
      applied_date: addDays(today, -14),
      response_date: addDays(today, -6),
      follow_up_date: addDays(today, 1),
      notes: "Technical interview done. Send a thank-you note.",
    }),
    row("Orbit Payments", "Platform Intern", "Applied", {
      applied_date: addDays(today, -5),
      follow_up_date: addDays(today, 10),
    }),
    row("Lakeside Robotics", "Embedded Software Intern", "Offer", {
      applied_date: addDays(today, -30),
      response_date: addDays(today, -20),
      deadline: addDays(today, 6),
      notes: "Offer received. Decision needed by the deadline.",
    }),
    row("Pine Street Games", "Tools Programmer Intern", "Rejected", {
      applied_date: addDays(today, -25),
      response_date: addDays(today, -15),
    }),
  ].map((r, i) => ({
    id: `demo-${i + 1}`,
    ...r,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
}

export function createLocalStore(today) {
  let memory = null; // fallback when localStorage is unavailable

  function read() {
    if (memory) return memory;
    const raw = safeGet(DEMO_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through to reseed */
      }
    }
    return write(sampleData(today));
  }
  function write(list) {
    memory = list;
    safeSet(DEMO_KEY, JSON.stringify(list));
    return list;
  }

  return {
    async list() {
      return [...read()];
    },
    async create(value) {
      const stamp = new Date().toISOString();
      const record = { id: `demo-${crypto.randomUUID()}`, ...value, created_at: stamp, updated_at: stamp };
      write([...read(), record]);
      return record;
    },
    async update(id, value) {
      const list = read();
      const existing = list.find((a) => a.id === id);
      if (!existing) throw new ApiError("Application not found.");
      const record = { ...value, id, created_at: existing.created_at, updated_at: new Date().toISOString() };
      write(list.map((a) => (a.id === id ? record : a)));
      return record;
    },
    async remove(id) {
      write(read().filter((a) => a.id !== id));
      return { ok: true };
    },
    reset() {
      safeRemove(DEMO_KEY);
      memory = null;
    },
  };
}
