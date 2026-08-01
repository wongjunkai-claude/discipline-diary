// ---------- Firebase (loaded directly from Google's CDN, no npm/build needed) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, arrayUnion, setDoc, getDoc,
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

const APP_VERSION = "2.0.0";
const DELETE_PASSWORD = "shsm";

// Paste the Web app URL from your Google Apps Script deployment here (see
// apps-script.gs for setup steps). Leave as-is to skip Sheets logging.
const SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyEXCtdtriLO9Qli9OIEHLH2348T9oc5VFEX9Qr7_nsrEv8zoYlrZftMExpEjcg4h_T/exec";

function logToSheet(record) {
  if (!SHEET_WEBHOOK_URL || SHEET_WEBHOOK_URL.startsWith("PASTE_")) return;
  try {
    fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify(record),
    }).catch(() => {});
  } catch (e) {
    // ignore
  }
}

// ---------- Constants ----------
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
const LOCATION_OPTIONS = ["General Office", "MPR 1"];
const ATTENDEE_OPTIONS = ["Father", "Mother", "Grandfather", "Grandmother", "Guardian", "Others"];

function buildClassOptions() {
  const out = [];
  for (let level = 1; level <= 6; level++) {
    const max = level <= 2 ? 8 : 6;
    for (let n = 1; n <= max; n++) out.push(`P${level}-${n}`);
  }
  return out;
}
const CLASS_OPTIONS = buildClassOptions();

// ---------- Date / calendar helpers ----------
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
function formatDateShort(iso) {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
function isWeekend(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

const DEFAULT_HOLIDAYS_2026 = {
  publicHolidays: [
    "2026-01-01", "2026-02-17", "2026-02-18", "2026-03-21", "2026-04-03",
    "2026-05-01", "2026-05-27", "2026-05-31", "2026-06-01", "2026-08-09",
    "2026-08-10", "2026-11-08", "2026-11-09", "2026-12-25",
  ],
};

function weekdayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function strictNextWeekday(iso, targetDow) {
  let d = addDays(iso, 1);
  while (weekdayOf(d) !== targetDow) d = addDays(d, 1);
  return d;
}

function computeMoeCalendar(year) {
  const jan1Dow = weekdayOf(`${year}-01-01`);
  const jan2 = `${year}-01-02`;
  const jan2Dow = weekdayOf(jan2);
  let w1;
  if (jan2Dow === 1) w1 = jan2;
  else if (jan2Dow === 2) w1 = addDays(jan2, -1);
  else w1 = strictNextWeekday(jan2, 1);
  if (jan1Dow === 0 || jan1Dow === 6) w1 = addDays(w1, 1);

  const term1End = addDays(w1, 67);
  const marchStart = addDays(term1End, 1);
  const marchEnd = addDays(marchStart, 8);
  const term2Start = addDays(marchEnd, 1);
  const term2End = addDays(term2Start, 67);
  const juneStart = addDays(term2End, 1);
  const juneEnd = addDays(juneStart, 29);
  const term3Start = addDays(juneEnd, 1);
  const term3End = addDays(term3Start, 67);
  const sepStart = addDays(term3End, 1);
  const sepEnd = addDays(sepStart, 8);
  const term4Start = addDays(sepEnd, 1);
  const term4End = addDays(term4Start, 67);
  const yearEndStart = addDays(term4End, 1);
  const yearEndEnd = `${year}-12-31`;

  const youthDay = addDays(term3Start, 7);
  const teachersDay = term3End;
  const childrensDay = strictNextWeekday(`${year}-09-30`, 5);

  const nationalDay = `${year}-08-09`;
  const ndDow = weekdayOf(nationalDay);
  let nationalDayInLieu = null;
  if (ndDow >= 1 && ndDow <= 4) nationalDayInLieu = addDays(nationalDay, 1);
  else if (ndDow === 6) nationalDayInLieu = addDays(nationalDay, 2);

  return {
    ranges: [
      { start: marchStart, end: marchEnd, label: "March holiday" },
      { start: juneStart, end: juneEnd, label: "June holiday" },
      { start: sepStart, end: sepEnd, label: "September holiday" },
      { start: yearEndStart, end: yearEndEnd, label: "Year-end holiday" },
    ],
    singleDays: [youthDay, teachersDay, childrensDay, ...(nationalDayInLieu ? [nationalDayInLieu] : [])],
  };
}

function isNonSchoolDay(iso) {
  if (isWeekend(iso)) return true;
  const year = parseInt(iso.slice(0, 4), 10);
  const moe = computeMoeCalendar(year);
  if (moe.singleDays.includes(iso)) return true;
  for (const r of moe.ranges) {
    if (iso >= r.start && iso <= r.end) return true;
  }
  const h = state.holidays;
  if (h && h.publicHolidays && h.publicHolidays.includes(iso)) return true;
  return false;
}
function nextSchoolDay(iso) {
  let d = addDays(iso, 1);
  while (isNonSchoolDay(d)) d = addDays(d, 1);
  return d;
}
function schoolDayChain(startDate, count) {
  const out = [startDate];
  let cur = startDate;
  for (let i = 1; i < count; i++) {
    cur = nextSchoolDay(cur);
    out.push(cur);
  }
  return out;
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

function askDeletePassword() {
  const pw = window.prompt("Enter password to remove this entry:");
  if (pw === null) return false;
  if (pw !== DELETE_PASSWORD) {
    alert("Incorrect password. Entry was not removed.");
    return false;
  }
  return true;
}

// ---------- Suspension day-entry helpers (new unified per-day model) ----------
function suspensionDayEntries(s) {
  if (Array.isArray(s.days) && s.days.length) return s.days;
  // legacy records (before the unified per-day model) stored `days` as a
  // plain count, not an array — read that instead
  const list = [];
  const count = s.totalDays || (typeof s.days === "number" ? s.days : 1);
  const start = s.startDate;
  if (!start) return [];
  let cur = start;
  for (let i = 0; i < count; i++) {
    if (i > 0) cur = nextSchoolDay(cur);
    list.push({ date: cur, type: s.type || "ISS", venue: (s.venuesByDate && s.venuesByDate[cur]) || s.venue || "" });
  }
  return list;
}
function suspensionDateRange(s) {
  const entries = suspensionDayEntries(s);
  if (!entries.length) return { first: s.startDate, last: s.startDate };
  const dates = entries.map((e) => e.date).sort();
  return { first: dates[0], last: dates[dates.length - 1] };
}
function suspensionStatus(s) {
  const { first, last } = suspensionDateRange(s);
  const today = todayISO();
  if (today < first) return "Upcoming";
  if (today <= last) return "Active";
  return "Completed";
}
function suspensionTypeSummary(s) {
  const entries = suspensionDayEntries(s);
  const hasIss = entries.some((e) => e.type === "ISS");
  const hasOss = entries.some((e) => e.type === "OSS");
  if (hasIss && hasOss) return "Mixed";
  if (hasIss) return "ISS";
  if (hasOss) return "OSS";
  return "ISS";
}
function studentsOnDate(type, dateISO) {
  const out = [];
  state.suspensions.forEach((s) => {
    if (s.deleted) return;
    suspensionDayEntries(s).forEach((e) => {
      if (e.date === dateISO && e.type === type) out.push({ ...s, _venue: e.venue });
    });
  });
  return out;
}

// ---------- App state ----------
const state = {
  authReady: false,
  teacherName: localStorage.getItem("dd-teacher-name") || "",
  holidays: null,
  section: "dashboard",
  showHelp: false,

  incidents: [],
  dataLoaded: false,
  tab: "All",
  query: "",
  selectedIncidentId: null,
  showNewForm: false,
  editingIncidentId: null,
  historyOpen: {},
  followDraft: {},

  suspensions: [],
  suspLoaded: false,
  suspTab: "All",
  suspQuery: "",
  selectedSuspId: null,
  showNewSuspForm: false,
  editingSuspensionId: null,
  _suspDraft: null,

  parentMeetings: [],
  pmLoaded: false,
  pmTab: "All",
  pmQuery: "",
  selectedPmId: null,
  showNewPmForm: false,
  editingPmId: null,
  _pmDraft: null,

  saveError: false,
  saving: false,
};

const root = document.getElementById("app");
let unsubIncidents = null;
let unsubSuspensions = null;
let unsubHolidays = null;
let unsubParentMeetings = null;

signInAnonymously(auth).catch(() => { render(); });

onAuthStateChanged(auth, (u) => {
  state.authReady = !!u;
  if (unsubIncidents) { unsubIncidents(); unsubIncidents = null; }
  if (unsubSuspensions) { unsubSuspensions(); unsubSuspensions = null; }
  if (unsubHolidays) { unsubHolidays(); unsubHolidays = null; }
  if (unsubParentMeetings) { unsubParentMeetings(); unsubParentMeetings = null; }
  if (u && state.teacherName) startListening();
  render();
});

function startListening() {
  state.dataLoaded = false;
  state.suspLoaded = false;
  state.pmLoaded = false;
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
  unsubParentMeetings = onSnapshot(
    collection(db, "parentMeetings"),
    (snap) => {
      state.parentMeetings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.pmLoaded = true;
      writeBackupSnapshot();
      render();
    },
    () => { state.pmLoaded = true; render(); }
  );
  ensureHolidaysSeeded();
  syncPublicHolidaysFromDataGovSg();
  unsubHolidays = onSnapshot(
    doc(db, "holidays", "singapore"),
    (snap) => { if (snap.exists()) { state.holidays = snap.data(); render(); } },
    () => {}
  );
}

async function ensureHolidaysSeeded() {
  try {
    const snap = await getDoc(doc(db, "holidays", "singapore"));
    if (!snap.exists()) await setDoc(doc(db, "holidays", "singapore"), DEFAULT_HOLIDAYS_2026);
  } catch (e) { /* non-fatal */ }
}

const SG_HOLIDAYS_DATASET_URL = "https://data.gov.sg/api/action/datastore_search?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=200";
async function syncPublicHolidaysFromDataGovSg() {
  try {
    const res = await fetch(SG_HOLIDAYS_DATASET_URL);
    if (!res.ok) return;
    const data = await res.json();
    const records = data?.result?.records;
    if (!Array.isArray(records) || records.length < 50) return;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const dates = new Set();
    for (const rec of records) {
      for (const key of Object.keys(rec)) {
        if (dateRegex.test(rec[key])) {
          dates.add(rec[key]);
          if (weekdayOf(rec[key]) === 0) dates.add(addDays(rec[key], 1));
          break;
        }
      }
    }
    if (dates.size < 50) return;
    const fresh = [...dates].sort();
    const current = state.holidays?.publicHolidays || [];
    if (JSON.stringify(fresh) !== JSON.stringify(current)) {
      await setDoc(doc(db, "holidays", "singapore"), { publicHolidays: fresh }, { merge: true });
    }
  } catch (e) { /* silent */ }
}

let backupTimer = null;
function writeBackupSnapshot() {
  if (!state.dataLoaded || !state.suspLoaded || !state.pmLoaded) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      await setDoc(doc(db, "backups", "latest"), {
        updatedAt: Date.now(),
        incidents: state.incidents,
        suspensions: state.suspensions,
        parentMeetings: state.parentMeetings,
      });
    } catch (e) { /* non-fatal */ }
  }, 1500);
}
function downloadBackupFile() {
  const payload = {
    exportedAt: new Date().toISOString(),
    incidents: state.incidents,
    suspensions: state.suspensions,
    parentMeetings: state.parentMeetings,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `discipline-diary-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function teacherName() { return state.teacherName || "Unnamed teacher"; }
function saveTeacherName(name) {
  state.teacherName = name;
  localStorage.setItem("dd-teacher-name", name);
  if (state.authReady) startListening();
  render();
}
function handleNameSubmit(e) {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (name) saveTeacherName(name);
}

// ==================== DISCIPLINE LOG ====================
async function submitNewIncident(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const issue = f.issue.value.trim();
  const actionTaken = f.actionTaken.value.trim();
  const status = state._newStatus || "Open";
  if (!studentName || !studentClass || !issue || !actionTaken) return;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const docRef = await addDoc(collection(db, "incidents"), {
      studentName, studentClass, date, issue, actionTaken, status,
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      followUps: [],
      history: [{ id: uid(), type: "created", detail: `Entry created — status set to ${STATUS_TEXT[status]}`, by: teacherName(), at: now }],
    });
    state.showNewForm = false;
    state._newStatus = "Open";
    state.selectedIncidentId = docRef.id;
    logToSheet({ recordType: "Incident", action: "Created", studentName, details: `Class: ${studentClass} — Status: ${status} — ${issue}`, loggedBy: teacherName() });
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
      history: arrayUnion({ id: uid(), type: "status", detail: `Status changed from ${STATUS_TEXT[currentStatus]} to ${STATUS_TEXT[newStatus]}`, by: teacherName(), at: now }),
    });
  } catch (err) { state.saveError = true; render(); }
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
    logToSheet({ recordType: "Incident", action: "Follow-up added", studentName: it?.studentName || "", details: note, loggedBy: teacherName() });
    render();
  } catch (err) { state.saveError = true; render(); }
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
  } catch (err) { state.saveError = true; render(); }
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
  } catch (err) { state.saveError = true; render(); }
}
function openEditIncident(id) { state.editingIncidentId = id; render(); }
async function submitEditIncident(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingIncidentId;
  const it = state.incidents.find((i) => i.id === id);
  if (!it) return;
  const updated = {
    studentName: f.studentName.value.trim(),
    studentClass: f.studentClass.value,
    date: f.date.value,
    issue: f.issue.value.trim(),
    actionTaken: f.actionTaken.value.trim(),
  };
  if (!updated.studentName || !updated.studentClass || !updated.issue || !updated.actionTaken) return;
  const changes = diffText(it, updated, [
    { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
    { key: "date", label: "Date" }, { key: "issue", label: "Issue" }, { key: "actionTaken", label: "Action taken" },
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
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}

// ==================== SUSPENSIONS (new unified per-day model) ====================
function freshSuspDraft() {
  return {
    studentName: "", studentClass: "", reason: "", startDate: todayISO(),
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [],
    issVenue: "", issDifferentVenues: false, issVenues: {},
  };
}
function regenerateSuspDates(d) {
  const total = (d.ossDays || 0) + (d.issDays || 0);
  if (!total) { d.ossDates = []; d.issDates = []; return d; }
  const chain = schoolDayChain(d.startDate || todayISO(), total);
  d.ossDates = chain.slice(0, d.ossDays || 0);
  d.issDates = chain.slice(d.ossDays || 0);
  return d;
}

async function submitNewSuspension(e) {
  e.preventDefault();
  const f = e.target;
  const d = state._suspDraft;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const reason = f.reason.value.trim();
  if (!studentName || !studentClass || !reason || !d.totalDays) return;
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: d.issDifferentVenues ? (d.issVenues[date] || "") : d.issVenue,
  }));
  const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const docRef = await addDoc(collection(db, "suspensions"), {
      studentName, studentClass, reason, startDate: d.startDate,
      totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays,
      days,
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      history: [{ id: uid(), type: "created", detail: `Suspension created — ${d.totalDays} day${d.totalDays > 1 ? "s" : ""} total (${d.ossDays} out-of-school, ${d.issDays} in-school)`, by: teacherName(), at: now }],
    });
    state.showNewSuspForm = false;
    state._suspDraft = null;
    state.selectedSuspId = docRef.id;
    const dayList = days.map((x) => `${formatDateShort(x.date)}:${x.type}${x.venue ? `@${x.venue}` : ""}`).join(", ");
    logToSheet({ recordType: "Suspension", action: "Created", studentName, details: `Class: ${studentClass} — ${dayList} — ${reason}`, loggedBy: teacherName() });
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
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
  } catch (err) { state.saveError = true; render(); }
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
  } catch (err) { state.saveError = true; render(); }
}
function openEditSuspension(id) {
  const s = state.suspensions.find((i) => i.id === id);
  if (!s) return;
  state.editingSuspensionId = id;
  const entries = suspensionDayEntries(s);
  const ossDates = entries.filter((x) => x.type === "OSS").map((x) => x.date).sort();
  const issEntries = entries.filter((x) => x.type === "ISS").sort((a, b) => a.date.localeCompare(b.date));
  const issDates = issEntries.map((x) => x.date);
  const issVenues = {};
  issEntries.forEach((x) => { issVenues[x.date] = x.venue || ""; });
  const uniqueVenues = [...new Set(Object.values(issVenues))];
  state._suspDraft = {
    studentName: s.studentName, studentClass: s.studentClass, reason: s.reason || "",
    startDate: s.startDate || (entries[0] && entries[0].date) || todayISO(),
    totalDays: s.totalDays || entries.length, issDays: issDates.length, ossDays: ossDates.length,
    ossDates, issDates,
    issVenue: uniqueVenues.length <= 1 ? (uniqueVenues[0] || "") : "",
    issDifferentVenues: uniqueVenues.length > 1, issVenues,
  };
  render();
}
async function submitEditSuspension(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingSuspensionId;
  const s = state.suspensions.find((i) => i.id === id);
  if (!s) return;
  const d = state._suspDraft;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const reason = f.reason.value.trim();
  if (!studentName || !studentClass || !reason || !d.totalDays) return;
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: d.issDifferentVenues ? (d.issVenues[date] || "") : d.issVenue,
  }));
  const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));
  const updated = { studentName, studentClass, reason, startDate: d.startDate, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days };
  const changes = diffText(s, updated, [
    { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
    { key: "reason", label: "Reason" }, { key: "totalDays", label: "Total days" },
  ]);
  const oldDaysKey = JSON.stringify(suspensionDayEntries(s));
  const newDaysKey = JSON.stringify(days);
  if (oldDaysKey !== newDaysKey) changes.push("Day-by-day schedule updated");
  if (changes.length === 0) { state.editingSuspensionId = null; state._suspDraft = null; render(); return; }
  const now = Date.now();
  state.saving = true;
  render();
  try {
    await updateDoc(doc(db, "suspensions", id), {
      ...updated,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Suspension edited — ${changes.join("; ")}`, by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "Suspension", action: "Edited", studentName, details: changes.join("; "), loggedBy: teacherName() });
    state.editingSuspensionId = null;
    state._suspDraft = null;
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}

// ==================== PARENT MEETINGS ====================
function freshPmDraft() { return { attendees: [], othersText: "" }; }
async function submitNewParentMeeting(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const reason = f.reason.value.trim();
  const attendees = state._pmDraft.attendees.slice();
  const othersText = state._pmDraft.othersText.trim();
  if (!studentName || !studentClass || !date || !reason || attendees.length === 0) return;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const attendeeSummaryStr = attendees.map((a) => a === "Others" && othersText ? `Others (${othersText})` : a).join(", ");
    const docRef = await addDoc(collection(db, "parentMeetings"), {
      studentName, studentClass, date, reason, attendees, othersText,
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      history: [{ id: uid(), type: "created", detail: `Meeting logged — attendees: ${attendeeSummaryStr}`, by: teacherName(), at: now }],
    });
    state.showNewPmForm = false;
    state._pmDraft = null;
    state.selectedPmId = docRef.id;
    logToSheet({ recordType: "ParentMeeting", action: "Created", studentName, details: `Class: ${studentClass} — ${formatDateShort(date)} — Attendees: ${attendeeSummaryStr} — ${reason}`, loggedBy: teacherName() });
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}
function openEditParentMeeting(id) {
  const m = state.parentMeetings.find((i) => i.id === id);
  if (!m) return;
  state.editingPmId = id;
  state._pmDraft = { attendees: (m.attendees || []).slice(), othersText: m.othersText || "" };
  render();
}
async function submitEditParentMeeting(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingPmId;
  const m = state.parentMeetings.find((i) => i.id === id);
  if (!m) return;
  const updated = {
    studentName: f.studentName.value.trim(), studentClass: f.studentClass.value,
    date: f.date.value, reason: f.reason.value.trim(),
    attendees: state._pmDraft.attendees.slice(), othersText: state._pmDraft.othersText.trim(),
  };
  if (!updated.studentName || !updated.studentClass || !updated.date || !updated.reason || updated.attendees.length === 0) return;
  const changes = diffText(m, updated, [
    { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
    { key: "date", label: "Date" }, { key: "reason", label: "Reason" },
  ]);
  if (JSON.stringify((m.attendees || []).slice().sort()) !== JSON.stringify(updated.attendees.slice().sort())) changes.push("Attendees updated");
  if (changes.length === 0) { state.editingPmId = null; state._pmDraft = null; render(); return; }
  const now = Date.now();
  state.saving = true;
  render();
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      ...updated,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Meeting edited — ${changes.join("; ")}`, by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "ParentMeeting", action: "Edited", studentName: updated.studentName, details: changes.join("; "), loggedBy: teacherName() });
    state.editingPmId = null;
    state._pmDraft = null;
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}
async function deleteParentMeeting(id) {
  if (!askDeletePassword()) return;
  const m = state.parentMeetings.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      deleted: true, deletedAt: now, deletedBy: teacherName(),
      history: arrayUnion({ id: uid(), type: "deleted", detail: "Meeting removed", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "ParentMeeting", action: "Removed", studentName: m?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) { state.saveError = true; render(); }
}
async function restoreParentMeeting(id) {
  const m = state.parentMeetings.find((i) => i.id === id);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      deleted: false,
      history: arrayUnion({ id: uid(), type: "restored", detail: "Meeting restored", by: teacherName(), at: now }),
    });
    logToSheet({ recordType: "ParentMeeting", action: "Restored", studentName: m?.studentName || "", details: "", loggedBy: teacherName() });
  } catch (err) { state.saveError = true; render(); }
}

// ==================== RENDER ====================
function render() {
  if (!state.authReady) { root.innerHTML = `<div class="dd-center"><div class="dd-mono">Opening the log…</div></div>`; return; }
  if (!state.teacherName) { root.innerHTML = renderNameScreen(); attachNameListeners(); return; }
  if (!state.dataLoaded || !state.suspLoaded || !state.pmLoaded) { root.innerHTML = `<div class="dd-center"><div class="dd-mono">Loading entries…</div></div>`; return; }
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
function attachNameListeners() { document.getElementById("name-form").addEventListener("submit", handleNameSubmit); }

function renderMain() {
  if (state.section === "dashboard") return renderDashboardSection();
  if (state.section === "log") return renderLogSection();
  if (state.section === "suspensions") return renderSuspensionSection();
  return renderParentMeetingSection();
}

function renderNav() {
  const items = [
    { key: "log", label: "Discipline Log" },
    { key: "suspensions", label: "Suspension Log" },
    { key: "parentMeetings", label: "Parent Meeting" },
  ];
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
        <div style="display:flex;gap:6px;width:100%;align-items:center">
          <button class="dd-circle-btn dd-nav-home ${state.section === "dashboard" ? "active" : ""}" data-action="set-section" data-section="dashboard" title="Dashboard">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h14V10"></path></svg>
          </button>
          ${items.map((it) => `<button class="dd-pill-tab dd-pill-tab-sm ${state.section === it.key ? "active" : ""}" data-action="set-section" data-section="${it.key}">${it.label}</button>`).join("")}
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
          <div class="dd-help-heading">Dashboard</div>
          <p>The home icon shows overall trends — who's been named most often, current counts, and who's in ISS/OSS today and over the next 2 days.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Discipline Log</div>
          <p>Status: <b>Open</b> (not yet actioned), <b>In Progress</b> (action taken, still watching), <b>Resolved</b> (closed). Pick an entry from the dropdown to view, edit, follow up, or remove it.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Suspension Log</div>
          <p>Set the total number of days, then how many are in-school vs out-of-school — the other side calculates itself. Pick the actual dates for each, and a location for in-school days. One suspension can mix in-school and out-of-school days in a single entry.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Parent Meeting</div>
          <p>Log who attended (multiple people allowed) and why. "Others" lets you type in a specific relationship.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Editing, removing, backups</div>
          <p>Every entry can be edited — changes are tracked in its audit trail. Removing asks for a password and only hides the entry; find it under "Deleted" to restore. The backup icon (top right) downloads everything as a file.</p>
        </div>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:14px">Version ${APP_VERSION}</div>
      </div>
    </div>`;
}

// ---------- Dashboard ----------
function renderDashboardSection() {
  const activeIncidents = state.incidents.filter((i) => !i.deleted);
  const activeSusp = state.suspensions.filter((s) => !s.deleted);
  const activePm = state.parentMeetings.filter((m) => !m.deleted);

  const dCounts = { Open: 0, Monitoring: 0, Resolved: 0 };
  activeIncidents.forEach((i) => { if (dCounts[i.status] !== undefined) dCounts[i.status]++; });

  const namedCounts = {};
  activeIncidents.forEach((i) => { namedCounts[i.studentName] = namedCounts[i.studentName] || { discipline: 0, suspension: 0 }; namedCounts[i.studentName].discipline++; });
  activeSusp.forEach((s) => { namedCounts[s.studentName] = namedCounts[s.studentName] || { discipline: 0, suspension: 0 }; namedCounts[s.studentName].suspension++; });
  const trend = Object.entries(namedCounts)
    .map(([name, c]) => ({ name, ...c, total: c.discipline + c.suspension }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
          <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
        </div>
        <div class="dd-grid2" style="margin-bottom:16px">
          <div class="dd-panel" style="text-align:center">
            <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase">Open discipline entries</div>
            <div class="dd-serif" style="font-size:30px;font-weight:700;color:#A3372B">${dCounts.Open}</div>
          </div>
          <div class="dd-panel" style="text-align:center">
            <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase">Active suspensions</div>
            <div class="dd-serif" style="font-size:30px;font-weight:700;color:#B8863B">${activeSusp.filter((s) => suspensionStatus(s) === "Active").length}</div>
          </div>
        </div>

        <div style="margin-bottom:16px">
          ${renderDashboardBox("ISS", "In-School Suspension", "#B8863B")}
          <div style="height:12px"></div>
          ${renderDashboardBox("OSS", "Out of School Suspension", "#A3372B")}
        </div>

        <div class="dd-panel">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px">Most named students</div>
          ${trend.length === 0 ? `<div class="dd-dash-empty">No entries logged yet.</div>` : `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${trend.map((t) => `
              <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #E4E1D4;padding-bottom:6px">
                <span class="dd-sans" style="font-size:14px">${escapeHtml(truncateName(t.name, 22))}</span>
                <span class="dd-mono-muted" style="font-size:12px">${t.discipline} discipline · ${t.suspension} suspension</span>
              </div>`).join("")}
          </div>`}
        </div>

        <div class="dd-panel" style="margin-top:16px">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:8px">Parent meetings</div>
          <div class="dd-mono-muted" style="font-size:12px">${activePm.length} logged in total</div>
        </div>
      </div>
    </div>`;
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
  const dayGroupHtml = (students) => {
    if (students.length === 0) return "";
    if (type !== "ISS") return students.map(studentRowHtml).join("");
    const groups = {};
    students.forEach((s) => { const loc = s._venue || "(no location set)"; (groups[loc] = groups[loc] || []).push(s); });
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
          <div class="dd-dash-list">${todayList.length === 0 ? `<div class="dd-dash-empty">None</div>` : dayGroupHtml(todayList)}</div>
        </div>
        <div class="dd-dash-col">
          <div class="dd-mono-muted dd-dash-col-label">Next 2 Days</div>
          <div class="dd-dash-list">
            ${nextDays.every((d) => d.students.length === 0) ? `<div class="dd-dash-empty">None</div>` : nextDays.map((d) => d.students.length === 0 ? "" : `
              <div class="dd-dash-date">${formatDate(d.date)}</div>
              ${dayGroupHtml(d.students)}
            `).join("")}
          </div>
        </div>
      </div>
    </div>`;
}

// ---------- Discipline Log ----------
function filteredIncidents() {
  let list = state.incidents;
  if (state.tab === "Deleted") list = list.filter((it) => it.deleted);
  else {
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
  state.incidents.forEach((it) => { if (it.deleted) { c.Deleted++; return; } if (c[it.status] !== undefined) c[it.status]++; });
  return c;
}

function renderLogSection() {
  const list = filteredIncidents();
  const c = counts();
  if (state.selectedIncidentId && !list.some((it) => it.id === state.selectedIncidentId)) state.selectedIncidentId = list[0]?.id || null;
  if (!state.selectedIncidentId && list.length) state.selectedIncidentId = list[0].id;
  const selected = list.find((it) => it.id === state.selectedIncidentId);
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
          ${list.length === 0 ? `<div class="dd-empty">${state.incidents.length === 0 ? "No entries yet. Log the first discipline issue to start the record." : "No entries match this filter."}</div>` : `
          <label class="dd-label">Select an entry (${list.length})</label>
          <select class="dd-input dd-entry-select" id="incident-select">
            ${list.map((it) => `<option value="${it.id}" ${it.id === state.selectedIncidentId ? "selected" : ""}>${escapeHtml(it.studentName)} — ${formatDateShort(it.date)} — ${escapeHtml(truncateName(it.issue, 30))}</option>`).join("")}
          </select>
          ${selected ? renderIncidentDetail(selected) : ""}`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save the last change. Check your connection and try again.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
    </div>`;
}

function renderIncidentDetail(it) {
  const s = STATUS_STYLE[it.status];
  const followUps = it.followUps || [];
  const history = it.history || [];
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(it.studentName)}</div>
          <div class="dd-card-meta">${formatDate(it.date)}${it.studentClass ? ` · Class ${escapeHtml(it.studentClass)}` : ""} · logged by ${escapeHtml(it.loggedBy)}</div>
        </div>
        <span class="dd-stamp-subtle" style="color:${s.ink}">${s.label}</span>
      </div>
      <div class="dd-grid2" style="margin:12px 0">
        <div><div class="dd-field-label">Issue</div><div class="dd-field-value">${escapeHtml(it.issue)}</div></div>
        <div><div class="dd-field-label">Action taken</div><div class="dd-field-value">${escapeHtml(it.actionTaken)}</div></div>
      </div>
      <div class="dd-status-row">
        <span class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-right:4px">Status:</span>
        ${STATUSES.map((st) => `<button class="dd-stamp" data-action="set-status" data-id="${it.id}" data-status="${st}" data-current="${it.status}" style="color:${STATUS_STYLE[st].ink};opacity:${it.status === st ? 1 : 0.35}">${STATUS_STYLE[st].label}</button>`).join("")}
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Follow-up thread</div>
      <div class="dd-followups">
        ${followUps.length === 0 ? `<div class="dd-sans" style="font-size:14px;font-style:italic;color:#8A8571">No follow-ups logged yet.</div>` : followUps.map((fu) => `<div class="dd-followup"><div class="dd-followup-note">${escapeHtml(fu.note)}</div><div class="dd-followup-meta">${formatDate(fu.date)} · ${escapeHtml(fu.by)}</div></div>`).join("")}
      </div>
      <div class="dd-followup-form">
        <input class="dd-input dd-followup-input" data-action="follow-input" data-id="${it.id}" placeholder="Add a follow-up note…" value="${escapeHtml(state.followDraft[it.id] || "")}" />
        <button class="dd-add-btn" data-action="add-followup" data-id="${it.id}">Add</button>
      </div>
      <button class="dd-history-toggle" data-action="toggle-history" data-id="${it.id}">${state.historyOpen[it.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[it.id] ? `<div class="dd-history">${history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${it.deleted
          ? `<div class="dd-mono-muted" style="font-size:11px">Removed by ${escapeHtml(it.deletedBy || "")} on ${formatDateTime(it.deletedAt)}</div>
             <button class="dd-add-btn" data-action="restore-incident" data-id="${it.id}">Restore entry</button>`
          : `<button class="dd-add-btn" data-action="edit-incident" data-id="${it.id}">Edit entry</button>
             <button class="dd-add-btn" style="background:#A3372B" data-action="delete-incident" data-id="${it.id}">Remove entry</button>`}
      </div>
    </div>`;
}

function classOptionsHtml(selected) {
  return `<option value="">Select class…</option>` + CLASS_OPTIONS.map((c) => `<option value="${c}" ${c === selected ? "selected" : ""}>${c}</option>`).join("");
}

function renderNewForm() {
  const st = state._newStatus || "Open";
  return `
    <div class="dd-modal-backdrop" id="modal-backdrop">
      <form class="dd-modal" id="new-form">
        <div class="dd-modal-head"><div class="dd-modal-title">New entry</div><button type="button" class="dd-modal-close" id="modal-close">✕</button></div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml("")}</select>
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${todayISO()}" />
        <label class="dd-label">Issue</label>
        <textarea class="dd-textarea dd-input" name="issue" rows="3" required placeholder="What happened?"></textarea>
        <label class="dd-label">Action taken <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="actionTaken" rows="2" required placeholder="What was done in response?"></textarea>
        <label class="dd-label">Status</label>
        <div class="dd-status-row">
          ${STATUSES.map((s) => `<button type="button" class="dd-stamp" data-action="pick-new-status" data-status="${s}" style="color:${STATUS_STYLE[s].ink};opacity:${st === s ? 1 : 0.35}">${STATUS_STYLE[s].label}</button>`).join("")}
        </div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save entry"}</button>
      </form>
    </div>`;
}
function renderEditIncidentForm() {
  const it = state.incidents.find((i) => i.id === state.editingIncidentId);
  if (!it) return "";
  return `
    <div class="dd-modal-backdrop" id="edit-modal-backdrop">
      <form class="dd-modal" id="edit-form">
        <div class="dd-modal-head"><div class="dd-modal-title">Edit entry</div><button type="button" class="dd-modal-close" id="edit-modal-close">✕</button></div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(it.studentName)}" />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(it.studentClass || "")}</select>
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${it.date}" />
        <label class="dd-label">Issue</label>
        <textarea class="dd-textarea dd-input" name="issue" rows="3" required>${escapeHtml(it.issue)}</textarea>
        <label class="dd-label">Action taken <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="actionTaken" rows="2" required>${escapeHtml(it.actionTaken || "")}</textarea>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save changes"}</button>
      </form>
    </div>`;
}

// ---------- Suspension Log ----------
function filteredSuspensions() {
  let list = state.suspensions.map((s) => ({ ...s, _status: suspensionStatus(s) }));
  if (state.suspTab === "Deleted") list = list.filter((s) => s.deleted);
  else {
    list = list.filter((s) => !s.deleted);
    if (state.suspTab !== "All") list = list.filter((s) => s._status === state.suspTab);
  }
  if (state.suspQuery.trim()) {
    const q = state.suspQuery.trim().toLowerCase();
    list = list.filter((s) => s.studentName.toLowerCase().includes(q));
  }
  const order = { Active: 0, Upcoming: 1, Completed: 2 };
  return list.sort((a, b) => (order[a._status] ?? 3) - (order[b._status] ?? 3) || (b.startDate || "").localeCompare(a.startDate || ""));
}
function suspCounts() {
  const c = { Upcoming: 0, Active: 0, Completed: 0, Deleted: 0 };
  state.suspensions.forEach((s) => { if (s.deleted) { c.Deleted++; return; } c[suspensionStatus(s)]++; });
  return c;
}

function renderSuspensionSection() {
  const list = filteredSuspensions();
  const c = suspCounts();
  if (state.selectedSuspId && !list.some((s) => s.id === state.selectedSuspId)) state.selectedSuspId = list[0]?.id || null;
  if (!state.selectedSuspId && list.length) state.selectedSuspId = list[0].id;
  const selected = list.find((s) => s.id === state.selectedSuspId);
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
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
          ${list.length === 0 ? `<div class="dd-empty">${state.suspensions.length === 0 ? "No suspensions logged yet." : "No entries match this filter."}</div>` : `
          <label class="dd-label">Select an entry (${list.length})</label>
          <select class="dd-input dd-entry-select" id="susp-select">
            ${list.map((s) => `<option value="${s.id}" ${s.id === state.selectedSuspId ? "selected" : ""}>${escapeHtml(s.studentName)} — ${formatDateShort(s.startDate)} — ${escapeHtml(truncateName(s.reason || "", 30))}</option>`).join("")}
          </select>
          ${selected ? renderSuspensionDetail(selected) : ""}`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save the last change. Check your connection and try again.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.editingSuspensionId ? renderSuspForm(true) : ""}
    </div>`;
}

function renderSuspensionDetail(s) {
  const statusStyle = s.deleted ? { ink: "#8A8571", label: "REMOVED" } : SUSP_STATUS_STYLE[suspensionStatus(s)];
  const entries = suspensionDayEntries(s).slice().sort((a, b) => a.date.localeCompare(b.date));
  const typeSummary = suspensionTypeSummary(s);
  const history = s.history || [];
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(s.studentName)}</div>
          <div class="dd-card-meta">${s.startDate ? formatDate(s.startDate) : ""}${s.studentClass ? ` · Class ${escapeHtml(s.studentClass)}` : ""} · logged by ${escapeHtml(s.loggedBy)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="dd-stamp-subtle" style="color:${typeSummary === "Mixed" ? "#4C6B8A" : SUSP_TYPE_STYLE[typeSummary].ink}">${typeSummary === "Mixed" ? "MIXED" : SUSP_TYPE_STYLE[typeSummary].label}</span>
          <span class="dd-stamp-subtle" style="color:${statusStyle.ink}">${statusStyle.label}</span>
        </div>
      </div>
      <div style="margin:12px 0">
        <div class="dd-field-label">Reason</div>
        <div class="dd-field-value">${escapeHtml(s.reason || "")}</div>
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Day-by-day (${entries.length} day${entries.length === 1 ? "" : "s"})</div>
      <div class="dd-followups" style="margin-bottom:16px">
        ${entries.map((e) => `<div class="dd-followup"><div class="dd-followup-note">${SUSP_TYPE_STYLE[e.type].label}${e.type === "ISS" && e.venue ? ` — ${escapeHtml(e.venue)}` : ""}</div><div class="dd-followup-meta">${formatDate(e.date)}</div></div>`).join("")}
      </div>
      <button class="dd-history-toggle" data-action="toggle-susp-history" data-id="${s.id}">${state.historyOpen[s.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[s.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="font-style:italic;color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${s.deleted
          ? `<div class="dd-mono-muted" style="font-size:11px">Removed by ${escapeHtml(s.deletedBy || "")} on ${formatDateTime(s.deletedAt)}</div>
             <button class="dd-add-btn" data-action="restore-suspension" data-id="${s.id}">Restore</button>`
          : `<button class="dd-add-btn" data-action="edit-suspension" data-id="${s.id}">Edit entry</button>
             <button class="dd-add-btn" style="background:#A3372B" data-action="delete-suspension" data-id="${s.id}">Remove</button>`}
      </div>
    </div>`;
}

function renderSuspForm(isEdit) {
  const d = state._suspDraft;
  const totalOptions = Array.from({ length: 14 }, (_, i) => i + 1);
  const dayCountOptions = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const showDatePickers = d.totalDays && (d.issDays + d.ossDays === d.totalDays) && (d.ossDates.length === d.ossDays) && (d.issDates.length === d.issDays);
  return `
    <div class="dd-modal-backdrop" id="susp-modal-backdrop">
      <form class="dd-modal" id="susp-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${isEdit ? "Edit suspension" : "New suspension"}</div>
          <button type="button" class="dd-modal-close" id="susp-modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(d.studentClass)}</select>
        <label class="dd-label">Reason <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="reason" rows="2" required>${escapeHtml(d.reason)}</textarea>
        <label class="dd-label">Start date (used to suggest default days)</label>
        <input class="dd-input" type="date" id="susp-start-date" value="${d.startDate}" />

        <label class="dd-label">Total days of suspension</label>
        <select class="dd-input" id="susp-total-days">
          <option value="">Select total days…</option>
          ${totalOptions.map((n) => `<option value="${n}" ${d.totalDays === n ? "selected" : ""}>${n} day${n > 1 ? "s" : ""}</option>`).join("")}
        </select>

        ${d.totalDays ? `
        <div class="dd-grid2" style="margin-top:10px">
          <div>
            <label class="dd-label">In-school days</label>
            <select class="dd-input" id="susp-iss-days">
              ${dayCountOptions(d.totalDays).map((n) => `<option value="${n}" ${d.issDays === n ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="dd-label">Out-of-school days</label>
            <select class="dd-input" id="susp-oss-days">
              ${dayCountOptions(d.totalDays).map((n) => `<option value="${n}" ${d.ossDays === n ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
        </div>` : ""}

        ${showDatePickers && d.ossDays > 0 ? `
        <label class="dd-label" style="margin-top:12px">Out-of-school dates</label>
        <div id="oss-date-rows">
          ${d.ossDates.map((dt, i) => `
            <div class="dd-venue-row">
              <span class="dd-venue-date">${formatDate(dt)}</span>
              <input type="date" class="dd-oss-date-input" data-idx="${i}" value="${dt}" title="Change this day's date" />
            </div>`).join("")}
        </div>` : ""}

        ${showDatePickers && d.issDays > 0 ? `
        <label class="dd-label" style="margin-top:12px">In-school dates</label>
        <div id="iss-date-rows">
          ${d.issDates.map((dt, i) => `
            <div class="dd-venue-row">
              <span class="dd-venue-date">${formatDate(dt)}</span>
              <input type="date" class="dd-iss-date-input" data-idx="${i}" value="${dt}" title="Change this day's date" />
            </div>`).join("")}
        </div>
        <label class="dd-label" style="margin-top:10px">In-school location</label>
        <select class="dd-input" name="issVenue" style="${d.issDifferentVenues ? "display:none" : ""}">
          <option value="">Select location…</option>
          ${LOCATION_OPTIONS.map((loc) => `<option value="${loc}" ${d.issVenue === loc ? "selected" : ""}>${loc}</option>`).join("")}
        </select>
        <label style="display:flex;align-items:center;gap:6px;margin-top:${d.issDifferentVenues ? "0" : "8px"};cursor:pointer">
          <input type="checkbox" id="susp-diff-venues" ${d.issDifferentVenues ? "checked" : ""} />
          <span class="dd-mono-muted" style="font-size:12px">Different location each day</span>
        </label>
        ${d.issDifferentVenues ? `
        <div id="iss-venue-rows" style="margin-top:8px">
          ${d.issDates.map((dt) => `
            <div class="dd-venue-row">
              <span class="dd-venue-date">${formatDate(dt)}</span>
              <select class="dd-input dd-iss-venue-select" data-date="${dt}">
                <option value="">Select location…</option>
                ${LOCATION_OPTIONS.map((loc) => `<option value="${loc}" ${d.issVenues[dt] === loc ? "selected" : ""}>${loc}</option>`).join("")}
              </select>
            </div>`).join("")}
        </div>` : ""}` : ""}

        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save suspension"}</button>
      </form>
    </div>`;
}

// ---------- Parent Meeting ----------
function filteredParentMeetings() {
  let list = state.parentMeetings;
  if (state.pmTab === "Deleted") list = list.filter((m) => m.deleted);
  else list = list.filter((m) => !m.deleted);
  if (state.pmQuery.trim()) {
    const q = state.pmQuery.trim().toLowerCase();
    list = list.filter((m) => m.studentName.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}
function pmCounts() {
  let deleted = 0, active = 0;
  state.parentMeetings.forEach((m) => { if (m.deleted) deleted++; else active++; });
  return { active, deleted };
}

function renderParentMeetingSection() {
  const list = filteredParentMeetings();
  const c = pmCounts();
  if (state.selectedPmId && !list.some((m) => m.id === state.selectedPmId)) state.selectedPmId = list[0]?.id || null;
  if (!state.selectedPmId && list.length) state.selectedPmId = list[0].id;
  const selected = list.find((m) => m.id === state.selectedPmId);
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
          <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="dd-pill ${state.pmTab === "Deleted" ? "active" : ""}" data-action="set-pm-tab" data-tab="Deleted">Deleted (${c.deleted})</button>
            <button class="dd-newbtn" id="btn-new-pm">+ New meeting</button>
          </div>
        </div>
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="pm-search-input" placeholder="Search by student name…" value="${escapeHtml(state.pmQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.parentMeetings.length === 0 ? "No parent meetings logged yet." : "No entries match this filter."}</div>` : `
          <label class="dd-label">Select an entry (${list.length})</label>
          <select class="dd-input dd-entry-select" id="pm-select">
            ${list.map((m) => `<option value="${m.id}" ${m.id === state.selectedPmId ? "selected" : ""}>${escapeHtml(m.studentName)} — ${formatDateShort(m.date)} — ${escapeHtml(truncateName(m.reason || "", 30))}</option>`).join("")}
          </select>
          ${selected ? renderParentMeetingDetail(selected) : ""}`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save the last change. Check your connection and try again.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewPmForm ? renderPmForm(false) : ""}
      ${state.editingPmId ? renderPmForm(true) : ""}
    </div>`;
}

function attendeeSummary(m) {
  return (m.attendees || []).map((a) => a === "Others" && m.othersText ? `Others (${m.othersText})` : a).join(", ");
}

function renderParentMeetingDetail(m) {
  const history = m.history || [];
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(m.studentName)}</div>
          <div class="dd-card-meta">${formatDate(m.date)}${m.studentClass ? ` · Class ${escapeHtml(m.studentClass)}` : ""} · logged by ${escapeHtml(m.loggedBy)}</div>
        </div>
      </div>
      <div class="dd-grid2" style="margin:12px 0">
        <div><div class="dd-field-label">Attendees</div><div class="dd-field-value">${escapeHtml(attendeeSummary(m))}</div></div>
        <div><div class="dd-field-label">Reason for meeting</div><div class="dd-field-value">${escapeHtml(m.reason || "")}</div></div>
      </div>
      <button class="dd-history-toggle" data-action="toggle-pm-history" data-id="${m.id}">${state.historyOpen[m.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[m.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="font-style:italic;color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${m.deleted
          ? `<div class="dd-mono-muted" style="font-size:11px">Removed by ${escapeHtml(m.deletedBy || "")} on ${formatDateTime(m.deletedAt)}</div>
             <button class="dd-add-btn" data-action="restore-pm" data-id="${m.id}">Restore</button>`
          : `<button class="dd-add-btn" data-action="edit-pm" data-id="${m.id}">Edit entry</button>
             <button class="dd-add-btn" style="background:#A3372B" data-action="delete-pm" data-id="${m.id}">Remove</button>`}
      </div>
    </div>`;
}

function renderPmForm(isEdit) {
  const m = isEdit ? state.parentMeetings.find((i) => i.id === state.editingPmId) : null;
  const d = state._pmDraft;
  return `
    <div class="dd-modal-backdrop" id="pm-modal-backdrop">
      <form class="dd-modal" id="pm-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${isEdit ? "Edit meeting" : "New parent meeting"}</div>
          <button type="button" class="dd-modal-close" id="pm-modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(m?.studentName || "")}" />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(m?.studentClass || "")}</select>
        <label class="dd-label">Who is attending?</label>
        <div class="dd-checkbox-group">
          ${ATTENDEE_OPTIONS.map((a) => `
            <label class="dd-checkbox-pill">
              <input type="checkbox" class="dd-attendee-cb" value="${a}" ${d.attendees.includes(a) ? "checked" : ""} />
              <span>${a}</span>
            </label>`).join("")}
        </div>
        ${d.attendees.includes("Others") ? `
        <label class="dd-label">Specify "Others"</label>
        <input class="dd-input" id="pm-others-text" value="${escapeHtml(d.othersText)}" placeholder="e.g. Aunt" />` : ""}
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${m?.date || todayISO()}" />
        <label class="dd-label">Reason for meeting <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="reason" rows="3" required>${escapeHtml(m?.reason || "")}</textarea>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save meeting"}</button>
      </form>
    </div>`;
}

// ==================== LISTENERS ====================
function attachMainListeners() {
  document.querySelectorAll('[data-action="set-section"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = el.dataset.section; render(); }));

  document.getElementById("btn-backup").addEventListener("click", downloadBackupFile);

  const helpBtn = document.getElementById("btn-help");
  if (helpBtn) helpBtn.addEventListener("click", () => { state.showHelp = true; render(); });
  if (state.showHelp) {
    document.getElementById("help-modal-close").addEventListener("click", () => { state.showHelp = false; render(); });
    document.getElementById("help-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "help-modal-backdrop") { state.showHelp = false; render(); }
    });
  }

  if (state.section === "log") attachLogListeners();
  else if (state.section === "suspensions") attachSuspListeners();
  else if (state.section === "parentMeetings") attachPmListeners();
}

function attachLogListeners() {
  document.getElementById("btn-new").addEventListener("click", () => { state.showNewForm = true; state._newStatus = "Open"; render(); });

  document.querySelectorAll('[data-action="set-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.tab = el.dataset.tab; state.selectedIncidentId = null; render(); }));

  const search = document.getElementById("search-input");
  if (search) search.addEventListener("input", () => {
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  const sel = document.getElementById("incident-select");
  if (sel) sel.addEventListener("change", () => { state.selectedIncidentId = sel.value; render(); });

  document.querySelectorAll('[data-action="set-status"]').forEach((el) =>
    el.addEventListener("click", () => updateStatus(el.dataset.id, el.dataset.status, el.dataset.current)));
  document.querySelectorAll('[data-action="follow-input"]').forEach((el) =>
    el.addEventListener("input", () => { state.followDraft[el.dataset.id] = el.value; }));
  document.querySelectorAll('[data-action="add-followup"]').forEach((el) =>
    el.addEventListener("click", () => addFollowUp(el.dataset.id)));
  document.querySelectorAll('[data-action="toggle-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));
  document.querySelectorAll('[data-action="delete-incident"]').forEach((el) =>
    el.addEventListener("click", () => deleteIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-incident"]').forEach((el) =>
    el.addEventListener("click", () => restoreIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-incident"]').forEach((el) =>
    el.addEventListener("click", () => openEditIncident(el.dataset.id)));

  if (state.showNewForm) {
    document.getElementById("new-form").addEventListener("submit", submitNewIncident);
    document.getElementById("modal-close").addEventListener("click", () => { state.showNewForm = false; render(); });
    document.getElementById("modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") { state.showNewForm = false; render(); } });
    document.querySelectorAll('[data-action="pick-new-status"]').forEach((el) =>
      el.addEventListener("click", () => { state._newStatus = el.dataset.status; render(); }));
  }
  if (state.editingIncidentId) {
    document.getElementById("edit-form").addEventListener("submit", submitEditIncident);
    document.getElementById("edit-modal-close").addEventListener("click", () => { state.editingIncidentId = null; render(); });
    document.getElementById("edit-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "edit-modal-backdrop") { state.editingIncidentId = null; render(); } });
  }
}

function attachSuspListeners() {
  document.getElementById("btn-new-susp").addEventListener("click", () => {
    state.showNewSuspForm = true;
    state.editingSuspensionId = null;
    state._suspDraft = freshSuspDraft();
    render();
  });

  document.querySelectorAll('[data-action="set-susp-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.suspTab = el.dataset.tab; state.selectedSuspId = null; render(); }));

  const search = document.getElementById("susp-search-input");
  if (search) search.addEventListener("input", () => {
    state.suspQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("susp-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  const sel = document.getElementById("susp-select");
  if (sel) sel.addEventListener("change", () => { state.selectedSuspId = sel.value; render(); });

  document.querySelectorAll('[data-action="delete-suspension"]').forEach((el) =>
    el.addEventListener("click", () => deleteSuspension(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-suspension"]').forEach((el) =>
    el.addEventListener("click", () => restoreSuspension(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-suspension"]').forEach((el) =>
    el.addEventListener("click", () => { openEditSuspension(el.dataset.id); state.showNewSuspForm = false; }));
  document.querySelectorAll('[data-action="toggle-susp-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));

  if (state.showNewSuspForm || state.editingSuspensionId) {
    const form = document.getElementById("susp-form");
    form.addEventListener("submit", state.editingSuspensionId ? submitEditSuspension : submitNewSuspension);
    document.getElementById("susp-modal-close").addEventListener("click", () => { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); });
    document.getElementById("susp-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "susp-modal-backdrop") { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); }
    });

    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._suspDraft[name] = el.value; }); };
    syncField("studentName"); syncField("reason");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._suspDraft.studentClass = classEl.value; });
    const venueEl = form.elements["issVenue"];
    if (venueEl) venueEl.addEventListener("change", () => { state._suspDraft.issVenue = venueEl.value; });

    const startDateEl = document.getElementById("susp-start-date");
    if (startDateEl) startDateEl.addEventListener("change", () => {
      state._suspDraft.startDate = startDateEl.value;
      regenerateSuspDates(state._suspDraft);
      render();
    });

    const totalEl = document.getElementById("susp-total-days");
    if (totalEl) totalEl.addEventListener("change", () => {
      const total = parseInt(totalEl.value, 10) || null;
      state._suspDraft.totalDays = total;
      if (total) {
        if (state._suspDraft.issDays + state._suspDraft.ossDays !== total) {
          state._suspDraft.issDays = total;
          state._suspDraft.ossDays = 0;
        }
        regenerateSuspDates(state._suspDraft);
      } else {
        state._suspDraft.ossDates = []; state._suspDraft.issDates = [];
      }
      render();
    });

    const issEl = document.getElementById("susp-iss-days");
    if (issEl) issEl.addEventListener("change", () => {
      const n = parseInt(issEl.value, 10) || 0;
      state._suspDraft.issDays = n;
      state._suspDraft.ossDays = state._suspDraft.totalDays - n;
      regenerateSuspDates(state._suspDraft);
      render();
    });
    const ossEl = document.getElementById("susp-oss-days");
    if (ossEl) ossEl.addEventListener("change", () => {
      const n = parseInt(ossEl.value, 10) || 0;
      state._suspDraft.ossDays = n;
      state._suspDraft.issDays = state._suspDraft.totalDays - n;
      regenerateSuspDates(state._suspDraft);
      render();
    });

    form.querySelectorAll(".dd-oss-date-input").forEach((el) =>
      el.addEventListener("change", () => { state._suspDraft.ossDates[parseInt(el.dataset.idx, 10)] = el.value; render(); }));
    form.querySelectorAll(".dd-iss-date-input").forEach((el) =>
      el.addEventListener("change", () => { state._suspDraft.issDates[parseInt(el.dataset.idx, 10)] = el.value; render(); }));
    form.querySelectorAll(".dd-iss-venue-select").forEach((el) =>
      el.addEventListener("change", () => { state._suspDraft.issVenues[el.dataset.date] = el.value; }));

    const diffEl = document.getElementById("susp-diff-venues");
    if (diffEl) diffEl.addEventListener("change", () => {
      state._suspDraft.issDifferentVenues = diffEl.checked;
      if (diffEl.checked) {
        state._suspDraft.issDates.forEach((dt) => { if (!state._suspDraft.issVenues[dt]) state._suspDraft.issVenues[dt] = state._suspDraft.issVenue; });
      }
      render();
    });
  }
}

function attachPmListeners() {
  document.getElementById("btn-new-pm").addEventListener("click", () => {
    state.showNewPmForm = true;
    state.editingPmId = null;
    state._pmDraft = freshPmDraft();
    render();
  });

  const search = document.getElementById("pm-search-input");
  if (search) search.addEventListener("input", () => {
    state.pmQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("pm-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  const sel = document.getElementById("pm-select");
  if (sel) sel.addEventListener("change", () => { state.selectedPmId = sel.value; render(); });

  document.querySelectorAll('[data-action="delete-pm"]').forEach((el) =>
    el.addEventListener("click", () => deleteParentMeeting(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-pm"]').forEach((el) =>
    el.addEventListener("click", () => restoreParentMeeting(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-pm"]').forEach((el) =>
    el.addEventListener("click", () => { openEditParentMeeting(el.dataset.id); state.showNewPmForm = false; }));
  document.querySelectorAll('[data-action="toggle-pm-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));

  if (state.showNewPmForm || state.editingPmId) {
    const form = document.getElementById("pm-form");
    form.addEventListener("submit", state.editingPmId ? submitEditParentMeeting : submitNewParentMeeting);
    document.getElementById("pm-modal-close").addEventListener("click", () => { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); });
    document.getElementById("pm-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "pm-modal-backdrop") { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); }
    });
    form.querySelectorAll(".dd-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const v = cb.value;
        if (cb.checked) { if (!state._pmDraft.attendees.includes(v)) state._pmDraft.attendees.push(v); }
        else { state._pmDraft.attendees = state._pmDraft.attendees.filter((a) => a !== v); }
        render();
      }));
    const othersEl = document.getElementById("pm-others-text");
    if (othersEl) othersEl.addEventListener("input", () => { state._pmDraft.othersText = othersEl.value; });
  }
}

render();
