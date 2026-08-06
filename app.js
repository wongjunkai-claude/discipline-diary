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

const APP_VERSION = "2.9.0";
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

// Builds the full current state of a record and sends it to the linked
// Google Sheet as one upsert — the Apps Script finds the existing row by ID
// and overwrites it, or appends a new row if it's not there yet. This is
// called after every change (create, edit, status change, follow-up,
// delete/restore) so the Sheet always reflects the record's current state,
// with all follow-ups accumulated into one cell rather than one row each.
function formatFollowUpsForSheet(followUps) {
  return (followUps || []).map((fu) => `${formatDate(fu.date)}: ${fu.note}`).join("\n");
}
function formatScheduleForSheet(days) {
  return (days || []).slice().sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => `${formatDate(d.date)} (${SUSP_TYPE_STYLE[d.type].label}${d.type === "ISS" && d.venue ? ` - ${d.venue}` : ""})`).join("\n");
}
function formatAttendeesForSheet(attendees, othersText) {
  return (attendees || []).map((a) => a === "Others" && othersText ? `Others (${othersText})` : a).join(", ");
}
function syncIncidentToSheet(it) {
  logToSheet({
    recordType: "Incident", id: it.id,
    studentName: it.studentName, studentClass: it.studentClass, date: it.date,
    issue: it.issue, actionTaken: it.actionTaken,
    status: (it.deleted ? "Removed — " : "") + (STATUS_TEXT[it.status] || it.status || ""),
    followUpsText: formatFollowUpsForSheet(it.followUps),
    loggedBy: it.loggedBy,
  });
}
function syncSuspensionToSheet(s) {
  logToSheet({
    recordType: "Suspension", id: s.id,
    studentName: s.studentName, studentClass: s.studentClass,
    reason: (s.deleted ? "Removed — " : "") + (s.reason || ""),
    startDate: s.startDate, totalDays: s.totalDays, issDays: s.issDays, ossDays: s.ossDays,
    scheduleText: formatScheduleForSheet(s.days),
    loggedBy: s.loggedBy,
  });
}
function syncParentMeetingToSheet(m) {
  logToSheet({
    recordType: "ParentMeeting", id: m.id,
    studentName: m.studentName, studentClass: m.studentClass,
    attendeesText: formatAttendeesForSheet(m.attendees, m.othersText),
    date: m.date,
    reason: (m.deleted ? "Removed — " : "") + (m.reason || ""),
    loggedBy: m.loggedBy,
  });
}

// ---------- Constants ----------
// "Open" removed as a selectable status — new entries default straight to
// "In Progress" (internally "Monitoring", kept for backward compatibility
// with existing data). STATUS_STYLE/STATUS_TEXT still map Open for display,
// so any pre-existing "Open" entries keep rendering correctly.
const STATUSES = ["Monitoring", "Resolved"];
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
  Upcoming: { ink: "#D98F2B", label: "UPCOMING" },
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
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTH_ABBR[m - 1]} ${y}`;
}
function formatDateShort(iso) {
  if (!iso) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")} ${MONTH_ABBR[m - 1]}`;
}
function formatDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const datePart = `${String(d.getDate()).padStart(2, "0")} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
  const timePart = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
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
  query: "",
  incidentSortBy: "date",
  disciplineFilter: "all", // 'all' | 'Monitoring' | 'Resolved'
  viewDeletedIncidents: false,
  selectedIncidentId: null,
  showNewForm: false,
  editingIncidentId: null,
  historyOpen: {},
  followDraft: {},
  editingFollowUpId: null,
  followEditDraft: {},

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
  pmFormError: "",

  showNewCaseFlow: false,
  newCaseStep: "discipline",
  _newCaseDraft: null,
  caseFormError: "",

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
function freshIncidentDraft() {
  return { studentName: "", studentClass: "", date: todayISO(), issue: "", actionTaken: "", status: "Monitoring", linkedSuspensionIds: [], linkedPmIds: [] };
}
function findRelatedRecords(studentName) {
  const name = (studentName || "").trim().toLowerCase();
  if (!name) return { suspensions: [], parentMeetings: [] };
  return {
    suspensions: state.suspensions.filter((s) => !s.deleted && s.studentName.trim().toLowerCase() === name),
    parentMeetings: state.parentMeetings.filter((m) => !m.deleted && m.studentName.trim().toLowerCase() === name),
  };
}

// ---------- New Case wizard: Discipline -> Suspension? -> Parent Meeting? -> Submit ----------
function freshNewCaseDraft() {
  return {
    studentName: "", studentClass: "", date: todayISO(), issue: "", actionTaken: "", status: "Monitoring",
    wantsSuspension: null, suspDraft: freshSuspDraft(),
    wantsPm: null, pmDraft: freshPmDraft(),
  };
}
function newCaseStepValid(step, d) {
  if (step === "discipline") return !!(d.studentName.trim() && d.studentClass && d.issue.trim() && d.actionTaken.trim());
  if (step === "ask-suspension") return d.wantsSuspension !== null;
  if (step === "suspension") return !!(d.suspDraft.reason.trim() && d.suspDraft.totalDays && d.suspDraft.issDays + d.suspDraft.ossDays === d.suspDraft.totalDays);
  if (step === "ask-pm") return d.wantsPm !== null;
  if (step === "pm") return !!(d.pmDraft.attendees.length && d.pmDraft.reason.trim());
  return true;
}
function newCaseStepErrorMessage(step, d) {
  if (step === "discipline") return "Fill in student name, class, issue, and action taken before continuing.";
  if (step === "ask-suspension") return "Choose Yes or No.";
  if (step === "suspension") {
    if (!d.suspDraft.reason.trim()) return "Enter a reason before continuing.";
    if (!d.suspDraft.totalDays) return "Choose the total number of days.";
    return "In-school and out-of-school days must add up to the total.";
  }
  if (step === "ask-pm") return "Choose Yes or No.";
  if (step === "pm") {
    if (!d.pmDraft.attendees.length) return "Select at least one attendee before continuing.";
    return "Enter a reason for the meeting before continuing.";
  }
  return "";
}
function newCaseNextStep(step, d) {
  if (step === "discipline") return "ask-suspension";
  if (step === "ask-suspension") return d.wantsSuspension ? "suspension" : "ask-pm";
  if (step === "suspension") return "ask-pm";
  if (step === "ask-pm") return d.wantsPm ? "pm" : "submit";
  if (step === "pm") return "submit";
  return "submit";
}
function newCasePrevStep(step, d) {
  if (step === "ask-suspension") return "discipline";
  if (step === "suspension") return "ask-suspension";
  if (step === "ask-pm") return d.wantsSuspension ? "suspension" : "ask-suspension";
  if (step === "pm") return "ask-pm";
  if (step === "submit") return d.wantsPm ? "pm" : "ask-pm";
  return "discipline";
}
async function submitNewCase() {
  const d = state._newCaseDraft;
  if (!newCaseStepValid("discipline", d)) {
    state.newCaseStep = "discipline"; state.caseFormError = newCaseStepErrorMessage("discipline", d); render(); return;
  }
  if (d.wantsSuspension && !newCaseStepValid("suspension", d)) {
    state.newCaseStep = "suspension"; state.caseFormError = newCaseStepErrorMessage("suspension", d); render(); return;
  }
  if (d.wantsPm && !newCaseStepValid("pm", d)) {
    state.newCaseStep = "pm"; state.caseFormError = newCaseStepErrorMessage("pm", d); render(); return;
  }
  state.caseFormError = "";
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const incidentPayload = {
      studentName: d.studentName.trim(), studentClass: d.studentClass, date: d.date,
      issue: d.issue.trim(), actionTaken: d.actionTaken.trim(), status: d.status,
      linkedSuspensionIds: [], linkedPmIds: [],
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      followUps: [],
      history: [{ id: uid(), type: "created", detail: `Entry created — status set to ${STATUS_TEXT[d.status]}`, by: teacherName(), at: now }],
    };
    let suspId = null, pmId = null;

    if (d.wantsSuspension) {
      const sd = d.suspDraft;
      const ossEntries = sd.ossDates.map((date) => ({ date, type: "OSS" }));
      const issEntries = sd.issDates.map((date) => ({ date, type: "ISS", venue: sd.issDifferentVenues ? (sd.issVenues[date] || "") : sd.issVenue }));
      const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));
      const suspRef = await addDoc(collection(db, "suspensions"), {
        studentName: d.studentName.trim(), studentClass: d.studentClass, reason: sd.reason.trim(), startDate: sd.startDate,
        totalDays: sd.totalDays, issDays: sd.issDays, ossDays: sd.ossDays, days,
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `Suspension created — ${sd.totalDays} day${sd.totalDays > 1 ? "s" : ""} total (${sd.ossDays} out-of-school, ${sd.issDays} in-school)`, by: teacherName(), at: now }],
      });
      suspId = suspRef.id;
      incidentPayload.linkedSuspensionIds = [suspId];
      syncSuspensionToSheet({ id: suspId, studentName: d.studentName.trim(), studentClass: d.studentClass, reason: sd.reason.trim(), startDate: sd.startDate, totalDays: sd.totalDays, issDays: sd.issDays, ossDays: sd.ossDays, days, loggedBy: teacherName() });
    }

    if (d.wantsPm) {
      const pd = d.pmDraft;
      const pmRef = await addDoc(collection(db, "parentMeetings"), {
        studentName: d.studentName.trim(), studentClass: d.studentClass, date: d.date,
        reason: pd.reason.trim(), attendees: pd.attendees.slice(), othersText: pd.othersText.trim(),
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `Meeting logged — attendees: ${formatAttendeesForSheet(pd.attendees, pd.othersText)}`, by: teacherName(), at: now }],
      });
      pmId = pmRef.id;
      incidentPayload.linkedPmIds = [pmId];
      syncParentMeetingToSheet({ id: pmId, studentName: d.studentName.trim(), studentClass: d.studentClass, date: d.date, reason: pd.reason.trim(), attendees: pd.attendees, othersText: pd.othersText, loggedBy: teacherName() });
    }

    const incidentRef = await addDoc(collection(db, "incidents"), incidentPayload);

    if (suspId) {
      await updateDoc(doc(db, "suspensions", suspId), {
        linkedIncidentIds: arrayUnion(incidentRef.id),
        history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to discipline entry: "${d.issue.trim()}"`, by: teacherName(), at: now }),
      });
    }
    if (pmId) {
      await updateDoc(doc(db, "parentMeetings", pmId), {
        linkedIncidentIds: arrayUnion(incidentRef.id),
        history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to discipline entry: "${d.issue.trim()}"`, by: teacherName(), at: now }),
      });
    }

    syncIncidentToSheet({ id: incidentRef.id, ...incidentPayload });
    state.showNewCaseFlow = false;
    state._newCaseDraft = null;
    state.newCaseStep = "discipline";
    state.section = "log";
    state.selectedIncidentId = incidentRef.id;
  } catch (err) {
    state.saveError = true;
  } finally {
    state.saving = false;
    render();
  }
}
async function submitNewIncident(e) {
  e.preventDefault();
  const f = e.target;
  const d = state._newIncidentDraft;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const issue = f.issue.value.trim();
  const actionTaken = f.actionTaken.value.trim();
  const status = d.status || "Open";
  if (!studentName || !studentClass || !issue || !actionTaken) return;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const docRef = await addDoc(collection(db, "incidents"), {
      studentName, studentClass, date, issue, actionTaken, status,
      linkedSuspensionIds: d.linkedSuspensionIds.slice(),
      linkedPmIds: d.linkedPmIds.slice(),
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      followUps: [],
      history: [{ id: uid(), type: "created", detail: `Entry created — status set to ${STATUS_TEXT[status]}`, by: teacherName(), at: now }],
    });
    // Reflect the link on the other side too, so it shows up on the
    // suspension/meeting record itself, not just this new entry.
    for (const sId of d.linkedSuspensionIds) {
      try {
        await updateDoc(doc(db, "suspensions", sId), {
          linkedIncidentIds: arrayUnion(docRef.id),
          history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to discipline entry: "${issue}"`, by: teacherName(), at: now }),
        });
      } catch (err) { /* non-fatal, main entry already saved */ }
    }
    for (const mId of d.linkedPmIds) {
      try {
        await updateDoc(doc(db, "parentMeetings", mId), {
          linkedIncidentIds: arrayUnion(docRef.id),
          history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to discipline entry: "${issue}"`, by: teacherName(), at: now }),
        });
      } catch (err) { /* non-fatal */ }
    }
    state.showNewForm = false;
    state._newIncidentDraft = null;
    state.selectedIncidentId = docRef.id;
    syncIncidentToSheet({ id: docRef.id, studentName, studentClass, date, issue, actionTaken, status, followUps: [], loggedBy: teacherName(), deleted: false });
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
    if (it) syncIncidentToSheet({ ...it, status: newStatus });
  } catch (err) { state.saveError = true; render(); }
}
async function addFollowUp(id) {
  const note = (state.followDraft[id] || "").trim();
  if (!note) return;
  const now = Date.now();
  const it = state.incidents.find((i) => i.id === id);
  const newFu = { id: uid(), date: todayISO(), note, by: teacherName() };
  try {
    await updateDoc(doc(db, "incidents", id), {
      followUps: arrayUnion(newFu),
      history: arrayUnion({ id: uid(), type: "followup", detail: `Follow-up added: "${note}"`, by: teacherName(), at: now }),
    });
    state.followDraft[id] = "";
    if (it) syncIncidentToSheet({ ...it, followUps: [...(it.followUps || []), newFu] });
    render();
  } catch (err) { state.saveError = true; render(); }
}
function openEditFollowUp(incidentId, followUpId) {
  const it = state.incidents.find((i) => i.id === incidentId);
  const fu = it?.followUps?.find((f) => f.id === followUpId);
  if (!fu) return;
  state.editingFollowUpId = followUpId;
  state.followEditDraft = { [followUpId]: fu.note };
  render();
}
function cancelEditFollowUp() {
  state.editingFollowUpId = null;
  render();
}
async function submitEditFollowUp(incidentId, followUpId) {
  const it = state.incidents.find((i) => i.id === incidentId);
  const fu = it?.followUps?.find((f) => f.id === followUpId);
  if (!it || !fu) return;
  const newNote = (state.followEditDraft[followUpId] || "").trim();
  if (!newNote) return;
  if (newNote === fu.note) { state.editingFollowUpId = null; render(); return; }
  const updatedFollowUps = it.followUps.map((f) => f.id === followUpId ? { ...f, note: newNote, editedAt: Date.now(), editedBy: teacherName() } : f);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", incidentId), {
      followUps: updatedFollowUps,
      history: arrayUnion({ id: uid(), type: "followup-edited", detail: `Follow-up edited — changed from "${fu.note}" to "${newNote}"`, by: teacherName(), at: now }),
    });
    syncIncidentToSheet({ ...it, followUps: updatedFollowUps });
    state.editingFollowUpId = null;
  } catch (err) { state.saveError = true; } finally { render(); }
}
async function deleteFollowUp(incidentId, followUpId) {
  const it = state.incidents.find((i) => i.id === incidentId);
  const fu = it?.followUps?.find((f) => f.id === followUpId);
  if (!it || !fu) return;
  if (!confirm(`Remove this follow-up note?\n\n"${fu.note}"`)) return;
  const updatedFollowUps = it.followUps.filter((f) => f.id !== followUpId);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", incidentId), {
      followUps: updatedFollowUps,
      history: arrayUnion({ id: uid(), type: "followup-removed", detail: `Follow-up removed — "${fu.note}"`, by: teacherName(), at: now }),
    });
    syncIncidentToSheet({ ...it, followUps: updatedFollowUps });
  } catch (err) { state.saveError = true; } finally { render(); }
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
    if (it) syncIncidentToSheet({ ...it, deleted: true });
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
    if (it) syncIncidentToSheet({ ...it, deleted: false });
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
    syncIncidentToSheet({ ...it, ...updated });
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
  d.issDates = chain.slice(0, d.issDays || 0);
  d.ossDates = chain.slice(d.issDays || 0);
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
    syncSuspensionToSheet({ id: docRef.id, studentName, studentClass, reason, startDate: d.startDate, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days, loggedBy: teacherName(), deleted: false });
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
    if (s) syncSuspensionToSheet({ ...s, deleted: true });
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
    if (s) syncSuspensionToSheet({ ...s, deleted: false });
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
    syncSuspensionToSheet({ ...s, ...updated });
    state.editingSuspensionId = null;
    state._suspDraft = null;
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}

// ==================== PARENT MEETINGS ====================
function freshPmDraft(m) {
  return {
    studentName: m?.studentName || "", studentClass: m?.studentClass || "",
    date: m?.date || todayISO(), reason: m?.reason || "",
    attendees: (m?.attendees || []).slice(), othersText: m?.othersText || "",
  };
}
async function submitNewParentMeeting(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const reason = f.reason.value.trim();
  const attendees = state._pmDraft.attendees.slice();
  const othersText = state._pmDraft.othersText.trim();
  if (!studentName || !studentClass || !date || !reason || attendees.length === 0) {
    state.pmFormError = attendees.length === 0 ? "Select at least one attendee before saving." : "Fill in every required field before saving.";
    render();
    return;
  }
  state.pmFormError = "";
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
    syncParentMeetingToSheet({ id: docRef.id, studentName, studentClass, date, reason, attendees, othersText, loggedBy: teacherName(), deleted: false });
  } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
}
function openEditParentMeeting(id) {
  const m = state.parentMeetings.find((i) => i.id === id);
  if (!m) return;
  state.editingPmId = id;
  state._pmDraft = freshPmDraft(m);
  state.pmFormError = "";
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
  if (!updated.studentName || !updated.studentClass || !updated.date || !updated.reason || updated.attendees.length === 0) {
    state.pmFormError = updated.attendees.length === 0 ? "Select at least one attendee before saving." : "Fill in every required field before saving.";
    render();
    return;
  }
  state.pmFormError = "";
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
    syncParentMeetingToSheet({ ...m, ...updated });
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
    if (m) syncParentMeetingToSheet({ ...m, deleted: true });
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
    if (m) syncParentMeetingToSheet({ ...m, deleted: false });
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
function monthKey(iso) { return iso ? iso.slice(0, 7) : null; }
function monthLabelFromKey(key) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${y}`;
}
function lastNMonthKeys(n = 11) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function computeMonthlyTrend() {
  const keys = lastNMonthKeys(11);
  const counts = {};
  keys.forEach((k) => { counts[k] = { discipline: 0, suspension: 0, parentMeeting: 0 }; });
  state.incidents.forEach((i) => { if (i.deleted) return; const k = monthKey(i.date); if (counts[k]) counts[k].discipline++; });
  state.suspensions.forEach((s) => { if (s.deleted) return; const k = monthKey(s.startDate); if (counts[k]) counts[k].suspension++; });
  state.parentMeetings.forEach((m) => { if (m.deleted) return; const k = monthKey(m.date); if (counts[k]) counts[k].parentMeeting++; });
  return keys.map((k) => ({ key: k, label: monthLabelFromKey(k), ...counts[k] }));
}
const CHART_COLORS = { discipline: "#1B2A41", suspension: "#B8863B", parentMeeting: "#3C6E47" };
function niceAxisMax(v) {
  if (v <= 5) return Math.max(v, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)));
  const residual = v / magnitude;
  let niceResidual;
  if (residual <= 1) niceResidual = 1;
  else if (residual <= 2) niceResidual = 2;
  else if (residual <= 5) niceResidual = 5;
  else niceResidual = 10;
  return niceResidual * magnitude;
}
function renderMonthlyChart() {
  const data = computeMonthlyTrend();
  const incl = {
    discipline: state.chartIncludeDiscipline !== false,
    suspension: state.chartIncludeSuspension !== false,
    parentMeeting: state.chartIncludeParentMeeting !== false,
  };
  const cats = [];
  if (incl.discipline) cats.push({ key: "discipline", label: "Discipline" });
  if (incl.suspension) cats.push({ key: "suspension", label: "Suspension" });
  if (incl.parentMeeting) cats.push({ key: "parentMeeting", label: "Parent Meeting" });
  const rawMax = Math.max(1, ...data.flatMap((d) => cats.map((c) => d[c.key])));
  const axisMax = niceAxisMax(rawMax);
  const pct = (v) => Math.max(v > 0 ? 3 : 0, Math.round((v / axisMax) * 100));
  const ticks = [0, axisMax * 0.25, axisMax * 0.5, axisMax * 0.75, axisMax].map((n) => Math.round(n));
  return `
    <div class="dd-panel" style="margin-top:16px">
      <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px">Monthly trend</div>
      <div class="dd-chart-toggles">
        <label class="dd-checkbox-pill"><input type="checkbox" id="chart-toggle-discipline" ${incl.discipline ? "checked" : ""} /><span style="color:${CHART_COLORS.discipline}">■ Discipline</span></label>
        <label class="dd-checkbox-pill"><input type="checkbox" id="chart-toggle-suspension" ${incl.suspension ? "checked" : ""} /><span style="color:${CHART_COLORS.suspension}">■ Suspension</span></label>
        <label class="dd-checkbox-pill"><input type="checkbox" id="chart-toggle-pm" ${incl.parentMeeting ? "checked" : ""} /><span style="color:${CHART_COLORS.parentMeeting}">■ Parent Meeting</span></label>
      </div>
      <div class="dd-chart-hrow" style="margin-bottom:10px">
        <span class="dd-chart-dot" style="background:transparent"></span>
        <div class="dd-chart-axis-track">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
        <span class="dd-chart-hval"></span>
      </div>
      <div class="dd-chart-rows">
        ${data.map((d) => {
          const total = cats.reduce((sum, c) => sum + d[c.key], 0);
          return `
          <div class="dd-chart-row-block">
            <div class="dd-chart-row-header">
              <span class="dd-chart-row-month">${d.label}</span>
              <span class="dd-chart-row-total">${total}</span>
            </div>
            ${cats.map((c) => `
              <div class="dd-chart-hrow">
                <span class="dd-chart-dot" style="background:${CHART_COLORS[c.key]}"></span>
                <div class="dd-chart-hbar-track">
                  <div class="dd-chart-hbar" style="width:${pct(d[c.key])}%;background:${CHART_COLORS[c.key]}"></div>
                </div>
                <span class="dd-chart-hval">${d[c.key]}</span>
              </div>`).join("")}
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

// ---------- New Case wizard rendering ----------
function renderNewCaseModal() {
  const d = state._newCaseDraft;
  const step = state.newCaseStep;
  const stepTitles = { discipline: "Discipline", "ask-suspension": "Suspension?", suspension: "Suspension details", "ask-pm": "Parent Meeting?", pm: "Parent Meeting details", submit: "Review & submit" };
  return `
    <div class="dd-modal-backdrop" id="case-modal-backdrop">
      <form class="dd-modal" id="case-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">New Case — ${stepTitles[step]}</div>
          <button type="button" class="dd-modal-close" id="case-modal-close">✕</button>
        </div>
        ${renderNewCaseStepBody(step, d)}
      </form>
    </div>`;
}
function renderNewCaseStepBody(step, d) {
  if (step === "discipline") {
    return `
      <label class="dd-label">Student name</label>
      <input class="dd-input" id="case-student-name" required value="${escapeHtml(d.studentName)}" />
      <label class="dd-label">Class</label>
      <select class="dd-input" id="case-student-class" required>${classOptionsHtml(d.studentClass)}</select>
      <label class="dd-label">Date</label>
      <input class="dd-input" type="date" id="case-date" required value="${d.date}" />
      <label class="dd-label">Issue</label>
      <textarea class="dd-textarea dd-input" id="case-issue" rows="3" required placeholder="What happened?">${escapeHtml(d.issue)}</textarea>
      <label class="dd-label">Action taken <span style="color:#A3372B">*</span></label>
      <textarea class="dd-textarea dd-input" id="case-action-taken" rows="2" required placeholder="What was done in response?">${escapeHtml(d.actionTaken)}</textarea>
      <label class="dd-label">Status</label>
      <div class="dd-status-row">
        ${STATUSES.map((s) => `<button type="button" class="dd-stamp" data-action="case-pick-status" data-status="${s}" style="color:${STATUS_STYLE[s].ink};opacity:${d.status === s ? 1 : 0.35}">${STATUS_STYLE[s].label}</button>`).join("")}
      </div>
      ${renderNewCaseNav("discipline", d)}`;
  }
  if (step === "ask-suspension") {
    return `
      <div class="dd-case-prompt">Is there an In-School or Out-of-School Suspension linked to this?</div>
      <div class="dd-case-yesno">
        <button type="button" class="dd-stamp" data-action="case-set-wants-susp" data-value="true" style="color:#3C6E47;opacity:${d.wantsSuspension === true ? 1 : 0.35}">YES</button>
        <button type="button" class="dd-stamp" data-action="case-set-wants-susp" data-value="false" style="color:#A3372B;opacity:${d.wantsSuspension === false ? 1 : 0.35}">NO</button>
      </div>
      ${renderNewCaseNav("ask-suspension", d)}`;
  }
  if (step === "suspension") {
    return `
      <div class="dd-mono-muted" style="font-size:12px;margin-bottom:10px">For ${escapeHtml(d.studentName)}, Class ${escapeHtml(d.studentClass)}</div>
      ${renderSuspFieldsBody(d.suspDraft, "case-susp")}
      ${renderNewCaseNav("suspension", d)}`;
  }
  if (step === "ask-pm") {
    return `
      <div class="dd-case-prompt">Is there a Parent's Meeting linked to this?</div>
      <div class="dd-case-yesno">
        <button type="button" class="dd-stamp" data-action="case-set-wants-pm" data-value="true" style="color:#3C6E47;opacity:${d.wantsPm === true ? 1 : 0.35}">YES</button>
        <button type="button" class="dd-stamp" data-action="case-set-wants-pm" data-value="false" style="color:#A3372B;opacity:${d.wantsPm === false ? 1 : 0.35}">NO</button>
      </div>
      ${renderNewCaseNav("ask-pm", d)}`;
  }
  if (step === "pm") {
    return `
      <div class="dd-mono-muted" style="font-size:12px;margin-bottom:10px">For ${escapeHtml(d.studentName)}, Class ${escapeHtml(d.studentClass)}</div>
      <label class="dd-label">Who is attending? <span style="color:#A3372B">*</span></label>
      <div class="dd-checkbox-group">
        ${ATTENDEE_OPTIONS.map((a) => `
          <label class="dd-checkbox-pill">
            <input type="checkbox" class="dd-case-pm-attendee-cb" value="${a}" ${d.pmDraft.attendees.includes(a) ? "checked" : ""} />
            <span>${a}</span>
          </label>`).join("")}
      </div>
      ${d.pmDraft.attendees.includes("Others") ? `
      <label class="dd-label">Specify "Others"</label>
      <input class="dd-input" id="case-pm-others-text" value="${escapeHtml(d.pmDraft.othersText)}" placeholder="e.g. Aunt" />` : ""}
      <label class="dd-label">Reason for meeting <span style="color:#A3372B">*</span></label>
      <textarea class="dd-textarea dd-input" id="case-pm-reason" rows="3" required>${escapeHtml(d.pmDraft.reason)}</textarea>
      ${renderNewCaseNav("pm", d)}`;
  }
  // submit
  return `
    <div class="dd-mono-muted" style="font-size:12px;margin-bottom:10px">Ready to save for ${escapeHtml(d.studentName)}, Class ${escapeHtml(d.studentClass)}:</div>
    <ul style="margin:0 0 16px;padding-left:20px;font-family:'IBM Plex Sans',sans-serif;font-size:14px;color:#1B2A41">
      <li>Discipline entry — ${escapeHtml(truncateName(d.issue, 40))}</li>
      ${d.wantsSuspension ? `<li>Suspension — ${d.suspDraft.totalDays} day${d.suspDraft.totalDays > 1 ? "s" : ""} (${d.suspDraft.ossDays} out-of-school, ${d.suspDraft.issDays} in-school)</li>` : ""}
      ${d.wantsPm ? `<li>Parent Meeting — ${escapeHtml(formatAttendeesForSheet(d.pmDraft.attendees, d.pmDraft.othersText))}</li>` : ""}
    </ul>
    ${renderNewCaseNav("submit", d)}`;
}
function renderNewCaseNav(step, d) {
  const isLast = step === "submit";
  return `
    ${state.caseFormError ? `<div class="dd-error" style="margin-top:12px">${escapeHtml(state.caseFormError)}</div>` : ""}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
      ${step !== "discipline" ? `<button type="button" class="dd-case-back-btn" data-action="case-back">← Back</button>` : `<span></span>`}
      ${isLast
        ? `<button type="button" class="dd-btn-primary" style="width:auto;margin-top:0" id="case-submit-btn" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Submit"}</button>`
        : `<button type="button" class="dd-btn-primary" style="width:auto;margin-top:0" data-action="case-next">Continue →</button>`}
    </div>`;
}

function renderDashboardSection() {
  const activeIncidents = state.incidents.filter((i) => !i.deleted);
  const activeSusp = state.suspensions.filter((s) => !s.deleted);
  const activePm = state.parentMeetings.filter((m) => !m.deleted);

  const dCounts = { Open: 0, Monitoring: 0, Resolved: 0 };
  activeIncidents.forEach((i) => { if (dCounts[i.status] !== undefined) dCounts[i.status]++; });

  const namedCounts = {};
  const namedClass = {};
  activeIncidents.forEach((i) => {
    namedCounts[i.studentName] = namedCounts[i.studentName] || { discipline: 0, suspension: 0 };
    namedCounts[i.studentName].discipline++;
    namedClass[i.studentName] = i.studentClass || namedClass[i.studentName];
  });
  activeSusp.forEach((s) => {
    namedCounts[s.studentName] = namedCounts[s.studentName] || { discipline: 0, suspension: 0 };
    namedCounts[s.studentName].suspension++;
    namedClass[s.studentName] = s.studentClass || namedClass[s.studentName];
  });
  const trend = Object.entries(namedCounts)
    .map(([name, c]) => ({ name, studentClass: namedClass[name] || "", ...c, total: c.discipline + c.suspension }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px">
          <button class="dd-newbtn" id="btn-new-case">+ New Entry</button>
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

        ${renderMonthlyChart()}

        <div class="dd-panel" style="margin-top:16px">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px">Most named students</div>
          ${trend.length === 0 ? `<div class="dd-dash-empty">No entries logged yet.</div>` : `
          <div style="display:flex;flex-direction:column;gap:8px">
            ${trend.map((t) => `
              <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #E4E1D4;padding-bottom:6px">
                <div>
                  <div class="dd-sans" style="font-size:14px">${escapeHtml(truncateName(t.name))}</div>
                  ${t.studentClass ? `<div class="dd-mono-muted" style="font-size:11px;margin-top:2px">Class ${escapeHtml(t.studentClass)}</div>` : ""}
                </div>
                <span class="dd-mono-muted" style="font-size:12px;text-align:right;flex-shrink:0;margin-left:8px">${t.discipline} discipline · ${t.suspension} suspension</span>
              </div>`).join("")}
          </div>`}
        </div>

        <div class="dd-panel" style="margin-top:16px">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:8px">Parent meetings</div>
          <div class="dd-mono-muted" style="font-size:12px">${activePm.length} logged in total</div>
        </div>
      </div>
      ${state.showNewCaseFlow ? renderNewCaseModal() : ""}
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
function classLevel(cls) {
  const m = /^P(\d+)/.exec(cls || "");
  return m ? parseInt(m[1], 10) : 999;
}
function filteredIncidents() {
  let list = state.incidents.filter((it) => (state.viewDeletedIncidents ? it.deleted : !it.deleted));
  if (!state.viewDeletedIncidents && state.disciplineFilter && state.disciplineFilter !== "all") {
    list = list.filter((it) => it.status === state.disciplineFilter);
  }
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    list = list.filter((it) => it.studentName.toLowerCase().includes(q));
  }
  const sortBy = state.incidentSortBy || "date";
  const sorted = [...list];
  if (sortBy === "name") sorted.sort((a, b) => a.studentName.localeCompare(b.studentName));
  else if (sortBy === "class") sorted.sort((a, b) => (a.studentClass || "").localeCompare(b.studentClass || ""));
  else if (sortBy === "level") sorted.sort((a, b) => classLevel(a.studentClass) - classLevel(b.studentClass) || (a.studentClass || "").localeCompare(b.studentClass || ""));
  else sorted.sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  return sorted;
}
function counts() {
  const c = { Open: 0, Monitoring: 0, Resolved: 0, Deleted: 0 };
  state.incidents.forEach((it) => { if (it.deleted) { c.Deleted++; return; } if (c[it.status] !== undefined) c[it.status]++; });
  return c;
}

function renderLogSection() {
  const list = filteredIncidents();
  const c = counts();
  const sortBy = state.incidentSortBy || "date";
  const filter = state.disciplineFilter || "all";
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
          <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
          <button class="dd-pill ${state.viewDeletedIncidents ? "active" : ""}" id="btn-toggle-deleted-incidents">Deleted (${c.Deleted})</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button class="dd-pill ${filter === "all" ? "active" : ""}" data-action="set-discipline-filter" data-filter="all">Show All</button>
          <button class="dd-pill ${filter === "Monitoring" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Monitoring">In Progress (${c.Monitoring})</button>
          <button class="dd-pill ${filter === "Resolved" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Resolved">Resolved (${c.Resolved})</button>
        </div>
        <div style="margin-bottom:14px;max-width:220px">
          <label class="dd-label" style="margin-top:0">Sort by</label>
          <select class="dd-input" id="incident-sort-by">
            <option value="date" ${sortBy === "date" ? "selected" : ""}>Date (default)</option>
            <option value="name" ${sortBy === "name" ? "selected" : ""}>Name</option>
            <option value="class" ${sortBy === "class" ? "selected" : ""}>Class</option>
            <option value="level" ${sortBy === "level" ? "selected" : ""}>Level</option>
          </select>
        </div>
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="search-input" placeholder="Search by student name…" value="${escapeHtml(state.query)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.incidents.length === 0 ? "No entries yet. Log the first discipline issue to start the record." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderIncidentDetail).join("")}</div>`}
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
  const dotColor = it.status === "Resolved" ? "#3C6E47" : "#A3372B";
  const followUps = it.followUps || [];
  const history = it.history || [];
  const linkedSusp = (it.linkedSuspensionIds || []).map((id) => state.suspensions.find((x) => x.id === id)).filter(Boolean);
  const linkedPm = (it.linkedPmIds || []).map((id) => state.parentMeetings.find((x) => x.id === id)).filter(Boolean);
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(it.studentName)}</div>
          <div class="dd-card-meta">${formatDate(it.date)}${it.studentClass ? ` · Class ${escapeHtml(it.studentClass)}` : ""} · logged by ${escapeHtml(it.loggedBy)}</div>
        </div>
        <span class="dd-status-dot" style="background:${dotColor}" title="${escapeHtml(s.label)}"></span>
      </div>
      ${linkedSusp.length || linkedPm.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related records</div>
        ${linkedSusp.map((x) => `<div class="dd-related-link" data-action="jump-to-suspension" data-id="${x.id}">Suspension — ${formatDateShort(x.startDate)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
        ${linkedPm.map((x) => `<div class="dd-related-link" data-action="jump-to-pm" data-id="${x.id}">Parent Meeting — ${formatDateShort(x.date)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
      </div>` : ""}<div class="dd-grid2" style="margin:12px 0">
        <div><div class="dd-field-label">Issue</div><div class="dd-field-value">${escapeHtml(it.issue)}</div></div>
        <div><div class="dd-field-label">Action taken</div><div class="dd-field-value">${escapeHtml(it.actionTaken)}</div></div>
      </div>
      <div class="dd-status-row">
        <span class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-right:4px">Status:</span>
        ${STATUSES.map((st) => `<button class="dd-stamp" data-action="set-status" data-id="${it.id}" data-status="${st}" data-current="${it.status}" style="color:${STATUS_STYLE[st].ink};opacity:${it.status === st ? 1 : 0.35}">${STATUS_STYLE[st].label}</button>`).join("")}
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Follow-up thread</div>
      <div class="dd-followups">
        ${followUps.length === 0 ? `<div class="dd-sans" style="font-size:14px;font-style:italic;color:#8A8571">No follow-ups logged yet.</div>` : followUps.map((fu) => {
          if (state.editingFollowUpId === fu.id) {
            return `<div class="dd-followup">
              <div class="dd-followup-edit-row">
                <input class="dd-input dd-followup-edit-input" data-incident="${it.id}" data-fu="${fu.id}" value="${escapeHtml(state.followEditDraft[fu.id] ?? fu.note)}" />
                <button class="dd-add-btn" data-action="save-followup-edit" data-incident="${it.id}" data-fu="${fu.id}">Save</button>
                <button class="dd-followup-icon-btn" data-action="cancel-followup-edit" title="Cancel">✕</button>
              </div>
            </div>`;
          }
          return `<div class="dd-followup">
            <div class="dd-followup-row">
              <div style="flex:1;min-width:0">
                <div class="dd-followup-note">${escapeHtml(fu.note)}</div>
                <div class="dd-followup-meta">${formatDate(fu.date)} · ${escapeHtml(fu.by)}${fu.editedAt ? ` · edited ${formatDateTime(fu.editedAt)}` : ""}</div>
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0">
                <button class="dd-followup-icon-btn" data-action="edit-followup" data-incident="${it.id}" data-fu="${fu.id}" title="Edit">✎</button>
                <button class="dd-followup-icon-btn" data-action="delete-followup" data-incident="${it.id}" data-fu="${fu.id}" title="Remove">✕</button>
              </div>
            </div>
          </div>`;
        }).join("")}
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
  const d = state._newIncidentDraft;
  const related = findRelatedRecords(d.studentName);
  const hasRelated = related.suspensions.length > 0 || related.parentMeetings.length > 0;
  return `
    <div class="dd-modal-backdrop" id="modal-backdrop">
      <form class="dd-modal" id="new-form">
        <div class="dd-modal-head"><div class="dd-modal-title">New entry</div><button type="button" class="dd-modal-close" id="modal-close">✕</button></div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" id="new-incident-student-name" required value="${escapeHtml(d.studentName)}" />
        ${hasRelated ? `
        <div class="dd-related-box">
          <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related records found for ${escapeHtml(d.studentName)} — tick any to link</div>
          ${related.suspensions.map((s) => `
            <label class="dd-checkbox-pill" style="display:flex;margin-bottom:4px">
              <input type="checkbox" class="dd-link-susp-cb" value="${s.id}" ${d.linkedSuspensionIds.includes(s.id) ? "checked" : ""} />
              <span>Suspension — ${formatDateShort(s.startDate)} — ${escapeHtml(truncateName(s.reason || "", 30))}</span>
            </label>`).join("")}
          ${related.parentMeetings.map((m) => `
            <label class="dd-checkbox-pill" style="display:flex;margin-bottom:4px">
              <input type="checkbox" class="dd-link-pm-cb" value="${m.id}" ${d.linkedPmIds.includes(m.id) ? "checked" : ""} />
              <span>Parent Meeting — ${formatDateShort(m.date)} — ${escapeHtml(truncateName(m.reason || "", 30))}</span>
            </label>`).join("")}
        </div>` : ""}
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(d.studentClass)}</select>
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${d.date}" />
        <label class="dd-label">Issue</label>
        <textarea class="dd-textarea dd-input" name="issue" rows="3" required placeholder="What happened?">${escapeHtml(d.issue)}</textarea>
        <label class="dd-label">Action taken <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="actionTaken" rows="2" required placeholder="What was done in response?">${escapeHtml(d.actionTaken)}</textarea>
        <label class="dd-label">Status</label>
        <div class="dd-status-row">
          ${STATUSES.map((s) => `<button type="button" class="dd-stamp" data-action="pick-new-status" data-status="${s}" style="color:${STATUS_STYLE[s].ink};opacity:${d.status === s ? 1 : 0.35}">${STATUS_STYLE[s].label}</button>`).join("")}
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
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderSuspensionDetail).join("")}</div>`}
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
  const history = s.history || [];
  const linkedIncidents = (s.linkedIncidentIds || []).map((id) => state.incidents.find((x) => x.id === id)).filter(Boolean);
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(s.studentName)}</div>
          <div class="dd-card-meta">${s.startDate ? formatDate(s.startDate) : ""}${s.studentClass ? ` · Class ${escapeHtml(s.studentClass)}` : ""} · logged by ${escapeHtml(s.loggedBy)}</div>
        </div>
        <span class="dd-status-dot" style="background:${statusStyle.ink}" title="${escapeHtml(statusStyle.label)}"></span>
      </div>
      ${linkedIncidents.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related discipline entries</div>
        ${linkedIncidents.map((x) => `<div class="dd-related-link" data-action="jump-to-incident" data-id="${x.id}">${formatDateShort(x.date)} — ${escapeHtml(truncateName(x.issue || "", 30))}</div>`).join("")}
      </div>` : ""}
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

function renderSuspFieldsBody(d, idPrefix) {
  const totalOptions = Array.from({ length: 14 }, (_, i) => i + 1);
  const dayCountOptions = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const showDatePickers = d.totalDays && (d.issDays + d.ossDays === d.totalDays) && (d.ossDates.length === d.ossDays) && (d.issDates.length === d.issDays);
  return `
        <label class="dd-label">Reason <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="reason" rows="2" required>${escapeHtml(d.reason)}</textarea>
        <label class="dd-label">Start date (used to suggest default days)</label>
        <input class="dd-input" type="date" id="${idPrefix}-start-date" value="${d.startDate}" />

        <label class="dd-label">Total days of suspension</label>
        <select class="dd-input" id="${idPrefix}-total-days">
          <option value="">Select total days…</option>
          ${totalOptions.map((n) => `<option value="${n}" ${d.totalDays === n ? "selected" : ""}>${n} day${n > 1 ? "s" : ""}</option>`).join("")}
        </select>

        ${d.totalDays ? `
        <div class="dd-grid2" style="margin-top:10px">
          <div>
            <label class="dd-label">In-school days</label>
            <select class="dd-input" id="${idPrefix}-iss-days">
              ${dayCountOptions(d.totalDays).map((n) => `<option value="${n}" ${d.issDays === n ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="dd-label">Out-of-school days</label>
            <select class="dd-input" id="${idPrefix}-oss-days">
              ${dayCountOptions(d.totalDays).map((n) => `<option value="${n}" ${d.ossDays === n ? "selected" : ""}>${n}</option>`).join("")}
            </select>
          </div>
        </div>` : ""}

        ${showDatePickers && d.totalDays > 0 ? (() => {
          const combined = [
            ...d.ossDates.map((dt, i) => ({ date: dt, type: "OSS", idx: i })),
            ...d.issDates.map((dt, i) => ({ date: dt, type: "ISS", idx: i })),
          ].sort((a, b) => a.date.localeCompare(b.date));
          return `
        <label class="dd-label" style="margin-top:12px">Day-by-day schedule (sorted by date)</label>
        <div id="${idPrefix}-combined-date-rows">
          ${combined.map((row) => `
            <div class="dd-venue-row">
              <span class="dd-venue-date">${formatDate(row.date)}</span>
              <span class="dd-stamp-subtle" style="color:${SUSP_TYPE_STYLE[row.type].ink};flex-shrink:0">${SUSP_TYPE_STYLE[row.type].label}</span>
              <div class="dd-date-icon-btn" title="Change this day's date">
                <input type="date" class="${idPrefix}-${row.type === "OSS" ? "oss" : "iss"}-date-input" data-idx="${row.idx}" value="${row.date}" />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
              </div>
              ${row.type === "ISS" && d.issDifferentVenues ? `
                <select class="dd-input ${idPrefix}-iss-venue-select" data-date="${row.date}" style="flex:1;min-width:100px">
                  <option value="">Select location…</option>
                  ${LOCATION_OPTIONS.map((loc) => `<option value="${loc}" ${d.issVenues[row.date] === loc ? "selected" : ""}>${loc}</option>`).join("")}
                </select>` : ""}
            </div>`).join("")}
        </div>` ; })() : ""}

        ${showDatePickers && d.issDays > 0 ? `
        <label class="dd-label" style="margin-top:10px">In-school location</label>
        <select class="dd-input" name="issVenue" style="${d.issDifferentVenues ? "display:none" : ""}">
          <option value="">Select location…</option>
          ${LOCATION_OPTIONS.map((loc) => `<option value="${loc}" ${d.issVenue === loc ? "selected" : ""}>${loc}</option>`).join("")}
        </select>
        <label style="display:flex;align-items:center;gap:6px;margin-top:${d.issDifferentVenues ? "0" : "8px"};cursor:pointer">
          <input type="checkbox" id="${idPrefix}-diff-venues" ${d.issDifferentVenues ? "checked" : ""} />
          <span class="dd-mono-muted" style="font-size:12px">Different location each day</span>
        </label>` : ""}`;
}
function attachSuspFieldListeners(form, idPrefix, d, onChange) {
  const venueEl = form.elements["issVenue"];
  if (venueEl) venueEl.addEventListener("change", () => { d.issVenue = venueEl.value; });

  const startDateEl = document.getElementById(`${idPrefix}-start-date`);
  if (startDateEl) startDateEl.addEventListener("change", () => { d.startDate = startDateEl.value; regenerateSuspDates(d); onChange(); });

  const totalEl = document.getElementById(`${idPrefix}-total-days`);
  if (totalEl) totalEl.addEventListener("change", () => {
    const total = parseInt(totalEl.value, 10) || null;
    d.totalDays = total;
    if (total) {
      if (d.issDays + d.ossDays !== total) { d.issDays = total; d.ossDays = 0; }
      regenerateSuspDates(d);
    } else { d.ossDates = []; d.issDates = []; }
    onChange();
  });

  const issEl = document.getElementById(`${idPrefix}-iss-days`);
  if (issEl) issEl.addEventListener("change", () => {
    const n = parseInt(issEl.value, 10) || 0;
    d.issDays = n; d.ossDays = d.totalDays - n;
    regenerateSuspDates(d); onChange();
  });
  const ossEl = document.getElementById(`${idPrefix}-oss-days`);
  if (ossEl) ossEl.addEventListener("change", () => {
    const n = parseInt(ossEl.value, 10) || 0;
    d.ossDays = n; d.issDays = d.totalDays - n;
    regenerateSuspDates(d); onChange();
  });

  form.querySelectorAll(`.${idPrefix}-oss-date-input`).forEach((el) =>
    el.addEventListener("change", () => { d.ossDates[parseInt(el.dataset.idx, 10)] = el.value; onChange(); }));
  form.querySelectorAll(`.${idPrefix}-iss-date-input`).forEach((el) =>
    el.addEventListener("change", () => { d.issDates[parseInt(el.dataset.idx, 10)] = el.value; onChange(); }));
  form.querySelectorAll(`.${idPrefix}-iss-venue-select`).forEach((el) =>
    el.addEventListener("change", () => { d.issVenues[el.dataset.date] = el.value; }));

  const diffEl = document.getElementById(`${idPrefix}-diff-venues`);
  if (diffEl) diffEl.addEventListener("change", () => {
    d.issDifferentVenues = diffEl.checked;
    if (diffEl.checked) d.issDates.forEach((dt) => { if (!d.issVenues[dt]) d.issVenues[dt] = d.issVenue; });
    onChange();
  });
}
function renderSuspForm(isEdit) {
  const d = state._suspDraft;
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
        ${renderSuspFieldsBody(d, "susp")}
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
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderParentMeetingDetail).join("")}</div>`}
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
  const linkedIncidents = (m.linkedIncidentIds || []).map((id) => state.incidents.find((x) => x.id === id)).filter(Boolean);
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div>
          <div class="dd-card-student">${escapeHtml(m.studentName)}</div>
          <div class="dd-card-meta">${formatDate(m.date)}${m.studentClass ? ` · Class ${escapeHtml(m.studentClass)}` : ""} · logged by ${escapeHtml(m.loggedBy)}</div>
        </div>
      </div>
      ${linkedIncidents.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related discipline entries</div>
        ${linkedIncidents.map((x) => `<div class="dd-related-link" data-action="jump-to-incident" data-id="${x.id}">${formatDateShort(x.date)} — ${escapeHtml(truncateName(x.issue || "", 30))}</div>`).join("")}
      </div>` : ""}
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
  const d = state._pmDraft;
  return `
    <div class="dd-modal-backdrop" id="pm-modal-backdrop">
      <form class="dd-modal" id="pm-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${isEdit ? "Edit meeting" : "New parent meeting"}</div>
          <button type="button" class="dd-modal-close" id="pm-modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(d.studentClass)}</select>
        <label class="dd-label">Who is attending? <span style="color:#A3372B">*</span></label>
        <div class="dd-checkbox-group">
          ${ATTENDEE_OPTIONS.map((a) => `
            <label class="dd-checkbox-pill">
              <input type="checkbox" class="dd-attendee-cb" value="${a}" ${d.attendees.includes(a) ? "checked" : ""} />
              <span>${a}</span>
            </label>`).join("")}
        </div>
        ${state.pmFormError ? `<div class="dd-error" style="margin-top:6px">${escapeHtml(state.pmFormError)}</div>` : ""}
        ${d.attendees.includes("Others") ? `
        <label class="dd-label">Specify "Others"</label>
        <input class="dd-input" id="pm-others-text" value="${escapeHtml(d.othersText)}" placeholder="e.g. Aunt" />` : ""}
        <label class="dd-label">Date</label>
        <input class="dd-input" type="date" name="date" required value="${d.date}" />
        <label class="dd-label">Reason for meeting <span style="color:#A3372B">*</span></label>
        <textarea class="dd-textarea dd-input" name="reason" rows="3" required>${escapeHtml(d.reason)}</textarea>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save meeting"}</button>
      </form>
    </div>`;
}

// ==================== LISTENERS ====================
function attachMainListeners() {
  document.querySelectorAll('[data-action="set-section"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = el.dataset.section; render(); }));

  document.querySelectorAll('[data-action="jump-to-incident"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "log"; state.selectedIncidentId = el.dataset.id; state.disciplineFilter = "all"; state.viewDeletedIncidents = false; render(); }));
  document.querySelectorAll('[data-action="jump-to-suspension"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "suspensions"; state.selectedSuspId = el.dataset.id; render(); }));
  document.querySelectorAll('[data-action="jump-to-pm"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "parentMeetings"; state.selectedPmId = el.dataset.id; render(); }));

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
  else if (state.section === "dashboard") attachDashboardListeners();
}

function attachDashboardListeners() {
  const toggle = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { state[key] = el.checked; render(); });
  };
  toggle("chart-toggle-discipline", "chartIncludeDiscipline");
  toggle("chart-toggle-suspension", "chartIncludeSuspension");
  toggle("chart-toggle-pm", "chartIncludeParentMeeting");

  const newCaseBtn = document.getElementById("btn-new-case");
  if (newCaseBtn) newCaseBtn.addEventListener("click", () => {
    state.showNewCaseFlow = true;
    state.newCaseStep = "discipline";
    state._newCaseDraft = freshNewCaseDraft();
    state.caseFormError = "";
    render();
  });

  if (state.showNewCaseFlow) attachNewCaseListeners();
}

function attachNewCaseListeners() {
  const d = state._newCaseDraft;
  const form = document.getElementById("case-form");
  form.addEventListener("submit", (e) => e.preventDefault());
  const closeFlow = () => { state.showNewCaseFlow = false; state._newCaseDraft = null; state.newCaseStep = "discipline"; render(); };
  document.getElementById("case-modal-close").addEventListener("click", closeFlow);
  document.getElementById("case-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "case-modal-backdrop") closeFlow(); });

  const goNext = () => {
    if (!newCaseStepValid(state.newCaseStep, d)) {
      state.caseFormError = newCaseStepErrorMessage(state.newCaseStep, d);
      render();
      return;
    }
    state.caseFormError = "";
    state.newCaseStep = newCaseNextStep(state.newCaseStep, d);
    render();
  };
  const goBack = () => { state.newCaseStep = newCasePrevStep(state.newCaseStep, d); render(); };
  document.querySelectorAll('[data-action="case-next"]').forEach((el) => el.addEventListener("click", goNext));
  document.querySelectorAll('[data-action="case-back"]').forEach((el) => el.addEventListener("click", goBack));
  const submitBtn = document.getElementById("case-submit-btn");
  if (submitBtn) submitBtn.addEventListener("click", submitNewCase);

  const step = state.newCaseStep;

  if (step === "discipline") {
    const sync = (id, field) => { const el = document.getElementById(id); if (el) el.addEventListener("input", () => { d[field] = el.value; }); };
    sync("case-student-name", "studentName");
    sync("case-date", "date");
    sync("case-issue", "issue");
    sync("case-action-taken", "actionTaken");
    const classEl = document.getElementById("case-student-class");
    if (classEl) classEl.addEventListener("change", () => { d.studentClass = classEl.value; });
    document.querySelectorAll('[data-action="case-pick-status"]').forEach((el) =>
      el.addEventListener("click", () => { d.status = el.dataset.status; render(); }));
  }

  if (step === "ask-suspension") {
    document.querySelectorAll('[data-action="case-set-wants-susp"]').forEach((el) =>
      el.addEventListener("click", () => {
        d.wantsSuspension = el.dataset.value === "true";
        if (d.wantsSuspension && !d.suspDraft.startDate) d.suspDraft.startDate = d.date || todayISO();
        render();
      }));
  }

  if (step === "suspension") {
    const reasonEl = form.elements["reason"];
    if (reasonEl) reasonEl.addEventListener("input", () => { d.suspDraft.reason = reasonEl.value; });
    attachSuspFieldListeners(form, "case-susp", d.suspDraft, render);
  }

  if (step === "ask-pm") {
    document.querySelectorAll('[data-action="case-set-wants-pm"]').forEach((el) =>
      el.addEventListener("click", () => { d.wantsPm = el.dataset.value === "true"; render(); }));
  }

  if (step === "pm") {
    form.querySelectorAll(".dd-case-pm-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = d.pmDraft.attendees;
        if (cb.checked) { if (!ids.includes(cb.value)) ids.push(cb.value); }
        else { d.pmDraft.attendees = ids.filter((x) => x !== cb.value); }
        if (d.pmDraft.attendees.length > 0) state.caseFormError = "";
        render();
      }));
    const othersEl = document.getElementById("case-pm-others-text");
    if (othersEl) othersEl.addEventListener("input", () => { d.pmDraft.othersText = othersEl.value; });
    const reasonEl = document.getElementById("case-pm-reason");
    if (reasonEl) reasonEl.addEventListener("input", () => { d.pmDraft.reason = reasonEl.value; });
  }
}

function attachLogListeners() {

  document.getElementById("btn-toggle-deleted-incidents").addEventListener("click", () => {
    state.viewDeletedIncidents = !state.viewDeletedIncidents; render();
  });
  document.querySelectorAll('[data-action="set-discipline-filter"]').forEach((el) =>
    el.addEventListener("click", () => { state.disciplineFilter = el.dataset.filter; render(); }));
  const sortSel = document.getElementById("incident-sort-by");
  if (sortSel) sortSel.addEventListener("change", () => { state.incidentSortBy = sortSel.value; render(); });

  const search = document.getElementById("search-input");
  if (search) search.addEventListener("input", () => {
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  document.querySelectorAll('[data-action="set-status"]').forEach((el) =>
    el.addEventListener("click", () => updateStatus(el.dataset.id, el.dataset.status, el.dataset.current)));
  document.querySelectorAll('[data-action="follow-input"]').forEach((el) =>
    el.addEventListener("input", () => { state.followDraft[el.dataset.id] = el.value; }));
  document.querySelectorAll('[data-action="add-followup"]').forEach((el) =>
    el.addEventListener("click", () => addFollowUp(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-followup"]').forEach((el) =>
    el.addEventListener("click", () => openEditFollowUp(el.dataset.incident, el.dataset.fu)));
  document.querySelectorAll('[data-action="cancel-followup-edit"]').forEach((el) =>
    el.addEventListener("click", () => cancelEditFollowUp()));
  document.querySelectorAll('[data-action="save-followup-edit"]').forEach((el) =>
    el.addEventListener("click", () => submitEditFollowUp(el.dataset.incident, el.dataset.fu)));
  document.querySelectorAll('[data-action="delete-followup"]').forEach((el) =>
    el.addEventListener("click", () => deleteFollowUp(el.dataset.incident, el.dataset.fu)));
  document.querySelectorAll(".dd-followup-edit-input").forEach((el) =>
    el.addEventListener("input", () => { state.followEditDraft[el.dataset.fu] = el.value; }));
  document.querySelectorAll('[data-action="toggle-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));
  document.querySelectorAll('[data-action="delete-incident"]').forEach((el) =>
    el.addEventListener("click", () => deleteIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="restore-incident"]').forEach((el) =>
    el.addEventListener("click", () => restoreIncident(el.dataset.id)));
  document.querySelectorAll('[data-action="edit-incident"]').forEach((el) =>
    el.addEventListener("click", () => openEditIncident(el.dataset.id)));

  if (state.showNewForm) {
    const form = document.getElementById("new-form");
    form.addEventListener("submit", submitNewIncident);
    document.getElementById("modal-close").addEventListener("click", () => { state.showNewForm = false; state._newIncidentDraft = null; render(); });
    document.getElementById("modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") { state.showNewForm = false; state._newIncidentDraft = null; render(); } });
    document.querySelectorAll('[data-action="pick-new-status"]').forEach((el) =>
      el.addEventListener("click", () => { state._newIncidentDraft.status = el.dataset.status; render(); }));

    // Student name re-renders on every keystroke (to refresh related-record
    // matches below it), so every other field needs to live in the draft too
    // or it would get wiped by that re-render — same fix as the earlier
    // Parent Meeting bug.
    const nameEl = document.getElementById("new-incident-student-name");
    if (nameEl) nameEl.addEventListener("input", () => {
      state._newIncidentDraft.studentName = nameEl.value;
      const cursor = nameEl.selectionStart;
      render();
      const ns = document.getElementById("new-incident-student-name");
      if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
    });
    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._newIncidentDraft[name] = el.value; }); };
    syncField("date"); syncField("issue"); syncField("actionTaken");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._newIncidentDraft.studentClass = classEl.value; });

    form.querySelectorAll(".dd-link-susp-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = state._newIncidentDraft.linkedSuspensionIds;
        if (cb.checked) { if (!ids.includes(cb.value)) ids.push(cb.value); }
        else { state._newIncidentDraft.linkedSuspensionIds = ids.filter((x) => x !== cb.value); }
      }));
    form.querySelectorAll(".dd-link-pm-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const ids = state._newIncidentDraft.linkedPmIds;
        if (cb.checked) { if (!ids.includes(cb.value)) ids.push(cb.value); }
        else { state._newIncidentDraft.linkedPmIds = ids.filter((x) => x !== cb.value); }
      }));
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

    attachSuspFieldListeners(form, "susp", state._suspDraft, render);
  }
}

function attachPmListeners() {
  document.getElementById("btn-new-pm").addEventListener("click", () => {
    state.showNewPmForm = true;
    state.editingPmId = null;
    state._pmDraft = freshPmDraft();
    state.pmFormError = "";
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
    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._pmDraft[name] = el.value; }); };
    syncField("studentName"); syncField("date"); syncField("reason");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._pmDraft.studentClass = classEl.value; });
    form.querySelectorAll(".dd-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const v = cb.value;
        if (cb.checked) { if (!state._pmDraft.attendees.includes(v)) state._pmDraft.attendees.push(v); }
        else { state._pmDraft.attendees = state._pmDraft.attendees.filter((a) => a !== v); }
        if (state._pmDraft.attendees.length > 0) state.pmFormError = "";
        render();
      }));
    const othersEl = document.getElementById("pm-others-text");
    if (othersEl) othersEl.addEventListener("input", () => { state._pmDraft.othersText = othersEl.value; });
  }
}

render();
