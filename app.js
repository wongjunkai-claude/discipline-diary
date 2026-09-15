// ---------- Firebase (loaded directly from Google's CDN, no npm/build needed) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, addDoc, updateDoc, doc, arrayUnion, setDoc, getDoc, deleteDoc,
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

const APP_VERSION = "2.54.1";
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
  const isLegacy = !Array.isArray(it.issues);
  const issueSummary = isLegacy ? (it.issue || "") : incidentSummaryLabel(it);
  const statusText = isLegacy ? (STATUS_TEXT[it.status] || it.status || "") : (groomingEntryResolved(it) ? "Resolved" : "In Progress");
  logToSheet({
    recordType: "Incident", id: it.id,
    studentName: it.studentName, studentClass: it.studentClass, date: it.date,
    issue: issueSummary, actionTaken: it.actionTaken || "",
    status: (it.deleted ? "Removed — " : "") + statusText,
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
function composeReasonValue(form, draft, fieldName) {
  fieldName = fieldName || "reason";
  const sel = form.querySelector(`[name="${fieldName}"]`);
  const val = sel ? sel.value : (draft?.reasonCategory || "");
  if (val !== "Others") return val;
  const othersEl = form.querySelector(`.dd-reason-others-input[data-for="${fieldName}"]`);
  const text = (othersEl?.value ?? draft?.reasonOthersText ?? "").trim();
  return text ? `Others — ${text}` : "Others";
}
function renderReasonPicker(selectedCategory, othersText, fieldName) {
  fieldName = fieldName || "reason";
  return `
    <label class="dd-label">Reason <span class="dd-mono-muted" style="font-size:11px;text-transform:none">scroll for more</span></label>
    <select class="dd-input dd-reason-select" name="${fieldName}" size="5" required>
      <option value="" disabled ${selectedCategory ? "" : "selected"}>Select reason…</option>
      ${REASON_OPTIONS.map((r) => `<option value="${escapeHtml(r)}" ${selectedCategory === r ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
    </select>
    ${selectedCategory === "Others" ? `
    <label class="dd-label">Please specify</label>
    <input class="dd-input dd-reason-others-input" data-for="${fieldName}" value="${escapeHtml(othersText || "")}" />` : ""}`;
}
// Splits an already-saved reason (which might be a plain category, or a
// composed "Others — some text" string from a past edit) back into the
// category dropdown's value and the Others box's text, for editing.
function splitSavedReason(saved) {
  if (!saved) return { category: "", othersText: "" };
  if (REASON_OPTIONS.includes(saved)) return { category: saved, othersText: "" };
  const m = /^Others\s*—\s*(.*)$/.exec(saved);
  if (m) return { category: "Others", othersText: m[1] };
  return { category: "Others", othersText: saved };
}
const ATTENDEE_OPTIONS = ["Father", "Mother", "Grandfather", "Grandmother", "Guardian", "Others"];
const REASON_OPTIONS = [
  "Open Defiance", "Verbal Bullying", "Hurtful Behaviour", "Assault", "Physical Bullying",
  "Fighting", "Skipping Classes", "Truancy", "Leaving School Grounds Without Permission",
  "Vandalism", "Unauthorised Device Use", "Cheating", "Forgery", "Cyberbullying", "Theft",
  "Smoking", "Vape-Related Offences", "Inhalant Abuse", "Pornography-Related Offence",
  "Sexual Misconduct", "Gambling", "Scams", "Gangsterism", "Arson", "Possession of Weapons",
  "Illegal / Criminal Offences Causing Grievous Hurt", "Others",
];

// ---------- Grooming Log config ----------
// days: [1st warning, 2nd warning, final warning] — calendar days given to
// fix the issue at each stage. parentFrom: the stage at which parents get
// contacted (1 = even on the first warning). finalAction: what happens if
// the final warning also lapses — "facilitated" prompts Level Support
// Teachers/SH-SM to do enforced facilitated calling; "shsm-only" means
// SH/SM just calls the parent directly, no facilitated-calling step.
const GROOMING_ISSUE_TYPES = [
  "Long Hair", "Coloured Hair", "Dirtied Uniform", "Missing Name Tag",
  "Improper Socks", "Improper Shoes", "Smartwatch/Handphone",
  "Improper Earrings/Hair Accessories", "Wearing Make Up/Improper Facial Patches",
  "Religious Items", "Others",
];
const GROOMING_ISSUE_CONFIG = {
  "Long Hair": { days: [4, 4, 1], parentFrom: 2, finalAction: "facilitated" },
  "Coloured Hair": { days: [4, 4, 1], parentFrom: 1, finalAction: "facilitated" },
  "Dirtied Uniform": { days: [7, 7, 1], parentFrom: 1, finalAction: "facilitated" },
  "Missing Name Tag": {
    days: [7, 7, 3], parentFrom: 2, finalAction: "facilitated",
    instructions: [
      "Student To Take Name Tag Form From Bookshop",
      "Order a replacement — direct parents to obtain the form from the school website.",
      "Order a replacement — give the hardcopy form directly to the student (over the weekend).",
    ],
  },
  "Improper Socks": { days: [1, 1, 1], parentFrom: 2, finalAction: "facilitated" },
  "Improper Shoes": { days: [4, 4, 1], parentFrom: 2, finalAction: "facilitated" },
  "Smartwatch/Handphone": { days: [1, 1, 1], parentFrom: 2, finalAction: "facilitated", note: "Student To Keep/Remove Immediately" },
  "Improper Earrings/Hair Accessories": { days: [1, 1, 1], parentFrom: 2, finalAction: "facilitated", note: "Student To Remove Immediately" },
  "Wearing Make Up/Improper Facial Patches": { days: [1, 1, 1], parentFrom: 2, finalAction: "facilitated", note: "Student To Remove Immediately" },
  "Religious Items": { days: [1, 1, 1], parentFrom: 1, finalAction: "shsm-only" },
  "Others": { days: [3, 3, 1], parentFrom: 2, finalAction: "facilitated" },
};
const WARNING_STAGE_LABEL = { 1: "1st Warning", 2: "2nd Warning", 3: "Final Warning" };
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
// Whole calendar days between two ISO dates (to, minus from) — used to
// say "overdue for N days" without drifting from timezone/DST quirks,
// since both dates are treated as plain UTC midnight.
function daysBetween(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
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
// Verified against MOM's official 2026/2027 gazetted public holiday
// lists (data.gov.sg) — these are MOM's confirmed dates.
const KNOWN_PUBLIC_HOLIDAYS = [
  { name: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-01" },
  { name: "Chinese New Year", startDate: "2026-02-17", endDate: "2026-02-18" },
  { name: "Hari Raya Puasa", startDate: "2026-03-21", endDate: "2026-03-21" },
  { name: "Good Friday", startDate: "2026-04-03", endDate: "2026-04-03" },
  { name: "Labour Day", startDate: "2026-05-01", endDate: "2026-05-01" },
  { name: "Hari Raya Haji", startDate: "2026-05-27", endDate: "2026-05-27" },
  { name: "Vesak Day", startDate: "2026-05-31", endDate: "2026-05-31" },
  { name: "Vesak Day (in lieu)", startDate: "2026-06-01", endDate: "2026-06-01" },
  { name: "National Day", startDate: "2026-08-09", endDate: "2026-08-09" },
  { name: "National Day (in lieu)", startDate: "2026-08-10", endDate: "2026-08-10" },
  { name: "Deepavali", startDate: "2026-11-08", endDate: "2026-11-08" },
  { name: "Deepavali (in lieu)", startDate: "2026-11-09", endDate: "2026-11-09" },
  { name: "Christmas Day", startDate: "2026-12-25", endDate: "2026-12-25" },
  { name: "New Year's Day", startDate: "2027-01-01", endDate: "2027-01-01" },
  { name: "Chinese New Year", startDate: "2027-02-06", endDate: "2027-02-07" },
  { name: "Chinese New Year (in lieu)", startDate: "2027-02-08", endDate: "2027-02-08" },
  { name: "Hari Raya Puasa", startDate: "2027-03-10", endDate: "2027-03-10" },
  { name: "Good Friday", startDate: "2027-03-26", endDate: "2027-03-26" },
  { name: "Labour Day", startDate: "2027-05-01", endDate: "2027-05-01" },
  { name: "Hari Raya Haji", startDate: "2027-05-17", endDate: "2027-05-17" },
  { name: "Vesak Day", startDate: "2027-05-20", endDate: "2027-05-20" },
  { name: "National Day", startDate: "2027-08-09", endDate: "2027-08-09" },
  { name: "Deepavali", startDate: "2027-10-28", endDate: "2027-10-28" },
  { name: "Christmas Day", startDate: "2027-12-25", endDate: "2027-12-25" },
];

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
  const jan2 = `${year}-01-02`;
  const jan2Dow = weekdayOf(jan2);
  // Week 1's Monday: if Jan 2 is a Monday or Tuesday, that week is Week 1
  // (no Week 0); if it's Wed/Thu/Fri, that week is Week 0, and Week 1
  // starts the following Monday. This anchor is purely about which week
  // Term 1 (and every 10-week term after it) starts on — it must not
  // shift for any other reason, since every holiday block and Teacher's
  // Day are all calculated as fixed offsets from it.
  let w1;
  if (jan2Dow === 1) w1 = jan2;
  else if (jan2Dow === 2) w1 = addDays(jan2, -1);
  else w1 = strictNextWeekday(jan2, 1);

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

  const computed = {
    terms: [
      { label: "Term 1", start: w1, end: term1End },
      { label: "Term 2", start: term2Start, end: term2End },
      { label: "Term 3", start: term3Start, end: term3End },
      { label: "Term 4", start: term4Start, end: term4End },
    ],
    ranges: [
      { start: marchStart, end: marchEnd, label: "March Holidays" },
      { start: juneStart, end: juneEnd, label: "June Holidays" },
      { start: sepStart, end: sepEnd, label: "September Holidays" },
      { start: yearEndStart, end: yearEndEnd, label: "December Holidays" },
    ],
    singleDayLabels: ["Youth Day", "Teachers' Day", "Children's Day", ...(nationalDayInLieu ? ["National Day (in lieu)"] : [])],
    singleDays: [youthDay, teachersDay, childrensDay, ...(nationalDayInLieu ? [nationalDayInLieu] : [])],
  };
  return applyCalendarOverrides(year, computed);
}
// Each computed boundary (term start/end, holiday block start/end, each
// single day) can be independently corrected under Settings → School
// Calendar without touching the formula — these don't cascade into each
// other, since an override represents "this is the actual confirmed
// date," not a new anchor to recompute the rest of the year from.
function applyCalendarOverrides(year, computed) {
  const overrides = state.schoolCalendarOverrides?.[year];
  if (!overrides) return computed;
  const terms = computed.terms.map((t, i) => ({
    ...t,
    start: overrides[`term${i + 1}Start`] || t.start,
    end: overrides[`term${i + 1}End`] || t.end,
  }));
  const rangeKeys = ["march", "june", "sep", "yearEnd"];
  const ranges = computed.ranges.map((r, i) => ({
    ...r,
    start: overrides[`${rangeKeys[i]}Start`] || r.start,
    end: overrides[`${rangeKeys[i]}End`] || r.end,
  }));
  const singleDayKeys = ["youthDay", "teachersDay", "childrensDay", "nationalDayInLieu"];
  const singleDays = computed.singleDays.map((d, i) => overrides[singleDayKeys[i]] || d);
  return { ...computed, terms, ranges, singleDays };
}

// A School Closure or HBL Day entry for a given date, if one exists.
// Whole-school closures list all 6 levels; HBL Days list only the levels
// actually at home. Entries can span a range of days (startDate..endDate;
// a single day just has startDate === endDate).
function schoolClosureEntryFor(iso) {
  return (state.schoolClosureDays?.entries || []).find((e) => {
    const start = e.startDate || e.date;
    const end = e.endDate || e.date;
    return start && iso >= start && iso <= end;
  }) || null;
}
// A public holiday can be a single day or a range (Chinese New Year is
// usually 2 days) — checks both the new named-entry list and the older
// flat date list some existing data may still be in.
function publicHolidayEntryFor(iso) {
  const entries = state.holidays?.publicHolidayEntries || [];
  return entries.find((e) => iso >= e.startDate && iso <= e.endDate) || null;
}
function isNonSchoolDay(iso, level) {
  if (isWeekend(iso)) return true;
  const year = parseInt(iso.slice(0, 4), 10);
  const moe = computeMoeCalendar(year);
  if (moe.singleDays.includes(iso)) return true;
  for (const r of moe.ranges) {
    if (iso >= r.start && iso <= r.end) return true;
  }
  const h = state.holidays;
  if (h && h.publicHolidays && h.publicHolidays.includes(iso)) return true;
  if (publicHolidayEntryFor(iso)) return true;
  const extraHolidays = state.schoolCalendarOverrides?.[year]?.extraHolidays || [];
  if (extraHolidays.some((e) => iso >= e.startDate && iso <= e.endDate)) return true;
  const closure = schoolClosureEntryFor(iso);
  if (closure) {
    // With a specific level in hand (e.g. scheduling a suspension for a
    // particular class), only treat it as a non-school day if that
    // level is actually affected — an HBL day for P3-P5 shouldn't push
    // out a P1 suspension's dates. With no level given (generic/visual
    // checks), any closure or HBL entry counts.
    if (level != null) return closure.levels.includes(level);
    return true;
  }
  return false;
}
function nextSchoolDay(iso, level) {
  let d = addDays(iso, 1);
  while (isNonSchoolDay(d, level)) d = addDays(d, 1);
  return d;
}
function schoolDayChain(startDate, count, level) {
  const out = [startDate];
  let cur = startDate;
  for (let i = 1; i < count; i++) {
    cur = nextSchoolDay(cur, level);
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

// Deleting an entry now just asks "Delete the entry?" with Yes/No,
// rather than a password — the confirmation IS the safeguard.
function requestDeleteConfirmation(type, id, extra) {
  state.confirmDeleteTarget = { type, id, ...(extra || {}) };
  render();
}
function cancelDeleteConfirmation() {
  state.confirmDeleteTarget = null;
  render();
}
async function confirmDeleteYes() {
  const target = state.confirmDeleteTarget;
  if (!target) return;
  state.confirmDeleteTarget = null;
  if (target.type === "incident") await deleteIncident(target.id);
  else if (target.type === "suspension") await deleteSuspension(target.id);
  else if (target.type === "parentMeeting") await deleteParentMeeting(target.id);
  else if (target.type === "publicHoliday") {
    const remaining = (state.holidays?.publicHolidayEntries || []).filter((e) => e.id !== target.id);
    try { await setDoc(doc(db, "holidays", "singapore"), { publicHolidayEntries: remaining }, { merge: true }); }
    catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
  } else if (target.type === "schoolClosureDay") {
    const remaining = (state.schoolClosureDays?.entries || []).filter((e) => e.id !== target.id);
    try { await setDoc(doc(db, "settings", "schoolClosureDays"), { entries: remaining }, { merge: true }); }
    catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
  } else if (target.type === "extraSchoolHoliday") {
    const all = state.schoolCalendarOverrides || {};
    const patch = {};
    for (const yr of Object.keys(all)) {
      const list = all[yr]?.extraHolidays || [];
      if (list.some((e) => e.id === target.id)) patch[yr] = { ...all[yr], extraHolidays: list.filter((e) => e.id !== target.id) };
    }
    try { await setDoc(doc(db, "settings", "schoolCalendarOverrides"), patch, { merge: true }); }
    catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
  }
}
// Tapping "+" opens this with an empty draft (id: null); tapping an
// existing entry's calendar icon opens it pre-filled (id set) — Save
// either creates a new entry or updates the existing one in place.
function renderPublicHolidayModal() {
  const d = state._publicHolidayDraft;
  return `
    <div class="dd-modal-backdrop" id="ph-modal-backdrop">
      <div class="dd-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${d.id ? "Edit" : "Add"} public holiday</div>
          <button type="button" class="dd-modal-close" id="ph-modal-close">✕</button>
        </div>
        <label class="dd-label" style="margin-top:0">Name</label>
        <input class="dd-input" id="ph-name-input" value="${escapeHtml(d.name)}" placeholder="e.g. Chinese New Year" />
        ${renderDateRangeFields("ph", d.startDate, d.endDate)}
        ${state.saveError ? `<div class="dd-error">${escapeHtml(state.saveErrorDetail || "Fill in every field.")}</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-public-holiday" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button>
      </div>
    </div>`;
}
function renderSchoolHolidayEditModal() {
  const d = state._schoolHolidayDraft;
  return `
    <div class="dd-modal-backdrop" id="sh-modal-backdrop">
      <div class="dd-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Correct ${escapeHtml(d.label)}</div>
          <button type="button" class="dd-modal-close" id="sh-modal-close">✕</button>
        </div>
        ${d.isRange ? renderDateRangeFields("sh", d.startDate, d.endDate) : `
        <label class="dd-label" style="margin-top:0">Date</label>
        ${renderDateField("sh-start", d.startDate)}`}
        ${state.saveError ? `<div class="dd-error">${escapeHtml(state.saveErrorDetail)}</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-school-holiday" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button>
      </div>
    </div>`;
}
function renderClosureDayModal() {
  const d = state._closureModalDraft;
  return `
    <div class="dd-modal-backdrop" id="cd-modal-backdrop">
      <div class="dd-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${d.id ? "Edit" : "Add"} closure / HBL day</div>
          <button type="button" class="dd-modal-close" id="cd-modal-close">✕</button>
        </div>
        <label class="dd-label" style="margin-top:0">Type</label>
        <div class="dd-issue-tag-grid">
          <button type="button" class="dd-issue-tag ${d.type === "closure" ? "active" : ""}" data-action="cd-set-type" data-type="closure">School Closure</button>
          <button type="button" class="dd-issue-tag ${d.type === "hbl" ? "active" : ""}" data-action="cd-set-type" data-type="hbl">HBL Day</button>
        </div>
        ${renderDateRangeFields("cd", d.startDate, d.endDate)}
        ${d.type === "hbl" ? `
        <label class="dd-label">Which levels are on HBL?</label>
        <div class="dd-issue-tag-grid">
          ${[1, 2, 3, 4, 5, 6].map((lvl) => `<button type="button" class="dd-issue-tag ${d.levels.includes(lvl) ? "active" : ""}" data-action="cd-toggle-level" data-level="${lvl}">P${lvl}</button>`).join("")}
        </div>` : ""}
        ${state.saveError ? `<div class="dd-error">${escapeHtml(state.saveErrorDetail || "Fill in every field.")}</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-closure-day" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button>
      </div>
    </div>`;
}
function renderExtraSchoolHolidayModal() {
  const d = state._extraSchoolHolidayDraft;
  return `
    <div class="dd-modal-backdrop" id="esh-modal-backdrop">
      <div class="dd-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${d.id ? "Edit" : "Add"} school holiday</div>
          <button type="button" class="dd-modal-close" id="esh-modal-close">✕</button>
        </div>
        <label class="dd-label" style="margin-top:0">Name</label>
        <input class="dd-input" id="esh-name-input" value="${escapeHtml(d.name)}" placeholder="e.g. Special one-off closure" />
        ${renderDateRangeFields("esh", d.startDate, d.endDate)}
        ${state.saveError ? `<div class="dd-error">${escapeHtml(state.saveErrorDetail || "Fill in every field.")}</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-extra-school-holiday" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save"}</button>
      </div>
    </div>`;
}
function renderDeleteConfirmModal() {
  return `
    <div class="dd-modal-backdrop" id="confirm-delete-backdrop">
      <div class="dd-modal" style="max-width:340px;text-align:center">
        <div class="dd-modal-title" style="margin-bottom:18px">Delete the entry?</div>
        <div style="display:flex;gap:8px">
          <button class="dd-add-btn" style="flex:1;background:#8A8571" id="btn-confirm-delete-no">No</button>
          <button class="dd-add-btn" style="flex:1;background:#A3372B" id="btn-confirm-delete-yes">Yes</button>
        </div>
      </div>
    </div>`;
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
  authUser: null,
  authError: "",
  userList: [],
  teacherName: localStorage.getItem("dd-teacher-name") || "",
  holidays: null,
  section: "dashboard",
  showHelp: false,
  chartRangeMode: "thisMonth",
  watchTier: "high",
  settingsView: "menu", // 'menu' | 'yearList' | 'yearReport' | 'classesForYear'
  settingsSelectedYear: null,
  classConfig: null,
  schoolClosureDays: null,
  schoolCalendarOverrides: null,
  holidaysAddModal: null, // null | "publicHoliday" | "schoolClosure"
  confirmDeleteTarget: null,
  undoToast: null,
  studentViewName: null,
  studentViewFromSection: "dashboard",
  showWatchlistInfo: false,
  _classDraft: null,
  calendarViewMonth: null, // set on first render to the current month
  dayViewDate: null, // set on first render to today
  weekViewMonday: null, // set on first render to this week's Monday
  yearViewYear: null, // set on first render to the current year
  selectedCalendarDay: null,
  chartCustomFrom: lastNMonthKeys(3)[0],
  chartCustomTo: lastNMonthKeys(1)[0],
  showChartCustomModal: false,

  incidents: [],
  dataLoaded: false,
  query: "",
  incidentSortBy: "date",
  disciplineFilter: "all", // 'all' | 'Monitoring' | 'Resolved'
  selectedIncidentId: null,
  showNewForm: false,
  editingIncidentId: null,
  historyOpen: {},
  entryExpanded: {},
  followDraft: {},
  editingFollowUpId: null,
  followEditDraft: {},

  suspensions: [],
  suspLoaded: false,
  suspTab: "All", // 'All' | 'This Week' | 'Upcoming' | 'Completed' | 'Deleted'
  suspSortBy: "date",
  suspQuery: "",
  selectedSuspId: null,
  showNewSuspForm: false,
  editingSuspensionId: null,
  _suspDraft: null,

  parentMeetings: [],
  pmLoaded: false,
  pmTab: "All", // 'All' | 'This Week' | 'Upcoming' | 'Completed' | 'Deleted'
  pmSortBy: "date",
  pmQuery: "",
  selectedPmId: null,
  showNewPmForm: false,
  editingPmId: null,
  _pmDraft: null,
  pmFormError: "",
  suspFormError: "",
  newIncidentFormError: "",

  showNewCaseFlow: false,
  newCaseStep: "discipline",
  _newCaseDraft: null,
  caseFormError: "",

  saveError: false,
  saveErrorDetail: "",
  saving: false,
};

const root = document.getElementById("app");
let unsubIncidents = null;
let unsubSuspensions = null;
let unsubHolidays = null;
let unsubParentMeetings = null;
let unsubUsers = null;

const ALLOWED_EMAIL_DOMAIN = "moe.edu.sg";
async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  // Not passing an "hd" domain hint here — the account picker will show
  // any Google account, but the real enforcement (which actually matters)
  // happens right after sign-in below, and again at the Firestore rules
  // level, so this isn't a security gap.
  state.authError = "";
  render();
  try {
    await signInWithPopup(auth, provider);
    // onAuthStateChanged below picks up from here.
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
      state.authError = "Sign-in didn't go through. Please try again.";
    }
    render();
  }
}
async function signOutOfApp() {
  try { await signOut(auth); } catch (e) { /* non-fatal */ }
}

onAuthStateChanged(auth, async (u) => {
  state.authReady = true;
  if (unsubIncidents) { unsubIncidents(); unsubIncidents = null; }
  if (unsubSuspensions) { unsubSuspensions(); unsubSuspensions = null; }
  if (unsubHolidays) { unsubHolidays(); unsubHolidays = null; }
  if (unsubParentMeetings) { unsubParentMeetings(); unsubParentMeetings = null; }
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  if (!u) { state.authUser = null; render(); return; }
  const email = (u.email || "").toLowerCase();
  if (!email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    state.authError = `Please sign in with your @${ALLOWED_EMAIL_DOMAIN} school account.`;
    state.authUser = null;
    await signOutOfApp();
    render();
    return;
  }
  state.authUser = { uid: u.uid, email };
  try {
    const userDoc = await getDoc(doc(db, "users", u.uid));
    state.teacherName = (userDoc.exists() && userDoc.data().name) ? userDoc.data().name : "";
  } catch (e) {
    state.teacherName = localStorage.getItem("dd-teacher-name") || "";
  }
  if (state.teacherName) startListening();
  render();
});

function startListening() {
  state.dataLoaded = false;
  state.suspLoaded = false;
  state.pmLoaded = false;
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(collection(db, "users"), (snap) => { state.userList = snap.docs.map((d) => d.data()); render(); });
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
  checkAnnualPublicHolidayFetch();
  unsubHolidays = onSnapshot(
    doc(db, "holidays", "singapore"),
    (snap) => { if (snap.exists()) { state.holidays = snap.data(); render(); } },
    () => {}
  );
  onSnapshot(
    doc(db, "settings", "classConfig"),
    (snap) => { state.classConfig = snap.exists() ? snap.data() : {}; render(); },
    () => { state.classConfig = {}; render(); }
  );
  onSnapshot(
    doc(db, "settings", "schoolClosureDays"),
    (snap) => { state.schoolClosureDays = snap.exists() ? snap.data() : { entries: [] }; render(); },
    () => { state.schoolClosureDays = { entries: [] }; render(); }
  );
  onSnapshot(
    doc(db, "settings", "schoolCalendarOverrides"),
    (snap) => { state.schoolCalendarOverrides = snap.exists() ? snap.data() : {}; render(); },
    () => { state.schoolCalendarOverrides = {}; render(); }
  );
}

async function ensureHolidaysSeeded() {
  try {
    const snap = await getDoc(doc(db, "holidays", "singapore"));
    if (!snap.exists()) await setDoc(doc(db, "holidays", "singapore"), DEFAULT_HOLIDAYS_2026);
  } catch (e) { /* non-fatal */ }
}

const SG_HOLIDAYS_DATASET_URL = "https://data.gov.sg/api/action/datastore_search?resource_id=d_8ef23381f9417e4d4254ee8b4dcdb176&limit=200";
// This is data.gov.sg's "Singapore Public Holidays (consolidated)"
// dataset — MOM keeps it updated annually (their description says
// "around Q3"), under this same URL, so it's safe to re-check every
// year rather than needing a new address each time. We check once a
// year starting 31 Jul, same window MOM typically uses to publish the
// next year's list, and only fetch if we don't already have next
// year's dates on file.
async function checkAnnualPublicHolidayFetch() {
  const today = todayISO();
  const currentYear = parseInt(today.slice(0, 4), 10);
  if (today < `${currentYear}-07-31`) return;
  const nextYear = currentYear + 1;
  const haveNextYear = (state.holidays?.publicHolidayEntries || []).some((e) => e.startDate.startsWith(String(nextYear)));
  if (haveNextYear) return;
  await syncPublicHolidaysFromDataGovSg();
}
async function syncPublicHolidaysFromDataGovSg() {
  try {
    const res = await fetch(SG_HOLIDAYS_DATASET_URL);
    if (!res.ok) return;
    const data = await res.json();
    const records = data?.result?.records;
    if (!Array.isArray(records) || records.length < 50) return;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const dates = new Set();
    // Named entries, keyed by date, for the new Settings display — the
    // dataset's name field isn't 100% guaranteed by us, so anything we
    // can't confidently name falls back to a plain "Public Holiday"
    // label rather than silently dropping the date.
    const named = new Map();
    for (const rec of records) {
      let dateVal = null;
      for (const key of Object.keys(rec)) {
        if (dateRegex.test(rec[key])) { dateVal = rec[key]; break; }
      }
      if (!dateVal) continue;
      dates.add(dateVal);
      let nameVal = rec.holiday || rec.day || rec.name || rec.description || "Public Holiday";
      // The dataset already lists in-lieu days as their own row, marked
      // "Observed" — that's the authoritative source for which days are
      // in lieu, so we just relabel it for consistency rather than also
      // guessing our own in-lieu day from the Sunday-landing rule, which
      // would double-count whatever MOM already states directly.
      if (/observed/i.test(nameVal)) nameVal = nameVal.replace(/\s*\(?observed\)?/i, "").trim() + " (in lieu)";
      named.set(dateVal, nameVal);
    }
    if (dates.size < 50) return;
    const fresh = [...dates].sort();
    const current = state.holidays?.publicHolidays || [];
    const patch = {};
    if (JSON.stringify(fresh) !== JSON.stringify(current)) patch.publicHolidays = fresh;
    // Merge named entries in additively — never overwrite a date the
    // user has already corrected or renamed by hand.
    const existingEntries = state.holidays?.publicHolidayEntries || [];
    const existingDates = new Set(existingEntries.map((e) => e.startDate));
    const newEntries = [...named.entries()]
      .filter(([d]) => !existingDates.has(d))
      .map(([d, name]) => ({ id: uid(), name, startDate: d, endDate: d }));
    if (newEntries.length > 0) patch.publicHolidayEntries = [...existingEntries, ...newEntries];
    if (Object.keys(patch).length > 0) await setDoc(doc(db, "holidays", "singapore"), patch, { merge: true });
  } catch (e) { /* silent — best-effort background sync */ }
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
  if (state.authUser) {
    setDoc(doc(db, "users", state.authUser.uid), { name, email: state.authUser.email }, { merge: true })
      .catch(() => { /* non-fatal — local state already has the name, will retry to sync on next save */ });
  }
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
  return { studentName: "", studentClass: "", date: todayISO(), selectedIssues: [], othersText: "", linkedSuspensionIds: [], linkedPmIds: [] };
}
// Compute a fresh issue object for a newly-picked grooming issue type,
// starting at 1st Warning with its deadline computed from that issue's
// configured day-count. Parents are marked contacted immediately if the
// issue's rules say so even on the first warning (e.g. Coloured Hair).
// A 4-calendar-day duration means "over the weekend" — these are things
// a parent needs to sort out at home (a haircut, new shoes), so the
// deadline is the student's next school day after the coming weekend,
// not a flat day count. If that Monday happens to be a public holiday
// or school holiday, it rolls forward to whichever day school actually
// resumes. Any other duration is just added as calendar days, as before.
function computeGroomingDeadline(cfg, stage, catchDate, level) {
  if (cfg.days[stage - 1] === 4) {
    let d = strictNextWeekday(catchDate, 1);
    while (isNonSchoolDay(d, level)) d = nextSchoolDay(d, level);
    return d;
  }
  return addDays(catchDate, cfg.days[stage - 1]);
}
function freshGroomingIssue(type, othersText, catchDate, level) {
  const cfg = GROOMING_ISSUE_CONFIG[type] || GROOMING_ISSUE_CONFIG.Others;
  const deadline = computeGroomingDeadline(cfg, 1, catchDate, level);
  return {
    id: uid(), type, othersText: type === "Others" ? (othersText || "") : "",
    stage: 1, deadline, overriddenBy: null, resolved: false, resolvedAt: null,
    parentContacted: cfg.parentFrom <= 1,
    history: [{ stage: 1, deadline, action: "1st Warning issued", at: catchDate }],
  };
}
function groomingIssueLabel(issue) {
  return issue.type === "Others" && issue.othersText ? `Others — ${issue.othersText}` : issue.type;
}
// A short display label for any incident, old-shape or new — used
// wherever a linked grooming entry needs to show a one-line summary.
function incidentSummaryLabel(it) {
  if (Array.isArray(it.issues)) return it.issues.map((x) => groomingIssueLabel(x)).join(", ");
  return it.issue || "";
}
// Resolve one issue within an entry (can happen mid-countdown, any stage).
function resolveGroomingIssue(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  issue.resolved = true;
  issue.resolvedAt = todayISO();
  issue.history.push({ stage: issue.stage, action: "Resolved", at: todayISO(), by: teacherName() });
  saveIncidentIssueUpdate(entry);
}
// Escalate one issue to the next warning stage (or, if already at Final,
// re-issue Final with a fresh deadline — SH/SM keeps calling until it's
// resolved, there's no stage beyond Final).
function escalateGroomingIssue(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  const cfg = GROOMING_ISSUE_CONFIG[issue.type] || GROOMING_ISSUE_CONFIG.Others;
  const today = todayISO();
  const nextStage = Math.min(issue.stage + 1, 3);
  issue.stage = nextStage;
  issue.deadline = computeGroomingDeadline(cfg, nextStage, today, classLevel(entry.studentClass));
  issue.overriddenBy = null;
  if (cfg.parentFrom <= nextStage) issue.parentContacted = true;
  issue.history.push({ stage: nextStage, deadline: issue.deadline, action: `${WARNING_STAGE_LABEL[nextStage]} issued`, at: today });
  saveIncidentIssueUpdate(entry);
}
// A student/parent can propose their own date instead of the computed
// deadline — this fully replaces it, no limit on how many times.
function overrideGroomingIssueDeadline(entryId, issueId, newDate) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  issue.deadline = newDate;
  issue.history.push({ stage: issue.stage, deadline: newDate, action: `Deadline moved to ${formatDate(newDate)}`, at: todayISO() });
  saveIncidentIssueUpdate(entry);
}
// Reverts an issue to the state it was in before its most recent logged
// action (resolve, escalate, or a deadline change) — in case something
// was tapped by mistake.
function undoGroomingIssueAction(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue || issue.history.length < 2) return;
  issue.history.pop();
  const prev = issue.history[issue.history.length - 1];
  issue.stage = prev.stage;
  issue.deadline = prev.deadline || issue.deadline;
  issue.resolved = false;
  issue.resolvedAt = null;
  saveIncidentIssueUpdate(entry);
}
// An entry is only "Resolved" once every issue inside it is resolved.
function groomingEntryResolved(entry) {
  return (entry.issues || []).length > 0 && entry.issues.every((x) => x.resolved);
}
// The highest warning stage this entry has ever reached, across all its
// issues — used for the per-entry (not per-issue) risk-tier counting.
function groomingEntryMaxStage(entry) {
  return (entry.issues || []).reduce((max, x) => Math.max(max, x.stage), 0);
}
// Every non-resolved grooming issue whose deadline has arrived (today or
// earlier), across all entries — this is the actual "who needs following
// up today" list, flattened to one row per issue rather than per entry,
// since an entry with two issues might only need follow-up on one of them.
function computeGroomingFollowUpBuckets() {
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const buckets = { today: [], tomorrow: [], dayAfter: [] };
  state.incidents.forEach((it) => {
    if (it.deleted || !Array.isArray(it.issues)) return;
    it.issues.forEach((issue) => {
      if (issue.resolved) return;
      const row = {
        incidentId: it.id, issueId: issue.id,
        name: it.studentName, studentClass: it.studentClass,
        issueLabel: groomingIssueLabel(issue), stage: issue.stage,
        deadline: issue.deadline, entryDate: it.date,
      };
      // Today's bucket absorbs anything overdue too, so nothing due
      // earlier falls through the cracks; tomorrow and the day after
      // only show what's landing exactly on that date.
      if (issue.deadline <= today) buckets.today.push(row);
      else if (issue.deadline === tomorrow) buckets.tomorrow.push(row);
      else if (issue.deadline === dayAfter) buckets.dayAfter.push(row);
    });
  });
  Object.values(buckets).forEach((list) => list.sort((a, b) => a.deadline.localeCompare(b.deadline)));
  return buckets;
}
async function saveIncidentIssueUpdate(entry) {
  state.saving = true; render();
  try {
    await updateDoc(doc(db, "incidents", entry.id), { issues: entry.issues });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  finally { state.saving = false; render(); }
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
  if (step === "suspension") return !!(d.suspDraft.reason.trim() && d.suspDraft.totalDays && d.suspDraft.issDays + d.suspDraft.ossDays === d.suspDraft.totalDays && d.suspDraft.issDates.every((dt) => d.suspDraft.issVenues[dt]));
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
    if (d.suspDraft.issDays + d.suspDraft.ossDays !== d.suspDraft.totalDays) return "In-school and out-of-school days must add up to the total.";
    return `Book a location for all ${d.suspDraft.issDays} in-school day${d.suspDraft.issDays === 1 ? "" : "s"} before continuing (${d.suspDraft.issDates.filter((dt) => d.suspDraft.issVenues[dt]).length} booked so far).`;
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
  state.saveError = false;
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
      const issEntries = sd.issDates.map((date) => ({ date, type: "ISS", venue: sd.issVenues[date] || "" }));
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
    state.saveErrorDetail = err?.message || String(err);
  } finally {
    state.saving = false;
    render();
  }
}
async function submitNewIncident() {
  const container = document.getElementById("new-form");
  const d = state._newIncidentDraft;
  const studentName = (container.querySelector('[name="studentName"]')?.value || "").trim();
  const studentClass = container.querySelector('[name="studentClass"]')?.value || "";
  const date = container.querySelector('[name="date"]')?.value || d.date;
  const selectedIssues = d.selectedIssues || [];
  if (!studentName) { state.newIncidentFormError = "Enter the student's name."; render(); return; }
  if (!studentClass) { state.newIncidentFormError = "Select a class."; render(); return; }
  if (selectedIssues.length === 0) { state.newIncidentFormError = "Select at least one issue."; render(); return; }
  if (selectedIssues.includes("Others") && !(d.othersText || "").trim()) { state.newIncidentFormError = "Specify what \"Others\" means for this entry."; render(); return; }
  state.newIncidentFormError = "";
  state.saveError = false;
  state.saving = true;
  render();
  try {
    const now = Date.now();
    const issues = selectedIssues.map((type) => freshGroomingIssue(type, d.othersText, date, classLevel(studentClass)));
    const issueSummary = issues.map((x) => groomingIssueLabel(x)).join(", ");
    const docRef = await addDoc(collection(db, "incidents"), {
      studentName, studentClass, date, issues,
      linkedSuspensionIds: d.linkedSuspensionIds.slice(),
      linkedPmIds: d.linkedPmIds.slice(),
      loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
      history: [{ id: uid(), type: "created", detail: `Entry created — ${issueSummary}`, by: teacherName(), at: now }],
    });
    // Reflect the link on the other side too, so it shows up on the
    // suspension/meeting record itself, not just this new entry.
    for (const sId of d.linkedSuspensionIds) {
      try {
        await updateDoc(doc(db, "suspensions", sId), {
          linkedIncidentIds: arrayUnion(docRef.id),
          history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to grooming entry: "${issueSummary}"`, by: teacherName(), at: now }),
        });
      } catch (err) { /* non-fatal, main entry already saved */ }
    }
    for (const mId of d.linkedPmIds) {
      try {
        await updateDoc(doc(db, "parentMeetings", mId), {
          linkedIncidentIds: arrayUnion(docRef.id),
          history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to grooming entry: "${issueSummary}"`, by: teacherName(), at: now }),
        });
      } catch (err) { /* non-fatal */ }
    }
    state.showNewForm = false;
    state._newIncidentDraft = null;
    state.section = "log";
    state.disciplineFilter = "all";
    state.selectedIncidentId = docRef.id;
    state.entryExpanded[docRef.id] = true;
    syncIncidentToSheet({ id: docRef.id, studentName, studentClass, date, issue: issueSummary, actionTaken: "", status: "Monitoring", followUps: [], loggedBy: teacherName(), deleted: false });
  } catch (err) {
    state.saveError = true;
    state.saveErrorDetail = err?.message || String(err);
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
// After a permanent delete, briefly offer to undo it — this captures the
// full document data right before deletion so "undo" can recreate the
// exact same record (same id, same fields) rather than trying to guess
// at reconstructing it. The toast counts down visibly so it's clear
// exactly how long is left before the option disappears.
let undoToastInterval = null;
function clearUndoToastTimer() {
  if (undoToastInterval) { clearInterval(undoToastInterval); undoToastInterval = null; }
}
function showUndoToast(collectionName, id, data) {
  clearUndoToastTimer();
  state.undoToast = { collectionName, id, data, secondsLeft: 5 };
  render();
  undoToastInterval = setInterval(() => {
    if (!state.undoToast) { clearUndoToastTimer(); return; }
    state.undoToast.secondsLeft -= 1;
    if (state.undoToast.secondsLeft <= 0) { clearUndoToastTimer(); state.undoToast = null; }
    renderKeepingPageScroll();
  }, 1000);
}
async function undoLastDelete() {
  const t = state.undoToast;
  if (!t) return;
  clearUndoToastTimer();
  state.undoToast = null;
  try { await setDoc(doc(db, t.collectionName, t.id), t.data); }
  catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
async function deleteIncident(id) {
  const entry = state.incidents.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "incidents", id));
    if (entry) { const { id: _drop, ...data } = entry; showUndoToast("incidents", id, data); }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}
function openEditIncident(id) {
  const it = state.incidents.find((i) => i.id === id);
  if (!it) return;
  state.editingIncidentId = id;
  const existingIssues = Array.isArray(it.issues) ? it.issues : [];
  state._editIncidentDraft = {
    studentName: it.studentName, studentClass: it.studentClass, date: it.date,
    selectedIssues: existingIssues.map((x) => x.type),
    othersText: (existingIssues.find((x) => x.type === "Others") || {}).othersText || "",
  };
  state.newIncidentFormError = "";
  render();
}
async function submitEditIncident() {
  const d = state._editIncidentDraft;
  const it = state.incidents.find((i) => i.id === state.editingIncidentId);
  if (!it || !d) return;
  if (!d.studentName.trim()) { state.newIncidentFormError = "Enter the student's name."; render(); return; }
  if (!d.studentClass) { state.newIncidentFormError = "Select a class."; render(); return; }
  if (d.selectedIssues.length === 0) { state.newIncidentFormError = "Select at least one issue."; render(); return; }
  if (d.selectedIssues.includes("Others") && !(d.othersText || "").trim()) { state.newIncidentFormError = "Specify what \"Others\" means for this entry."; render(); return; }
  state.newIncidentFormError = "";
  state.saveError = false;
  state.saving = true;
  render();
  // Issues that are still selected keep their existing stage/deadline/
  // history untouched; newly-ticked issue types start fresh at 1st
  // Warning; anything unticked is dropped from the entry entirely.
  const existingIssues = Array.isArray(it.issues) ? it.issues : [];
  const keptIssues = existingIssues.filter((x) => d.selectedIssues.includes(x.type));
  const newTypes = d.selectedIssues.filter((type) => !existingIssues.some((x) => x.type === type));
  const newIssues = newTypes.map((type) => freshGroomingIssue(type, d.othersText, d.date, classLevel(d.studentClass)));
  const finalIssues = [...keptIssues, ...newIssues].map((x) => x.type === "Others" ? { ...x, othersText: d.othersText || "" } : x);
  const now = Date.now();
  try {
    await updateDoc(doc(db, "incidents", it.id), {
      studentName: d.studentName.trim(), studentClass: d.studentClass, date: d.date, issues: finalIssues,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Entry edited — issues now: ${finalIssues.map(groomingIssueLabel).join(", ")}`, by: teacherName(), at: now }),
    });
    state.editingIncidentId = null;
    state._editIncidentDraft = null;
    state.saving = false;
    render();
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
}

// ==================== SUSPENSIONS (new unified per-day model) ====================
function freshSuspDraft() {
  return {
    studentName: "", studentClass: "", reasonCategory: "", reasonOthersText: "", startDate: todayISO(),
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [], issOverridden: [], issVenues: {},
    tagPm: false, pmAttendees: [], pmOthersText: "", pmReasonCategory: "", pmReasonOthersText: "",
  };
}
// OSS dates are chosen (default to the earliest school days from the start
// date, each individually overridable via a calendar icon). ISS dates are
// *auto-derived* by default — whichever of the suspension's total school
// days aren't used for OSS — but any individual ISS day can also be
// manually overridden via its own calendar icon (tracked in
// d.issOverridden by slot index); an overridden slot keeps its date across
// further recalculation, while every other slot keeps auto-deriving.
function regenerateSuspDates(d) {
  const total = d.totalDays || 0;
  if (!total) { d.ossDates = []; d.issDates = []; d.issOverridden = []; d.issVenues = {}; return d; }
  const startDate = d.startDate || todayISO();
  const level = classLevel(d.studentClass);
  const defaultOss = schoolDayChain(startDate, d.ossDays || 0, level);
  if (!Array.isArray(d.ossDates)) d.ossDates = [];
  if (d.ossDates.length > d.ossDays) d.ossDates = d.ossDates.slice(0, d.ossDays);
  else if (d.ossDates.length < d.ossDays) {
    for (let i = d.ossDates.length; i < d.ossDays; i++) d.ossDates.push(defaultOss[i]);
  }

  if (!Array.isArray(d.issDates)) d.issDates = [];
  if (!Array.isArray(d.issOverridden)) d.issOverridden = [];
  if (d.issDates.length > d.issDays) { d.issDates = d.issDates.slice(0, d.issDays); d.issOverridden = d.issOverridden.slice(0, d.issDays); }

  const ossSet = new Set(d.ossDates);
  const keptOverrides = new Set();
  for (let i = 0; i < d.issDays; i++) {
    if (d.issOverridden[i] && d.issDates[i]) keptOverrides.add(d.issDates[i]);
  }
  let pool = schoolDayChain(startDate, total, level);
  let remaining = pool.filter((dt) => !ossSet.has(dt) && !keptOverrides.has(dt));
  const neededAuto = d.issDays - keptOverrides.size;
  while (remaining.length < neededAuto) {
    const next = nextSchoolDay(pool[pool.length - 1], level);
    pool.push(next);
    if (!ossSet.has(next) && !keptOverrides.has(next)) remaining.push(next);
  }
  let autoIdx = 0;
  const newIssDates = [];
  const newOverridden = [];
  for (let i = 0; i < d.issDays; i++) {
    if (d.issOverridden[i] && d.issDates[i]) {
      newIssDates.push(d.issDates[i]);
      newOverridden.push(true);
    } else {
      newIssDates.push(remaining[autoIdx]);
      newOverridden.push(false);
      autoIdx++;
    }
  }
  d.issDates = newIssDates;
  d.issOverridden = newOverridden;
  const keptVenues = {};
  d.issDates.forEach((dt) => { if (d.issVenues && d.issVenues[dt]) keptVenues[dt] = d.issVenues[dt]; });
  d.issVenues = keptVenues;
  return d;
}
// Who (if anyone) already occupies each location on a given date, excluding
// the suspension currently being edited (so it doesn't block itself).
const LOCATION_CAPACITY = { "General Office": 1, "MPR 1": 4 };
function locationAbbrev(loc) { return loc === "General Office" ? "GO" : loc; }
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekdayName(iso) { return WEEKDAY_NAMES[weekdayOf(iso)]; }
function locationOccupancyForDate(dateISO, excludeSuspensionId) {
  const occupants = {};
  LOCATION_OPTIONS.forEach((loc) => { occupants[loc] = []; });
  state.suspensions.forEach((s) => {
    if (s.deleted || s.id === excludeSuspensionId) return;
    suspensionDayEntries(s).forEach((e) => {
      if (e.type === "ISS" && e.date === dateISO && occupants[e.venue] !== undefined) {
        occupants[e.venue].push(s.studentName);
      }
    });
  });
  return LOCATION_OPTIONS.map((loc) => {
    const capacity = LOCATION_CAPACITY[loc] || 1;
    return { location: loc, occupants: occupants[loc], capacity, remaining: capacity - occupants[loc].length };
  });
}

async function submitNewSuspension(e) {
  e.preventDefault();
  const f = e.target;
  const d = state._suspDraft;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const reason = composeReasonValue(f, d);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.suspFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if (!d.issDates.every((dt) => d.issVenues[dt])) {
    state.suspFormError = `Book a location for all ${d.issDays} in-school day${d.issDays === 1 ? "" : "s"} before saving (${d.issDates.filter((dt) => d.issVenues[dt]).length} booked so far).`;
    render();
    return;
  }
  const pmReasonValue = d.tagPm ? composeReasonValue(f, d, "pmReason") : "";
  if (d.tagPm && (d.pmAttendees.length === 0 || !d.pmReasonCategory)) {
    state.suspFormError = "Fill in who's attending and the reason for the tagged parent meeting.";
    render();
    return;
  }
  state.suspFormError = "";
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: d.issVenues[date] || "",
  }));
  const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));
  state.saveError = false;
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
    if (d.tagPm) {
      try {
        const pmRef = await addDoc(collection(db, "parentMeetings"), {
          studentName, studentClass, date: d.startDate, attendees: d.pmAttendees.slice(),
          othersText: d.pmOthersText || "", reason: pmReasonValue,
          linkedSuspensionIds: [docRef.id],
          loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
          history: [{ id: uid(), type: "created", detail: "Parent meeting tagged from a suspension entry", by: teacherName(), at: now }],
        });
        await updateDoc(doc(db, "suspensions", docRef.id), { linkedPmIds: arrayUnion(pmRef.id) });
        syncParentMeetingToSheet({ id: pmRef.id, studentName, studentClass, date: d.startDate, attendees: d.pmAttendees, othersText: d.pmOthersText || "", reason: pmReasonValue, loggedBy: teacherName(), deleted: false });
      } catch (err) { /* non-fatal — suspension already saved */ }
    }
    state.showNewSuspForm = false;
    state._suspDraft = null;
    state.section = "suspensions";
    state.suspTab = "All";
    state.selectedSuspId = docRef.id;
    state.entryExpanded[docRef.id] = true;
    syncSuspensionToSheet({ id: docRef.id, studentName, studentClass, reason, startDate: d.startDate, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days, loggedBy: teacherName(), deleted: false });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
}
async function deleteSuspension(id) {
  const entry = state.suspensions.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "suspensions", id));
    if (entry) { const { id: _drop, ...data } = entry; showUndoToast("suspensions", id, data); }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
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
  const reasonSplit = splitSavedReason(s.reason);
  state._suspDraft = {
    studentName: s.studentName, studentClass: s.studentClass, reasonCategory: reasonSplit.category, reasonOthersText: reasonSplit.othersText,
    startDate: s.startDate || (entries[0] && entries[0].date) || todayISO(),
    totalDays: s.totalDays || entries.length, issDays: issDates.length, ossDays: ossDates.length,
    ossDates, issDates, issOverridden: issDates.map(() => false), issVenues,
  };
  state.suspFormError = "";
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
  const reason = composeReasonValue(f, d);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.suspFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if (!d.issDates.every((dt) => d.issVenues[dt])) {
    state.suspFormError = `Book a location for all ${d.issDays} in-school day${d.issDays === 1 ? "" : "s"} before saving (${d.issDates.filter((dt) => d.issVenues[dt]).length} booked so far).`;
    render();
    return;
  }
  state.suspFormError = "";
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: d.issVenues[date] || "",
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
  state.saveError = false;
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
  const split = splitSavedReason(m?.reason);
  return {
    studentName: m?.studentName || "", studentClass: m?.studentClass || "",
    date: m?.date || todayISO(), reasonCategory: split.category, reasonOthersText: split.othersText,
    attendees: (m?.attendees || []).slice(), othersText: m?.othersText || "",
  };
}
async function submitNewParentMeeting(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim();
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const reason = composeReasonValue(f, state._pmDraft);
  const attendees = state._pmDraft.attendees.slice();
  const othersText = state._pmDraft.othersText.trim();
  if (!studentName || !studentClass || !date || !reason || attendees.length === 0) {
    state.pmFormError = attendees.length === 0 ? "Select at least one attendee before saving." : "Fill in every required field before saving.";
    render();
    return;
  }
  state.pmFormError = "";
  state.saveError = false;
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
    state.section = "parentMeetings";
    state.pmTab = "All";
    state.selectedPmId = docRef.id;
    state.entryExpanded[docRef.id] = true;
    syncParentMeetingToSheet({ id: docRef.id, studentName, studentClass, date, reason, attendees, othersText, loggedBy: teacherName(), deleted: false });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
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
    date: f.date.value, reason: composeReasonValue(f, state._pmDraft),
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
  state.saveError = false;
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
  const entry = state.parentMeetings.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "parentMeetings", id));
    if (entry) { const { id: _drop, ...data } = entry; showUndoToast("parentMeetings", id, data); }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}

// ==================== RENDER ====================
function render() {
  if (!state.authReady) { root.innerHTML = `<div class="dd-center"><div class="dd-mono">Opening the log…</div></div>`; return; }
  if (!state.authUser) { root.innerHTML = renderSignInScreen(); attachSignInListeners(); return; }
  if (!state.teacherName) { root.innerHTML = renderNameScreen(); attachNameListeners(); return; }
  if (!state.dataLoaded || !state.suspLoaded || !state.pmLoaded) { root.innerHTML = `<div class="dd-center"><div class="dd-mono">Loading entries…</div></div>`; return; }
  updateFollowUpBadge();
  root.innerHTML = renderMain();
  attachMainListeners();
}
// Reflects the overdue/due-today grooming follow-up count in the browser
// tab title, and on the installed app's icon where the platform
// supports it — so it's visible without having the app open.
function updateFollowUpBadge() {
  const n = computeGroomingFollowUpBuckets().today.length;
  document.title = n > 0 ? `(${n}) Discipline Diary` : "Discipline Diary";
  if ("setAppBadge" in navigator) {
    try { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) { /* unsupported, non-fatal */ }
  }
}
function renderSignInScreen() {
  return `
    <div class="dd-app"><div class="dd-center">
      <div class="dd-auth-card">
        <div class="dd-title">Discipline Diary</div>
        <div class="dd-subtitle">Sign in with your school Google account to continue. Only @${ALLOWED_EMAIL_DOMAIN} accounts can access this app.</div>
        ${state.authError ? `<div class="dd-error" style="margin-bottom:12px">${escapeHtml(state.authError)}</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-google-signin">Sign in with Google</button>
      </div>
    </div></div>`;
}
function attachSignInListeners() {
  const btn = document.getElementById("btn-google-signin");
  if (btn) btn.addEventListener("click", signInWithGoogle);
}
function renderNameScreen() {
  return `
    <div class="dd-app"><div class="dd-center">
      <form id="name-form" class="dd-auth-card">
        <div class="dd-title">Discipline Diary</div>
        <div class="dd-subtitle">Signed in as ${escapeHtml(state.authUser?.email || "")}. What name should show on entries you log? <button type="button" class="dd-back-link" id="btn-signin-signout" style="display:inline">Not you? Sign out</button></div>
        <label class="dd-label">Your name</label>
        <input class="dd-input" name="name" placeholder="e.g. Mr. Adams" required autofocus />
        <button class="dd-btn-primary" type="submit">Enter the log</button>
      </form>
    </div></div>`;
}
function attachNameListeners() {
  document.getElementById("name-form").addEventListener("submit", handleNameSubmit);
  const signOutBtn = document.getElementById("btn-signin-signout");
  if (signOutBtn) signOutBtn.addEventListener("click", signOutOfApp);
}

function renderMain() {
  let html;
  if (state.section === "studentView") html = renderStudentView();
  else if (state.section === "dashboard") html = renderDashboardSection();
  else if (state.section === "log") html = renderLogSection();
  else if (state.section === "suspensions") html = renderSuspensionSection();
  else if (state.section === "settings") html = renderSettingsSection();
  else html = renderParentMeetingSection();
  if (state._publicHolidayDraft) html += renderPublicHolidayModal();
  if (state._schoolHolidayDraft) html += renderSchoolHolidayEditModal();
  if (state._extraSchoolHolidayDraft) html += renderExtraSchoolHolidayModal();
  if (state._closureModalDraft) html += renderClosureDayModal();
  html += state.confirmDeleteTarget ? renderDeleteConfirmModal() : "";
  html += state.undoToast ? renderUndoToast() : "";
  return html;
}
function renderUndoToast() {
  const secs = state.undoToast?.secondsLeft ?? 5;
  return `
    <div class="dd-undo-toast">
      <span>Entry deleted. <span class="dd-undo-countdown">${secs}s</span></span>
      <button type="button" id="btn-undo-delete">Undo</button>
    </div>`;
}

function renderNav() {
  const items = [
    { key: "log", label: "Grooming Log" },
    { key: "suspensions", label: "Suspension Log" },
    { key: "parentMeetings", label: "Parent Meeting" },
  ];
  return `
    <div class="dd-header" style="position:relative">
      <div class="dd-header-topright">
        <button class="dd-circle-btn" id="btn-help" title="How to use this app">?</button>
        <button class="dd-circle-btn ${state.section === "settings" ? "dd-recycle-active" : ""}" id="btn-settings" title="Settings">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button class="dd-circle-btn" id="btn-backup" title="Download a full backup as a file">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 19h16"></path></svg>
        </button>
      </div>
      <div class="dd-header-inner dd-header-title-row">
        <div>
          <div class="dd-header-title">Discipline Diary</div>
          <div class="dd-header-sub">Signed in as ${escapeHtml(teacherName())} · v${APP_VERSION}</div>
        </div>
      </div>
      <div class="dd-header-inner" style="margin-top:14px">
        <div style="display:flex;gap:6px;width:100%;align-items:center">
          <button class="dd-circle-btn dd-nav-home ${state.section === "dashboard" ? "active" : ""}" style="position:relative" data-action="set-section" data-section="dashboard" title="Dashboard">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h14V10"></path></svg>
            ${(() => { const n = computeGroomingFollowUpBuckets().today.length; return n > 0 ? `<span class="dd-nav-badge">${n > 9 ? "9+" : n}</span>` : ""; })()}
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
          <p>The home icon shows trend charts (Today/Week/Month/Term/Year views) and the Students' Watchlist — High/Medium/Low Risk, based on grooming warnings and suspensions this semester.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Grooming Log</div>
          <p>Pick one or more issues when logging an entry (Long Hair, Uniform, etc.) — each gets its own 1st/2nd/Final Warning countdown with its own deadline. Resolve an issue any time, or mark it unresolved to escalate to the next warning; deadlines can be moved if the student or parent proposes a different date. An entry only shows Resolved once every issue in it is resolved.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Suspension Log</div>
          <p>Set the total number of days, then how many are in-school vs out-of-school — the other side calculates itself. Pick the actual dates for each, and a location for in-school days. You can tag a Parent Meeting to a suspension right after entering its details.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Parent Meeting</div>
          <p>Log who attended (multiple people allowed) and why. "Others" lets you type in a specific relationship.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Editing, removing, backups</div>
          <p>Suspensions and Parent Meetings can be edited — changes are tracked in the audit trail. Removing asks for a password and only hides the entry; find it under the recycling-bin icon to restore, for 30 days. The backup icon (top right) downloads everything as a file.</p>
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
// All month keys (YYYY-MM) from `fromKey` to `toKey` inclusive.
// All days of a given YYYY-MM month, each with per-category counts.
// Suspension counts by actual day (from suspensionDayEntries), not just
// the start date, so a multi-day suspension shows on every day it covers.
const OSS_DOT_COLOR = "#A3372B";
// For the calendar's day-by-day dots — a multi-day suspension shows a dot
// on every day it actually covers, split by ISS (gold, matches the
// Suspension category color) vs OSS (red). This is purely visual; the
// tally total below still counts each suspension once (see
// suspensionEntryCountForMonth), consistent with the bar-graph views.
function computeDailyCountsForMonth(monthKeyStr) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const counts = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKeyStr}-${String(d).padStart(2, "0")}`;
    counts[iso] = { discipline: 0, suspensionISS: 0, suspensionOSS: 0, parentMeeting: 0 };
  }
  state.incidents.forEach((i) => { if (i.deleted) return; if (counts[i.date]) counts[i.date].discipline++; });
  state.suspensions.forEach((s) => {
    if (s.deleted) return;
    suspensionDayEntries(s).forEach((e) => {
      if (!counts[e.date]) return;
      if (e.type === "OSS") counts[e.date].suspensionOSS++;
      else counts[e.date].suspensionISS++;
    });
  });
  state.parentMeetings.forEach((m) => { if (m.deleted) return; if (counts[m.date]) counts[m.date].parentMeeting++; });
  return counts;
}
function suspensionEntryCountForMonth(monthKeyStr) {
  return state.suspensions.filter((s) => !s.deleted && monthKey(s.startDate) === monthKeyStr).length;
}
function shiftMonthKey(monthKeyStr, delta) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function currentMonthKeyStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}
function currentYearMonthKeys() {
  const y = new Date().getFullYear();
  return Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
}
// All month keys (YYYY-MM) from `fromKey` to `toKey` inclusive.
function monthKeysInRange(fromKey, toKey) {
  const [fy, fm] = fromKey.split("-").map(Number);
  const [ty, tm] = toKey.split("-").map(Number);
  const out = [];
  let y = fy, m = fm;
  let guard = 0; // safety cap so a reversed range can't runaway-loop
  while ((y < ty || (y === ty && m <= tm)) && guard < 240) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
    guard++;
  }
  return out.length ? out : [fromKey];
}
// Options for the custom range's From/To dropdowns — 24 months back to 12
// months ahead of today, a generous span without being unbounded.
function chartMonthOptionKeys() {
  const out = [];
  const now = new Date();
  for (let i = -24; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function dateDiffDays(fromISO, toISO) {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}
function weekLabelForMonday(monday) {
  const year = parseInt(monday.slice(0, 4), 10);
  const moe = computeMoeCalendar(year);
  for (let i = 0; i < moe.terms.length; i++) {
    const t = moe.terms[i];
    if (monday >= t.start && monday <= t.end) {
      const weekNum = Math.floor(dateDiffDays(t.start, monday) / 7) + 1;
      return `Term ${i + 1} Week ${weekNum}`;
    }
  }
  return "School Holidays";
}
function monthKeysForTerm(termIndex) {
  const year = new Date().getFullYear();
  const moe = computeMoeCalendar(year);
  const term = moe.terms[termIndex];
  return monthKeysInRange(monthKey(term.start), monthKey(term.end));
}
function chartRangeKeys() {
  switch (state.chartRangeMode) {
    case "term1": return monthKeysForTerm(0);
    case "term2": return monthKeysForTerm(1);
    case "term3": return monthKeysForTerm(2);
    case "term4": return monthKeysForTerm(3);
    case "thisYear": return currentYearMonthKeys();
    case "custom": return monthKeysInRange(state.chartCustomFrom, state.chartCustomTo);
    default: return lastNMonthKeys(3);
  }
}
function computeMonthlyTrend() {
  const keys = chartRangeKeys();
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
const CHART_RANGE_OPTIONS_PRIMARY = [
  { key: "today", label: "Day" },
  { key: "thisWeek", label: "Week" },
  { key: "thisMonth", label: "Month" },
  { key: "thisYear", label: "Year" },
];
const CHART_RANGE_OPTIONS_SECONDARY = [
  { key: "term1", label: "Term 1" },
  { key: "term2", label: "Term 2" },
  { key: "term3", label: "Term 3" },
  { key: "term4", label: "Term 4" },
  { key: "custom", label: "Custom" },
];
const CHART_RANGE_OPTIONS = [...CHART_RANGE_OPTIONS_PRIMARY, ...CHART_RANGE_OPTIONS_SECONDARY];
const CATEGORY_META = {
  discipline: { label: "Grooming", checkboxLabel: "Grooming" },
  suspension: { label: "Suspension", checkboxLabel: "Suspension" },
  parentMeeting: { label: "Parent Meeting", checkboxLabel: "Parent Meeting" },
};
function renderCategoryToggles(incl) {
  const cats = [
    { key: "discipline", label: "Grooming Issue" },
    { key: "suspension", label: "Suspension" },
    { key: "parentMeeting", label: "Parent Meeting" },
  ];
  return `
    <div class="dd-show-box">
      <div class="dd-show-header">Show…</div>
      <div class="dd-show-buttons">
        ${cats.map((c) => `<button type="button" class="dd-show-btn ${incl[c.key] ? "active" : ""}" data-action="toggle-chart-cat" data-cat="${c.key}" style="${incl[c.key] ? `background:${CHART_COLORS[c.key]};border-color:${CHART_COLORS[c.key]}` : ""}">${c.label}</button>`).join("")}
      </div>
    </div>`;
}
// Shared across Discipline/Suspension/Parent Meeting logs: a row of 6
// level counters (P1-P6), one of which can be expanded into a table of
// that level's classes vs the current year's four school terms. Only one
// level stays expanded at a time (per page — each page tracks its own).
// ---------- Annual Summary Reports ----------
function availableReportYears() {
  const years = new Set([new Date().getFullYear()]);
  state.incidents.forEach((i) => { if (!i.deleted && i.date) years.add(parseInt(i.date.slice(0, 4), 10)); });
  state.suspensions.forEach((s) => { if (!s.deleted && s.startDate) years.add(parseInt(s.startDate.slice(0, 4), 10)); });
  state.parentMeetings.forEach((m) => { if (!m.deleted && m.date) years.add(parseInt(m.date.slice(0, 4), 10)); });
  return Array.from(years).sort((a, b) => b - a);
}
function computeYearlyCategoryTotals(year) {
  const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`)).length;
  const parentMeeting = state.parentMeetings.filter((m) => !m.deleted && m.date && m.date.startsWith(`${year}-`)).length;
  const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`)).length;
  return { discipline, suspension, parentMeeting };
}
function computeYearMonthlyTrend(year) {
  const keys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const counts = {};
  keys.forEach((k) => { counts[k] = { discipline: 0, suspension: 0, parentMeeting: 0 }; });
  state.incidents.forEach((i) => { if (i.deleted) return; const k = monthKey(i.date); if (counts[k]) counts[k].discipline++; });
  state.suspensions.forEach((s) => { if (s.deleted) return; const k = monthKey(s.startDate); if (counts[k]) counts[k].suspension++; });
  state.parentMeetings.forEach((m) => { if (m.deleted) return; const k = monthKey(m.date); if (counts[k]) counts[k].parentMeeting++; });
  return keys.map((k) => ({ label: monthLabelFromKey(k), ...counts[k] }));
}
function computeYearTermTrend(year) {
  const moe = computeMoeCalendar(year);
  return moe.terms.map((t) => ({
    label: t.label,
    discipline: state.incidents.filter((i) => !i.deleted && i.date >= t.start && i.date <= t.end).length,
    suspension: state.suspensions.filter((s) => !s.deleted && s.startDate >= t.start && s.startDate <= t.end).length,
    parentMeeting: state.parentMeetings.filter((m) => !m.deleted && m.date >= t.start && m.date <= t.end).length,
  }));
}
function computeYearLevelRanking(year) {
  return [1, 2, 3, 4, 5, 6].map((lvl) => {
    const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`) && classLevel(i.studentClass) === lvl).length;
    const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`) && classLevel(s.studentClass) === lvl).length;
    return { label: `P${lvl}`, discipline, suspension, total: discipline + suspension };
  }).sort((a, b) => b.total - a.total);
}
function computeYearClassRanking(year) {
  return CLASS_OPTIONS.map((cls) => {
    const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`) && i.studentClass === cls).length;
    const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`) && s.studentClass === cls).length;
    return { label: cls, discipline, suspension, total: discipline + suspension };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
}
// Builds the plain-language trend paragraph for the Annual Summary
// Report: how each category moved term-to-term within the year, which
// grooming issue type came up most, and how the year compares to the
// one before it. Everything here is computed from actual counts —
// there's no AI writing involved, just a template filled in from data,
// so the numbers it cites are always traceable back to real records.
function describeTrend(firstCount, lastCount) {
  if (firstCount === 0 && lastCount === 0) return "stayed flat";
  if (lastCount > firstCount) return "trended upward";
  if (lastCount < firstCount) return "trended downward";
  return "stayed roughly level";
}
function computeTopGroomingIssueType(year) {
  const tally = {};
  state.incidents.forEach((it) => {
    if (it.deleted || !it.date || !it.date.startsWith(`${year}-`) || !Array.isArray(it.issues)) return;
    it.issues.forEach((issue) => { tally[issue.type] = (tally[issue.type] || 0) + 1; });
  });
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  return sorted.length ? { type: sorted[0][0], count: sorted[0][1] } : null;
}
function pctChangeLabel(prev, curr) {
  if (prev === 0 && curr === 0) return "no change";
  if (prev === 0) return `up from 0 to ${curr}`;
  const pct = Math.round(((curr - prev) / prev) * 100);
  if (pct === 0) return "no real change";
  return `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% (${prev} → ${curr})`;
}
function computeYearNarrative(year) {
  const terms = computeYearTermTrend(year);
  const thisYear = computeYearlyCategoryTotals(year);
  const lastYear = computeYearlyCategoryTotals(year - 1);
  const hasLastYear = lastYear.discipline + lastYear.suspension + lastYear.parentMeeting > 0;
  const topIssue = computeTopGroomingIssueType(year);
  const levelRanking = computeYearLevelRanking(year);
  const classRanking = computeYearClassRanking(year);

  const withinYear = terms.every((t) => t.discipline + t.suspension + t.parentMeeting === 0)
    ? `No grooming, suspension, or parent meeting entries were logged for ${year} yet, so a within-year trend can't be drawn.`
    : `Across the four terms, grooming issues ${describeTrend(terms[0].discipline, terms[3].discipline)} (Term 1: ${terms[0].discipline}, Term 4: ${terms[3].discipline}), suspensions ${describeTrend(terms[0].suspension, terms[3].suspension)} (Term 1: ${terms[0].suspension}, Term 4: ${terms[3].suspension}), and parent meetings ${describeTrend(terms[0].parentMeeting, terms[3].parentMeeting)} (Term 1: ${terms[0].parentMeeting}, Term 4: ${terms[3].parentMeeting}).` +
      (topIssue ? ` The most common grooming issue this year was ${escapeHtml(topIssue.type)}, logged ${topIssue.count} time${topIssue.count === 1 ? "" : "s"}.` : "");

  const acrossYears = !hasLastYear
    ? `There isn't a prior year on record yet to compare ${year} against.`
    : `Compared to ${year - 1}, grooming issues are ${pctChangeLabel(lastYear.discipline, thisYear.discipline)}, suspensions are ${pctChangeLabel(lastYear.suspension, thisYear.suspension)}, and parent meetings are ${pctChangeLabel(lastYear.parentMeeting, thisYear.parentMeeting)}.`;

  const improvements = [];
  const concerns = [];
  if (terms.length === 4) {
    if (terms[3].discipline < terms[0].discipline) improvements.push("grooming issues eased off by Term 4 compared to Term 1");
    else if (terms[3].discipline > terms[0].discipline) concerns.push("grooming issues were higher in Term 4 than Term 1 — worth watching whether this continues into next year");
    if (terms[3].suspension < terms[0].suspension) improvements.push("suspensions were less frequent by Term 4");
    else if (terms[3].suspension > terms[0].suspension) concerns.push("suspensions picked up later in the year rather than easing off");
  }
  if (hasLastYear) {
    if (thisYear.discipline + thisYear.suspension < lastYear.discipline + lastYear.suspension) improvements.push(`overall discipline cases (grooming + suspensions) are down from ${year - 1}`);
    else if (thisYear.discipline + thisYear.suspension > lastYear.discipline + lastYear.suspension) concerns.push(`overall discipline cases (grooming + suspensions) are up from ${year - 1}`);
  }
  if (levelRanking.length) concerns.push(`${levelRanking[0].label} recorded the most cases of any level (${levelRanking[0].discipline + levelRanking[0].suspension} combined) and may benefit from closer attention`);
  if (classRanking.length) concerns.push(`${classRanking[0].label} was the single most-flagged class this year (${classRanking[0].total} combined cases)`);

  const improvementsPara = improvements.length ? `Improvements: ${improvements.join("; ")}.` : "No clear year-over-year or in-year improvement stood out from the numbers alone.";
  const concernsPara = concerns.length ? `Areas for improvement: ${concerns.join("; ")}.` : "No particular class or level stood out as needing extra attention this year.";

  return { withinYear, acrossYears, improvementsPara, concernsPara };
}

function computeYearSuspensionRoster(year) {
  const rows = {};
  state.suspensions.forEach((s) => {
    if (s.deleted || !s.startDate || !s.startDate.startsWith(`${year}-`)) return;
    rows[s.studentName] = rows[s.studentName] || { name: s.studentName, cls: s.studentClass, count: 0 };
    rows[s.studentName].count++;
    rows[s.studentName].cls = s.studentClass || rows[s.studentName].cls;
  });
  return Object.values(rows).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function renderReportBarRows(rows) {
  const cats = [
    { key: "discipline", label: "Grooming Issue" },
    { key: "suspension", label: "Suspension" },
    { key: "parentMeeting", label: "Parent Meeting" },
  ];
  const rawMax = Math.max(1, ...rows.flatMap((r) => cats.map((c) => r[c.key])));
  const axisMax = niceAxisMax(rawMax);
  const pct = (v) => Math.max(v > 0 ? 3 : 0, Math.round((v / axisMax) * 100));
  const ticks = [0, axisMax * 0.25, axisMax * 0.5, axisMax * 0.75, axisMax].map((n) => Math.round(n));
  return `
    <div class="dd-chart-hrow" style="margin-bottom:10px">
      <span class="dd-chart-dot" style="background:transparent"></span>
      <div class="dd-chart-axis-track">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
      <span class="dd-chart-hval"></span>
    </div>
    <div class="dd-chart-rows">
      ${rows.map((r) => {
        const total = cats.reduce((s, c) => s + r[c.key], 0);
        return `
        <div class="dd-chart-row-block">
          <div class="dd-chart-row-header"><span class="dd-chart-row-month">${r.label}</span><span class="dd-chart-row-total">${total}</span></div>
          ${cats.map((c) => `
            <div class="dd-chart-hrow">
              <span class="dd-chart-dot" style="background:${CHART_COLORS[c.key]}"></span>
              <div class="dd-chart-hbar-track"><div class="dd-chart-hbar" style="width:${pct(r[c.key])}%;background:${CHART_COLORS[c.key]}"></div></div>
              <span class="dd-chart-hval">${r[c.key]}</span>
            </div>`).join("")}
        </div>`;
      }).join("")}
    </div>`;
}
function renderRankingList(rows) {
  if (!rows.length) return `<div class="dd-dash-empty">No entries this year.</div>`;
  return `
    <div style="display:flex;flex-direction:column;gap:6px">
      ${rows.map((r) => `
        <div class="dd-rank-row">
          <div class="dd-rank-label">${escapeHtml(r.label)}</div>
          <div class="dd-rank-total">${r.total}</div>
          <div class="dd-rank-detail">${r.discipline} discipline · ${r.suspension} suspension</div>
        </div>`).join("")}
    </div>`;
}
function formatDateOrRange(start, end) {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}
// One calendar-icon row for a single date field.
function renderDateField(id, value, extraAttrs) {
  return `
    <div class="dd-issue-due-row">
      <div class="dd-date-icon-btn" title="Change this date">
        <input type="date" class="dd-input" id="${id}" value="${value}" ${extraAttrs || ""} />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
      </div>
      <span class="dd-sans" style="font-size:15px">${formatDate(value)}</span>
    </div>`;
}
// Shared start/end range picker — same layout everywhere a date range is
// picked (public holidays, school holidays, closure/HBL days). The end
// date is never allowed to go earlier than the start date; if they end up
// equal, it's saved and displayed as a single day, not a range.
function renderDateRangeFields(idPrefix, startVal, endVal) {
  return `
    <label class="dd-label" style="margin-top:0">Start date</label>
    ${renderDateField(`${idPrefix}-start`, startVal)}
    <label class="dd-label">End date</label>
    ${renderDateField(`${idPrefix}-end`, endVal, `min="${startVal}"`)}`;
}
function renderSettingsSection() {
  const backBtn = (label, action) => `<button type="button" class="dd-back-link" data-action="${action}">← ${label}</button>`;
  let body;
  if (state.settingsView === "yearReport" && state.settingsSelectedYear) {
    const year = state.settingsSelectedYear;
    const totals = computeYearlyCategoryTotals(year);
    body = `
      <div class="dd-print-hide" style="display:flex;justify-content:space-between;align-items:flex-start">
        ${backBtn("Years", "settings-back-to-years")}
        <button type="button" class="dd-print-btn" id="btn-print-report">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"></path><rect x="4" y="9" width="16" height="8" rx="1.5"></rect><path d="M6 14h12v7H6z"></path></svg>
          <span>Print/<br>Export PDF</span>
        </button>
      </div>
      <div style="margin:10px 0">
        <div class="dd-dash-title" style="color:#1B2A41;margin:0">Annual Summary — ${year}</div>
      </div>
      <div id="report-print-area">
      ${renderTallyGrid(["discipline", "suspension", "parentMeeting"], totals)}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By term</div>
      <div class="dd-level-breakdown">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class">Term</div>
          <div class="dd-level-cell-term">Grooming</div><div class="dd-level-cell-term">Suspension</div><div class="dd-level-cell-term">Meeting</div>
        </div>
        ${computeYearTermTrend(year).map((t) => `
          <div class="dd-level-row">
            <div class="dd-level-cell-class">${t.label}</div>
            <div class="dd-level-cell-term">${t.discipline}</div><div class="dd-level-cell-term">${t.suspension}</div><div class="dd-level-cell-term">${t.parentMeeting}</div>
          </div>`).join("")}
      </div>
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By month</div>
      ${renderReportBarRows(computeYearMonthlyTrend(year))}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By term (chart)</div>
      ${renderReportBarRows(computeYearTermTrend(year))}
      ${(() => {
        const n = computeYearNarrative(year);
        return `
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Trend analysis</div>
      <div class="dd-panel" style="background:#F7F5EE;border:1px solid #E4E1D4;padding:12px;margin-bottom:4px">
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 10px">${n.withinYear}</p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 10px">${n.acrossYears}</p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 8px"><b>${n.improvementsPara}</b></p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0">${n.concernsPara}</p>
      </div>`;
      })()}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Most challenging levels</div>
      ${renderRankingList(computeYearLevelRanking(year))}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Most challenging classes</div>
      ${renderRankingList(computeYearClassRanking(year))}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">All suspensions this year</div>
      ${(() => {
        const roster = computeYearSuspensionRoster(year);
        if (!roster.length) return `<div class="dd-dash-empty">No suspensions this year.</div>`;
        return `<div style="display:flex;flex-direction:column;gap:6px">
          ${roster.map((r) => `
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #E4E1D4;padding-bottom:6px">
              <div class="dd-sans" style="font-size:14px">${escapeHtml(truncateName(r.name))}${r.cls ? ` <span class="dd-mono-muted" style="font-size:11px">Class ${escapeHtml(r.cls)}</span>` : ""}</div>
              <span class="dd-mono-muted" style="font-size:12px">${r.count} suspension${r.count === 1 ? "" : "s"}</span>
            </div>`).join("")}
        </div>`;
      })()}
      </div>`;
  } else if (state.settingsView === "yearList") {
    const years = availableReportYears();
    body = `
      ${backBtn("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Annual Summary Reports</div>
      <div class="dd-settings-menu-group">
        ${years.map((y) => `<button type="button" class="dd-settings-menu-row" data-action="settings-open-year" data-year="${y}"><span>${y}</span><span class="dd-settings-chevron">›</span></button>`).join("")}
      </div>`;
  } else if (state.settingsView === "classesForYear") {
    const year = new Date().getFullYear();
    const draft = state._classDraft || classOptionsForCurrentYear();
    body = `
      ${backBtn("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Classes For ${year}</div>
      <div class="dd-mono-muted" style="font-size:12px;margin-bottom:12px">
        Only ticked classes will show up in the class dropdown when logging an entry this year. Untick any that don't exist this year (e.g. after re-streaming); tick any new ones.
      </div>
      <div class="dd-issue-grid">
        ${CLASS_OPTIONS.map((c) => `
          <label class="dd-checkbox-pill" style="display:flex">
            <input type="checkbox" class="dd-class-year-cb" value="${c}" ${draft.includes(c) ? "checked" : ""} />
            <span>${c}</span>
          </label>`).join("")}
      </div>
      ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
      <button class="dd-btn-primary" type="button" id="btn-save-class-config" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : `Save for ${year}`}</button>`;
  } else if (state.settingsView === "holidays") {
    const year = new Date().getFullYear();
    const moe = computeMoeCalendar(year);
    const phEntries = (state.holidays?.publicHolidayEntries || []).filter((e) => e.startDate.startsWith(String(year))).sort((a, b) => a.startDate.localeCompare(b.startDate));
    const closureEntries = (state.schoolClosureDays?.entries || [])
      .map((e) => ({ ...e, startDate: e.startDate || e.date, endDate: e.endDate || e.date }))
      .filter((e) => e.startDate && e.startDate.startsWith(String(year)))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    const sectionHead = (label, addAction) => `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px">
        <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:0">${label}</div>
        ${addAction ? `<button type="button" class="dd-settings-add-btn" data-action="${addAction}">+</button>` : ""}
      </div>`;
    const listRow = (title, sub, editAction, editData, deleteAction, deleteId) => `
      <div class="dd-settings-list-row">
        <button type="button" class="dd-date-icon-btn" data-action="${editAction}" ${editData || ""} title="Adjust">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
        </button>
        <div style="flex:1;min-width:0">
          <div class="dd-sans" style="font-size:14px">${escapeHtml(title)}</div>
          <div class="dd-mono-muted" style="font-size:12px">${sub}</div>
        </div>
        ${deleteAction ? `<button class="dd-followup-icon-btn" data-action="${deleteAction}" data-id="${deleteId}" title="Remove">✕</button>` : ""}
      </div>`;
    const rangeKeys = ["march", "june", "sep", "yearEnd"];
    const singleDayKeys = ["youthDay", "teachersDay", "childrensDay", "nationalDayInLieu"];
    body = `
      ${backBtn("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Setting Holidays/School Closure/HBL Days</div>

      ${sectionHead("Public Holidays", "open-add-public-holiday")}
      ${phEntries.length === 0 ? `<div class="dd-dash-empty">None added yet.</div>` : phEntries.map((e) => listRow(
        e.name, formatDateOrRange(e.startDate, e.endDate),
        "edit-public-holiday", `data-id="${e.id}"`,
        "request-delete-public-holiday", e.id
      )).join("")}
      <button type="button" class="dd-back-link" id="btn-load-known-holidays" style="margin-top:8px">Load known public holidays (2026 &amp; 2027)</button>

      ${sectionHead("School Holidays", "open-add-school-holiday")}
      ${moe.ranges.map((r, i) => listRow(r.label, formatDateOrRange(r.start, r.end), "edit-school-holiday", `data-key="${rangeKeys[i]}" data-range="true" data-label="${escapeHtml(r.label)}" data-start="${r.start}" data-end="${r.end}"`, null, null)).join("")}
      ${(state.schoolCalendarOverrides?.[year]?.extraHolidays || []).map((e) => listRow(e.name, formatDateOrRange(e.startDate, e.endDate), "edit-extra-school-holiday", `data-id="${e.id}"`, "request-delete-extra-school-holiday", e.id)).join("")}
      ${moe.singleDays.map((d, i) => ({ d, label: moe.singleDayLabels[i], key: singleDayKeys[i] }))
        .filter(({ label, d }) => label !== "National Day (in lieu)" || !publicHolidayEntryFor(d))
        .map(({ d, label, key }) => listRow(label, formatDate(d), "edit-school-holiday", `data-key="${key}" data-range="false" data-label="${escapeHtml(label)}" data-start="${d}" data-end="${d}"`, null, null)).join("")}

      ${sectionHead("School Closure / HBL Days", "open-add-closure-day")}
      ${closureEntries.length === 0 ? `<div class="dd-dash-empty">None added yet.</div>` : closureEntries.map((e) => listRow(
        e.levels.length === 6 ? "School Closure" : e.levels.map((l) => "P" + l).join("/") + " HBL",
        formatDateOrRange(e.startDate, e.endDate),
        "edit-closure-day", `data-id="${e.id}"`,
        "request-delete-closure-day", e.id
      )).join("")}`;
  } else if (state.settingsView === "userList") {
    const users = (state.userList || []).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    body = `
      ${backBtn("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">User List</div>
      ${users.length === 0 ? `<div class="dd-dash-empty">No one has signed in yet.</div>` : `
      <div class="dd-level-breakdown">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class">Name</div>
          <div class="dd-level-cell-term">Email</div>
        </div>
        ${users.map((u) => `
        <div class="dd-level-row">
          <div class="dd-level-cell-class">${escapeHtml(u.name || "—")}</div>
          <div class="dd-level-cell-term" style="text-align:left">${escapeHtml(u.email || "—")}</div>
        </div>`).join("")}
      </div>`}`;
  } else {
    const year = new Date().getFullYear();
    const needsReview = !state.classConfig?.classesByYear?.[String(year)];
    const menuRow = (label, action) => `<button type="button" class="dd-settings-menu-row" data-action="${action}"><span>${label}</span><span class="dd-settings-chevron">›</span></button>`;
    body = `
      <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px">Settings</div>
      ${needsReview ? `<div class="dd-error" style="margin-bottom:10px">Classes for ${year} haven't been reviewed yet — pick which classes are active this year below.</div>` : ""}
      <div class="dd-settings-menu-group">
        ${menuRow("Annual Summary Reports", "settings-open-years")}
        ${menuRow("Classes For The Year", "settings-open-classes")}
        ${menuRow("Setting Holidays/School Closure/HBL Days", "settings-open-holidays")}
        ${menuRow("User List", "settings-open-users")}
      </div>
      <button type="button" class="dd-back-link" id="btn-app-sign-out" style="margin-top:16px">Sign out</button>`;
  }
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <div class="dd-panel">${body}</div>
      </div>
    </div>`;
}
// Shown where "Sort by" used to be, only once a level is selected: one
// equally-sized pill per class in that level (this year's active classes
// only), letting the list be narrowed to a single class on top of the
// level filter already in effect.
function renderClassPillsRow(pageKey, level) {
  const classes = classOptionsForCurrentYear().filter((c) => classLevel(c) === level);
  if (!classes.length) return "";
  const selected = state[`${pageKey}SelectedClass`] || null;
  return `
    <div class="dd-range-pills" style="flex-wrap:nowrap;margin-bottom:14px">
      ${classes.map((c) => `<button type="button" class="dd-range-pill${selected === c ? " active" : ""}" style="flex:1" data-action="select-class-pill" data-page="${pageKey}" data-class="${c}">${c}</button>`).join("")}
    </div>`;
}
function renderLevelBreakdown(pageKey, items, dateField) {
  const year = new Date().getFullYear();
  const moe = computeMoeCalendar(year);
  const today = todayISO();
  const active = items.filter((it) => !it.deleted);
  const levelCounts = [1, 2, 3, 4, 5, 6].map((lvl) => ({
    level: lvl,
    count: active.filter((it) => classLevel(it.studentClass) === lvl).length,
  }));
  const expandedLevel = state[`${pageKey}ExpandedLevel`] || null;
  const countersHtml = `
    <div class="dd-level-counters">
      ${levelCounts.map((lc) => `
        <button type="button" class="dd-level-btn ${expandedLevel === lc.level ? "active" : ""}" data-action="toggle-level" data-page="${pageKey}" data-level="${lc.level}">
          <div class="dd-level-num">P${lc.level}</div>
          <div class="dd-level-count">${lc.count}</div>
        </button>`).join("")}
    </div>`;
  if (!expandedLevel) return countersHtml;
  const classes = classOptionsForCurrentYear().filter((c) => classLevel(c) === expandedLevel);
  const termCountFor = (cls, t) => (t.start > today ? null : active.filter((it) => it.studentClass === cls && it[dateField] >= t.start && it[dateField] <= t.end).length);
  const rowTotals = classes.map((cls) => moe.terms.reduce((sum, t) => sum + (termCountFor(cls, t) || 0), 0));
  const colTotals = moe.terms.map((t) => classes.reduce((sum, cls) => sum + (termCountFor(cls, t) || 0), 0));
  const grandTotal = rowTotals.reduce((a, b) => a + b, 0);
  const breakdownHtml = `
    <div class="dd-level-breakdown">
      <div class="dd-level-row dd-level-row-header">
        <div class="dd-level-cell-class">Class</div>
        ${moe.terms.map((t) => `<div class="dd-level-cell-term">${t.label}</div>`).join("")}
        <div class="dd-level-cell-term">Total</div>
      </div>
      ${classes.map((cls, i) => `
        <div class="dd-level-row">
          <div class="dd-level-cell-class">${cls}</div>
          ${moe.terms.map((t) => {
            const n = termCountFor(cls, t);
            return `<div class="dd-level-cell-term">${n === null ? "" : n}</div>`;
          }).join("")}
          <div class="dd-level-cell-term dd-level-cell-total">${rowTotals[i]}</div>
        </div>`).join("")}
      <div class="dd-level-row dd-level-row-total">
        <div class="dd-level-cell-class">Total</div>
        ${colTotals.map((n) => `<div class="dd-level-cell-term">${n}</div>`).join("")}
        <div class="dd-level-cell-term dd-level-cell-total">${grandTotal}</div>
      </div>
    </div>`;
  return countersHtml + breakdownHtml;
}
function renderTallyGrid(cats, totals) {
  if (!cats.length) return `<div class="dd-dash-empty">Nothing selected above.</div>`;
  return `
    <div class="dd-tally-grid" style="grid-template-columns:repeat(${cats.length}, 1fr)">
      ${cats.map((c) => `
        <div class="dd-tally-col">
          <div class="dd-tally-label" style="color:${CHART_COLORS[c]}">${CATEGORY_META[c].label}</div>
          <div class="dd-tally-number" style="color:${CHART_COLORS[c]}">${totals[c]}</div>
        </div>`).join("")}
    </div>`;
}
function renderDayDetail(dateISO, incl) {
  if (!dateISO) return "";
  const items = [];
  if (incl.discipline) {
    state.incidents.forEach((i) => { if (!i.deleted && i.date === dateISO) items.push({ type: "discipline", name: i.studentName, cls: i.studentClass }); });
  }
  if (incl.suspension) {
    state.suspensions.forEach((s) => {
      if (s.deleted) return;
      suspensionDayEntries(s).forEach((e) => {
        if (e.date === dateISO) items.push({ type: e.type === "OSS" ? "oss" : "iss", name: s.studentName, cls: s.studentClass, location: e.venue });
      });
    });
  }
  if (incl.parentMeeting) {
    state.parentMeetings.forEach((m) => { if (!m.deleted && m.date === dateISO) items.push({ type: "parentMeeting", name: m.studentName, cls: m.studentClass }); });
  }
  const typeOrder = { discipline: 0, iss: 1, oss: 2, parentMeeting: 3 };
  items.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (classLevel(a.cls) - classLevel(b.cls)));
  const typeColor = { discipline: CHART_COLORS.discipline, iss: CHART_COLORS.suspension, oss: OSS_DOT_COLOR, parentMeeting: CHART_COLORS.parentMeeting };
  return `
    <div class="dd-day-detail">
      <div class="dd-day-detail-title">${formatDate(dateISO)}</div>
      ${items.length === 0 ? `<div class="dd-mono-muted" style="font-size:12px;font-style:italic">Nothing logged this day.</div>` : items.map((it) => `
        <div class="dd-day-detail-row">
          <span class="dd-cal-dot" style="background:${typeColor[it.type]}"></span>
          <span class="dd-day-detail-name">${escapeHtml(it.name)}</span>
          <span class="dd-day-detail-class">${escapeHtml(it.cls || "")}</span>
          ${it.location ? `<span class="dd-day-detail-location">${escapeHtml(it.location)}</span>` : ""}
        </div>`).join("")}
    </div>`;
}
// Per-day breakdown, split ISS/OSS like the month calendar — used for
// Today, and for each day-cell in the This Week view.
function computeCountsForDate(dateISO) {
  const c = { discipline: 0, suspensionISS: 0, suspensionOSS: 0, parentMeeting: 0 };
  state.incidents.forEach((i) => { if (!i.deleted && i.date === dateISO) c.discipline++; });
  state.suspensions.forEach((s) => {
    if (s.deleted) return;
    suspensionDayEntries(s).forEach((e) => { if (e.date === dateISO) { if (e.type === "OSS") c.suspensionOSS++; else c.suspensionISS++; } });
  });
  state.parentMeetings.forEach((m) => { if (!m.deleted && m.date === dateISO) c.parentMeeting++; });
  return c;
}
function suspensionEntryCountForRange(fromISO, toISO) {
  return state.suspensions.filter((s) => !s.deleted && s.startDate >= fromISO && s.startDate <= toISO).length;
}
function renderCalLegend(incl) {
  const legendLeft = [];
  const legendRight = [];
  if (incl.discipline) legendLeft.push({ color: CHART_COLORS.discipline, label: "Grooming Issue" });
  if (incl.parentMeeting) legendLeft.push({ color: CHART_COLORS.parentMeeting, label: "Parent Meeting" });
  if (incl.suspension) legendRight.push({ color: CHART_COLORS.suspension, label: "In-School Suspension", square: true });
  if (incl.suspension) legendRight.push({ color: OSS_DOT_COLOR, label: "Out-of-School Suspension", square: true });
  const col = (items) => items.map((li) => `<div class="dd-cal-legend-item"><span class="dd-cal-dot${li.square ? " dd-cal-dot-suspension" : ""}" style="background:${li.color}"></span>${li.label}</div>`).join("");
  if (!legendLeft.length && !legendRight.length) return "";
  return `<div class="dd-cal-legend dd-cal-legend-2col"><div class="dd-cal-legend-col">${col(legendLeft)}</div><div class="dd-cal-legend-col">${col(legendRight)}</div></div>`;
}
function renderTodayView(incl) {
  const viewDate = state.dayViewDate || todayISO();
  const c = computeCountsForDate(viewDate);
  const totals = { discipline: c.discipline, suspension: c.suspensionISS + c.suspensionOSS, parentMeeting: c.parentMeeting };
  const cats = ["discipline", "suspension", "parentMeeting"].filter((x) => incl[x]);
  return `
    ${renderTallyGrid(cats, totals)}
    <div class="dd-cal-nav">
      <button type="button" class="dd-cal-nav-btn" data-action="nav-prev-day">‹</button>
      <div class="dd-cal-nav-label">${formatDate(viewDate)}${viewDate === todayISO() ? " (Today)" : ""}</div>
      <button type="button" class="dd-cal-nav-btn" data-action="nav-next-day">›</button>
    </div>
    ${renderDayDetail(viewDate, incl)}
    ${renderCalLegend(incl)}`;
}
function renderWeekCalendar(incl) {
  const monday = state.weekViewMonday || currentWeekBounds().monday;
  const sunday = addDays(monday, 6);
  const days = [];
  let cur = monday;
  for (let i = 0; i < 7; i++) { days.push(cur); cur = addDays(cur, 1); }
  const totals = { discipline: 0, suspension: 0, parentMeeting: 0 };
  days.forEach((d) => {
    const c = computeCountsForDate(d);
    totals.discipline += c.discipline;
    totals.parentMeeting += c.parentMeeting;
    totals.suspension += c.suspensionISS + c.suspensionOSS;
  });
  const cats = ["discipline", "suspension", "parentMeeting"].filter((x) => incl[x]);
  const today = todayISO();
  const cells = days.map((d) => {
    const c = computeCountsForDate(d);
    const dots = [];
    if (incl.discipline && c.discipline > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.discipline}"></span>`);
    if (incl.suspension && c.suspensionISS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${CHART_COLORS.suspension}"></span>`);
    if (incl.suspension && c.suspensionOSS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${OSS_DOT_COLOR}"></span>`);
    if (incl.parentMeeting && c.parentMeeting > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.parentMeeting}"></span>`);
    const isSelected = state.selectedCalendarDay === d;
    const isWknd = isWeekend(d);
    const isPubHol = isPublicHoliday(d);
    const isOtherHol = !isPubHol && isHolidayNotWeekend(d);
    const isClosure = !isPubHol && !isOtherHol && !isWknd && !!schoolClosureEntryFor(d);
    const dayTypeClass = isPubHol ? "dd-mini-pubholiday" : isOtherHol ? "dd-mini-holiday" : isClosure ? "dd-mini-closure" : isWknd ? "dd-mini-weekend" : "";
    return `<button type="button" class="dd-week-cell ${dayTypeClass} ${d === today ? "dd-cal-today" : ""} ${isSelected ? "dd-cal-selected" : ""}" data-action="select-cal-day" data-date="${d}">
      <div class="dd-cal-weekday-label">${weekdayName(d).slice(0, 3)}</div>
      <div class="dd-cal-daynum">${parseInt(d.split("-")[2], 10)}</div>
      <div class="dd-cal-dots">${dots.join("")}</div>
    </button>`;
  });
  return `
    ${renderTallyGrid(cats, totals)}
    <div class="dd-cal-nav">
      <button type="button" class="dd-cal-nav-btn" data-action="nav-prev-week">‹</button>
      <div class="dd-cal-nav-label">
        <div>${weekLabelForMonday(monday)}</div>
        <div class="dd-cal-nav-sublabel">${formatDate(monday)} – ${formatDate(sunday)}</div>
      </div>
      <button type="button" class="dd-cal-nav-btn" data-action="nav-next-week">›</button>
    </div>
    <div class="dd-week-grid">${cells.join("")}</div>
    ${renderDayDetail(state.selectedCalendarDay, incl)}
    ${renderCalLegend(incl)}
    ${renderDayTypeLegend()}`;
}
function isPublicHoliday(iso) {
  const h = state.holidays;
  if (h && h.publicHolidays && h.publicHolidays.includes(iso)) return true;
  return !!publicHolidayEntryFor(iso);
}
// Yellow shading ("School Holiday") must mean specifically the MOE
// calendar or a manually-added extra school holiday — not closure/HBL
// days, which get their own blue. isNonSchoolDay's generic (no-level)
// form deliberately treats closure/HBL as a non-school day too, which
// is right for scheduling but wrong for telling the two shading
// categories apart, so this checks only the school-holiday sources.
function isSchoolHolidayOnly(iso) {
  const year = parseInt(iso.slice(0, 4), 10);
  const moe = computeMoeCalendar(year);
  if (moe.singleDays.includes(iso)) return true;
  for (const r of moe.ranges) {
    if (iso >= r.start && iso <= r.end) return true;
  }
  const extraHolidays = state.schoolCalendarOverrides?.[year]?.extraHolidays || [];
  return extraHolidays.some((e) => iso >= e.startDate && iso <= e.endDate);
}
function isHolidayNotWeekend(iso) { return isSchoolHolidayOnly(iso) && !isWeekend(iso); }
function renderMiniMonth(monthKeyStr, incl) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const firstDow = weekdayOf(`${monthKeyStr}-01`);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayISO();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="dd-mini-cell dd-mini-cell-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKeyStr}-${String(d).padStart(2, "0")}`;
    const c = computeCountsForDate(iso);
    const segs = [];
    if (incl.discipline && c.discipline > 0) segs.push(CHART_COLORS.discipline);
    if (incl.suspension && c.suspensionISS > 0) segs.push(CHART_COLORS.suspension);
    if (incl.suspension && c.suspensionOSS > 0) segs.push(OSS_DOT_COLOR);
    if (incl.parentMeeting && c.parentMeeting > 0) segs.push(CHART_COLORS.parentMeeting);
    // Segments are just split evenly by which categories occurred that
    // day, not weighted by how many of each — a day with 3 discipline
    // entries and 1 suspension still splits into two equal halves.
    const barHtml = segs.length > 0
      ? `<div class="dd-mini-bar">${segs.map((color) => `<span style="flex:1;background:${color}"></span>`).join("")}</div>`
      : `<div class="dd-mini-bar dd-mini-bar-empty"></div>`;
    const isWknd = isWeekend(iso);
    const isPubHol = isPublicHoliday(iso);
    const isOtherHol = !isPubHol && isHolidayNotWeekend(iso);
    const isClosure = !isPubHol && !isOtherHol && !isWknd && !!schoolClosureEntryFor(iso);
    const cellClass = isPubHol ? "dd-mini-pubholiday" : isOtherHol ? "dd-mini-holiday" : isClosure ? "dd-mini-closure" : isWknd ? "dd-mini-weekend" : "";
    const isSelected = state.selectedCalendarDay === iso;
    cells.push(`<button type="button" class="dd-mini-cell ${cellClass} ${iso === today ? "dd-mini-today" : ""} ${isSelected ? "dd-mini-selected" : ""}" data-action="select-cal-day" data-date="${iso}">
      <span class="dd-mini-daynum">${d}</span>${barHtml}
    </button>`);
  }
  return `
    <div class="dd-mini-month">
      <div class="dd-mini-month-title">${monthLabelFromKey(monthKeyStr).split(" ")[0]}</div>
      <div class="dd-mini-weekdays"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
      <div class="dd-mini-grid">${cells.join("")}</div>
    </div>`;
}
function renderYearCalendar(incl) {
  const year = state.yearViewYear || new Date().getFullYear();
  const cats = ["discipline", "suspension", "parentMeeting"].filter((c) => incl[c]);
  const totals = { discipline: 0, suspension: 0, parentMeeting: 0 };
  totals.discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`)).length;
  totals.parentMeeting = state.parentMeetings.filter((m) => !m.deleted && m.date && m.date.startsWith(`${year}-`)).length;
  totals.suspension = suspensionEntryCountForRange(`${year}-01-01`, `${year}-12-31`);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  return `
    ${renderTallyGrid(cats, totals)}
    <div class="dd-cal-nav">
      <button type="button" class="dd-cal-nav-btn" data-action="nav-prev-year">‹</button>
      <div class="dd-cal-nav-label">${year}</div>
      <button type="button" class="dd-cal-nav-btn" data-action="nav-next-year">›</button>
    </div>
    <div class="dd-mini-year-grid">${months.map((mk) => renderMiniMonth(mk, incl)).join("")}</div>
    ${renderDayDetail(state.selectedCalendarDay, incl)}
    ${renderCalLegend(incl)}
    ${renderDayTypeLegend()}`;
}
// Shared across Year, Month, and Week views — same 4 colors, same 2x2
// layout, so weekends/holidays/closures read identically everywhere.
function renderDayTypeLegend() {
  return `
    <div class="dd-cal-legend dd-daytype-legend">
      <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:#E4E1D4"></span>Weekend</div>
      <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:#F5E3A1"></span>School Holiday</div>
      <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:#F2B8B0"></span>Public Holiday</div>
      <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:#B8D4E8"></span>Closure / HBL Day</div>
    </div>`;
}
function renderMonthCalendar(monthKeyStr, incl) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const daily = computeDailyCountsForMonth(monthKeyStr);
  const firstDow = weekdayOf(`${monthKeyStr}-01`);
  const daysInMonth = new Date(y, m, 0).getDate();
  const totals = { discipline: 0, suspension: 0, parentMeeting: 0 };
  Object.values(daily).forEach((c) => { totals.discipline += c.discipline; totals.parentMeeting += c.parentMeeting; });
  totals.suspension = suspensionEntryCountForMonth(monthKeyStr);
  const today = todayISO();
  const cats = ["discipline", "suspension", "parentMeeting"].filter((c) => incl[c]);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="dd-cal-cell dd-cal-cell-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKeyStr}-${String(d).padStart(2, "0")}`;
    const c = daily[iso];
    const dots = [];
    if (incl.discipline && c.discipline > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.discipline}" title="${c.discipline} discipline"></span>`);
    if (incl.suspension && c.suspensionISS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${CHART_COLORS.suspension}" title="${c.suspensionISS} in-school suspension"></span>`);
    if (incl.suspension && c.suspensionOSS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${OSS_DOT_COLOR}" title="${c.suspensionOSS} out-of-school suspension"></span>`);
    if (incl.parentMeeting && c.parentMeeting > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.parentMeeting}" title="${c.parentMeeting} parent meeting"></span>`);
    const isSelected = state.selectedCalendarDay === iso;
    const isWknd = isWeekend(iso);
    const isPubHol = isPublicHoliday(iso);
    const isOtherHol = !isPubHol && isHolidayNotWeekend(iso);
    const isClosure = !isPubHol && !isOtherHol && !isWknd && !!schoolClosureEntryFor(iso);
    const dayTypeClass = isPubHol ? "dd-mini-pubholiday" : isOtherHol ? "dd-mini-holiday" : isClosure ? "dd-mini-closure" : isWknd ? "dd-mini-weekend" : "";
    cells.push(`<button type="button" class="dd-cal-cell ${dayTypeClass} ${iso === today ? "dd-cal-today" : ""} ${isSelected ? "dd-cal-selected" : ""}" data-action="select-cal-day" data-date="${iso}"><div class="dd-cal-daynum">${d}</div><div class="dd-cal-dots">${dots.join("")}</div></button>`);
  }
  return `
    ${renderTallyGrid(cats, totals)}
    <div class="dd-cal-nav">
      <button type="button" class="dd-cal-nav-btn" data-action="cal-prev-month">‹</button>
      <div class="dd-cal-nav-label">${monthLabelFromKey(monthKeyStr)}</div>
      <button type="button" class="dd-cal-nav-btn" data-action="cal-next-month">›</button>
    </div>
    <div class="dd-cal-weekdays"><div>S</div><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div></div>
    <div class="dd-cal-grid">${cells.join("")}</div>
    ${renderDayDetail(state.selectedCalendarDay, incl)}
    ${renderCalLegend(incl)}
    ${renderDayTypeLegend()}`;
}
function renderChartCustomModal() {
  return `
    <div class="dd-modal-backdrop" id="chart-custom-modal-backdrop">
      <div class="dd-modal" id="chart-custom-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Custom range</div>
          <button type="button" class="dd-modal-close" id="chart-custom-modal-close">✕</button>
        </div>
        <label class="dd-label" style="margin-top:0">From</label>
        ${renderDateField("chart-custom-from", `${state.chartCustomFrom}-01`)}
        <label class="dd-label">To</label>
        ${renderDateField("chart-custom-to", `${state.chartCustomTo}-01`)}
        <button class="dd-btn-primary" type="button" id="chart-custom-apply">Apply</button>
      </div>
    </div>`;
}
function renderMonthlyChart() {
  const rangeMode = state.chartRangeMode || "thisMonth";
  const incl = {
    discipline: state.chartIncludeDiscipline !== false,
    suspension: state.chartIncludeSuspension !== false,
    parentMeeting: state.chartIncludeParentMeeting !== false,
  };
  const rangePillsRow = (opts) => `
    <div class="dd-range-pills">
      ${opts.map((o) => `<button type="button" class="dd-range-pill ${rangeMode === o.key ? "active" : ""}" data-action="set-chart-range" data-range="${o.key}">${o.label}</button>`).join("")}
    </div>`;
  const rangeSelectorHtml = `
    ${rangePillsRow(CHART_RANGE_OPTIONS_PRIMARY)}
    <div style="margin-top:8px">${rangePillsRow(CHART_RANGE_OPTIONS_SECONDARY)}</div>`;

  if (rangeMode === "today") {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderTodayView(incl)}
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
  }

  if (rangeMode === "thisWeek") {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderWeekCalendar(incl)}
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
  }

  if (rangeMode === "thisMonth") {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderMonthCalendar(state.calendarViewMonth || currentMonthKeyStr(), incl)}
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
  }

  if (rangeMode === "thisYear") {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderYearCalendar(incl)}
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
  }

  const data = computeMonthlyTrend();
  const cats = ["discipline", "suspension", "parentMeeting"].filter((c) => incl[c]);
  const catObjs = cats.map((key) => ({ key, label: CATEGORY_META[key].label }));
  const rawMax = Math.max(1, ...data.flatMap((d) => catObjs.map((c) => d[c.key])));
  const axisMax = niceAxisMax(rawMax);
  const pct = (v) => Math.max(v > 0 ? 3 : 0, Math.round((v / axisMax) * 100));
  const ticks = [0, axisMax * 0.25, axisMax * 0.5, axisMax * 0.75, axisMax].map((n) => Math.round(n));
  const rangeTotals = { discipline: 0, suspension: 0, parentMeeting: 0 };
  data.forEach((d) => { rangeTotals.discipline += d.discipline; rangeTotals.suspension += d.suspension; rangeTotals.parentMeeting += d.parentMeeting; });

  return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderTallyGrid(cats, rangeTotals)}
      <div class="dd-chart-hrow" style="margin:14px 0 10px">
        <span class="dd-chart-dot" style="background:transparent"></span>
        <div class="dd-chart-axis-track">${ticks.map((t) => `<span>${t}</span>`).join("")}</div>
        <span class="dd-chart-hval"></span>
      </div>
      <div class="dd-chart-rows">
        ${data.map((d) => {
          const total = catObjs.reduce((sum, c) => sum + d[c.key], 0);
          return `
          <div class="dd-chart-row-block">
            <div class="dd-chart-row-header">
              <span class="dd-chart-row-month">${d.label}</span>
              <span class="dd-chart-row-total">${total}</span>
            </div>
            ${catObjs.map((c) => `
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
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
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
      <label class="dd-label">Action taken</label>
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
      ${renderSuspFieldsBody(d.suspDraft, "case-susp", null)}
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
      <label class="dd-label">Who is attending?</label>
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
      <label class="dd-label">Reason for meeting</label>
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
    ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
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

// A "semester" is 2 terms — Term1+2, or Term3+4 — whichever contains
// today (falling back to whichever half of the year today is closer to,
// if today happens to land in a between-term holiday gap).
function computeCurrentSemesterBounds() {
  const year = new Date().getFullYear();
  const moe = computeMoeCalendar(year);
  const today = todayISO();
  const [t1, t2, t3, t4] = moe.terms;
  if (today <= t2.end) return { start: t1.start, end: t2.end };
  return { start: t3.start, end: t4.end };
}
function renderGroomingFollowUpList() {
  const buckets = computeGroomingFollowUpBuckets();
  const today = todayISO();
  const renderRow = (r) => `
    <div class="dd-followup-row-item" data-action="jump-to-incident" data-id="${r.incidentId}">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <span class="dd-sans" style="font-size:14px;font-weight:600">${escapeHtml(truncateName(r.name))}</span>
        <span class="dd-issue-stage-badge ${r.deadline < today ? "dd-issue-overdue" : ""}">${WARNING_STAGE_LABEL[r.stage]}</span>
      </div>
      <div class="dd-mono-muted" style="font-size:11px;margin-top:2px">${escapeHtml(r.studentClass || "")} · ${escapeHtml(r.issueLabel)}</div>
      ${(() => {
        const daysOverdue = daysBetween(r.deadline, today);
        return daysOverdue > 0 ? `<div class="dd-mono-muted" style="font-size:11px;color:#A3372B">Overdue for ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}</div>` : "";
      })()}
    </div>`;
  const renderDaySection = (label, dateIso, rows) => `
    <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;display:flex;justify-content:space-between;align-items:baseline;margin-top:14px">
      <span class="dd-mono-muted" style="font-size:12px;font-weight:400">${formatDate(dateIso)}</span>
      <span>(${label})</span>
    </div>
    ${rows.length === 0 ? `<div class="dd-dash-empty" style="margin-top:6px">Nothing here.</div>` : `
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${rows.map(renderRow).join("")}</div>`}`;
  return `
    <div class="dd-panel" style="margin-bottom:16px">
      <div class="dd-dash-title" style="color:#1B2A41">Grooming Follow-Up List</div>
      ${renderDaySection("Today", today, buckets.today)}
      ${renderDaySection("Tomorrow", addDays(today, 1), buckets.tomorrow)}
      ${renderDaySection("2 Days Later", addDays(today, 2), buckets.dayAfter)}
    </div>`;
}
function renderDashboardSection() {
  const activeIncidents = state.incidents.filter((i) => !i.deleted);
  const activeSusp = state.suspensions.filter((s) => !s.deleted);
  const activePm = state.parentMeetings.filter((m) => !m.deleted);

  const semester = computeCurrentSemesterBounds();
  const watchCounts = {};
  const watchClass = {};
  activeIncidents.forEach((i) => {
    if (i.date < semester.start || i.date > semester.end) return;
    const isLegacy = !Array.isArray(i.issues);
    const maxStage = isLegacy ? 0 : groomingEntryMaxStage(i);
    watchCounts[i.studentName] = watchCounts[i.studentName] || { suspension: 0, second: 0, third: 0 };
    if (maxStage >= 3) watchCounts[i.studentName].third++;
    else if (maxStage >= 2) watchCounts[i.studentName].second++;
    watchClass[i.studentName] = i.studentClass || watchClass[i.studentName];
  });
  activeSusp.forEach((s) => {
    if (s.startDate < semester.start || s.startDate > semester.end) return;
    watchCounts[s.studentName] = watchCounts[s.studentName] || { suspension: 0, second: 0, third: 0 };
    watchCounts[s.studentName].suspension++;
    watchClass[s.studentName] = s.studentClass || watchClass[s.studentName];
  });
  // Risk tiers (per semester, counted by entry not by issue), checked in
  // priority order so someone qualifying for a higher tier is never also
  // shown as a lower one.
  const riskTierFor = (c) => {
    if (c.suspension >= 2 || c.third >= 3) return "high";
    if (c.suspension === 1 || (c.second >= 4 && c.second <= 6) || c.third === 2) return "medium";
    if (c.second >= 1 && c.second <= 3) return "low";
    return null;
  };
  const watchTier = state.watchTier || "high";
  let watchlist = Object.entries(watchCounts)
    .map(([name, c]) => ({ name, studentClass: watchClass[name] || "", ...c, tier: riskTierFor(c) }))
    .filter((t) => t.tier === watchTier);
  watchlist = watchlist.sort((a, b) => b.suspension - a.suspension || b.third - a.third || b.second - a.second);

  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${!state.classConfig?.classesByYear?.[String(new Date().getFullYear())] ? `
        <div class="dd-error" style="margin-bottom:12px" data-action="goto-classes-for-year">Classes for ${new Date().getFullYear()} haven't been reviewed yet — <button type="button" class="dd-back-link" data-action="goto-classes-for-year" style="text-decoration:underline">tap here to set them up</button>.</div>` : ""}
        <div class="dd-new-entry-row">
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-case" style="flex:1">+ Grooming Issue</button>
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-susp-only" style="flex:1">+ Suspension</button>
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-pm-only" style="flex:1">+ Parent Meeting</button>
        </div>

        ${renderGroomingFollowUpList()}

        ${renderMonthlyChart()}

        <div class="dd-panel" style="margin-top:16px">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px;display:flex;align-items:center;gap:6px">
            Students' Watchlist
            <button type="button" class="dd-info-icon-btn" data-action="toggle-watchlist-info" title="How risk is worked out">i</button>
          </div>
          ${state.showWatchlistInfo ? `
          <div class="dd-mono-muted" style="font-size:11px;margin-bottom:10px;background:#F2EFE6;padding:8px 10px;border-radius:4px">
            Per semester — <b>High:</b> 2+ suspensions or 3+ final warnings. <b>Medium:</b> 1 suspension, 4-6 second warnings, or 2 final warnings. <b>Low:</b> 1-3 second warnings, no suspension.
          </div>` : ""}
          <div class="dd-range-pills" style="flex-wrap:nowrap">
            <button type="button" class="dd-range-pill${watchTier === "high" ? " active" : ""}" style="flex:1" data-action="set-watch-tier" data-tier="high">High Risk</button>
            <button type="button" class="dd-range-pill${watchTier === "medium" ? " active" : ""}" style="flex:1" data-action="set-watch-tier" data-tier="medium">Medium Risk</button>
            <button type="button" class="dd-range-pill${watchTier === "low" ? " active" : ""}" style="flex:1" data-action="set-watch-tier" data-tier="low">Low Risk</button>
          </div>
          ${watchlist.length === 0 ? `<div class="dd-dash-empty" style="margin-top:10px">No students in this tier.</div>` : `
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
            ${watchlist.map((t) => {
              const stats = [];
              if (t.suspension > 0) stats.push(`${t.suspension} suspension${t.suspension === 1 ? "" : "s"}`);
              if (t.third > 0) stats.push(`${t.third} final warning${t.third === 1 ? "" : "s"}`);
              if (t.second > 0) stats.push(`${t.second} 2nd warning${t.second === 1 ? "" : "s"}`);
              return `
              <div style="border-bottom:1px solid #E4E1D4;padding-bottom:8px">
                <div class="dd-sans dd-card-student-link" style="font-size:14px" data-action="view-student" data-name="${escapeHtml(t.name)}">${escapeHtml(truncateName(t.name))}${t.studentClass ? ` <span class="dd-mono-muted" style="font-size:11px">${escapeHtml(t.studentClass)}</span>` : ""}</div>
                ${stats.map((s) => `<div class="dd-mono-muted" style="font-size:12px;margin-top:2px">${s}</div>`).join("")}
              </div>`;
            }).join("")}
          </div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.showNewPmForm ? renderPmForm(false) : ""}
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
  let list = state.incidents.filter((it) => !it.deleted);
  if (state.disciplineFilter && state.disciplineFilter !== "all") {
    const wantResolved = state.disciplineFilter === "Resolved";
    list = list.filter((it) => {
      const isLegacy = !Array.isArray(it.issues);
      const resolved = isLegacy ? it.status === "Resolved" : groomingEntryResolved(it);
      return resolved === wantResolved;
    });
  }
  if (state.disciplineExpandedLevel) {
    list = list.filter((it) => classLevel(it.studentClass) === state.disciplineExpandedLevel);
    if (state.disciplineSelectedClass) list = list.filter((it) => it.studentClass === state.disciplineSelectedClass);
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
    const isLegacy = !Array.isArray(it.issues);
    const resolved = isLegacy ? it.status === "Resolved" : groomingEntryResolved(it);
    if (resolved) c.Resolved++; else c.Monitoring++;
  });
  return c;
}

function renderLogSection() {
  const list = filteredIncidents();
  const c = counts();
  const filter = state.disciplineFilter || "all";
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${renderLevelBreakdown("discipline", state.incidents, "date")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button class="dd-pill ${filter === "all" ? "active" : ""}" data-action="set-discipline-filter" data-filter="all">Show All</button>
          <button class="dd-pill ${filter === "Monitoring" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Monitoring">In Progress (${c.Monitoring})</button>
          <button class="dd-pill ${filter === "Resolved" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Resolved">Resolved (${c.Resolved})</button>
        </div>
        ${state.disciplineExpandedLevel ? renderClassPillsRow("discipline", state.disciplineExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="search-input" placeholder="Search by student name…" value="${escapeHtml(state.query)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.incidents.length === 0 ? "No entries yet. Log the first grooming issue to start the record." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderIncidentDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
    </div>`;
}

function renderStudentView() {
  const name = state.studentViewName || "";
  const grooming = state.incidents.filter((i) => !i.deleted && i.studentName === name).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const suspensions = state.suspensions.filter((s) => !s.deleted && s.studentName === name).sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const meetings = state.parentMeetings.filter((m) => !m.deleted && m.studentName === name).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latestClass = (grooming[0]?.studentClass) || (suspensions[0]?.studentClass) || (meetings[0]?.studentClass) || "";
  const sectionBlock = (title, count, items, renderFn) => `
    <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:20px 0 8px">${title} (${count})</div>
    ${count === 0 ? `<div class="dd-dash-empty">Nothing on file.</div>` : `<div style="display:flex;flex-direction:column;gap:12px">${items.map(renderFn).join("")}</div>`}`;
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <button type="button" class="dd-back-link" data-action="student-view-back">‹ Back</button>
        <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">${escapeHtml(name)}${latestClass ? ` <span class="dd-mono-muted" style="font-size:14px;font-weight:400">${escapeHtml(latestClass)}</span>` : ""}</div>
        <div class="dd-mono-muted" style="font-size:12px;margin-bottom:6px">Everything on file for this student, across all three logs.</div>
        ${sectionBlock("Grooming Log", grooming.length, grooming, renderIncidentDetail)}
        ${sectionBlock("Suspension Log", suspensions.length, suspensions, renderSuspensionDetail)}
        ${sectionBlock("Parent Meetings", meetings.length, meetings, renderParentMeetingDetail)}
      </div>
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
      ${state.editingSuspensionId ? renderSuspForm(true) : ""}
      ${state.editingPmId ? renderPmForm(true) : ""}
    </div>`;
}

function renderIncidentDetail(it) {
  const isLegacy = !Array.isArray(it.issues);
  const issues = isLegacy ? [] : it.issues;
  const resolved = isLegacy ? it.status === "Resolved" : groomingEntryResolved(it);
  const dotColor = resolved ? "#3C6E47" : "#A3372B";
  const summaryLabel = isLegacy ? (it.issue || "") : issues.map((x) => groomingIssueLabel(x)).join(", ");
  const followUps = it.followUps || [];
  const history = it.history || [];
  const linkedSusp = (it.linkedSuspensionIds || []).map((id) => state.suspensions.find((x) => x.id === id)).filter(Boolean);
  const linkedPm = (it.linkedPmIds || []).map((id) => state.parentMeetings.find((x) => x.id === id)).filter(Boolean);
  const expanded = !!state.entryExpanded[it.id];
  const today = todayISO();
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(it.studentName)}">${escapeHtml(it.studentName)}</div>
          <div class="dd-card-meta dd-card-meta-primary">${formatDate(it.date)}${it.studentClass ? ` · ${escapeHtml(it.studentClass)}` : ""}</div>
          <div class="dd-card-meta">logged by ${escapeHtml(it.loggedBy)}</div>
          ${isLegacy ? `<div class="dd-card-summary-issue">${escapeHtml(summaryLabel)} (legacy entry)</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0">
          <span class="dd-status-dot" style="background:${dotColor}" title="${resolved ? "Resolved" : "In Progress"}"></span>
          <button class="dd-expand-toggle" data-action="toggle-entry-expanded" data-id="${it.id}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▲" : "▼"}</button>
        </div>
      </div>
      ${expanded ? `
      ${linkedSusp.length || linkedPm.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related records</div>
        ${linkedSusp.map((x) => `<div class="dd-related-link" data-action="jump-to-suspension" data-id="${x.id}">Suspension — ${formatDateShort(x.startDate)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
        ${linkedPm.map((x) => `<div class="dd-related-link" data-action="jump-to-pm" data-id="${x.id}">Parent Meeting — ${formatDateShort(x.date)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
      </div>` : ""}
      ${isLegacy ? `
      <div class="dd-mono-muted" style="font-size:12px;font-style:italic;margin:12px 0">This is an entry from before the Grooming Log rework — no per-issue tracking available for it.</div>
      ` : `
      <div style="margin:12px 0;display:flex;flex-direction:column;gap:10px">
        ${issues.map((issue) => {
          const cfg = GROOMING_ISSUE_CONFIG[issue.type] || GROOMING_ISSUE_CONFIG.Others;
          const overdue = !issue.resolved && issue.deadline < today;
          const canUndo = issue.history.length > 1;
          return `
          <div class="dd-issue-card">
            <div class="dd-issue-card-head">
              <div class="dd-issue-card-label">${escapeHtml(groomingIssueLabel(issue))}</div>
              ${issue.resolved
                ? `<span class="dd-issue-stage-badge dd-issue-resolved">Resolved</span>`
                : `<span class="dd-issue-stage-badge ${overdue ? "dd-issue-overdue" : ""}">${WARNING_STAGE_LABEL[issue.stage]}</span>`}
            </div>
            ${!issue.resolved ? `
            <div class="dd-issue-due-row">
              <div class="dd-date-icon-btn" title="Change this issue's deadline">
                <input type="date" class="dd-input dd-issue-override-input" data-id="${it.id}" data-issue="${issue.id}" value="${issue.deadline}" />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
              </div>
              <span class="dd-mono-muted" style="font-size:12px">Due ${formatDate(issue.deadline)}${overdue ? " — overdue" : ""}</span>
            </div>
            ${(() => {
              // Every non-final stage always shows exactly one FT-facing
              // action: Contact Parents once this issue's rules call for
              // it, otherwise a standing reminder that the student needs
              // to be spoken to. Final Warning always shows the escalated
              // action (facilitated call, or SH/SM contact for the
              // shsm-only issues) instead of either of those.
              if (issue.stage === 3) {
                return `<div class="dd-issue-instruction">${cfg.finalAction === "shsm-only" ? "SH/SM Contact Parents" : "LST or SH/SM Enforced Facilitated Call"}</div>`;
              }
              return `<div class="dd-issue-instruction">${cfg.parentFrom <= issue.stage ? "FT Contact Parents" : "FT Remind Student"}</div>`;
            })()}
            ${cfg.instructions ? (issue.stage === 1
              ? `<div class="dd-issue-instruction">${escapeHtml(cfg.instructions[0] || "")}</div>`
              : `<div class="dd-mono-muted" style="font-size:11px;margin-top:2px;font-style:italic">${escapeHtml(cfg.instructions[issue.stage - 1] || "")}</div>`) : ""}
            ${cfg.note ? `<div class="dd-issue-instruction">${escapeHtml(cfg.note)}</div>` : ""}
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="dd-add-btn" style="flex:1" data-action="resolve-issue" data-id="${it.id}" data-issue="${issue.id}">Resolved</button>
              ${issue.stage < 3 ? `<button class="dd-add-btn" style="flex:1;background:#A3372B" data-action="escalate-issue" data-id="${it.id}" data-issue="${issue.id}">Escalate</button>` : ""}
            </div>
            ${canUndo ? `<button class="dd-back-link" style="margin-top:6px" data-action="undo-issue-action" data-id="${it.id}" data-issue="${issue.id}">↺ Undo</button>` : ""}
            ` : `
            <div class="dd-mono-muted" style="font-size:11px;margin-top:2px">Resolved ${formatDate(issue.resolvedAt)} at ${WARNING_STAGE_LABEL[issue.stage]}</div>
            ${canUndo ? `<button class="dd-back-link" style="margin-top:6px" data-action="undo-issue-action" data-id="${it.id}" data-issue="${issue.id}">↺ Undo</button>` : ""}
            `}
          </div>`;
        }).join("")}
      </div>`}
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
        <button class="dd-add-btn" data-action="open-edit-incident" data-id="${it.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-incident" data-id="${it.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}

function recycleBinButton(id, active, count) {
  return `<button class="dd-circle-btn ${active ? "dd-recycle-active" : ""}" id="${id}" title="Deleted (${count})">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 7.5h15l-1.4 13.2a1 1 0 0 1-1 .9H6.9a1 1 0 0 1-1-.9L4.5 7.5z"></path>
      <path d="M9 7.5V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.5"></path>
      <path d="M11.45 12.26L9.92 14.90"></path>
      <path d="M9.92 14.90l1.2.3M9.92 14.90l.3-1.2"></path>
      <path d="M10.34 16.10L13.39 16.10"></path>
      <path d="M13.39 16.10l-.9.85M13.39 16.10l-1.15-.5"></path>
      <path d="M14.22 15.14L12.69 12.50"></path>
      <path d="M12.69 12.50l1.25-.15M12.69 12.50l-.6 1.1"></path>
    </svg>
  </button>`;
}
// The classes actually available this year, if configured under Settings
// → Classes For The Year — falls back to the full roster if nothing has
// been set for this year yet (e.g. before the feature was ever used).
function classOptionsForCurrentYear() {
  const year = String(new Date().getFullYear());
  const configured = state.classConfig?.classesByYear?.[year];
  return Array.isArray(configured) && configured.length ? configured : CLASS_OPTIONS;
}
function classOptionsHtml(selected) {
  const options = classOptionsForCurrentYear();
  // If an entry's saved class isn't in this year's active list (e.g. an
  // older record, or the list changed after it was logged), still show it
  // so editing doesn't silently blank out the field.
  const withSelected = selected && !options.includes(selected) ? [...options, selected] : options;
  return `<option value="">Select class…</option>` + withSelected.map((c) => `<option value="${c}" ${c === selected ? "selected" : ""}>${c}</option>`).join("");
}

function renderNewForm() {
  const d = state._newIncidentDraft;
  const related = findRelatedRecords(d.studentName);
  const hasRelated = related.suspensions.length > 0 || related.parentMeetings.length > 0;
  return `
    <div class="dd-modal-backdrop" id="modal-backdrop">
      <div class="dd-modal" id="new-form">
        <div class="dd-modal-head"><div class="dd-modal-title">New grooming issue</div><button type="button" class="dd-modal-close" id="modal-close">✕</button></div>
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
        <label class="dd-label">Date caught</label>
        <div class="dd-issue-due-row">
          <div class="dd-date-icon-btn" title="Change the date">
            <input class="dd-input" type="date" name="date" required value="${d.date}" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </div>
          <span class="dd-sans" style="font-size:15px" id="new-incident-date-label">${formatDate(d.date)}</span>
        </div>
        <label class="dd-label">Issue(s) <span class="dd-mono-muted" style="font-size:11px;text-transform:none">tap all that apply</span></label>
        <div class="dd-issue-tag-grid">
          ${GROOMING_ISSUE_TYPES.map((type) => `
            <button type="button" class="dd-issue-tag ${d.selectedIssues.includes(type) ? "active" : ""}" data-action="toggle-grooming-issue" data-issue="${escapeHtml(type)}">${escapeHtml(type)}</button>`).join("")}
        </div>
        ${d.selectedIssues.includes("Others") ? `
        <label class="dd-label">Please specify</label>
        <input class="dd-input" id="new-incident-others-text" value="${escapeHtml(d.othersText)}" />` : ""}
        ${d.selectedIssues.length > 0 ? `
        <div class="dd-mono-muted" style="font-size:11px;margin-top:10px">
          ${d.selectedIssues.map((type) => {
            const cfg = GROOMING_ISSUE_CONFIG[type] || GROOMING_ISSUE_CONFIG.Others;
            return `${escapeHtml(type)}: 1st Warning due ${formatDate(addDays(d.date, cfg.days[0]))}${cfg.parentFrom <= 1 ? " — parents contacted immediately" : ""}`;
          }).join("<br>")}
        </div>` : ""}
        ${state.newIncidentFormError ? `<div class="dd-error">${escapeHtml(state.newIncidentFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-new-incident" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save entry"}</button>
      </div>
    </div>`;
}
function renderEditIncidentForm() {
  const it = state.incidents.find((i) => i.id === state.editingIncidentId);
  const d = state._editIncidentDraft;
  if (!it || !d) return "";
  return `
    <div class="dd-modal-backdrop" id="edit-modal-backdrop">
      <div class="dd-modal" id="edit-form">
        <div class="dd-modal-head"><div class="dd-modal-title">Edit entry</div><button type="button" class="dd-modal-close" id="edit-modal-close">✕</button></div>
        <label class="dd-label" style="margin-top:0">Student name</label>
        <input class="dd-input" id="edit-incident-student-name" value="${escapeHtml(d.studentName)}" />
        <label class="dd-label">Class</label>
        <select class="dd-input" id="edit-incident-class">${classOptionsHtml(d.studentClass)}</select>
        <label class="dd-label">Date</label>
        ${renderDateField("edit-incident-date", d.date)}
        <label class="dd-label">Issue(s) <span class="dd-mono-muted" style="font-size:11px;text-transform:none">tap all that apply</span></label>
        <div class="dd-issue-tag-grid">
          ${GROOMING_ISSUE_TYPES.map((type) => `
            <button type="button" class="dd-issue-tag ${d.selectedIssues.includes(type) ? "active" : ""}" data-action="edit-toggle-grooming-issue" data-issue="${escapeHtml(type)}">${escapeHtml(type)}</button>`).join("")}
        </div>
        ${d.selectedIssues.includes("Others") ? `
        <label class="dd-label">Please specify</label>
        <input class="dd-input" id="edit-incident-others-text" value="${escapeHtml(d.othersText)}" />` : ""}
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Unticking an issue removes it and its warning history. Ticking a new one starts it fresh at 1st Warning. Issues left ticked keep their current stage untouched.</div>
        ${state.newIncidentFormError ? `<div class="dd-error">${escapeHtml(state.newIncidentFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <button class="dd-btn-primary" type="button" id="btn-save-edit-incident" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save changes"}</button>
      </div>
    </div>`;
}

// ---------- Suspension Log ----------
function currentWeekBounds() {
  const today = todayISO();
  const dow = weekdayOf(today);
  const diffToMonday = dow === 0 ? 6 : dow - 1;
  const monday = addDays(today, -diffToMonday);
  const sunday = addDays(monday, 6);
  return { monday, sunday };
}
// Week-relative categorization for filter pills — distinct from
// suspensionStatus() (today-based, drives the status dot). A suspension
// spanning several days can overlap "this week" even if it started earlier
// or ends later.
function suspensionWeekCategory(s) {
  const { monday, sunday } = currentWeekBounds();
  const { first, last } = suspensionDateRange(s);
  if (last < monday) return "Completed";
  if (first > sunday) return "Upcoming";
  return "This Week";
}
function filteredSuspensions() {
  let list = state.suspensions.map((s) => ({ ...s, _week: suspensionWeekCategory(s) })).filter((s) => !s.deleted);
  if (state.suspTab !== "All") list = list.filter((s) => s._week === state.suspTab);
  if (state.suspensionExpandedLevel) {
    list = list.filter((s) => classLevel(s.studentClass) === state.suspensionExpandedLevel);
    if (state.suspensionSelectedClass) list = list.filter((s) => s.studentClass === state.suspensionSelectedClass);
  }
  if (state.suspQuery.trim()) {
    const q = state.suspQuery.trim().toLowerCase();
    list = list.filter((s) => s.studentName.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
}
function suspCounts() {
  const c = { "This Week": 0, Upcoming: 0, Completed: 0, Deleted: 0 };
  state.suspensions.forEach((s) => { if (s.deleted) { c.Deleted++; return; } c[suspensionWeekCategory(s)]++; });
  return c;
}

function renderSuspensionSection() {
  const list = filteredSuspensions();
  const c = suspCounts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${renderLevelBreakdown("suspension", state.suspensions, "startDate")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.suspTab === t ? "active" : ""}" data-action="set-susp-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.suspensionExpandedLevel ? renderClassPillsRow("suspension", state.suspensionExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="susp-search-input" placeholder="Search by student name…" value="${escapeHtml(state.suspQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.suspensions.length === 0 ? "No suspensions logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderSuspensionDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
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
  const expanded = !!state.entryExpanded[s.id];
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(s.studentName)}">${escapeHtml(s.studentName)}</div>
          <div class="dd-card-meta dd-card-meta-primary">${s.startDate ? formatDate(s.startDate) : ""}${s.studentClass ? ` · ${escapeHtml(s.studentClass)}` : ""}</div>
          <div class="dd-card-meta">logged by ${escapeHtml(s.loggedBy)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0">
          <span class="dd-status-dot" style="background:${statusStyle.ink}" title="${escapeHtml(statusStyle.label)}"></span>
          <button class="dd-expand-toggle" data-action="toggle-entry-expanded" data-id="${s.id}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▲" : "▼"}</button>
        </div>
      </div>
      ${expanded ? `
      ${linkedIncidents.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related grooming entries</div>
        ${linkedIncidents.map((x) => `<div class="dd-related-link" data-action="jump-to-incident" data-id="${x.id}">${formatDateShort(x.date)} — ${escapeHtml(truncateName(incidentSummaryLabel(x), 30))}</div>`).join("")}
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
        <button class="dd-add-btn" data-action="edit-suspension" data-id="${s.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-suspension" data-id="${s.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}

function renderSuspFieldsBody(d, idPrefix, excludeSuspensionId) {
  const totalOptions = Array.from({ length: 14 }, (_, i) => i + 1);
  const dayCountOptions = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const showDatePickers = d.totalDays && (d.issDays + d.ossDays === d.totalDays) && (d.ossDates.length === d.ossDays);
  return `
        ${renderReasonPicker(d.reasonCategory, d.reasonOthersText)}
        <label class="dd-label">Start date (used to suggest default days)</label>
        <div class="dd-issue-due-row">
          <div class="dd-date-icon-btn" title="Change the start date">
            <input class="dd-input" type="date" id="${idPrefix}-start-date" value="${d.startDate}" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </div>
          <span class="dd-sans" style="font-size:15px">${formatDate(d.startDate)}</span>
        </div>

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

        ${showDatePickers && d.ossDays > 0 ? `
        <label class="dd-label" style="margin-top:12px">Out-of-school dates</label>
        <div id="${idPrefix}-oss-date-rows">
          ${d.ossDates.map((dt, i) => `
            <div class="dd-venue-row">
              <div class="dd-date-icon-btn" title="Change this day's date">
                <input type="date" class="${idPrefix}-oss-date-input" data-idx="${i}" value="${dt}" />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
              </div>
              <span class="dd-venue-date">${formatDate(dt)}</span>
            </div>`).join("")}
        </div>` : ""}

        ${showDatePickers && d.issDays > 0 ? (() => {
          const bookedCount = d.issDates.filter((dt) => d.issVenues[dt]).length;
          const issRows = d.issDates.map((dt, i) => ({ dt, i })).sort((a, b) => a.dt.localeCompare(b.dt));
          return `
        <label class="dd-label" style="margin-top:12px">In-school days booked: ${bookedCount} of ${d.issDays}</label>
        <div id="${idPrefix}-iss-date-rows" style="margin-bottom:8px">
          ${issRows.map(({ dt, i }) => `
            <div class="dd-venue-row">
              <div class="dd-date-icon-btn" title="Change this day's date">
                <input type="date" class="${idPrefix}-iss-date-input" data-idx="${i}" value="${dt}" />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
              </div>
              <span class="dd-venue-date">${formatDate(dt)}</span>
              <span class="dd-sans" style="font-size:13px;flex:1;${d.issVenues[dt] ? "" : "font-style:italic;color:#8A8571"}">${d.issVenues[dt] ? escapeHtml(d.issVenues[dt]) : "Pending Location"}</span>
              ${d.issVenues[dt] ? `<button type="button" class="dd-followup-icon-btn" data-action="${idPrefix}-unbook-iss" data-date="${dt}" title="Remove this booking">✕</button>` : ""}
            </div>`).join("")}
        </div>
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin:10px 0 6px">Tap a day and location to book it</div>
        <div class="dd-avail-list">
          ${d.issDates.slice().sort().map((dt) => {
            const occ = locationOccupancyForDate(dt, excludeSuspensionId);
            return `
            <div class="dd-avail-row">
              <div class="dd-avail-date">${formatDate(dt)}<div class="dd-avail-weekday">${weekdayName(dt)}</div></div>
              <div class="dd-avail-chips">
                ${occ.map((o) => {
                  const isThisBooking = d.issVenues[dt] === o.location;
                  let occupants = o.occupants.slice();
                  if (isThisBooking) occupants = [...occupants, d.studentName || "This student"];
                  const full = occupants.length >= o.capacity && !isThisBooking;
                  const cls = isThisBooking ? "dd-avail-chip-selected" : full ? "dd-avail-chip-full" : "dd-avail-chip-free";
                  const namesHtml = occupants.length ? `<div class="dd-avail-chip-names">${occupants.map((n) => `<div>${escapeHtml(truncateName(n, 20))}</div>`).join("")}</div>` : "";
                  return `<button type="button" class="dd-avail-chip ${cls}"
                    data-action="${idPrefix}-book-iss" data-date="${dt}" data-location="${o.location}">
                    <div class="dd-avail-chip-label">${locationAbbrev(o.location)} (${occupants.length}/${o.capacity})${isThisBooking ? " ✓" : ""}</div>
                    ${namesHtml}
                  </button>`;
                }).join("")}
              </div>
            </div>`;
          }).join("")}
        </div>
        <div class="dd-mono-muted" style="font-size:11px;margin-top:6px">A location marked "full" can still be booked if needed — it's a warning, not a hard block.</div>`;
        })() : ""}`;
}
// Re-renders while preserving the open modal's scroll position — a plain
// render() resets scroll to the top, which is jarring on a long form when
// all you did was tap one checkbox or button partway down.
function renderKeepingModalScroll() {
  const modal = document.querySelector(".dd-modal");
  const scrollTop = modal ? modal.scrollTop : null;
  render();
  if (scrollTop !== null) {
    const newModal = document.querySelector(".dd-modal");
    if (newModal) newModal.scrollTop = scrollTop;
  }
}
// Same idea as renderKeepingModalScroll but for controls that live directly
// on a scrollable page (no modal involved) — e.g. the Dashboard's trend
// section, which sits well below the fold.
function renderKeepingPageScroll() {
  const scrollY = window.scrollY;
  render();
  window.scrollTo(0, scrollY);
}
// Every click here triggers a full re-render, which normally resets scroll
// to the top of the modal — very disruptive on a long form. This preserves
// the open modal's scroll position across the re-render.
function attachSuspFieldListeners(form, idPrefix, d, rawOnChange) {
  const onChange = renderKeepingModalScroll;
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
    el.addEventListener("change", () => { d.ossDates[parseInt(el.dataset.idx, 10)] = el.value; regenerateSuspDates(d); onChange(); }));

  form.querySelectorAll(`.${idPrefix}-iss-date-input`).forEach((el) =>
    el.addEventListener("change", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!Array.isArray(d.issOverridden)) d.issOverridden = [];
      d.issDates[idx] = el.value;
      d.issOverridden[idx] = true;
      regenerateSuspDates(d);
      onChange();
    }));

  // Availability: tap a location to book it for that (fixed) in-school day,
  // tap the same location again to clear it back to "Pending Location".
  form.querySelectorAll(`[data-action="${idPrefix}-book-iss"]`).forEach((el) =>
    el.addEventListener("click", () => {
      const date = el.dataset.date;
      const location = el.dataset.location;
      if (d.issVenues[date] === location) delete d.issVenues[date];
      else d.issVenues[date] = location;
      if (idPrefix === "susp") state.suspFormError = "";
      if (idPrefix === "case-susp") state.caseFormError = "";
      onChange();
    }));
  form.querySelectorAll(`[data-action="${idPrefix}-unbook-iss"]`).forEach((el) =>
    el.addEventListener("click", () => { delete d.issVenues[el.dataset.date]; onChange(); }));
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
        ${renderSuspFieldsBody(d, "susp", state.editingSuspensionId)}
        ${!isEdit ? `
        <label class="dd-checkbox-pill" style="display:flex;margin-top:14px">
          <input type="checkbox" id="susp-tag-pm-cb" ${d.tagPm ? "checked" : ""} />
          <span>Meeting Parents</span>
        </label>
        ${d.tagPm ? `
        <div class="dd-related-box" style="margin-top:8px">
          <label class="dd-label" style="margin-top:0">Who is attending?</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${ATTENDEE_OPTIONS.map((a) => `
              <label class="dd-checkbox-pill">
                <input type="checkbox" class="dd-susp-pm-attendee-cb" value="${a}" ${d.pmAttendees.includes(a) ? "checked" : ""} />
                <span>${a}</span>
              </label>`).join("")}
          </div>
          ${d.pmAttendees.includes("Others") ? `<input class="dd-input" id="susp-pm-others-text" style="margin-top:8px" placeholder="Please specify" value="${escapeHtml(d.pmOthersText)}" />` : ""}
          ${renderReasonPicker(d.pmReasonCategory, d.pmReasonOthersText, "pmReason")}
        </div>` : ""}` : ""}
        ${state.suspFormError ? `<div class="dd-error">${escapeHtml(state.suspFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save suspension"}</button>
      </form>
    </div>`;
}

// ---------- Parent Meeting ----------
function parentMeetingWeekCategory(m) {
  const { monday, sunday } = currentWeekBounds();
  if (!m.date) return "This Week";
  if (m.date < monday) return "Completed";
  if (m.date > sunday) return "Upcoming";
  return "This Week";
}
function filteredParentMeetings() {
  let list = state.parentMeetings.map((m) => ({ ...m, _week: parentMeetingWeekCategory(m) })).filter((m) => !m.deleted);
  if (state.pmTab !== "All") list = list.filter((m) => m._week === state.pmTab);
  if (state.pmExpandedLevel) {
    list = list.filter((m) => classLevel(m.studentClass) === state.pmExpandedLevel);
    if (state.pmSelectedClass) list = list.filter((m) => m.studentClass === state.pmSelectedClass);
  }
  if (state.pmQuery.trim()) {
    const q = state.pmQuery.trim().toLowerCase();
    list = list.filter((m) => m.studentName.toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}
function pmCounts() {
  const c = { "This Week": 0, Upcoming: 0, Completed: 0, Deleted: 0 };
  state.parentMeetings.forEach((m) => { if (m.deleted) { c.Deleted++; return; } c[parentMeetingWeekCategory(m)]++; });
  return c;
}

function renderParentMeetingSection() {
  const list = filteredParentMeetings();
  const c = pmCounts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${renderLevelBreakdown("pm", state.parentMeetings, "date")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.pmTab === t ? "active" : ""}" data-action="set-pm-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.pmExpandedLevel ? renderClassPillsRow("pm", state.pmExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="pm-search-input" placeholder="Search by student name…" value="${escapeHtml(state.pmQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.parentMeetings.length === 0 ? "No parent meetings logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderParentMeetingDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
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
  const expanded = !!state.entryExpanded[m.id];
  const weekCat = parentMeetingWeekCategory(m);
  const dotColor = m.deleted ? "#8A8571" : weekCat === "Completed" ? "#3C6E47" : weekCat === "Upcoming" ? "#D98F2B" : "#A3372B";
  const dotLabel = m.deleted ? "Removed" : weekCat;
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(m.studentName)}">${escapeHtml(m.studentName)}</div>
          <div class="dd-card-meta dd-card-meta-primary">${formatDate(m.date)}${m.studentClass ? ` · ${escapeHtml(m.studentClass)}` : ""}</div>
          <div class="dd-card-meta">logged by ${escapeHtml(m.loggedBy)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0">
          <span class="dd-status-dot" style="background:${dotColor}" title="${escapeHtml(dotLabel)}"></span>
          <button class="dd-expand-toggle" data-action="toggle-entry-expanded" data-id="${m.id}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▲" : "▼"}</button>
        </div>
      </div>
      ${expanded ? `
      ${linkedIncidents.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related grooming entries</div>
        ${linkedIncidents.map((x) => `<div class="dd-related-link" data-action="jump-to-incident" data-id="${x.id}">${formatDateShort(x.date)} — ${escapeHtml(truncateName(incidentSummaryLabel(x), 30))}</div>`).join("")}
      </div>` : ""}
      <div class="dd-grid2" style="margin:12px 0">
        <div><div class="dd-field-label">Attendees</div><div class="dd-field-value">${escapeHtml(attendeeSummary(m))}</div></div>
        <div><div class="dd-field-label">Reason for meeting</div><div class="dd-field-value">${escapeHtml(m.reason || "")}</div></div>
      </div>
      <button class="dd-history-toggle" data-action="toggle-pm-history" data-id="${m.id}">${state.historyOpen[m.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[m.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="font-style:italic;color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="dd-add-btn" data-action="edit-pm" data-id="${m.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-pm" data-id="${m.id}">Delete Entry</button>
      </div>` : ""}
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
        <label class="dd-label">Date</label>
        <div class="dd-issue-due-row">
          <div class="dd-date-icon-btn" title="Change the date">
            <input class="dd-input" type="date" name="date" required value="${d.date}" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </div>
          <span class="dd-sans" style="font-size:15px">${formatDate(d.date)}</span>
        </div>
        ${renderReasonPicker(d.reasonCategory, d.reasonOthersText)}
        <label class="dd-label">Who is attending?</label>
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
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save meeting"}</button>
      </form>
    </div>`;
}

// ==================== LISTENERS ====================
function attachMainListeners() {
  const undoBtn = document.getElementById("btn-undo-delete");
  if (undoBtn) undoBtn.addEventListener("click", undoLastDelete);

  document.querySelectorAll('[data-action="view-student"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.studentViewFromSection = state.section;
      state.studentViewName = el.dataset.name;
      state.section = "studentView";
      window.scrollTo(0, 0);
      render();
    }));
  document.querySelectorAll('[data-action="student-view-back"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = state.studentViewFromSection || "dashboard"; render(); }));

  document.querySelectorAll('[data-action="set-section"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = el.dataset.section; render(); }));

  document.querySelectorAll('[data-action="jump-to-incident"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "log"; state.selectedIncidentId = el.dataset.id; state.disciplineFilter = "all"; state.entryExpanded[el.dataset.id] = true; render(); }));
  document.querySelectorAll('[data-action="jump-to-suspension"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "suspensions"; state.selectedSuspId = el.dataset.id; state.entryExpanded[el.dataset.id] = true; render(); }));
  document.querySelectorAll('[data-action="jump-to-pm"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "parentMeetings"; state.selectedPmId = el.dataset.id; state.entryExpanded[el.dataset.id] = true; render(); }));
  document.querySelectorAll('[data-action="toggle-entry-expanded"]').forEach((el) =>
    el.addEventListener("click", () => { state.entryExpanded[el.dataset.id] = !state.entryExpanded[el.dataset.id]; render(); }));

  document.querySelectorAll('[data-action="toggle-level"]').forEach((el) =>
    el.addEventListener("click", () => {
      const key = `${el.dataset.page}ExpandedLevel`;
      const level = parseInt(el.dataset.level, 10);
      state[key] = state[key] === level ? null : level;
      state[`${el.dataset.page}SelectedClass`] = null;
      renderKeepingPageScroll();
    }));
  document.querySelectorAll('[data-action="select-class-pill"]').forEach((el) =>
    el.addEventListener("click", () => {
      const key = `${el.dataset.page}SelectedClass`;
      state[key] = state[key] === el.dataset.class ? null : el.dataset.class;
      renderKeepingPageScroll();
    }));

  document.getElementById("btn-backup").addEventListener("click", downloadBackupFile);

  const settingsBtn = document.getElementById("btn-settings");
  if (settingsBtn) settingsBtn.addEventListener("click", () => { state.section = "settings"; state.settingsView = "menu"; render(); });

  document.querySelectorAll('[data-action="settings-open-years"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "yearList"; render(); }));
  document.querySelectorAll('[data-action="settings-back-to-menu"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "menu"; render(); }));
  document.querySelectorAll('[data-action="settings-back-to-years"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "yearList"; render(); }));
  document.querySelectorAll('[data-action="settings-open-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsSelectedYear = parseInt(el.dataset.year, 10); state.settingsView = "yearReport"; render(); }));

  document.querySelectorAll('[data-action="settings-open-classes"]').forEach((el) =>
    el.addEventListener("click", () => { state._classDraft = classOptionsForCurrentYear().slice(); state.settingsView = "classesForYear"; state.saveError = false; render(); }));

  document.querySelectorAll('[data-action="settings-open-holidays"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "holidays"; state.saveError = false; render(); }));

  document.querySelectorAll('[data-action="settings-open-users"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "userList"; render(); }));
  const signOutBtn = document.getElementById("btn-app-sign-out");
  if (signOutBtn) signOutBtn.addEventListener("click", signOutOfApp);

  const printReportBtn = document.getElementById("btn-print-report");
  if (printReportBtn) printReportBtn.addEventListener("click", () => {
    const label = printReportBtn.querySelector("span");
    if (label) label.textContent = "Opening…";
    printReportBtn.style.opacity = "0.5";
    // The native print dialog can take a moment to build its preview,
    // especially on mobile — this lets the browser paint the "Opening…"
    // state first, so the tap feels acknowledged immediately rather
    // than looking like nothing happened while the dialog loads.
    setTimeout(() => window.print(), 30);
  });

  const loadKnownBtn = document.getElementById("btn-load-known-holidays");
  if (loadKnownBtn) loadKnownBtn.addEventListener("click", async () => {
    const existing = state.holidays?.publicHolidayEntries || [];
    const already = new Set(existing.map((e) => `${e.name}|${e.startDate}`));
    const toAdd = KNOWN_PUBLIC_HOLIDAYS.filter((h) => !already.has(`${h.name}|${h.startDate}`)).map((h) => ({ ...h, id: uid() }));
    if (toAdd.length === 0) return;
    try { await setDoc(doc(db, "holidays", "singapore"), { publicHolidayEntries: [...existing, ...toAdd] }, { merge: true }); }
    catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
  });

  // -- Public Holidays --
  document.querySelectorAll('[data-action="open-add-public-holiday"]').forEach((el) =>
    el.addEventListener("click", () => { state._publicHolidayDraft = { id: null, name: "", startDate: todayISO(), endDate: todayISO() }; state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="edit-public-holiday"]').forEach((el) =>
    el.addEventListener("click", () => {
      const entry = (state.holidays?.publicHolidayEntries || []).find((e) => e.id === el.dataset.id);
      if (entry) { state._publicHolidayDraft = { ...entry }; state.saveError = false; render(); }
    }));
  document.querySelectorAll('[data-action="request-delete-public-holiday"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("publicHoliday", el.dataset.id)));

  // -- School Holidays (correction only, no add/delete) --
  document.querySelectorAll('[data-action="edit-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => {
      state._schoolHolidayDraft = { key: el.dataset.key, label: el.dataset.label, isRange: el.dataset.range === "true", startDate: el.dataset.start, endDate: el.dataset.end };
      state.saveError = false;
      render();
    }));

  document.querySelectorAll('[data-action="open-add-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => { state._extraSchoolHolidayDraft = { id: null, name: "", startDate: todayISO(), endDate: todayISO() }; state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="edit-extra-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => {
      const year = new Date().getFullYear();
      const entry = (state.schoolCalendarOverrides?.[year]?.extraHolidays || []).find((e) => e.id === el.dataset.id);
      if (entry) { state._extraSchoolHolidayDraft = { ...entry }; state.saveError = false; render(); }
    }));
  document.querySelectorAll('[data-action="request-delete-extra-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("extraSchoolHoliday", el.dataset.id)));

  // -- School Closure / HBL Days --
  document.querySelectorAll('[data-action="open-add-closure-day"]').forEach((el) =>
    el.addEventListener("click", () => { state._closureModalDraft = { id: null, type: "closure", startDate: todayISO(), endDate: todayISO(), levels: [1, 2, 3, 4, 5, 6] }; state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="edit-closure-day"]').forEach((el) =>
    el.addEventListener("click", () => {
      const entry = (state.schoolClosureDays?.entries || []).find((e) => e.id === el.dataset.id);
      if (entry) { state._closureModalDraft = { id: entry.id, type: entry.levels.length === 6 ? "closure" : "hbl", startDate: entry.startDate, endDate: entry.endDate, levels: entry.levels.slice() }; state.saveError = false; render(); }
    }));
  document.querySelectorAll('[data-action="request-delete-closure-day"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("schoolClosureDay", el.dataset.id)));

  // -- Public Holiday modal --
  if (state._publicHolidayDraft) {
    const d = state._publicHolidayDraft;
    const close = () => { state._publicHolidayDraft = null; state.saveError = false; render(); };
    const closeBtn = document.getElementById("ph-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = document.getElementById("ph-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target.id === "ph-modal-backdrop") close(); });
    const nameEl = document.getElementById("ph-name-input");
    if (nameEl) nameEl.addEventListener("input", () => { d.name = nameEl.value; });
    const startEl = document.getElementById("ph-start");
    const endEl = document.getElementById("ph-end");
    if (startEl) startEl.addEventListener("change", () => { d.startDate = startEl.value; if (d.endDate < d.startDate) d.endDate = d.startDate; renderKeepingModalScroll(); });
    if (endEl) endEl.addEventListener("change", () => { d.endDate = endEl.value < d.startDate ? d.startDate : endEl.value; renderKeepingModalScroll(); });
    const saveBtn = document.getElementById("btn-save-public-holiday");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      if (!d.name.trim()) { state.saveError = true; state.saveErrorDetail = "Give this holiday a name."; render(); return; }
      state.saveError = false; state.saving = true; render();
      try {
        const existing = state.holidays?.publicHolidayEntries || [];
        const entry = { id: d.id || uid(), name: d.name.trim(), startDate: d.startDate, endDate: d.endDate };
        const updated = d.id ? existing.map((e) => e.id === d.id ? entry : e) : [...existing, entry];
        await setDoc(doc(db, "holidays", "singapore"), { publicHolidayEntries: updated }, { merge: true });
        state._publicHolidayDraft = null; state.saving = false; render();
      } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
    });
  }

  // -- School Holiday correction modal --
  if (state._schoolHolidayDraft) {
    const d = state._schoolHolidayDraft;
    const close = () => { state._schoolHolidayDraft = null; state.saveError = false; render(); };
    const closeBtn = document.getElementById("sh-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = document.getElementById("sh-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target.id === "sh-modal-backdrop") close(); });
    const startEl = document.getElementById("sh-start");
    const endEl = document.getElementById("sh-end");
    if (startEl) startEl.addEventListener("change", () => { d.startDate = startEl.value; if (d.isRange && d.endDate < d.startDate) d.endDate = d.startDate; renderKeepingModalScroll(); });
    if (endEl) endEl.addEventListener("change", () => { d.endDate = endEl.value < d.startDate ? d.startDate : endEl.value; renderKeepingModalScroll(); });
    const saveBtn = document.getElementById("btn-save-school-holiday");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      state.saveError = false; state.saving = true; render();
      const year = String(new Date().getFullYear());
      const patch = d.isRange ? { [`${d.key}Start`]: d.startDate, [`${d.key}End`]: d.endDate } : { [d.key]: d.startDate };
      try {
        await setDoc(doc(db, "settings", "schoolCalendarOverrides"), { [year]: { ...(state.schoolCalendarOverrides?.[year] || {}), ...patch } }, { merge: true });
        state._schoolHolidayDraft = null; state.saving = false; render();
      } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
    });
  }

  // -- Extra (custom) School Holiday modal --
  if (state._extraSchoolHolidayDraft) {
    const d = state._extraSchoolHolidayDraft;
    const close = () => { state._extraSchoolHolidayDraft = null; state.saveError = false; render(); };
    const closeBtn = document.getElementById("esh-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = document.getElementById("esh-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target.id === "esh-modal-backdrop") close(); });
    const nameEl = document.getElementById("esh-name-input");
    if (nameEl) nameEl.addEventListener("input", () => { d.name = nameEl.value; });
    const startEl = document.getElementById("esh-start");
    const endEl = document.getElementById("esh-end");
    if (startEl) startEl.addEventListener("change", () => { d.startDate = startEl.value; if (d.endDate < d.startDate) d.endDate = d.startDate; renderKeepingModalScroll(); });
    if (endEl) endEl.addEventListener("change", () => { d.endDate = endEl.value < d.startDate ? d.startDate : endEl.value; renderKeepingModalScroll(); });
    const saveExtraBtn = document.getElementById("btn-save-extra-school-holiday");
    if (saveExtraBtn) saveExtraBtn.addEventListener("click", async () => {
      if (!d.name.trim()) { state.saveError = true; state.saveErrorDetail = "Give this holiday a name."; render(); return; }
      state.saveError = false; state.saving = true; render();
      const year = String(new Date(d.startDate).getFullYear());
      try {
        const existing = state.schoolCalendarOverrides?.[year]?.extraHolidays || [];
        const entry = { id: d.id || uid(), name: d.name.trim(), startDate: d.startDate, endDate: d.endDate };
        const updated = d.id ? existing.map((e) => e.id === d.id ? entry : e) : [...existing, entry];
        await setDoc(doc(db, "settings", "schoolCalendarOverrides"), { [year]: { ...(state.schoolCalendarOverrides?.[year] || {}), extraHolidays: updated } }, { merge: true });
        state._extraSchoolHolidayDraft = null; state.saving = false; render();
      } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
    });
  }

  // -- School Closure / HBL Day modal --
  if (state._closureModalDraft) {
    const d = state._closureModalDraft;
    const close = () => { state._closureModalDraft = null; state.saveError = false; render(); };
    const closeBtn = document.getElementById("cd-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = document.getElementById("cd-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target.id === "cd-modal-backdrop") close(); });
    document.querySelectorAll('[data-action="cd-set-type"]').forEach((el) =>
      el.addEventListener("click", () => { d.type = el.dataset.type; if (d.type === "closure") d.levels = [1, 2, 3, 4, 5, 6]; else d.levels = []; renderKeepingModalScroll(); }));
    document.querySelectorAll('[data-action="cd-toggle-level"]').forEach((el) =>
      el.addEventListener("click", () => {
        const lvl = parseInt(el.dataset.level, 10);
        d.levels = d.levels.includes(lvl) ? d.levels.filter((x) => x !== lvl) : [...d.levels, lvl];
        renderKeepingModalScroll();
      }));
    const startEl = document.getElementById("cd-start");
    const endEl = document.getElementById("cd-end");
    if (startEl) startEl.addEventListener("change", () => { d.startDate = startEl.value; if (d.endDate < d.startDate) d.endDate = d.startDate; renderKeepingModalScroll(); });
    if (endEl) endEl.addEventListener("change", () => { d.endDate = endEl.value < d.startDate ? d.startDate : endEl.value; renderKeepingModalScroll(); });
    const saveBtn = document.getElementById("btn-save-closure-day");
    if (saveBtn) saveBtn.addEventListener("click", async () => {
      if (d.type === "hbl" && d.levels.length === 0) { state.saveError = true; state.saveErrorDetail = "Pick at least one level for the HBL day."; render(); return; }
      const existing = state.schoolClosureDays?.entries || [];
      const rangesOverlap = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;
      const dLevels = d.type === "closure" ? [1, 2, 3, 4, 5, 6] : d.levels;
      const conflict = existing.find((e) => {
        if (e.id === d.id) return false; // editing itself isn't a conflict
        const eStart = e.startDate || e.date, eEnd = e.endDate || e.date;
        if (!rangesOverlap(d.startDate, d.endDate, eStart, eEnd)) return false;
        // A closure covers every level, so it conflicts with anything on
        // the same dates; two HBL entries only conflict if they actually
        // share a level (P1-P2 HBL and P3-P4 HBL the same day is fine).
        return dLevels.some((l) => e.levels.includes(l));
      });
      if (conflict) {
        const conflictLabel = conflict.levels.length === 6 ? "a School Closure" : "an HBL Day";
        state.saveError = true;
        state.saveErrorDetail = `Those dates overlap with ${conflictLabel} already on ${formatDateOrRange(conflict.startDate || conflict.date, conflict.endDate || conflict.date)} — a School Closure and an HBL Day can't cover the same date.`;
        render();
        return;
      }
      state.saveError = false; state.saving = true; render();
      try {
        const entry = { id: d.id || uid(), startDate: d.startDate, endDate: d.endDate, levels: d.type === "closure" ? [1, 2, 3, 4, 5, 6] : d.levels.slice() };
        const updated = d.id ? existing.map((e) => e.id === d.id ? entry : e) : [...existing, entry];
        await setDoc(doc(db, "settings", "schoolClosureDays"), { entries: updated }, { merge: true });
        state._closureModalDraft = null; state.saving = false; render();
      } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
    });
  }

  document.querySelectorAll('[data-action="goto-classes-for-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "settings"; state._classDraft = classOptionsForCurrentYear().slice(); state.settingsView = "classesForYear"; state.saveError = false; render(); }));
  document.querySelectorAll(".dd-class-year-cb").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (!state._classDraft) state._classDraft = classOptionsForCurrentYear().slice();
      if (cb.checked) { if (!state._classDraft.includes(cb.value)) state._classDraft.push(cb.value); }
      else { state._classDraft = state._classDraft.filter((x) => x !== cb.value); }
    }));
  const saveClassBtn = document.getElementById("btn-save-class-config");
  if (saveClassBtn) saveClassBtn.addEventListener("click", async () => {
    const year = String(new Date().getFullYear());
    const classes = (state._classDraft || []).slice();
    state.saveError = false;
    state.saving = true;
    render();
    try {
      await setDoc(doc(db, "settings", "classConfig"), { classesByYear: { ...(state.classConfig?.classesByYear || {}), [year]: classes } }, { merge: true });
      state.settingsView = "menu";
      state.saving = false;
      render();
    } catch (err) {
      state.saveError = true;
      state.saveErrorDetail = err?.message || String(err);
      state.saving = false;
      render();
    }
  });

  const helpBtn = document.getElementById("btn-help");
  if (helpBtn) helpBtn.addEventListener("click", () => { state.showHelp = true; render(); });
  if (state.showHelp) {
    document.getElementById("help-modal-close").addEventListener("click", () => { state.showHelp = false; render(); });
    document.getElementById("help-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "help-modal-backdrop") { state.showHelp = false; render(); }
    });
  }

  if (state.section === "suspensions") attachSuspListeners();
  else if (state.section === "parentMeetings") attachPmListeners();
  else if (state.section === "log") attachGroomingListeners();
  else if (state.section === "dashboard") attachDashboardListeners();
  else if (state.section === "studentView") { attachGroomingListeners(); attachSuspListeners(); attachPmListeners(); }
}

// Grooming Log page — filter pills, search, follow-up thread, audit
// trail, and the per-issue resolve/escalate/override/undo actions.
function attachGroomingListeners() {
  document.querySelectorAll('[data-action="set-discipline-filter"]').forEach((el) =>
    el.addEventListener("click", () => { state.disciplineFilter = el.dataset.filter; render(); }));

  document.querySelectorAll('[data-action="open-edit-incident"]').forEach((el) =>
    el.addEventListener("click", () => openEditIncident(el.dataset.id)));

  if (state.editingIncidentId && state._editIncidentDraft) {
    const d = state._editIncidentDraft;
    const close = () => { state.editingIncidentId = null; state._editIncidentDraft = null; state.newIncidentFormError = ""; render(); };
    const closeBtn = document.getElementById("edit-modal-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const backdrop = document.getElementById("edit-modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target.id === "edit-modal-backdrop") close(); });
    const nameEl = document.getElementById("edit-incident-student-name");
    if (nameEl) nameEl.addEventListener("input", () => { d.studentName = nameEl.value; });
    const classEl = document.getElementById("edit-incident-class");
    if (classEl) classEl.addEventListener("change", () => { d.studentClass = classEl.value; });
    const dateEl = document.getElementById("edit-incident-date");
    if (dateEl) dateEl.addEventListener("change", () => { d.date = dateEl.value; renderKeepingModalScroll(); });
    const othersEl = document.getElementById("edit-incident-others-text");
    if (othersEl) othersEl.addEventListener("input", () => { d.othersText = othersEl.value; });
    document.querySelectorAll('[data-action="edit-toggle-grooming-issue"]').forEach((el) =>
      el.addEventListener("click", () => {
        const type = el.dataset.issue;
        d.selectedIssues = d.selectedIssues.includes(type) ? d.selectedIssues.filter((x) => x !== type) : [...d.selectedIssues, type];
        renderKeepingModalScroll();
      }));
    const saveBtn = document.getElementById("btn-save-edit-incident");
    if (saveBtn) saveBtn.addEventListener("click", submitEditIncident);
  }

  const search = document.getElementById("search-input");
  if (search) search.addEventListener("input", () => {
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

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
    el.addEventListener("click", () => requestDeleteConfirmation("incident", el.dataset.id)));

  document.querySelectorAll('[data-action="resolve-issue"]').forEach((el) =>
    el.addEventListener("click", () => resolveGroomingIssue(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll('[data-action="escalate-issue"]').forEach((el) =>
    el.addEventListener("click", () => escalateGroomingIssue(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll(".dd-issue-override-input").forEach((el) =>
    el.addEventListener("change", () => { if (el.value) overrideGroomingIssueDeadline(el.dataset.id, el.dataset.issue, el.value); }));
  document.querySelectorAll('[data-action="undo-issue-action"]').forEach((el) =>
    el.addEventListener("click", () => undoGroomingIssueAction(el.dataset.id, el.dataset.issue)));
}

function attachDashboardListeners() {
  document.querySelectorAll('[data-action="toggle-watchlist-info"]').forEach((el) =>
    el.addEventListener("click", () => { state.showWatchlistInfo = !state.showWatchlistInfo; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="toggle-chart-cat"]').forEach((el) =>
    el.addEventListener("click", () => {
      const key = el.dataset.cat === "parentMeeting" ? "chartIncludeParentMeeting" : el.dataset.cat === "suspension" ? "chartIncludeSuspension" : "chartIncludeDiscipline";
      state[key] = !(state[key] !== false);
      renderKeepingPageScroll();
    }));

  document.querySelectorAll('[data-action="set-chart-range"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.chartRangeMode = el.dataset.range;
      if (el.dataset.range === "custom") state.showChartCustomModal = true;
      if (el.dataset.range === "thisMonth") state.calendarViewMonth = currentMonthKeyStr();
      if (el.dataset.range === "today") state.dayViewDate = todayISO();
      if (el.dataset.range === "thisWeek") state.weekViewMonday = currentWeekBounds().monday;
      if (el.dataset.range === "thisYear") state.yearViewYear = new Date().getFullYear();
      state.selectedCalendarDay = null;
      renderKeepingPageScroll();
    }));

  document.querySelectorAll('[data-action="nav-prev-day"]').forEach((el) =>
    el.addEventListener("click", () => { state.dayViewDate = addDays(state.dayViewDate || todayISO(), -1); renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="nav-next-day"]').forEach((el) =>
    el.addEventListener("click", () => { state.dayViewDate = addDays(state.dayViewDate || todayISO(), 1); renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="nav-prev-week"]').forEach((el) =>
    el.addEventListener("click", () => { state.weekViewMonday = addDays(state.weekViewMonday || currentWeekBounds().monday, -7); state.selectedCalendarDay = null; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="nav-next-week"]').forEach((el) =>
    el.addEventListener("click", () => { state.weekViewMonday = addDays(state.weekViewMonday || currentWeekBounds().monday, 7); state.selectedCalendarDay = null; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="nav-prev-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.yearViewYear = (state.yearViewYear || new Date().getFullYear()) - 1; state.selectedCalendarDay = null; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="nav-next-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.yearViewYear = (state.yearViewYear || new Date().getFullYear()) + 1; state.selectedCalendarDay = null; renderKeepingPageScroll(); }));

  document.querySelectorAll('[data-action="cal-prev-month"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.calendarViewMonth = shiftMonthKey(state.calendarViewMonth || currentMonthKeyStr(), -1);
      state.selectedCalendarDay = null;
      renderKeepingPageScroll();
    }));
  document.querySelectorAll('[data-action="cal-next-month"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.calendarViewMonth = shiftMonthKey(state.calendarViewMonth || currentMonthKeyStr(), 1);
      state.selectedCalendarDay = null;
      renderKeepingPageScroll();
    }));
  document.querySelectorAll('[data-action="select-cal-day"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.selectedCalendarDay = state.selectedCalendarDay === el.dataset.date ? null : el.dataset.date;
      renderKeepingPageScroll();
    }));

  document.querySelectorAll('[data-action="set-watch-tier"]').forEach((el) =>
    el.addEventListener("click", () => { state.watchTier = el.dataset.tier; renderKeepingPageScroll(); }));

  const closeCustomModal = () => { state.showChartCustomModal = false; render(); };
  const customModalClose = document.getElementById("chart-custom-modal-close");
  if (customModalClose) customModalClose.addEventListener("click", closeCustomModal);
  const customModalBackdrop = document.getElementById("chart-custom-modal-backdrop");
  if (customModalBackdrop) customModalBackdrop.addEventListener("click", (e) => { if (e.target.id === "chart-custom-modal-backdrop") closeCustomModal(); });
  const customFromEl = document.getElementById("chart-custom-from");
  const customToEl = document.getElementById("chart-custom-to");
  if (customFromEl) customFromEl.addEventListener("change", () => { if (customFromEl.value) state.chartCustomFrom = monthKey(customFromEl.value); renderKeepingModalScroll(); });
  if (customToEl) customToEl.addEventListener("change", () => { if (customToEl.value) state.chartCustomTo = monthKey(customToEl.value); renderKeepingModalScroll(); });
  const customApplyBtn = document.getElementById("chart-custom-apply");
  if (customApplyBtn) customApplyBtn.addEventListener("click", () => {
    const fromSel = document.getElementById("chart-custom-from");
    const toSel = document.getElementById("chart-custom-to");
    if (fromSel && fromSel.value) state.chartCustomFrom = monthKey(fromSel.value);
    if (toSel && toSel.value) state.chartCustomTo = monthKey(toSel.value);
    state.showChartCustomModal = false;
    render();
  });

  const newCaseBtn = document.getElementById("btn-new-case");
  if (newCaseBtn) newCaseBtn.addEventListener("click", () => {
    state.showNewForm = true;
    state._newIncidentDraft = freshIncidentDraft();
    state.newIncidentFormError = "";
    render();
  });

  const newSuspOnlyBtn = document.getElementById("btn-new-susp-only");
  if (newSuspOnlyBtn) newSuspOnlyBtn.addEventListener("click", () => {
    state.showNewSuspForm = true;
    state.editingSuspensionId = null;
    state._suspDraft = freshSuspDraft();
    state.suspFormError = "";
    render();
  });
  const newPmOnlyBtn = document.getElementById("btn-new-pm-only");
  if (newPmOnlyBtn) newPmOnlyBtn.addEventListener("click", () => {
    state.showNewPmForm = true;
    state.editingPmId = null;
    state._pmDraft = freshPmDraft();
    state.pmFormError = "";
    render();
  });

  if (state.showNewCaseFlow) attachNewCaseListeners();
  attachSuspFormModalListeners();
  attachPmFormModalListeners();
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


function attachSuspListeners() {
  document.querySelectorAll('[data-action="set-susp-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.suspTab = el.dataset.tab; render(); }));

  const search = document.getElementById("susp-search-input");
  if (search) search.addEventListener("input", () => {
    state.suspQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("susp-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  document.querySelectorAll('[data-action="delete-suspension"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("suspension", el.dataset.id)));
  document.querySelectorAll('[data-action="edit-suspension"]').forEach((el) =>
    el.addEventListener("click", () => { openEditSuspension(el.dataset.id); state.showNewSuspForm = false; }));
  document.querySelectorAll('[data-action="toggle-susp-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));

  attachSuspFormModalListeners();
}

// Shared between the Suspension Log page (editing) and the Dashboard's
// "+ New Suspension Only" button (creating standalone, no discipline entry).
function attachSuspFormModalListeners() {
  if (state.showNewSuspForm || state.editingSuspensionId) {
    const form = document.getElementById("susp-form");
    form.addEventListener("submit", state.editingSuspensionId ? submitEditSuspension : submitNewSuspension);
    document.getElementById("susp-modal-close").addEventListener("click", () => { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); });
    document.getElementById("susp-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "susp-modal-backdrop") { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); }
    });

    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._suspDraft[name] = el.value; }); };
    syncField("studentName");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._suspDraft.studentClass = classEl.value; regenerateSuspDates(state._suspDraft); renderKeepingModalScroll(); });
    const reasonSel = form.elements["reason"];
    if (reasonSel) reasonSel.addEventListener("change", () => { state._suspDraft.reasonCategory = reasonSel.value; renderKeepingModalScroll(); });
    const reasonOthersEl = form.querySelector(".dd-reason-others-input");
    if (reasonOthersEl) reasonOthersEl.addEventListener("input", () => { state._suspDraft.reasonOthersText = reasonOthersEl.value; });

    attachSuspFieldListeners(form, "susp", state._suspDraft, render);

    const tagPmCb = document.getElementById("susp-tag-pm-cb");
    if (tagPmCb) tagPmCb.addEventListener("change", () => { state._suspDraft.tagPm = tagPmCb.checked; renderKeepingModalScroll(); });
    form.querySelectorAll(".dd-susp-pm-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const list = state._suspDraft.pmAttendees;
        if (cb.checked) { if (!list.includes(cb.value)) list.push(cb.value); }
        else { state._suspDraft.pmAttendees = list.filter((x) => x !== cb.value); }
        renderKeepingModalScroll();
      }));
    const pmOthersEl = document.getElementById("susp-pm-others-text");
    if (pmOthersEl) pmOthersEl.addEventListener("input", () => { state._suspDraft.pmOthersText = pmOthersEl.value; });
    const pmReasonSel = form.querySelector('[name="pmReason"]');
    if (pmReasonSel) pmReasonSel.addEventListener("change", () => { state._suspDraft.pmReasonCategory = pmReasonSel.value; renderKeepingModalScroll(); });
    const pmReasonOthersEl = form.querySelector('.dd-reason-others-input[data-for="pmReason"]');
    if (pmReasonOthersEl) pmReasonOthersEl.addEventListener("input", () => { state._suspDraft.pmReasonOthersText = pmReasonOthersEl.value; });
  }
}

function attachPmListeners() {
  const search = document.getElementById("pm-search-input");
  if (search) search.addEventListener("input", () => {
    state.pmQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("pm-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  });

  document.querySelectorAll('[data-action="set-pm-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.pmTab = el.dataset.tab; render(); }));

  document.querySelectorAll('[data-action="delete-pm"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("parentMeeting", el.dataset.id)));
  document.querySelectorAll('[data-action="edit-pm"]').forEach((el) =>
    el.addEventListener("click", () => { openEditParentMeeting(el.dataset.id); state.showNewPmForm = false; }));
  document.querySelectorAll('[data-action="toggle-pm-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));

  attachPmFormModalListeners();
}

// Shared between the Parent Meeting Log page (editing) and the Dashboard's
// "+ New Meeting Only" button (creating standalone, no discipline entry).
function attachPmFormModalListeners() {
  if (state.showNewPmForm || state.editingPmId) {
    const form = document.getElementById("pm-form");
    form.addEventListener("submit", state.editingPmId ? submitEditParentMeeting : submitNewParentMeeting);
    document.getElementById("pm-modal-close").addEventListener("click", () => { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); });
    document.getElementById("pm-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "pm-modal-backdrop") { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); }
    });
    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._pmDraft[name] = el.value; }); };
    syncField("studentName");
    const reasonSel = form.elements["reason"];
    if (reasonSel) reasonSel.addEventListener("change", () => { state._pmDraft.reasonCategory = reasonSel.value; renderKeepingModalScroll(); });
    const reasonOthersEl = form.querySelector(".dd-reason-others-input");
    if (reasonOthersEl) reasonOthersEl.addEventListener("input", () => { state._pmDraft.reasonOthersText = reasonOthersEl.value; });
    const pmDateEl = form.elements["date"];
    if (pmDateEl) pmDateEl.addEventListener("change", () => { state._pmDraft.date = pmDateEl.value; renderKeepingModalScroll(); });
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._pmDraft.studentClass = classEl.value; });
    form.querySelectorAll(".dd-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const v = cb.value;
        if (cb.checked) { if (!state._pmDraft.attendees.includes(v)) state._pmDraft.attendees.push(v); }
        else { state._pmDraft.attendees = state._pmDraft.attendees.filter((a) => a !== v); }
        if (state._pmDraft.attendees.length > 0) state.pmFormError = "";
        renderKeepingModalScroll();
      }));
    const othersEl = document.getElementById("pm-others-text");
    if (othersEl) othersEl.addEventListener("input", () => { state._pmDraft.othersText = othersEl.value; });
  }
}

// ---------- Pull-to-refresh ----------
// Installed as a standalone PWA (added to Home Screen), the browser's own
// pull-to-refresh gesture doesn't exist — that's a browser-chrome feature
// tied to the address bar, which standalone mode hides. This adds a simple
// custom one. Refreshing also clears the service worker's cache first, so
// it reliably fetches the actual latest deployed version, rather than
// re-showing whatever the cache already had (the same reason "clear site
// data" has been the manual fix for stale versions up to now).
function setupPullToRefresh() {
  const spokes = Array.from({ length: 8 }, (_, i) =>
    `<line x1="12" y1="4" x2="12" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="${(1 - i * 0.11).toFixed(2)}" transform="rotate(${i * 45} 12 12)"></line>`
  ).join("");
  const indicator = document.createElement("div");
  indicator.id = "pull-refresh-indicator";
  indicator.innerHTML = `<svg id="pull-refresh-spinner" width="26" height="26" viewBox="0 0 24 24">${spokes}</svg>`;
  document.body.appendChild(indicator);
  const spinner = indicator.querySelector("#pull-refresh-spinner");

  const THRESHOLD = 70;
  const MAX_PULL = 120;
  let startY = null;
  let pulling = false;

  document.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && !document.querySelector(".dd-modal-backdrop")) {
      startY = e.touches[0].clientY;
      pulling = true;
      indicator.style.transition = "none";
      spinner.style.animation = "dd-spin 0.8s linear infinite";
    } else {
      startY = null;
      pulling = false;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling || startY === null) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 0 && window.scrollY <= 0) {
      const pull = Math.min(delta, MAX_PULL);
      indicator.style.transform = `translateY(${pull - 50}px)`;
      indicator.style.opacity = Math.min(pull / THRESHOLD, 1);
    }
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling || startY === null) return;
    const match = /translateY\(([-\d.]+)px\)/.exec(indicator.style.transform || "");
    const pull = match ? parseFloat(match[1]) + 50 : 0;
    indicator.style.transition = "transform 0.2s ease, opacity 0.2s ease";
    if (pull > THRESHOLD) {
      indicator.style.transform = "translateY(10px)";
      indicator.style.opacity = 1;
      forceRefreshApp();
    } else {
      indicator.style.transform = "translateY(-50px)";
      indicator.style.opacity = 0;
      spinner.style.animation = "none";
    }
    startY = null;
    pulling = false;
  });
}
async function forceRefreshApp() {
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) await reg.unregister();
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (e) { /* ignore — reload regardless */ }
  window.location.reload();
}
setupPullToRefresh();

// Attached once, permanently, to document — not inside attachMainListeners
// — so these buttons always work via event delegation even if a render
// cycle somehow fails to (re-)attach a listener directly to them.
//
// Triggered on touchend rather than waiting for the browser's synthetic
// "click" event: a click only fires after the browser finishes its own
// touch-to-click processing, which can occasionally get disrupted mid-tap
// (e.g. if dismissing a keyboard shifts the layout underneath the finger)
// — that looked like "the first tap does nothing, the second tap works."
// touchend fires the instant the finger lifts, before any of that. A
// timestamp guard stops the same tap from firing twice if a click event
// also ends up following the touchend.
const lastDelegatedActionAt = {};
function runDelegatedAction(key, fn) {
  const now = Date.now();
  if (now - (lastDelegatedActionAt[key] || 0) < 350) return;
  lastDelegatedActionAt[key] = now;
  fn();
}
function handleDelegatedTap(e) {
  const yesBtn = e.target.closest && e.target.closest("#btn-confirm-delete-yes");
  if (yesBtn) { runDelegatedAction("confirm-delete-yes", () => confirmDeleteYes()); return; }
  const noBtn = e.target.closest && e.target.closest("#btn-confirm-delete-no");
  const confirmBackdropHit = e.target.id === "confirm-delete-backdrop";
  if (noBtn || confirmBackdropHit) { runDelegatedAction("confirm-delete-no", () => cancelDeleteConfirmation()); return; }
  const closeBtn = e.target.closest && e.target.closest("#modal-close");
  const backdropHit = e.target.id === "modal-backdrop";
  if (closeBtn || backdropHit) {
    runDelegatedAction("close-new-form", () => { state.showNewForm = false; state._newIncidentDraft = null; render(); });
    return;
  }
  // Whatever event actually changed a field (input, change, autocomplete,
  // autofill, a native picker's own "Done" button — not all of these
  // reliably fire a plain input/change event in every browser before a
  // subsequent tap elsewhere registers), grab every field's current
  // on-screen value before any action triggers a re-render, so nothing
  // typed or picked can ever be wiped out by a stale value lingering in
  // state. Same fix as the name field, applied to every field in this
  // form rather than just the one we happened to notice first.
  if (state._newIncidentDraft) {
    const container = document.getElementById("new-form");
    if (container) {
      const nameEl = container.querySelector("#new-incident-student-name");
      if (nameEl) state._newIncidentDraft.studentName = nameEl.value;
      const classEl = container.querySelector('[name="studentClass"]');
      if (classEl) state._newIncidentDraft.studentClass = classEl.value;
      const dateEl = container.querySelector('[name="date"]');
      if (dateEl) state._newIncidentDraft.date = dateEl.value;
      const othersEl = container.querySelector("#new-incident-others-text");
      if (othersEl) state._newIncidentDraft.othersText = othersEl.value;
    }
  }
  const saveBtn = e.target.closest && e.target.closest("#btn-save-new-incident");
  if (saveBtn && !saveBtn.disabled) { runDelegatedAction("save-new-incident", () => submitNewIncident()); return; }
  const tagBtn = e.target.closest && e.target.closest(".dd-issue-tag");
  if (tagBtn && state._newIncidentDraft) {
    const type = tagBtn.dataset.issue;
    runDelegatedAction("toggle-tag-" + type, () => {
      const list = state._newIncidentDraft.selectedIssues;
      if (list.includes(type)) state._newIncidentDraft.selectedIssues = list.filter((x) => x !== type);
      else list.push(type);
      renderKeepingModalScroll();
    });
  }
}
document.addEventListener("touchend", handleDelegatedTap);
document.addEventListener("click", handleDelegatedTap);

render();
