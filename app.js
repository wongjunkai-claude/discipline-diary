// ---------- Firebase (loaded directly from Google's CDN, no npm/build needed) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, arrayUnion, setDoc,
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

// Paste the Web app URL from your Google Apps Script deployment here (see
// apps-script.gs for setup steps). Leave as-is to skip Sheets logging.
const SHEET_WEBHOOK_URL = https://script.google.com/macros/s/AKfycbyEXCtdtriLO9Qli9OIEHLH2348T9oc5VFEX9Qr7_nsrEv8zoYlrZftMExpEjcg4h_T/exec;

function logToSheet(record) {
  if (!SHEET_WEBHOOK_URL || SHEET_WEBHOOK_URL.startsWith("PASTE_")) return;
  try {
    fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors", // Apps Script web apps don't return CORS headers; we don't need to read the response
      body: JSON.stringify(record),
    }).catch(() => {}); // Sheets logging is a bonus mirror — never blocks or breaks the main app
  } catch (e) {
    // ignore — Firestore remains the source of truth regardless
  }
}

// ---------- Helpers ----------
const STATUSES = ["Open", "Monitoring", "Resolved"];
const STATUS_STYLE = {
  Open: { ink: "#A3372B", label: "OPEN" },
  Monitoring: { ink: "#B8863B", label: "IN PROGRESS" },
  Resolved: { ink: "#3C6E47", label: "RESOLVED" },
};
const STATUS_TEXT = { Open: "Open", Monitoring: "In Progress", Resolved: "Resolved" };
const SUSP_TYPE_STYLE = {
  ISS: { ink: "#B8863B", label: "IN-SCHOOL" },
  OSS: { ink: "#A3372B", label: "OUT-OF-SCHOOL" },
};
const SUSP_STATUS_STYLE = {
  Upcoming: { ink: "#4C6B8A", label: "UPCOMING" },
  Active: { ink: "#A3372B", label: "ACTIVE" },
  Completed: { ink: "#3C6E47", label: "COMPLETED" },
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const escapeHtml = (s) => (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function formatDateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function suspensionStatus(s) {
  const today = todayISO();
  const end = addDays(s.startDate, s.days);
  if (today < s.startDate) return "Upcoming";
  if (today < end) return "Active";
  return "Completed";
}
function suspensionDateRange(startDate, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDays(startDate, i));
  return out;
}
// Falls back to the old single `venue` field for suspensions logged before
// per-day locations existed, so nothing old breaks.
function venueForDate(s, dateISO) {
  if (s.venuesByDate && s.venuesByDate[dateISO] !== undefined) return s.venuesByDate[dateISO];
  return s.venue || "";
}
function linkedParts(s) {
  if (!s.caseId) return [];
  return state.suspensions
    .filter((x) => x.caseId === s.caseId && !x.deleted)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}
function truncateName(name, n = 15) {
  const s = name || "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function diffText(oldObj, newObj, fields) {
  const changes = [];
  fields.forEach(({ key, label }) => {
    const before = (oldObj[key] ?? "").toString();
    const after = (newObj[key] ?? "").toString();
    if (before !== after) changes.push(`${label} changed from "${before || "(blank)"}" to "${after || "(blank)"}"`);
  });
  return changes;
}
function studentsOnDate(type, dateISO) {
  return state.suspensions.filter((s) => {
    if (s.deleted || s.type !== type) return false;
    const end = addDays(s.startDate, s.days);
    return dateISO >= s.startDate && dateISO < end;
  });
}
function renderDashboardBox(type, title, color) {
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const todayList = studentsOnDate(type, today);
  const nextDays = [
    { date: tomorrow, students: studentsOnDate(type, tomorrow) },
    { date: dayAfter, students: studentsOnDate(type, dayAfter) },
  ];
  const studentRowHtml = (s) => `
    <div class="dd-dash-row">
      <span class="dd-dash-name">${escapeHtml(truncateName(s.studentName))}</span>
      <span class="dd-dash-class">${escapeHtml(s.studentClass || "")}</span>
    </div>`;
  // ISS: group students by their location on that specific date, location shown once above the names that share it.
  // OSS: no location concept, so just list students directly.
  const dayGroupHtml = (students, dateForVenue) => {
    if (students.length === 0) return "";
    if (type !== "ISS") return students.map(studentRowHtml).join("");
    const groups = {};
    students.forEach((s) => {
      const loc = venueForDate(s, dateForVenue) || "(no location set)";
      (groups[loc] = groups[loc] || []).push(s);
    });
    return Object.keys(groups).sort((a, b) => a.localeCompare(b)).map((loc) => `
      <div class="dd-dash-location">${escapeHtml(truncateName(loc, 20))}</div>
      ${groups[loc].map(studentRowHtml).join("")}
    `).join("");
  };
  return `
    <div class="dd-panel dd-dash-box">
      <div class="dd-dash-title" style="color:${color}">${title}</div>
      <div class="dd-dash-cols">
        <div class="dd-dash-col">
          <div class="dd-mono-muted dd-dash-col-label">Today</div>
          <div class="dd-serif dd-dash-count" style="color:${color}">${todayList.length}</div>
          <div class="dd-dash-list">
            ${todayList.length === 0 ? `<div class="dd-dash-empty">None</div>` : dayGroupHtml(todayList, today)}
          </div>
        </div>
        <div class="dd-dash-col">
          <div class="dd-mono-muted dd-dash-col-label">Next 2 Days</div>
          <div class="dd-dash-list">
            ${nextDays.every((d) => d.students.length === 0) ? `<div class="dd-dash-empty">None</div>` : nextDays.map((d) => d.students.length === 0 ? "" : `
              <div class="dd-dash-date">${formatDate(d.date)}</div>
              ${dayGroupHtml(d.students, d.date)}
            `).join("")}
          </div>
        </div>
      </div>
    </div>`;
}

// ---------- App state ----------
const state = {
  authReady: false,
  teacherName: localStorage.getItem("dd-teacher-name") || "",
  section: "log", // 'log' | 'suspensions'
  showHelp: false,

  incidents: [],
  dataLoaded: false,
  tab: "All",
  query: "",
  expandedId: null,
  showNewForm: false,
  editingIncidentId: null,
  historyOpen: {},
  followDraft: {},

  suspensions: [],
  suspLoaded: false,
  suspTab: "All",
  suspQuery: "",
  showNewSuspForm: false,
  _newSuspType: "ISS",
  editingSuspensionId: null,
  expandedSuspId: null,
  _suspFormDraft: { studentName: "", studentClass: "", startDate: "", days: 1, reason: "", venue: "", differentVenues: false, venues: {} },
  _linkedCaseId: null,

  saveError: false,
  saving: false,
};

const root = document.getElementById("app");
let unsubIncidents = null;
let unsubSuspensions = null;

signInAnonymously(auth).catch(() => { render(); });

onAuthStateChanged(auth, (u) => {
  state.authReady = !!u;
  if (unsubIncidents) { unsubIncidents(); unsubIncidents = null; }
  if (unsubSuspensions) { unsubSuspensions(); unsubSuspensions = null; }
  if (u && state.teacherName) startListening();
  render();
});

function startListening() {
  state.dataLoaded = false;
  state.suspLoaded = false;
  unsubIncidents = onSnapshot(
    collection(db, "incidents"),
    (snap) => {
      state.incidents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.dataLoaded = true;
      writeBackupSnapshot();
      render();
    },
    () => { state.dataLoaded = true; render(); }
  );
  unsubSuspensions = onSnapshot(
    collection(db, "suspensions"),
    (snap) => {
      state.suspensions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.suspLoaded = true;
      writeBackupSnapshot();
      render();
    },
    () => { state.suspLoaded = true; render(); }
  );
}

// Rolling "last known good" snapshot. Every time data changes, the full
// current dataset is mirrored into backups/latest. If a bug ever corrupts
// or overwrites something in the live collections, this document in the
// Firebase console (Firestore Database > Data > backups > latest) always
// holds the most recent good copy you can manually restore from.
let backupTimer = null;
function writeBackupSnapshot() {
  if (!state.dataLoaded || !state.suspLoaded) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      await setDoc(doc(db, "backups", "latest"), {
        updatedAt: Date.now(),
        incidents: state.incidents,
        suspensions: state.suspensions,
      });
    } catch (e) {
      // non-fatal — backup is a safety net, not the primary data path
    }
  }, 1500);
}

function downloadBackupFile() {
  const payload = {
    exportedAt: new Date().toISOString(),
    incidents: state.incidents,
    suspensions: state.suspensions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `discipline-diary-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Bump this alongside the CACHE version in sw.js whenever you ship an update —
// makes it easy to confirm (in the app footer, or a screenshot from a teacher)
// exactly which version is actually running on a given device.
const APP_VERSION = "1.13.0";
const DELETE_PASSWORD = "shsm";

function askDeletePassword() {
  const pw = window.prompt("Enter password to remove this entry:");
  if (pw === null) return false;
  if (pw !== DELETE_PASSWORD) {
    alert("Incorrect password. Entry was not removed.");
    return false;
  }
  return true;
}

function teacherName() {
  return state.teacherName || "Unnamed teacher";
}

function saveTeacherName(name) {
  state.teacherName = name;
  localStorage.setItem("dd-teacher-name", name);
  if (state.authReady) startListening();
  render();
}

// ---------- Discipline log actions ----------
function handleNameSubmit(e) {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (name) saveTeacherName(name);
}

async function submitNewIncident(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value.trim();
  const date = f.date.value;
  const issue = f.issue.value.trim();
  const actionTaken = f.actionTaken.value.trim();
  const status = state._newStatus || "Open";
  if (!studentName || !studentClass || !issue) return;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    await addDoc(collection(db, "incidents"), {
      studentName, studentClass, date, issue, actionTaken, status,
      loggedBy: teacherName(),
      loggedByUid: auth.currentUser?.uid || null,
      createdAt: now,
      followUps: [],
      history: [{ id: uid(), type: "created", detail: `Entry created — status set to ${STATUS_TEXT[status]}`, by: teacherName(), at: now }],
    });
    state.showNewForm = false;
    state._newStatus = "Open";
    logToSheet({
      recordType: "Incident", action: "Created", studentName,
      details: `Class: ${studentClass} — Status: ${status} — ${issue}`, loggedBy: teacherName(),
    });
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
  const it = state.incidents.find((i) => i.id === id);
  try {
    await updateDoc(doc(db, "incidents", id), {
      status: newStatus,
      history: arrayUnion({ id: uid(), type: "status", detail: `Status changed from ${STATUS_TEXT[currentStatus]} to ${STATUS_TEXT[newStatus]}`, by: teacherName(), at: now }),
    });
    logToSheet({
      recordType: "Incident", action: "Status changed", studentName: it?.studentName || "",
      details: `${currentStatus} → ${newStatus}`, loggedBy: teacherName(),
    });
  } catch (err) {
    state.saveError = true; render();
  }
}

async function addFollowUp(id) {
  const note = (state.followDraft[id] || "").trim();
  if (!note) return;
  const now = Date.now();
  const it = state.incidents.find((i) => i.id === id);
  try {
    await updateDoc(doc(db, "incidents", id), {
      followUps: arrayUnion({ id: uid(), date: todayISO(), note, by: teacherName() }),
      history: arrayUnion({ id: uid(), type: "followup", detail: `Follow-up added: "${note}"`, by: teacherName(), at: now }),
    });
    state.followDraft[id] = "";
    logToSheet({
      recordType: "Incident", action: "Follow-up added", studentName: it?.studentName || "",
      details: note, loggedBy: teacherName(),
    });
    render();
  } catch (err) {
    state.saveError = true; render();
  }
}

async function deleteIncident(id) {
  if (!askDeletePassword()) return;
  const it = state.incidents.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", id), {
      deleted: true, deletedAt: now, deletedBy: teacherName(),
      history: arrayUnion({ id: uid(), type: "deleted", detail: "Entry removed", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Incident", action: "Removed", studentName: it?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) {
    state.saveError = true; render();
  }
}

async function restoreIncident(id) {
  const it = state.incidents.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", id), {
      deleted: false,
      history: arrayUnion({ id: uid(), type: "restored", detail: "Entry restored", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Incident", action: "Restored", studentName: it?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) {
    state.saveError = true; render();
  }
}

function openEditIncident(id) {
  state.editingIncidentId = id;
  render();
}

async function submitEditIncident(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingIncidentId;
  const it = state.incidents.find((i) => i.id === id);
  if (!it) return;
  const updated = {
    studentName: f.studentName.value.trim(),
    studentClass: f.studentClass.value.trim(),
    date: f.date.value,
    issue: f.issue.value.trim(),
    actionTaken: f.actionTaken.value.trim(),
  };
  if (!updated.studentName || !updated.studentClass || !updated.issue) return;
  const changes = diffText(it, updated, [
    { key: "studentName", label: "Student name" },
    { key: "studentClass", label: "Class" },
    { key: "date", label: "Date" },
    { key: "issue", label: "Issue" },
    { key: "actionTaken", label: "Action taken" },
  ]);
  if (changes.length === 0) { state.editingIncidentId = null; render(); return; }
  const now = Date.now();
  state.saving = true;
  render();
  try {
    await updateDoc(doc(db, "incidents", id), {
      ...updated,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Entry edited — ${changes.join("; ")}`, by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Incident", action: "Edited", studentName: updated.studentName, details: changes.join("; "), loggedBy: teacherName() });
    state.editingIncidentId = null;
  } catch (err) {
    state.saveError = true;
  } finally {
    state.saving = false;
    render();
  }
}

function buildVenuesByDate(form, startDate, days) {
  const differentVenues = form.elements["differentVenues"]?.checked;
  const venuesByDate = {};
  if (differentVenues) {
    form.querySelectorAll(".dd-venue-input").forEach((el) => { venuesByDate[el.dataset.date] = el.value.trim(); });
  } else {
    const singleVenue = (form.elements["venue"]?.value || "").trim();
    suspensionDateRange(startDate, days).forEach((d) => { venuesByDate[d] = singleVenue; });
  }
  return venuesByDate;
}

async function submitNewSuspension(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value.trim();
  const startDate = f.startDate.value;
  const days = parseInt(f.days.value, 10);
  const type = state._newSuspType;
  const reason = f.reason.value.trim();
  if (!studentName || !studentClass || !startDate || !days) return;
  const venuesByDate = type === "ISS" ? buildVenuesByDate(f, startDate, days) : {};
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const caseId = state._linkedCaseId || null;
    await addDoc(collection(db, "suspensions"), {
      studentName, studentClass, type, startDate, days, venuesByDate, reason,
      ...(caseId ? { caseId } : {}),
      loggedBy: teacherName(),
      loggedByUid: auth.currentUser?.uid || null,
      createdAt: now,
      history: [{
        id: uid(), type: "created",
        detail: caseId
          ? `Suspension created — ${type}, ${days} day${days > 1 ? "s" : ""} from ${startDate} (linked part of an existing suspension)`
          : `Suspension created — ${type}, ${days} day${days > 1 ? "s" : ""} from ${startDate}`,
        by: teacherName(), at: now,
      }],
    });
    state.showNewSuspForm = false;
    state._newSuspType = "ISS";
    state._linkedCaseId = null;
    state._suspFormDraft = { studentName: "", studentClass: "", startDate: "", days: 1, reason: "", venue: "", differentVenues: false, venues: {} };
    const venueSummary = Object.entries(venuesByDate).map(([d, v]) => `${formatDate(d)}: ${v || "—"}`).join(", ");
    logToSheet({
      recordType: "Suspension", action: "Created", studentName,
      details: `Class: ${studentClass} — ${type} — ${days} day${days > 1 ? "s" : ""} from ${startDate}${venueSummary ? ` — Locations: ${venueSummary}` : ""}${reason ? ` — ${reason}` : ""}`,
      loggedBy: teacherName(),
    });
  } catch (err) {
    state.saveError = true;
  } finally {
    state.saving = false;
    render();
  }
}

async function deleteSuspension(id) {
  if (!askDeletePassword()) return;
  const s = state.suspensions.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "suspensions", id), {
      deleted: true, deletedAt: now, deletedBy: teacherName(),
      history: arrayUnion({ id: uid(), type: "deleted", detail: "Suspension removed", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Suspension", action: "Removed", studentName: s?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) {
    state.saveError = true; render();
  }
}

async function restoreSuspension(id) {
  const s = state.suspensions.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "suspensions", id), {
      deleted: false,
      history: arrayUnion({ id: uid(), type: "restored", detail: "Suspension restored", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Suspension", action: "Restored", studentName: s?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) {
    state.saveError = true; render();
  }
}

async function openLinkedSuspension(id) {
  const original = state.suspensions.find((s) => s.id === id);
  if (!original) return;
  let caseId = original.caseId;
  if (!caseId) {
    caseId = uid();
    try {
      await updateDoc(doc(db, "suspensions", id), {
        caseId,
        history: arrayUnion({ id: uid(), type: "linked", detail: "Marked as part of a multi-part suspension", by: teacherName(), at: Date.now() }),
      });
    } catch (err) {
      state.saveError = true; render(); return;
    }
  }
  const suggestedType = original.type === "ISS" ? "OSS" : "ISS";
  const suggestedStart = addDays(original.startDate, original.days);
  state._linkedCaseId = caseId;
  state._newSuspType = suggestedType;
  state._suspFormDraft = {
    studentName: original.studentName, studentClass: original.studentClass,
    startDate: suggestedStart, days: 1, reason: original.reason || "",
    venue: "", differentVenues: false, venues: {},
  };
  state.showNewSuspForm = true;
  render();
}

function openEditSuspension(id) {
  state.editingSuspensionId = id;
  const s = state.suspensions.find((i) => i.id === id);
  if (s) {
    state._newSuspType = s.type;
    const dates = suspensionDateRange(s.startDate, s.days);
    const venues = {};
    dates.forEach((d) => { venues[d] = venueForDate(s, d); });
    const uniqueVenues = [...new Set(Object.values(venues))];
    const differentVenues = uniqueVenues.length > 1;
    state._suspFormDraft = {
      studentName: s.studentName, studentClass: s.studentClass,
      startDate: s.startDate, days: s.days, reason: s.reason || "",
      venue: differentVenues ? "" : (uniqueVenues[0] || ""),
      differentVenues, venues,
    };
  }
  render();
}

async function submitEditSuspension(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingSuspensionId;
  const s = state.suspensions.find((i) => i.id === id);
  if (!s) return;
  const type = state._newSuspType;
  const startDate = f.startDate.value;
  const days = parseInt(f.days.value, 10);
  const venuesByDate = type === "ISS" ? buildVenuesByDate(f, startDate, days) : {};
  const updated = {
    studentName: f.studentName.value.trim(),
    studentClass: f.studentClass.value.trim(),
    type,
    startDate,
    days,
    venuesByDate,
    reason: f.reason.value.trim(),
  };
  if (!updated.studentName || !updated.studentClass || !updated.startDate || !updated.days) return;
  const changes = diffText(s, updated, [
    { key: "studentName", label: "Student name" },
    { key: "studentClass", label: "Class" },
    { key: "type", label: "Type" },
    { key: "startDate", label: "Start date" },
    { key: "days", label: "Duration (days)" },
    { key: "reason", label: "Reason" },
  ]);
  const oldVenueKey = JSON.stringify(s.venuesByDate || (s.venue ? { [s.startDate]: s.venue } : {}));
  const newVenueKey = JSON.stringify(venuesByDate);
  if (type === "ISS" && oldVenueKey !== newVenueKey) changes.push("Location schedule updated");
  if (changes.length === 0) { state.editingSuspensionId = null; render(); return; }
  const now = Date.now();
  state.saving = true;
  render();
  try {
    await updateDoc(doc(db, "suspensions", id), {
      ...updated,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Suspension edited — ${changes.join("; ")}`, by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Suspension", action: "Edited", studentName: updated.studentName, details: changes.join("; "), loggedBy: teacherName() });
    state.editingSuspensionId = null;
  } catch (err) {
    state.saveError = true;
  } finally {
    state.saving = false;
    render();
  }
}

// ---------- Rendering ----------
function render() {
  if (!state.authReady) {
    root.innerHTML = `<div class="dd-center"><div class="dd-mono">Opening the log…</div></div>`;
    return;
  }
  if (!state.teacherName) {
    root.innerHTML = renderNameScreen();
    attachNameListeners();
    return;
  }
  if (!state.dataLoaded || !state.suspLoaded) {
    root.innerHTML = `<div class="dd-center"><div class="dd-mono">Loading entries…</div></div>`;
    return;
  }
  root.innerHTML = renderMain();
  attachMainListeners();
}

function renderNameScreen() {
  return `
    <div class="dd-app"><div class="dd-center">
      <form id="name-form" class="dd-auth-card">
        <div class="dd-title">Discipline Diary</div>
        <div class="dd-subtitle">Sign the register to begin. This name is saved on this device only, and will tag every entry and follow-up you log.</div>
        <label class="dd-label">Your name</label>
        <input class="dd-input" name="name" placeholder="e.g. Mr. Adams" required autofocus />
        <button class="dd-btn-primary" type="submit">Enter the log</button>
      </form>
    </div></div>`;
}

function attachNameListeners() {
  document.getElementById("name-form").addEventListener("submit", handleNameSubmit);
}

function filteredIncidents() {
  let list = state.incidents;
  if (state.tab === "Deleted") {
    list = list.filter((it) => it.deleted);
  } else {
    list = list.filter((it) => !it.deleted);
    if (state.tab !== "All") list = list.filter((it) => it.status === state.tab);
  }
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    list = list.filter((it) => it.studentName.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}

function counts() {
  const c = { Open: 0, Monitoring: 0, Resolved: 0, Deleted: 0 };
  state.incidents.forEach((it) => {
    if (it.deleted) { c.Deleted++; return; }
    if (c[it.status] !== undefined) c[it.status]++;
  });
  return c;
}

function filteredSuspensions() {
  let list = state.suspensions.map((s) => ({ ...s, _status: suspensionStatus(s) }));
  if (state.suspTab === "Deleted") {
    list = list.filter((s) => s.deleted);
  } else {
    list = list.filter((s) => !s.deleted);
    if (state.suspTab !== "All") list = list.filter((s) => s._status === state.suspTab);
  }
  if (state.suspQuery.trim()) {
    const q = state.suspQuery.trim().toLowerCase();
    list = list.filter((s) => s.studentName.toLowerCase().includes(q));
  }
  const order = { Active: 0, Upcoming: 1, Completed: 2 };
  return list.sort((a, b) => (order[a._status] ?? 3) - (order[b._status] ?? 3) || b.startDate.localeCompare(a.startDate));
}

function suspCounts() {
  const c = { Upcoming: 0, Active: 0, Completed: 0, ISS: 0, OSS: 0, Deleted: 0 };
  state.suspensions.forEach((s) => {
    if (s.deleted) { c.Deleted++; return; }
    c[suspensionStatus(s)]++;
    if (s.type === "ISS") c.ISS++; else c.OSS++;
  });
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
            ${formatDate(it.date)}${it.studentClass ? ` · Class ${escapeHtml(it.studentClass)}` : ""} · logged by ${escapeHtml(it.loggedBy)}
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
        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${it.deleted
            ? `<div class="dd-mono-muted" style="font-size:11px">Removed by ${escapeHtml(it.deletedBy || "")} on ${formatDateTime(it.deletedAt)}</div>
               <button class="dd-add-btn" data-action="restore-incident" data-id="${it.id}">Restore entry</button>`
            : `<button class="dd-add-btn" data-action="edit-incident" data-id="${it.id}">Edit entry</button>
               <button class="dd-add-btn" style="background:#A3372B" data-action="delete-incident" data-id="${it.id}">Remove entry</button>`}
        </div>
      </div>` : ""}
    </div>`;
}

function renderSuspCard(s) {
  const typeStyle = SUSP_TYPE_STYLE[s.type];
  const statusStyle = s.deleted ? { ink: "#8A8571", label: "REMOVED" } : SUSP_STATUS_STYLE[s._status];
  const endDate = addDays(s.startDate, s.days);
  const expanded = state.expandedSuspId === s.id;
  const history = s.history || [];
  const dates = suspensionDateRange(s.startDate, s.days);
  const venues = dates.map((d) => venueForDate(s, d));
  const uniqueVenues = [...new Set(venues.filter(Boolean))];
  let venueSummary = "";
  if (s.type === "ISS") {
    if (uniqueVenues.length === 1) venueSummary = ` · ${escapeHtml(uniqueVenues[0])}`;
    else if (uniqueVenues.length > 1) venueSummary = ` · Multiple locations`;
  }
  const parts = linkedParts(s);
  const partIndex = parts.findIndex((p) => p.id === s.id);
  return `
    <div class="dd-card">
      <button class="dd-card-head" data-action="toggle-susp-expand" data-id="${s.id}">
        <div style="min-width:0">
          <div class="dd-card-student">${escapeHtml(s.studentName)}${parts.length > 1 ? ` <span class="dd-mono-muted" style="font-size:11px;font-weight:400">— part ${partIndex + 1} of ${parts.length}</span>` : ""}</div>
          <div class="dd-card-issue">
            ${formatDate(s.startDate)} → ${formatDate(endDate)} · ${s.days} day${s.days > 1 ? "s" : ""}
            ${s.studentClass ? ` · Class ${escapeHtml(s.studentClass)}` : ""}
            ${venueSummary}
          </div>
          ${s.reason ? `<div class="dd-card-meta">${escapeHtml(s.reason)}</div>` : ""}
          <div class="dd-card-meta">logged by ${escapeHtml(s.loggedBy)}</div>
        </div>
        <div class="dd-card-right">
          <span class="dd-stamp" style="color:${typeStyle.ink}">${typeStyle.label}</span>
          <span class="dd-stamp" style="color:${statusStyle.ink}">${statusStyle.label}</span>
          <span>${expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      ${expanded ? `
      <div class="dd-expand">
        ${parts.length > 1 ? `
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Linked suspension — all parts</div>
        <div class="dd-followups" style="margin-bottom:16px">
          ${parts.map((p, i) => `<div class="dd-followup"><div class="dd-followup-note">${i === partIndex ? "<b>" : ""}Part ${i + 1}: ${SUSP_TYPE_STYLE[p.type].label}, ${p.days} day${p.days > 1 ? "s" : ""}${i === partIndex ? "</b>" : ""}</div><div class="dd-followup-meta">${formatDate(p.startDate)} → ${formatDate(addDays(p.startDate, p.days))}</div></div>`).join("")}
        </div>` : ""}
        ${s.type === "ISS" ? `
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Location by day</div>
        <div class="dd-followups" style="margin-bottom:16px">
          ${dates.map((dt, i) => `<div class="dd-followup"><div class="dd-followup-note">${escapeHtml(venues[i] || "(not set)")}</div><div class="dd-followup-meta">${formatDate(dt)}</div></div>`).join("")}
        </div>` : ""}
        <button class="dd-history-toggle" data-action="toggle-susp-history" data-id="${s.id}">${state.historyOpen[s.id] ? "Hide audit trail" : "Show audit trail"}</button>
        ${state.historyOpen[s.id] ? `
          <div class="dd-history">
            ${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="font-style:italic;color:#8A8571">No history recorded for this entry yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}
          </div>` : ""}
        <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${s.deleted
            ? `<div class="dd-mono-muted" style="font-size:11px">Removed by ${escapeHtml(s.deletedBy || "")} on ${formatDateTime(s.deletedAt)}</div>
               <button class="dd-add-btn" data-action="restore-suspension" data-id="${s.id}">Restore</button>`
            : `<button class="dd-add-btn" data-action="edit-suspension" data-id="${s.id}">Edit entry</button>
               <button class="dd-add-btn" style="background:#4C6B8A" data-action="link-suspension" data-id="${s.id}">+ Add linked part</button>
               <button class="dd-add-btn" style="background:#A3372B" data-action="delete-suspension" data-id="${s.id}">Remove</button>`}
        </div>
      </div>` : ""}
    </div>`;
}

function renderMain() {
  if (state.section === "suspensions") return renderSuspensionSection();
  return renderLogSection();
}

function renderNav() {
  return `
    <div class="dd-header" style="position:relative">
      <button class="dd-circle-btn dd-header-backup" id="btn-backup" title="Download a full backup as a file">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 19h16"></path></svg>
      </button>
      <div class="dd-header-inner">
        <div>
          <div class="dd-header-title">Discipline Diary</div>
          <div class="dd-header-sub">Signed in as ${escapeHtml(teacherName())} · v${APP_VERSION}</div>
        </div>
      </div>
      <div class="dd-header-inner" style="margin-top:14px">
        <div style="display:flex;gap:10px;width:100%">
          <button class="dd-pill-tab ${state.section === "log" ? "active" : ""}" data-action="set-section" data-section="log">Discipline Log</button>
          <button class="dd-pill-tab ${state.section === "suspensions" ? "active" : ""}" data-action="set-section" data-section="suspensions">Suspensions</button>
        </div>
      </div>
    </div>
    ${state.showHelp ? renderHelpModal() : ""}`;
}

function renderHelpModal() {
  return `
    <div class="dd-modal-backdrop" id="help-modal-backdrop">
      <div class="dd-modal" id="help-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">How to use Discipline Diary</div>
          <button type="button" class="dd-modal-close" id="help-modal-close">✕</button>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Discipline Log</div>
          <p>Log an issue with <b>+ New entry</b>. Status means:</p>
          <ul>
            <li><b>Open</b> — logged, action not yet taken</li>
            <li><b>In Progress</b> — action taken, still being watched</li>
            <li><b>Resolved</b> — closed, nothing further expected</li>
          </ul>
          <p>Tap an entry to expand it — add follow-up notes, change status, edit details, or remove it.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Suspensions</div>
          <p>Track In-School (ISS) and Out-of-School (OSS) suspensions. The dashboard shows who's serving <b>today</b> and who's coming up in the <b>next 2 days</b>. Tap a suspension card to edit it, view its history, or remove it.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Editing &amp; audit trail</div>
          <p>Every entry can be edited. Every edit, status change, and follow-up is permanently recorded — tap "Show audit trail" on any entry to see the full history of who changed what and when.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Removing entries</div>
          <p>Removing asks for a password and only hides the entry — it's never truly deleted. Find removed entries under the <b>Deleted</b> tab to restore them any time.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Backups</div>
          <p>The backup icon (top right, downward-arrow circle) downloads a full copy of everything as a file. Worth doing occasionally and keeping a copy somewhere safe, like Google Drive.</p>
        </div>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:14px">Version ${APP_VERSION}</div>
      </div>
    </div>`;
}

function renderLogSection() {
  const list = filteredIncidents();
  const c = counts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
          <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="dd-pill ${state.tab === "Deleted" ? "active" : ""}" data-action="set-tab" data-tab="Deleted">Deleted (${c.Deleted})</button>
            <button class="dd-newbtn" id="btn-new">+ New entry</button>
          </div>
        </div>
        <div class="dd-tabs">
          ${["All", ...STATUSES].map((t) => `<button class="dd-tab ${state.tab === t ? "active" : ""}" data-action="set-tab" data-tab="${t}">${t === "All" ? t : STATUS_TEXT[t]}${t !== "All" ? ` <span class="count">(${c[t]})</span>` : ""}</button>`).join("")}
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
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
    </div>`;
}

function renderSuspensionSection() {
  const list = filteredSuspensions();
  const c = suspCounts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="margin-bottom:16px">
          ${renderDashboardBox("ISS", "In-School Suspension", "#B8863B")}
          <div style="height:12px"></div>
          ${renderDashboardBox("OSS", "Out of School Suspension", "#A3372B")}
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
          <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="dd-pill ${state.suspTab === "Deleted" ? "active" : ""}" data-action="set-susp-tab" data-tab="Deleted">Deleted (${c.Deleted})</button>
            <button class="dd-newbtn" id="btn-new-susp">+ New suspension</button>
          </div>
        </div>
        <div class="dd-tabs">
          ${["All", "Active", "Upcoming", "Completed"].map((t) => `<button class="dd-tab ${state.suspTab === t ? "active" : ""}" data-action="set-susp-tab" data-tab="${t}">${t}${t !== "All" ? ` <span class="count">(${c[t]})</span>` : ""}</button>`).join("")}
        </div>
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="susp-search-input" placeholder="Search by student name…" value="${escapeHtml(state.suspQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.suspensions.length === 0 ? "No suspensions logged yet." : "No entries match this filter."}</div>` : ""}
          ${list.map(renderSuspCard).join("")}
        </div>
      </div>
      ${state.showNewSuspForm ? renderNewSuspForm() : ""}
      ${state.editingSuspensionId ? renderEditSuspensionForm() : ""}
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
        <label class="dd-label">Class</label>
        <input class="dd-input" name="studentClass" placeholder="e.g. 5A" required />
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

function renderVenueRowsHtml(startDate, days, venuesMap) {
  const dates = suspensionDateRange(startDate, days || 1);
  return dates.map((d) => `
    <div class="dd-venue-row">
      <span class="dd-venue-date">${formatDate(d)}</span>
      <input class="dd-input dd-venue-input" data-date="${d}" placeholder="e.g. Room 204" value="${escapeHtml(venuesMap[d] || "")}" />
    </div>`).join("");
}

function renderLocationSection(d, idPrefix) {
  return `
    <label class="dd-label">Location</label>
    <input class="dd-input" name="venue" placeholder="e.g. Room 204" value="${escapeHtml(d.venue)}" style="${d.differentVenues ? "display:none" : ""}" />
    <label style="display:flex;align-items:center;gap:6px;margin-top:${d.differentVenues ? "0" : "8px"};cursor:pointer">
      <input type="checkbox" name="differentVenues" ${d.differentVenues ? "checked" : ""} />
      <span class="dd-mono-muted" style="font-size:12px">Different location each day</span>
    </label>
    ${d.differentVenues ? `
    <div class="dd-mono-muted" style="font-size:11px;margin:8px 0 6px">A student can be in a different room on different days.</div>
    <div id="${idPrefix}-venue-rows">${renderVenueRowsHtml(d.startDate || todayISO(), d.days || 1, d.venues)}</div>` : ""}`;
}

function renderNewSuspForm() {
  const type = state._newSuspType;
  const d = state._suspFormDraft;
  return `
    <div class="dd-modal-backdrop" id="susp-modal-backdrop">
      <form class="dd-modal" id="new-susp-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">New suspension</div>
          <button type="button" class="dd-modal-close" id="susp-modal-close">✕</button>
        </div>
        ${state._linkedCaseId ? `<div class="dd-mono-muted" style="font-size:11px;margin-bottom:10px;color:#4C6B8A">Adding a linked part to an existing suspension — student, class, and reason are carried over.</div>` : ""}
        <label class="dd-label">Type</label>
        <div class="dd-status-row">
          <button type="button" class="dd-stamp" data-action="pick-susp-type" data-type="ISS" style="color:${SUSP_TYPE_STYLE.ISS.ink};opacity:${type === "ISS" ? 1 : 0.35}">IN-SCHOOL</button>
          <button type="button" class="dd-stamp" data-action="pick-susp-type" data-type="OSS" style="color:${SUSP_TYPE_STYLE.OSS.ink};opacity:${type === "OSS" ? 1 : 0.35}">OUT-OF-SCHOOL</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" />
        <label class="dd-label">Class</label>
        <input class="dd-input" name="studentClass" placeholder="e.g. 5A" required value="${escapeHtml(d.studentClass)}" />
        <label class="dd-label">Start date</label>
        <input class="dd-input" type="date" name="startDate" id="susp-start-date" required value="${d.startDate || todayISO()}" />
        <label class="dd-label">Duration (days)</label>
        <input class="dd-input" type="number" name="days" id="susp-days" min="1" required value="${d.days || 1}" />
        ${type === "ISS" ? renderLocationSection(d, "new") : ""}
        <label class="dd-label">Reason</label>
        <textarea class="dd-textarea dd-input" name="reason" rows="2" placeholder="Why was this issued? (optional)">${escapeHtml(d.reason)}</textarea>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save suspension"}</button>
      </form>
    </div>`;
}

function renderEditIncidentForm() {
  const it = state.incidents.find((i) => i.id === state.editingIncidentId);
  if (!it) return "";
  return `
    <div class="dd-modal-backdrop" id="edit-modal-backdrop">
      <form class="dd-modal" id="edit-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Edit entry</div>
          <button type="button" class="dd-modal-close" id="edit-modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(it.studentName)}" />
        <label class="dd-label">Class</label>
        <input class="dd-input" name="studentClass" required value="${escapeHtml(it.studentClass || "")}" />
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${it.date}" />
        <label class="dd-label">Issue</label>
        <textarea class="dd-textarea dd-input" name="issue" rows="3" required>${escapeHtml(it.issue)}</textarea>
        <label class="dd-label">Action taken</label>
        <textarea class="dd-textarea dd-input" name="actionTaken" rows="2">${escapeHtml(it.actionTaken || "")}</textarea>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save changes"}</button>
      </form>
    </div>`;
}

function renderEditSuspensionForm() {
  const s = state.suspensions.find((i) => i.id === state.editingSuspensionId);
  if (!s) return "";
  const type = state._newSuspType || s.type;
  const d = state._suspFormDraft;
  return `
    <div class="dd-modal-backdrop" id="edit-susp-modal-backdrop">
      <form class="dd-modal" id="edit-susp-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Edit suspension</div>
          <button type="button" class="dd-modal-close" id="edit-susp-modal-close">✕</button>
        </div>
        <label class="dd-label">Type</label>
        <div class="dd-status-row">
          <button type="button" class="dd-stamp" data-action="pick-edit-susp-type" data-type="ISS" style="color:${SUSP_TYPE_STYLE.ISS.ink};opacity:${type === "ISS" ? 1 : 0.35}">IN-SCHOOL</button>
          <button type="button" class="dd-stamp" data-action="pick-edit-susp-type" data-type="OSS" style="color:${SUSP_TYPE_STYLE.OSS.ink};opacity:${type === "OSS" ? 1 : 0.35}">OUT-OF-SCHOOL</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" />
        <label class="dd-label">Class</label>
        <input class="dd-input" name="studentClass" required value="${escapeHtml(d.studentClass)}" />
        <label class="dd-label">Start date</label>
        <input class="dd-input" type="date" name="startDate" id="edit-susp-start-date" required value="${d.startDate}" />
        <label class="dd-label">Duration (days)</label>
        <input class="dd-input" type="number" name="days" id="edit-susp-days" min="1" required value="${d.days}" />
        ${type === "ISS" ? renderLocationSection(d, "edit") : ""}
        <label class="dd-label">Reason</label>
        <textarea class="dd-textarea dd-input" name="reason" rows="2">${escapeHtml(d.reason)}</textarea>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save changes"}</button>
      </form>
    </div>`;
}

function attachMainListeners() {
  document.querySelectorAll('[data-action="set-section"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = el.dataset.section; render(); }));

  document.getElementById("btn-backup").addEventListener("click", downloadBackupFile);

  document.getElementById("btn-help").addEventListener("click", () => { state.showHelp = true; render(); });
  if (state.showHelp) {
    document.getElementById("help-modal-close").addEventListener("click", () => { state.showHelp = false; render(); });
    document.getElementById("help-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "help-modal-backdrop") { state.showHelp = false; render(); }
    });
  }

  if (state.section === "log") attachLogListeners();
  else attachSuspListeners();
}

function attachLogListeners() {
  document.getElementById("btn-new").addEventListener("click", () => { state.showNewForm = true; state.expandedId = null; state._newStatus = "Open"; render(); });

  document.querySelectorAll('[data-action="set-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.tab = el.dataset.tab; render(); }));

  const search = document.getElementById("search-input");
  search.addEventListener("input", () => {
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const newSearch = document.getElementById("search-input");
    if (newSearch) { newSearch.focus(); newSearch.setSelectionRange(cursor, cursor); }
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

  document.querySelectorAll('[data-action="delete-incident"]').forEach((el) =>
    el.addEventListener("click", () => deleteIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-incident"]').forEach((el) =>
    el.addEventListener("click", () => restoreIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-incident"]').forEach((el) =>
    el.addEventListener("click", () => openEditIncident(el.dataset.id)));

  if (state.showNewForm) {
    document.getElementById("new-form").addEventListener("submit", submitNewIncident);
    document.getElementById("modal-close").addEventListener("click", () => { state.showNewForm = false; render(); });
    document.getElementById("modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "modal-backdrop") { state.showNewForm = false; render(); }
    });
    document.querySelectorAll('[data-action="pick-new-status"]').forEach((el) =>
      el.addEventListener("click", () => { state._newStatus = el.dataset.status; render(); }));
  }

  if (state.editingIncidentId) {
    document.getElementById("edit-form").addEventListener("submit", submitEditIncident);
    document.getElementById("edit-modal-close").addEventListener("click", () => { state.editingIncidentId = null; render(); });
    document.getElementById("edit-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "edit-modal-backdrop") { state.editingIncidentId = null; render(); }
    });
  }
}

function attachSuspListeners() {
  document.getElementById("btn-new-susp").addEventListener("click", () => {
    state.showNewSuspForm = true;
    state._newSuspType = "ISS";
    state._linkedCaseId = null;
    state._suspFormDraft = { studentName: "", studentClass: "", startDate: todayISO(), days: 1, reason: "", venue: "", differentVenues: false, venues: {} };
    render();
  });

  document.querySelectorAll('[data-action="set-susp-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.suspTab = el.dataset.tab; render(); }));

  const search = document.getElementById("susp-search-input");
  search.addEventListener("input", () => {
    state.suspQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const newSearch = document.getElementById("susp-search-input");
    if (newSearch) { newSearch.focus(); newSearch.setSelectionRange(cursor, cursor); }
  });

  document.querySelectorAll('[data-action="delete-suspension"]').forEach((el) =>
    el.addEventListener("click", () => deleteSuspension(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-suspension"]').forEach((el) =>
    el.addEventListener("click", () => restoreSuspension(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-suspension"]').forEach((el) =>
    el.addEventListener("click", () => openEditSuspension(el.dataset.id)));
  document.querySelectorAll('[data-action="link-suspension"]').forEach((el) =>
    el.addEventListener("click", () => openLinkedSuspension(el.dataset.id)));

  document.querySelectorAll('[data-action="toggle-susp-expand"]').forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      state.expandedSuspId = state.expandedSuspId === id ? null : id;
      render();
    }));

  document.querySelectorAll('[data-action="toggle-susp-history"]').forEach((el) =>
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      state.historyOpen[id] = !state.historyOpen[id];
      render();
    }));

  function attachSuspFormFieldSync(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const syncTextField = (name) => {
    const el = form.elements[name];
    if (el) el.addEventListener("input", () => { state._suspFormDraft[name] = el.value; });
  };
  syncTextField("studentName");
  syncTextField("studentClass");
  syncTextField("reason");
  syncTextField("venue");

  form.querySelectorAll(".dd-venue-input").forEach((el) =>
    el.addEventListener("input", () => { state._suspFormDraft.venues[el.dataset.date] = el.value; }));

  const diffVenuesEl = form.elements["differentVenues"];
  if (diffVenuesEl) {
    diffVenuesEl.addEventListener("change", () => {
      state._suspFormDraft.differentVenues = diffVenuesEl.checked;
      if (diffVenuesEl.checked) {
        // seed each day's row with the single location already typed, so switching to per-day mode doesn't blank everything out
        suspensionDateRange(state._suspFormDraft.startDate || todayISO(), state._suspFormDraft.days || 1).forEach((dt) => {
          if (!state._suspFormDraft.venues[dt]) state._suspFormDraft.venues[dt] = state._suspFormDraft.venue;
        });
      }
      render();
    });
  }

  const startDateEl = form.elements["startDate"];
  const daysEl = form.elements["days"];
  const onDateOrDaysChange = () => {
    state._suspFormDraft.startDate = startDateEl.value;
    state._suspFormDraft.days = parseInt(daysEl.value, 10) || 1;
    render();
  };
  if (startDateEl) startDateEl.addEventListener("change", onDateOrDaysChange);
  if (daysEl) daysEl.addEventListener("change", onDateOrDaysChange);
}

if (state.showNewSuspForm) {
    document.getElementById("new-susp-form").addEventListener("submit", submitNewSuspension);
    document.getElementById("susp-modal-close").addEventListener("click", () => { state.showNewSuspForm = false; state._linkedCaseId = null; render(); });
    document.getElementById("susp-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "susp-modal-backdrop") { state.showNewSuspForm = false; state._linkedCaseId = null; render(); }
    });
    document.querySelectorAll('[data-action="pick-susp-type"]').forEach((el) =>
      el.addEventListener("click", () => { state._newSuspType = el.dataset.type; render(); }));
    attachSuspFormFieldSync("new-susp-form");
  }

  if (state.editingSuspensionId) {
    document.getElementById("edit-susp-form").addEventListener("submit", submitEditSuspension);
    document.getElementById("edit-susp-modal-close").addEventListener("click", () => { state.editingSuspensionId = null; render(); });
    document.getElementById("edit-susp-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "edit-susp-modal-backdrop") { state.editingSuspensionId = null; render(); }
    });
    document.querySelectorAll('[data-action="pick-edit-susp-type"]').forEach((el) =>
      el.addEventListener("click", () => { state._newSuspType = el.dataset.type; render(); }));
    attachSuspFormFieldSync("edit-susp-form");
  }
}

render();
