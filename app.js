// ---------- Firebase (loaded directly from Google's CDN, no npm/build needed) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDbVoepZjtkLhyLV2yaMwN0G8lTjYkIQQ8",
  authDomain: "discipline-diary.firebaseapp.com",
  projectId: "discipline-diary",
  storageBucket: "discipline-diary.firebasestorage.app",
  messagingSenderId: "1043193508854",
  appId: "1:1043193508854:web:d5f5e919aa2839e742cdd7",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- Helpers ----------
const STATUSES = ["Open", "Monitoring", "Resolved"];
const STATUS_STYLE = {
  Open: { ink: "#A3372B", label: "OPEN" },
  Monitoring: { ink: "#B8863B", label: "MONITORING" },
  Resolved: { ink: "#3C6E47", label: "RESOLVED" },
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (s) => (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatDateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- App state ----------
const state = {
  user: undefined, // undefined = loading, null = signed out
  authMode: "signin",
  authError: "",
  authBusy: false,
  incidents: [],
  dataLoaded: false,
  tab: "All",
  query: "",
  expandedId: null,
  showNewForm: false,
  historyOpen: {},
  followDraft: {},
  saveError: false,
  saving: false,
};

const root = document.getElementById("app");
let unsubIncidents = null;

onAuthStateChanged(auth, (u) => {
  state.user = u;
  if (unsubIncidents) { unsubIncidents(); unsubIncidents = null; }
  if (u) {
    state.dataLoaded = false;
    unsubIncidents = onSnapshot(
      collection(db, "incidents"),
      (snap) => {
        state.incidents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        state.dataLoaded = true;
        render();
      },
      () => { state.dataLoaded = true; render(); }
    );
  }
  render();
});

function teacherName() {
  return state.user?.displayName || state.user?.email || "Unnamed teacher";
}

// ---------- Actions ----------
async function handleAuthSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.name?.value?.trim();
  const email = form.email.value.trim();
  const password = form.password.value;
  state.authError = "";
  state.authBusy = true;
  render();
  try {
    if (state.authMode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: name || email.split("@")[0] });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
  } catch (err) {
    state.authError = err.message.replace("Firebase: ", "");
  } finally {
    state.authBusy = false;
    render();
  }
}

async function submitNewIncident(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const date = f.date.value;
  const issue = f.issue.value.trim();
  const actionTaken = f.actionTaken.value.trim();
  const status = state._newStatus || "Open";
  if (!studentName || !issue) return;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    await addDoc(collection(db, "incidents"), {
      studentName, date, issue, actionTaken, status,
      loggedBy: teacherName(),
      loggedByUid: state.user.uid,
      createdAt: now,
      followUps: [],
      history: [{ id: uid(), type: "created", detail: `Entry created — status set to ${status}`, by: teacherName(), at: now }],
    });
    state.showNewForm = false;
    state._newStatus = "Open";
  } catch (err) {
    state.saveError = true;
  } finally {
    state.saving = false;
    render();
  }
}

async function updateStatus(id, newStatus, currentStatus) {
  if (newStatus === currentStatus) return;
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", id), {
      status: newStatus,
      history: arrayUnion({ id: uid(), type: "status", detail: `Status changed from ${currentStatus} to ${newStatus}`, by: teacherName(), at: now }),
    });
  } catch (err) {
    state.saveError = true; render();
  }
}

async function addFollowUp(id) {
  const note = (state.followDraft[id] || "").trim();
  if (!note) return;
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", id), {
      followUps: arrayUnion({ id: uid(), date: todayISO(), note, by: teacherName() }),
      history: arrayUnion({ id: uid(), type: "followup", detail: `Follow-up added: "${note}"`, by: teacherName(), at: now }),
    });
    state.followDraft[id] = "";
    render();
  } catch (err) {
    state.saveError = true; render();
  }
}

// ---------- Rendering ----------
function render() {
  if (state.user === undefined) {
    root.innerHTML = `<div class="dd-center"><div class="dd-mono">Opening the log…</div></div>`;
    return;
  }
  if (state.user === null) {
    root.innerHTML = renderAuthScreen();
    attachAuthListeners();
    return;
  }
  if (!state.dataLoaded) {
    root.innerHTML = `<div class="dd-center"><div class="dd-mono">Loading entries…</div></div>`;
    return;
  }
  root.innerHTML = renderMain();
  attachMainListeners();
}

function renderAuthScreen() {
  const isSignup = state.authMode === "signup";
  return `
    <div class="dd-app"><div class="dd-center">
      <form id="auth-form" class="dd-auth-card">
        <div class="dd-title">Discipline Diary</div>
        <div class="dd-subtitle">${isSignup ? "Create your account to join the shared discipline log." : "Sign in with your school account to view and log entries."}</div>
        ${isSignup ? `<label class="dd-label">Your name</label><input class="dd-input" name="name" placeholder="e.g. Mr. Adams" required />` : ""}
        <label class="dd-label">Email</label>
        <input class="dd-input" name="email" type="email" required />
        <label class="dd-label">Password</label>
        <input class="dd-input" name="password" type="password" minlength="6" required />
        ${state.authError ? `<div class="dd-error">${escapeHtml(state.authError)}</div>` : ""}
        <button class="dd-btn-primary" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Please wait…" : isSignup ? "Create account" : "Sign in"}</button>
        <div class="dd-switch">
          ${isSignup
            ? `Already have an account? <button type="button" id="switch-mode">Sign in</button>`
            : `No account yet? <button type="button" id="switch-mode">Sign up</button>`}
        </div>
      </form>
    </div></div>`;
}

function attachAuthListeners() {
  document.getElementById("auth-form").addEventListener("submit", handleAuthSubmit);
  document.getElementById("switch-mode").addEventListener("click", () => {
    state.authMode = state.authMode === "signin" ? "signup" : "signin";
    state.authError = "";
    render();
  });
}

function filteredIncidents() {
  let list = state.incidents;
  if (state.tab !== "All") list = list.filter((it) => it.status === state.tab);
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    list = list.filter((it) => it.studentName.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}

function counts() {
  const c = { Open: 0, Monitoring: 0, Resolved: 0 };
  state.incidents.forEach((it) => { if (c[it.status] !== undefined) c[it.status]++; });
  return c;
}

function renderCard(it) {
  const s = STATUS_STYLE[it.status];
  const expanded = state.expandedId === it.id;
  const followUps = it.followUps || [];
  const history = it.history || [];
  return `
    <div class="dd-card" data-id="${it.id}">
      <button class="dd-card-head" data-action="toggle-expand" data-id="${it.id}">
        <div style="min-width:0">
          <div class="dd-card-student">${escapeHtml(it.studentName)}</div>
          <div class="dd-card-issue">${escapeHtml(it.issue)}</div>
          <div class="dd-card-meta">
            ${formatDate(it.date)} · logged by ${escapeHtml(it.loggedBy)}
            ${followUps.length ? ` · ${followUps.length} follow-up${followUps.length > 1 ? "s" : ""}` : ""}
            ${history.length > 1 ? ` · last activity ${formatDateTime(history[history.length - 1].at)}` : ""}
          </div>
        </div>
        <div class="dd-card-right">
          <span class="dd-stamp" style="color:${s.ink}">${s.label}</span>
          <span>${expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      ${expanded ? `
      <div class="dd-expand">
        <div class="dd-grid2">
          <div><div class="dd-field-label">Issue</div><div class="dd-field-value">${escapeHtml(it.issue)}</div></div>
          <div><div class="dd-field-label">Action taken</div><div class="dd-field-value">${it.actionTaken ? escapeHtml(it.actionTaken) : `<span style="opacity:.5">None recorded</span>`}</div></div>
        </div>
        <div class="dd-status-row">
          <span class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-right:4px">Status:</span>
          ${STATUSES.map((st) => `<button class="dd-stamp" data-action="set-status" data-id="${it.id}" data-status="${st}" data-current="${it.status}" style="color:${STATUS_STYLE[st].ink};opacity:${it.status === st ? 1 : 0.35}">${STATUS_STYLE[st].label}</button>`).join("")}
        </div>
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Follow-up thread</div>
        <div class="dd-followups">
          ${followUps.length === 0 ? `<div class="dd-sans" style="font-size:14px;font-style:italic;color:#8A8571">No follow-ups logged yet.</div>` : ""}
          ${followUps.map((fu) => `<div class="dd-followup"><div class="dd-followup-note">${escapeHtml(fu.note)}</div><div class="dd-followup-meta">${formatDate(fu.date)} · ${escapeHtml(fu.by)}</div></div>`).join("")}
        </div>
        <div class="dd-followup-form">
          <input class="dd-input dd-followup-input" data-action="follow-input" data-id="${it.id}" placeholder="Add a follow-up note…" value="${escapeHtml(state.followDraft[it.id] || "")}" />
          <button class="dd-add-btn" data-action="add-followup" data-id="${it.id}">Add</button>
        </div>
        <button class="dd-history-toggle" data-action="toggle-history" data-id="${it.id}">${state.historyOpen[it.id] ? "Hide audit trail" : "Show audit trail"}</button>
        ${state.historyOpen[it.id] ? `
          <div class="dd-history">
            ${history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}
          </div>` : ""}
      </div>` : ""}
    </div>`;
}

function renderMain() {
  const list = filteredIncidents();
  const c = counts();
  return `
    <div class="dd-app">
      <div class="dd-header">
        <div class="dd-header-inner">
          <div>
            <div class="dd-header-title">Discipline Diary</div>
            <div class="dd-header-sub">Case log &amp; follow-up register — signed in as ${escapeHtml(teacherName())}</div>
          </div>
          <div class="dd-header-actions">
            <button class="dd-newbtn" id="btn-new">+ New entry</button>
            <button class="dd-signout" id="btn-signout">Sign out</button>
          </div>
        </div>
      </div>
      <div class="dd-main">
        <div class="dd-tabs">
          ${["All", ...STATUSES].map((t) => `<button class="dd-tab ${state.tab === t ? "active" : ""}" data-action="set-tab" data-tab="${t}">${t}${t !== "All" ? ` <span class="count">(${c[t]})</span>` : ""}</button>`).join("")}
        </div>
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="search-input" placeholder="Search by student name…" value="${escapeHtml(state.query)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.incidents.length === 0 ? "No entries yet. Log the first discipline issue to start the record." : "No entries match this filter."}</div>` : ""}
          ${list.map(renderCard).join("")}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save the last change. Check your connection and try again.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
    </div>`;
}

function renderNewForm() {
  const st = state._newStatus || "Open";
  return `
    <div class="dd-modal-backdrop" id="modal-backdrop">
      <form class="dd-modal" id="new-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">New entry</div>
          <button type="button" class="dd-modal-close" id="modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required />
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${todayISO()}" />
        <label class="dd-label">Issue</label>
        <textarea class="dd-textarea dd-input" name="issue" rows="3" required placeholder="What happened?"></textarea>
        <label class="dd-label">Action taken</label>
        <textarea class="dd-textarea dd-input" name="actionTaken" rows="2" placeholder="What was done in response? (optional)"></textarea>
        <label class="dd-label">Status</label>
        <div class="dd-status-row">
          ${STATUSES.map((s) => `<button type="button" class="dd-stamp" data-action="pick-new-status" data-status="${s}" style="color:${STATUS_STYLE[s].ink};opacity:${st === s ? 1 : 0.35}">${STATUS_STYLE[s].label}</button>`).join("")}
        </div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save entry"}</button>
      </form>
    </div>`;
}

function attachMainListeners() {
  document.getElementById("btn-new").addEventListener("click", () => { state.showNewForm = true; state.expandedId = null; state._newStatus = "Open"; render(); });
  document.getElementById("btn-signout").addEventListener("click", () => signOut(auth));

  document.querySelectorAll('[data-action="set-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.tab = el.dataset.tab; render(); }));

  const search = document.getElementById("search-input");
  search.addEventListener("input", () => {
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const newSearch = document.getElementById("search-input");
    if (newSearch) {
      newSearch.focus();
      newSearch.setSelectionRange(cursor, cursor);
    }
  });

  document.querySelectorAll('[data-action="toggle-expand"]').forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      state.expandedId = state.expandedId === id ? null : id;
      render();
    }));

  document.querySelectorAll('[data-action="set-status"]').forEach((el) =>
    el.addEventListener("click", () => updateStatus(el.dataset.id, el.dataset.status, el.dataset.current)));

  document.querySelectorAll('[data-action="follow-input"]').forEach((el) =>
    el.addEventListener("input", () => { state.followDraft[el.dataset.id] = el.value; }));

  document.querySelectorAll('[data-action="add-followup"]').forEach((el) =>
    el.addEventListener("click", () => addFollowUp(el.dataset.id)));

  document.querySelectorAll('[data-action="toggle-history"]').forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      state.historyOpen[id] = !state.historyOpen[id];
      render();
    }));

  if (state.showNewForm) {
    document.getElementById("new-form").addEventListener("submit", submitNewIncident);
    document.getElementById("modal-close").addEventListener("click", () => { state.showNewForm = false; render(); });
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") { state.showNewForm = false; render(); }
    });
    document.querySelectorAll('[data-action="pick-new-status"]').forEach((el) =>
      el.addEventListener("click", () => { state._newStatus = el.dataset.status; render(); }));
  }
}

render();
