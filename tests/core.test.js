import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildDigest,
  computeStats,
  daysBetween,
  describeReason,
  filterApps,
  isValidDate,
  sortApps,
  todayISO,
  urgencyFor,
  validateApplication,
} from "../public/js/core.js";

const TODAY = "2026-10-29";
const app = (overrides = {}) => ({
  id: "x",
  company: "Acme",
  role: "Intern",
  status: "Applied",
  applied_date: "",
  deadline: "",
  follow_up_date: "",
  response_date: "",
  notes: "",
  ...overrides,
});

test("dates: validation, arithmetic and month rollover", () => {
  assert.equal(isValidDate("2026-02-28"), true);
  assert.equal(isValidDate("2026-02-31"), false);
  assert.equal(isValidDate("26-1-1"), false);
  assert.equal(daysBetween("2026-10-29", "2026-11-01"), 3);
  assert.equal(daysBetween("2026-10-29", "2026-10-28"), -1);
  assert.equal(daysBetween("nope", "2026-10-28"), null);
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("todayISO uses the requested time zone", () => {
  const instant = new Date("2026-10-29T02:30:00Z"); // still Oct 28 evening in Toronto
  assert.equal(todayISO("America/Toronto", instant), "2026-10-28");
  assert.equal(todayISO("UTC", instant), "2026-10-29");
});

test("validate: trims, defaults the status and accepts a good application", () => {
  const { ok, value } = validateApplication({ company: "  Shopify ", role: "SWE Intern" });
  assert.equal(ok, true);
  assert.equal(value.company, "Shopify");
  assert.equal(value.status, "Applied");
});

test("validate: reports every problem at once", () => {
  const { ok, errors } = validateApplication({
    company: "",
    role: "x".repeat(101),
    status: "Maybe",
    deadline: "2026-13-01",
    url: "javascript:alert(1)",
    notes: "n".repeat(2001),
  });
  assert.equal(ok, false);
  for (const key of ["company", "role", "status", "deadline", "url", "notes"]) {
    assert.ok(errors[key], `expected an error for ${key}`);
  }
});

test("validate: response date can't be before applied date; non-objects are rejected safely", () => {
  const bad = validateApplication({
    company: "A", role: "B", applied_date: "2026-10-10", response_date: "2026-10-01",
  });
  assert.ok(bad.errors.response_date);
  assert.equal(validateApplication(null).ok, false);
  assert.equal(validateApplication("hi").ok, false);
});

test("validate: ignores unknown fields", () => {
  const { value } = validateApplication({ company: "A", role: "B", admin: true });
  assert.equal("admin" in value, false);
});

test("urgency: follow-ups flag when overdue, soon, or far away", () => {
  assert.equal(urgencyFor(app({ follow_up_date: "2026-10-27" }), TODAY).level, "overdue");
  assert.equal(urgencyFor(app({ follow_up_date: TODAY }), TODAY).level, "soon");
  assert.equal(urgencyFor(app({ follow_up_date: "2026-11-01" }), TODAY).level, "soon");
  assert.equal(urgencyFor(app({ follow_up_date: "2026-11-02" }), TODAY).level, "none");
});

test("urgency: a passed application deadline is only a problem while it's still a wishlist item", () => {
  const past = "2026-10-20";
  assert.equal(urgencyFor(app({ status: "Wishlist", deadline: past }), TODAY).level, "overdue");
  assert.equal(urgencyFor(app({ status: "Applied", deadline: past }), TODAY).level, "none");
  assert.equal(urgencyFor(app({ status: "Offer", deadline: "2026-10-30" }), TODAY).level, "soon");
});

test("urgency: closed applications never alert, overdue beats soon", () => {
  assert.equal(urgencyFor(app({ status: "Rejected", follow_up_date: "2026-10-01" }), TODAY).level, "none");
  assert.equal(urgencyFor(app({ status: "Withdrawn", follow_up_date: "2026-10-01" }), TODAY).level, "none");
  const both = urgencyFor(
    app({ status: "Wishlist", deadline: "2026-10-30", follow_up_date: "2026-10-01" }),
    TODAY
  );
  assert.equal(both.level, "overdue");
  assert.equal(both.reasons.length, 2);
});

test("describeReason reads naturally", () => {
  assert.equal(describeReason({ label: "Follow-up", days: 0 }), "Follow-up is today");
  assert.equal(describeReason({ label: "Follow-up", days: 1 }), "Follow-up is tomorrow");
  assert.equal(describeReason({ label: "Deadline", days: 3 }), "Deadline is in 3 days");
  assert.equal(describeReason({ label: "Deadline", days: -1 }), "Deadline was yesterday");
  assert.equal(describeReason({ label: "Deadline", days: -4 }), "Deadline was 4 days ago");
});

test("stats: empty list has no rate or average", () => {
  const s = computeStats([], TODAY);
  assert.equal(s.total, 0);
  assert.equal(s.responseRate, null);
  assert.equal(s.avgDaysToResponse, null);
});

test("stats: totals, response rate, average response time, attention count", () => {
  const apps = [
    app({ status: "Wishlist", deadline: "2026-10-30" }),
    app({ status: "Applied", applied_date: "2026-10-01" }),
    app({ status: "Interview", applied_date: "2026-10-01", response_date: "2026-10-05" }),
    app({ status: "Rejected", applied_date: "2026-10-02", response_date: "2026-10-08" }),
    app({ status: "Withdrawn", applied_date: "2026-10-03" }),
  ];
  const s = computeStats(apps, TODAY);
  assert.equal(s.total, 5);
  assert.equal(s.submitted, 4); // the wishlist item isn't counted
  assert.equal(s.responded, 2);
  assert.equal(s.responseRate, 0.5);
  assert.equal(s.avgDaysToResponse, 5); // (4 + 6) / 2
  assert.equal(s.needsAttention, 1);
  assert.equal(s.byStatus.Interview, 1);
});

test("filter and sort: search, status, empty dates last, urgency first", () => {
  const apps = [
    app({ id: "1", company: "Beta", deadline: "2026-11-10", status: "Wishlist" }),
    app({ id: "2", company: "Alpha", deadline: "", notes: "great team" }),
    app({ id: "3", company: "Gamma", deadline: "2026-10-30", status: "Wishlist" }),
  ];
  assert.deepEqual(filterApps(apps, { q: "GREAT" }).map((a) => a.id), ["2"]);
  assert.deepEqual(filterApps(apps, { status: "Wishlist" }).map((a) => a.id), ["1", "3"]);

  assert.deepEqual(sortApps(apps, "deadline", "asc", TODAY).map((a) => a.id), ["3", "1", "2"]);
  assert.deepEqual(sortApps(apps, "deadline", "desc", TODAY).map((a) => a.id), ["1", "3", "2"]);
  assert.deepEqual(sortApps(apps, "urgency", "asc", TODAY).map((a) => a.id)[0], "3");
  assert.equal(apps[0].id, "1", "sorting must not change the original array");
});

test("digest: orders by urgency, escapes HTML, and reports when nothing is due", () => {
  const apps = [
    app({ id: "a", company: "<b>Evil</b> & Co", follow_up_date: "2026-11-01" }),
    app({ id: "b", company: "Late Inc", follow_up_date: "2026-10-25" }),
    app({ id: "c", company: "Calm Ltd", follow_up_date: "2027-01-01" }),
  ];
  const d = buildDigest(apps, TODAY);
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].app.id, "b");
  assert.match(d.subject, /2 items need attention/);
  assert.ok(!d.html.includes("<b>Evil"), "company names must be escaped in the HTML body");
  assert.ok(d.html.includes("&lt;b&gt;Evil&lt;/b&gt; &amp; Co"));
  assert.match(d.text, /Late Inc - Intern \(Applied\): Follow-up was 4 days ago/);

  const empty = buildDigest([apps[2]], TODAY);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.subject, "Application tracker: nothing due");
});
