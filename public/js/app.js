// Browser UI. Everything user-supplied is inserted with textContent / DOM APIs (never innerHTML),
// so a company name like <script>... can't run code.

import {
  STATUSES,
  computeStats,
  describeReason,
  filterApps,
  sortApps,
  todayISO,
  urgencyFor,
  validateApplication,
} from "./core.js";
import {
  ApiError,
  createLocalStore,
  createRemoteStore,
  login,
  safeGet,
  safeRemove,
  safeSet,
} from "./storage.js";

const TOKEN_KEY = "application-tracker-token";
const MODE_KEY = "application-tracker-mode";

const COLUMNS = [
  { key: "company", label: "Company" },
  { key: "role", label: "Role" },
  { key: "status", label: "Status" },
  { key: "applied_date", label: "Applied" },
  { key: "deadline", label: "Deadline" },
  { key: "follow_up_date", label: "Follow-up" },
  { key: "urgency", label: "Attention" },
];

const FIELDS = [
  { key: "company", label: "Company", type: "text", required: true },
  { key: "role", label: "Role", type: "text", required: true },
  { key: "status", label: "Status", type: "select" },
  { key: "url", label: "Posting link", type: "url", placeholder: "https://..." },
  { key: "applied_date", label: "Applied on", type: "date" },
  { key: "response_date", label: "First response on", type: "date" },
  { key: "deadline", label: "Deadline", type: "date", hint: "Application deadline, or the date you must answer an offer." },
  { key: "follow_up_date", label: "Follow up on", type: "date", hint: "You'll get flagged when this is close." },
  { key: "notes", label: "Notes", type: "textarea", full: true },
];

const state = {
  mode: null, // "remote" | "demo"
  store: null,
  apps: [],
  sort: { key: "urgency", dir: "asc" },
  q: "",
  status: "",
  editingId: null,
  today: todayISO(),
};
let memoryToken = null;

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h("button", { class: "btn", text: "Hi", onclick: fn }, child, ...) */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name === "value") node.value = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// ---------- small helpers ----------

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function safeLink(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

function announce(message) {
  const el = $("live-status");
  el.textContent = "";
  // A short delay makes screen readers announce repeated messages reliably.
  setTimeout(() => (el.textContent = message), 50);
}

function showBanner(message) {
  const el = $("banner");
  el.textContent = message;
  el.hidden = !message;
}

const getToken = () => memoryToken || safeGet(TOKEN_KEY) || "";

// ---------- rendering ----------

function renderStats() {
  const stats = computeStats(state.apps, state.today);
  const pct = stats.responseRate === null ? "—" : `${Math.round(stats.responseRate * 100)}%`;

  const stat = (value, label, extra = "") =>
    h("div", { class: `stat ${extra}`.trim() }, h("div", { class: "stat-value", text: String(value) }), h("div", { class: "stat-label", text: label }));

  $("stats").replaceChildren(
    stat(stats.total, "Total applications"),
    stat(pct, `Response rate (${stats.responded} of ${stats.submitted} sent)`),
    stat(stats.avgDaysToResponse === null ? "—" : `${stats.avgDaysToResponse} days`, "Average time to first response"),
    stat(stats.needsAttention, "Need attention now", stats.needsAttention > 0 ? "stat-attention" : "")
  );

  const breakdown = $("breakdown");
  if (stats.total === 0) {
    breakdown.replaceChildren();
    return;
  }
  const bar = h("div", { class: "bar", "aria-hidden": "true" });
  for (const status of STATUSES) {
    const count = stats.byStatus[status];
    if (!count) continue;
    const segment = h("span", { class: `s-${status}` });
    segment.style.width = `${(count / stats.total) * 100}%`;
    bar.append(segment);
  }
  const legend = h(
    "ul",
    { class: "legend", "aria-label": "Applications by status" },
    STATUSES.map((status) =>
      h("li", {}, h("span", { class: `swatch s-${status}`, "aria-hidden": "true" }), `${status}: ${stats.byStatus[status]}`)
    )
  );
  breakdown.replaceChildren(bar, legend);
}

function renderHead() {
  const cells = COLUMNS.map((col) => {
    const active = state.sort.key === col.key;
    const ariaSort = active ? (state.sort.dir === "asc" ? "ascending" : "descending") : "none";
    const arrow = active ? (state.sort.dir === "asc" ? "▲" : "▼") : "";
    return h(
      "th",
      { scope: "col", "aria-sort": ariaSort },
      h("button", { type: "button", onclick: () => toggleSort(col.key) }, col.label, h("span", { "aria-hidden": "true", text: arrow }))
    );
  });
  cells.push(h("th", { scope: "col" }, h("span", { class: "sr-only", text: "Actions" })));
  $("thead").replaceChildren(h("tr", {}, ...cells));
}

function renderRows() {
  const visible = sortApps(filterApps(state.apps, { q: state.q, status: state.status }), state.sort.key, state.sort.dir, state.today);

  const rows = visible.map((app) => {
    const { level, reasons } = urgencyFor(app, state.today);
    const link = safeLink(app.url);

    const attention =
      level === "none"
        ? h("span", { class: "muted", text: "—" })
        : h(
            "span",
            {},
            h("span", { class: `chip chip-${level}`, text: level === "overdue" ? "Overdue" : "Due soon" }),
            ...reasons.map((r) => h("span", { class: "sub", text: describeReason(r) }))
          );

    return h(
      "tr",
      { class: level === "none" ? "" : `row-${level}` },
      h(
        "td",
        {},
        link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer", text: app.company }) : h("strong", { text: app.company }),
        app.notes ? h("span", { class: "notes", text: app.notes }) : null
      ),
      h("td", { text: app.role }),
      h("td", {}, h("span", { class: "badge", text: app.status })),
      h("td", { text: formatDate(app.applied_date) }),
      h("td", { text: formatDate(app.deadline) }),
      h("td", { text: formatDate(app.follow_up_date) }),
      h("td", {}, attention),
      h(
        "td",
        {},
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn btn-small", "aria-label": `Edit ${app.company}`, onclick: () => openForm(app), text: "Edit" }),
          h("button", { type: "button", class: "btn btn-small btn-danger", "aria-label": `Delete ${app.company}`, onclick: () => removeApp(app), text: "Delete" })
        )
      )
    );
  });
  $("tbody").replaceChildren(...rows);

  const empty = $("empty");
  if (state.apps.length === 0) {
    empty.textContent = "No applications yet. Add your first one to get started.";
    empty.hidden = false;
  } else if (visible.length === 0) {
    empty.textContent = "No applications match your search.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

function renderAll() {
  renderStats();
  renderHead();
  renderRows();
}

function toggleSort(key) {
  state.sort =
    state.sort.key === key ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
  renderHead();
  renderRows();
}

// ---------- form ----------

function buildForm() {
  const grid = $("form-grid");
  grid.replaceChildren(
    ...FIELDS.map((f) => {
      const id = `f-${f.key}`;
      let control;
      if (f.type === "select") {
        control = h("select", { id, name: f.key }, STATUSES.map((s) => h("option", { value: s, text: s })));
      } else if (f.type === "textarea") {
        control = h("textarea", { id, name: f.key, maxlength: "2000" });
      } else {
        control = h("input", { id, name: f.key, type: f.type, required: f.required, placeholder: f.type === "date" ? "YYYY-MM-DD" : f.placeholder });
      }
      return h(
        "div",
        { class: f.full ? "full" : "" },
        h("label", { for: id, text: f.required ? `${f.label} (required)` : f.label }),
        control,
        f.hint ? h("p", { class: "hint", id: `${id}-hint`, text: f.hint }) : null,
        h("p", { class: "field-error", id: `${id}-error`, hidden: true })
      );
    })
  );
}

function showFieldErrors(errors) {
  let first = null;
  for (const f of FIELDS) {
    const control = $(`f-${f.key}`);
    const message = $(`f-${f.key}-error`);
    const text = errors[f.key];
    message.hidden = !text;
    message.textContent = text || "";
    const describedBy = [text ? message.id : null, f.hint ? `f-${f.key}-hint` : null].filter(Boolean).join(" ");
    if (text) {
      control.setAttribute("aria-invalid", "true");
      first = first || control;
    } else {
      control.removeAttribute("aria-invalid");
    }
    if (describedBy) control.setAttribute("aria-describedby", describedBy);
    else control.removeAttribute("aria-describedby");
  }
  return first;
}

function openForm(app = null) {
  state.editingId = app ? app.id : null;
  $("dialog-title").textContent = app ? `Edit application: ${app.company}` : "Add application";
  $("form-error").hidden = true;
  for (const f of FIELDS) {
    $(`f-${f.key}`).value = app ? app[f.key] || "" : f.key === "status" ? "Applied" : "";
  }
  showFieldErrors({});
  $("form-dialog").showModal();
  $("f-company").focus();
}

async function submitForm(event) {
  event.preventDefault();
  const input = Object.fromEntries(FIELDS.map((f) => [f.key, $(`f-${f.key}`).value]));
  const { ok, errors, value } = validateApplication(input);
  const firstInvalid = showFieldErrors(errors);
  if (!ok) {
    $("form-error").textContent = "Please fix the highlighted fields.";
    $("form-error").hidden = false;
    firstInvalid?.focus();
    return;
  }
  $("form-error").hidden = true;

  const saveBtn = $("save-btn");
  saveBtn.disabled = true;
  try {
    if (state.editingId) await state.store.update(state.editingId, value);
    else await state.store.create(value);
    $("form-dialog").close();
    await loadApps();
    announce(state.editingId ? "Application updated." : "Application added.");
  } catch (err) {
    if (err instanceof ApiError && err.fieldErrors) showFieldErrors(err.fieldErrors);
    $("form-error").textContent = err.message || "Could not save.";
    $("form-error").hidden = false;
  } finally {
    saveBtn.disabled = false;
  }
}

async function removeApp(app) {
  if (!window.confirm(`Delete the application to ${app.company}? This can't be undone.`)) return;
  try {
    await state.store.remove(app.id);
    await loadApps();
    announce(`Deleted ${app.company}.`);
  } catch (err) {
    showBanner(err.message || "Could not delete.");
  }
}

// ---------- data + session ----------

async function loadApps() {
  try {
    state.today = todayISO();
    state.apps = await state.store.list();
    showBanner("");
  } catch (err) {
    showBanner(err.message || "Could not load your applications.");
  }
  renderAll();
}

async function enterApp(mode) {
  state.mode = mode;
  safeSet(MODE_KEY, mode);

  if (mode === "demo") {
    state.store = createLocalStore(todayISO());
  } else {
    state.store = createRemoteStore({ getToken, onSignedOut: () => leave("Your session ended. Please sign in again.") });
  }

  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("header-actions").hidden = false;
  $("mode-badge").textContent = mode === "demo" ? "Demo: sample data, saved only in this browser" : "Signed in: saved to your account";
  $("reset-demo").hidden = mode !== "demo";
  $("sign-out").textContent = mode === "demo" ? "Leave demo" : "Sign out";
  $("empty").textContent = "Loading…";
  $("empty").hidden = false;
  await loadApps();
}

function leave(message = "") {
  memoryToken = null;
  safeRemove(TOKEN_KEY);
  safeRemove(MODE_KEY);
  state.mode = null;
  state.store = null;
  state.apps = [];
  $("app-view").hidden = true;
  $("header-actions").hidden = true;
  $("login-view").hidden = false;
  $("password").value = "";
  showBanner(message);
  $("password").focus();
}

async function handleLogin(event) {
  event.preventDefault();
  const error = $("login-error");
  const password = $("password").value;
  error.hidden = true;
  if (!password) {
    error.textContent = "Enter the owner password, or try the demo.";
    error.hidden = false;
    $("password").focus();
    return;
  }
  const button = event.submitter || event.target.querySelector("[type=submit]");
  button.disabled = true;
  try {
    memoryToken = await login(password);
    safeSet(TOKEN_KEY, memoryToken);
    showBanner("");
    await enterApp("remote");
  } catch (err) {
    error.textContent = err.message || "Could not sign in.";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ---------- start ----------

function init() {
  const statusFilter = $("status-filter");
  statusFilter.replaceChildren(h("option", { value: "", text: "All statuses" }), ...STATUSES.map((s) => h("option", { value: s, text: s })));

  buildForm();

  $("login-form").addEventListener("submit", handleLogin);
  $("try-demo").addEventListener("click", () => {
    showBanner("");
    enterApp("demo");
  });
  $("sign-out").addEventListener("click", () => leave());
  $("reset-demo").addEventListener("click", async () => {
    if (!window.confirm("Reset the demo back to its sample data?")) return;
    state.store.reset();
    await loadApps();
    announce("Demo data reset.");
  });

  $("add-btn").addEventListener("click", () => openForm());
  $("cancel-btn").addEventListener("click", () => $("form-dialog").close());
  $("app-form").addEventListener("submit", submitForm);

  $("search").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderRows();
  });
  statusFilter.addEventListener("change", (e) => {
    state.status = e.target.value;
    renderRows();
  });

  const savedMode = safeGet(MODE_KEY);
  if (savedMode === "demo") enterApp("demo");
  else if (savedMode === "remote" && getToken()) enterApp("remote");
}

init();
