// Core logic for the Application Tracker.
// Pure functions only (no DOM, no network, no storage), so the exact same file runs in
// the browser, in the Netlify functions, and in the tests.

export const STATUSES = ["Wishlist", "Applied", "Interview", "Offer", "Rejected", "Withdrawn"];

// "Closed" applications never raise urgency alerts.
const CLOSED = new Set(["Rejected", "Withdrawn"]);
// A company getting back to you in any of these ways counts as a response.
const RESPONDED = new Set(["Interview", "Offer", "Rejected"]);
// The deadline field only matters while there is still something to do before it:
// submit the application (Wishlist) or decide on an offer (Offer).
const DEADLINE_STATUSES = new Set(["Wishlist", "Offer"]);

export const SOON_DAYS = 3;

export const DATE_FIELDS = ["applied_date", "deadline", "follow_up_date", "response_date"];

const LIMITS = { company: 100, role: 100, url: 500, notes: 2000 };

// ---------- dates (all dates are plain YYYY-MM-DD strings, compared in UTC) ----------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseISO(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const time = Date.UTC(y, m - 1, d);
  const check = new Date(time);
  // Rejects things like 2026-02-31 that JavaScript would silently roll over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return time;
}

export function isValidDate(value) {
  return parseISO(value) !== null;
}

/** Whole days from a to b (positive when b is later). Null if either date is invalid. */
export function daysBetween(a, b) {
  const ta = parseISO(a);
  const tb = parseISO(b);
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / 86400000);
}

export function addDays(iso, days) {
  const t = parseISO(iso);
  if (t === null) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD in the given IANA time zone (or the local zone if omitted). */
export function todayISO(timeZone, now = new Date()) {
  return now.toLocaleDateString("en-CA", timeZone ? { timeZone } : undefined);
}

// ---------- validation ----------

/**
 * Cleans and validates form input.
 * Returns { ok, errors, value }. `value` only contains known fields, trimmed.
 */
export function validateApplication(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const text = (key) => (typeof src[key] === "string" ? src[key].trim() : "");
  const errors = {};

  const value = {
    company: text("company"),
    role: text("role"),
    status: typeof src.status === "string" && src.status ? src.status : "Applied",
    url: text("url"),
    notes: text("notes"),
  };
  for (const field of DATE_FIELDS) value[field] = text(field);

  if (!value.company) errors.company = "Company is required.";
  else if (value.company.length > LIMITS.company) {
    errors.company = `Keep the company under ${LIMITS.company} characters.`;
  }

  if (!value.role) errors.role = "Role is required.";
  else if (value.role.length > LIMITS.role) {
    errors.role = `Keep the role under ${LIMITS.role} characters.`;
  }

  if (!STATUSES.includes(value.status)) errors.status = "Choose one of the listed statuses.";

  for (const field of DATE_FIELDS) {
    if (value[field] && !isValidDate(value[field])) errors[field] = "Enter a valid date.";
  }
  if (
    !errors.applied_date &&
    !errors.response_date &&
    value.applied_date &&
    value.response_date &&
    daysBetween(value.applied_date, value.response_date) < 0
  ) {
    errors.response_date = "The response can't be before the applied date.";
  }

  if (value.url) {
    if (value.url.length > LIMITS.url) errors.url = "That link is too long.";
    else {
      try {
        const parsed = new URL(value.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
      } catch {
        errors.url = "Enter a full link starting with http:// or https://.";
      }
    }
  }

  if (value.notes.length > LIMITS.notes) {
    errors.notes = `Keep notes under ${LIMITS.notes} characters.`;
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}

// ---------- urgency ----------

/**
 * Decides whether an application needs attention today.
 * Returns { level: "none" | "soon" | "overdue", reasons: [{ label, date, days }] }.
 */
export function urgencyFor(app, today, soonDays = SOON_DAYS) {
  if (CLOSED.has(app.status)) return { level: "none", reasons: [] };

  const reasons = [];
  let level = "none";

  const check = (label, date) => {
    if (!date) return;
    const days = daysBetween(today, date);
    if (days === null) return;
    if (days < 0) {
      level = "overdue";
      reasons.push({ label, date, days });
    } else if (days <= soonDays) {
      if (level !== "overdue") level = "soon";
      reasons.push({ label, date, days });
    }
  };

  if (DEADLINE_STATUSES.has(app.status)) check("Deadline", app.deadline);
  check("Follow-up", app.follow_up_date);

  return { level, reasons };
}

/** "Follow-up is tomorrow", "Deadline was 2 days ago", ... */
export function describeReason({ label, days }) {
  if (days === 0) return `${label} is today`;
  if (days === 1) return `${label} is tomorrow`;
  if (days > 1) return `${label} is in ${days} days`;
  if (days === -1) return `${label} was yesterday`;
  return `${label} was ${-days} days ago`;
}

// ---------- stats ----------

export function computeStats(apps, today) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const app of apps) if (app.status in byStatus) byStatus[app.status] += 1;

  const total = apps.length;
  // Wishlist items haven't been sent yet, so they don't count towards the response rate.
  const submitted = total - byStatus.Wishlist;
  const responded = apps.filter((a) => RESPONDED.has(a.status)).length;

  const gaps = apps
    .map((a) => daysBetween(a.applied_date, a.response_date))
    .filter((d) => d !== null && d >= 0);
  const avgDaysToResponse = gaps.length
    ? Math.round((gaps.reduce((sum, d) => sum + d, 0) / gaps.length) * 10) / 10
    : null;

  const needsAttention = today
    ? apps.filter((a) => urgencyFor(a, today).level !== "none").length
    : 0;

  return {
    total,
    byStatus,
    submitted,
    responded,
    responseRate: submitted > 0 ? responded / submitted : null,
    avgDaysToResponse,
    needsAttention,
  };
}

// ---------- table helpers ----------

export function filterApps(apps, { q = "", status = "" } = {}) {
  const needle = q.trim().toLowerCase();
  return apps.filter((a) => {
    if (status && a.status !== status) return false;
    if (!needle) return true;
    return [a.company, a.role, a.notes].some((v) => (v || "").toLowerCase().includes(needle));
  });
}

const URGENCY_RANK = { overdue: 0, soon: 1, none: 2 };

/** Sorts a copy of the list. Empty dates always sink to the bottom, whatever the direction. */
export function sortApps(apps, key, dir, today) {
  const sign = dir === "desc" ? -1 : 1;
  const value = (a) => (key === "urgency" ? URGENCY_RANK[urgencyFor(a, today).level] : a[key] || "");

  return [...apps].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const aEmpty = va === "";
    const bEmpty = vb === "";
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    if (va < vb) return -1 * sign;
    if (va > vb) return 1 * sign;
    return (a.company || "").localeCompare(b.company || "");
  });
}

// ---------- email digest ----------

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/** Builds the daily digest (subject + plain text + HTML) for everything that needs attention. */
export function buildDigest(apps, today, soonDays = SOON_DAYS) {
  const items = [];
  for (const app of apps) {
    const { level, reasons } = urgencyFor(app, today, soonDays);
    if (level !== "none") items.push({ app, level, reasons });
  }
  const soonest = (item) => Math.min(...item.reasons.map((r) => r.days));
  items.sort((a, b) => URGENCY_RANK[a.level] - URGENCY_RANK[b.level] || soonest(a) - soonest(b));

  const count = items.length;
  const subject = count
    ? `Application tracker: ${count} ${count === 1 ? "item needs" : "items need"} attention`
    : "Application tracker: nothing due";

  const line = (item) =>
    `${item.app.company} - ${item.app.role} (${item.app.status}): ` +
    item.reasons.map(describeReason).join("; ");

  const text = count
    ? `Here is what needs attention (${today}):\n\n` + items.map((i) => `- ${line(i)}`).join("\n")
    : `Nothing is due in the next ${soonDays} days. Nice work staying on top of things.`;

  const htmlItems = items
    .map(
      (i) =>
        `<li><strong>${escapeHtml(i.app.company)}</strong> &ndash; ${escapeHtml(i.app.role)} ` +
        `(${escapeHtml(i.app.status)})<br>` +
        `${i.level === "overdue" ? "<strong>Overdue:</strong> " : ""}` +
        `${i.reasons.map((r) => escapeHtml(describeReason(r))).join("; ")}</li>`
    )
    .join("");
  const html = count
    ? `<p>Here is what needs attention (${escapeHtml(today)}):</p><ul>${htmlItems}</ul>`
    : `<p>${escapeHtml(text)}</p>`;

  return { items, subject, text, html };
}
