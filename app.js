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

const APP_VERSION = "2.95.0";

// Paste the Web app URL from your Google Apps Script deployment here (see
// apps-script.gs for setup steps). Leave as-is to skip Sheets logging.
const SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyEXCtdtriLO9Qli9OIEHLH2348T9oc5VFEX9Qr7_nsrEv8zoYlrZftMExpEjcg4h_T/exec";

// Every post carries the signed-in teacher's Firebase ID token. The Apps
// Script checks it with Google before writing anything, so knowing the
// (public) web-app URL alone isn't enough to add or change Sheet rows.
async function logToSheet(record) {
  if (!SHEET_WEBHOOK_URL || SHEET_WEBHOOK_URL.startsWith("PASTE_")) return;
  try {
    const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : "";
    if (!idToken) return;
    fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      body: JSON.stringify({ ...record, idToken, origin: location.origin }),
    }).catch(() => {});
  } catch (e) {
    // best-effort — Firestore remains the source of truth
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
    .map((d) => `${formatDate(d.date)} (${SUSP_TYPE_STYLE[d.type].label}${d.type === "ISS" && d.venue ? ` - ${d.venue}${d.administrator ? ` / ${d.administrator}` : ""}` : ""})`).join("\n");
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
// Same shape as a suspension (Time Outs started life as a copy of that log),
// sent under its own recordType so apps-script.gs files it on its own tab.
function syncTimeOutToSheet(t) {
  logToSheet({
    recordType: "TimeOut", id: t.id,
    studentName: t.studentName, studentClass: t.studentClass,
    toType: toTypeLabel(t.toType),
    reason: (t.deleted ? "Removed — " : "") + (t.reason || ""),
    startDate: t.startDate, totalDays: t.totalDays, issDays: t.issDays, ossDays: t.ossDays,
    scheduleText: formatScheduleForSheet(t.days),
    loggedBy: t.loggedBy,
  });
}
function syncParentMeetingToSheet(m) {
  logToSheet({
    recordType: "ParentMeeting", id: m.id,
    studentName: m.studentName, studentClass: m.studentClass,
    attendeesText: formatAttendeesForSheet(m.attendees, m.othersText),
    date: m.date,
    reason: (m.deleted ? "Removed — " : "") + (m.pmStatus === "Cancelled" ? "[Cancelled] " : m.pmStatus === "Postponed" ? (m.postponedTo ? `[Postponed to ${formatDate(m.postponedTo)}] ` : "[Postponed] ") : "") + (m.reason || ""),
    loggedBy: m.loggedBy,
  });
}

// ---------- Constants ----------
// "Open" removed as a selectable status — new entries default straight to
// "In Progress" (internally "Monitoring", kept for backward compatibility
// with existing data). STATUS_STYLE/STATUS_TEXT still map Open for display,
// so any pre-existing "Open" entries keep rendering correctly.
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
// Status-dot colours shared by every log: green = completed, orange =
// ongoing (upcoming, active, in progress), red = postponed or cancelled.
const STATUS_DOT = { completed: "#3C6E47", ongoing: "#D98F2B", stopped: "#A3372B", removed: "#8A8571" };
const SUSP_STATUS_STYLE = {
  Upcoming: { ink: STATUS_DOT.ongoing, label: "UPCOMING" },
  Active: { ink: STATUS_DOT.ongoing, label: "ACTIVE" },
  Completed: { ink: STATUS_DOT.completed, label: "COMPLETED" },
};
const LOCATION_OPTIONS = ["General Office", "MPR 1"];
// The four kinds of Time Out. Recess/Lesson time outs have no "sent home"
// variant — the student is always kept in school — so those are forced
// in-school for every day. CCA/Learning Experience time outs can go either
// way (stay in school under supervision, or simply not attend), so those
// keep the same editable in-school/out-of-school day split a suspension has.
const TO_TYPES = [
  { key: "Recess", label: "Time Out (Recess)", shortLabel: "Recess", abbrev: "R", alwaysInSchool: true },
  { key: "Lesson", label: "Time Out (Lesson)", shortLabel: "Lesson", abbrev: "L", alwaysInSchool: true },
  { key: "CCA", label: "Time Out (CCA)", shortLabel: "CCA", abbrev: "CCA", alwaysInSchool: false },
  { key: "LearningExperience", label: "Time Out (Learning Experience)", shortLabel: "Learning Exp.", abbrev: "LE", alwaysInSchool: false },
];
function toTypeInfo(key) { return TO_TYPES.find((t) => t.key === key) || TO_TYPES[0]; }
function toTypeLabel(key) { return toTypeInfo(key).label; }
// Tallies a list of already-filtered Time Out records by type — used
// wherever a "Time Out" total is entry-counted (one record = one count),
// i.e. Month/Year/Chart/Annual Report. An unrecognized/missing toType (old
// data from before types existed) is folded into Recess rather than
// dropped, so the breakdown's total always matches the plain count.
function timeOutTypeBreakdown(records) {
  const counts = {};
  TO_TYPES.forEach((t) => { counts[t.key] = 0; });
  records.forEach((t) => { counts[counts.hasOwnProperty(t.toType) ? t.toType : "Recess"]++; });
  return counts;
}
// Splits an already-saved reason (which might be a plain category, or a
// composed "Others — some text" string from a past edit) back into the
// category dropdown's value and the Others box's text, for editing.
function splitSavedReason(saved) {
  if (!saved) return { category: "", othersText: "" };
  saved = canonicalReason(saved);
  if (REASON_OPTIONS.includes(saved) || PM_REASON_OPTIONS.includes(saved)) return { category: saved, othersText: "" };
  const m = /^Others\s*—\s*(.*)$/.exec(saved);
  if (m) return { category: "Others", othersText: m[1] };
  return { category: "Others", othersText: saved };
}
// Multi-select reason checklist shared by the Suspension and Time Out
// forms: the grouped offence list (bold, unselectable category headers) as
// a tick list, so an entry can carry several reasons. "Others" reveals a
// free-text box. `idPrefix` ("susp" / "to") keeps the two lists' ids apart.
function renderMultiReasonPicker(selected, othersText, idPrefix) {
  selected = selected || [];
  return `
    <label class="dd-label">Reason(s) <span class="dd-mono-muted" style="font-size:11px;text-transform:none">select all that apply</span></label>
    <div class="dd-pm-reason-list" id="${idPrefix}-reason-list">
      ${[...OFFENCE_GROUPS, { title: "", items: REASON_EXTRA_OPTIONS }].map((g) => `
      ${g.title ? `<div class="dd-reason-group-head">${escapeHtml(g.title)}</div>` : `<div class="dd-reason-group-head dd-reason-group-head-blank"></div>`}
      ${g.items.map((r) => `
        <div class="dd-pm-reason-row">
          <label class="dd-pm-reason-check">
            <input type="checkbox" class="dd-multi-reason-cb" value="${escapeHtml(r)}" ${selected.includes(r) ? "checked" : ""} />
            <span>${escapeHtml(r)}</span>
          </label>
          ${r === "Others" && selected.includes("Others") ? `
          <div class="dd-pm-reason-extra">
            <input class="dd-input dd-multi-reason-others-input" placeholder="Please specify" value="${escapeHtml(othersText || "")}" />
          </div>` : ""}
        </div>`).join("")}`).join("")}
    </div>`;
}
// Composes the display/search `reason` string from a multi-reason draft,
// in list order ("Assault; Fighting; Others — …"). Existing screens,
// search, the Sheet sync and reports all keep reading this one string.
function composeMultiReason(selected, othersText) {
  const text = (othersText || "").trim();
  return REASON_OPTIONS.filter((r) => (selected || []).includes(r))
    .map((r) => r === "Others" ? (text ? `Others — ${text}` : "Others") : r)
    .join("; ");
}
// Rehydrates a saved suspension's / time out's reasons for editing: new records carry a
// `reasons` array; older ones only have the single `reason` string.
function multiReasonsFromSaved(t) {
  if (Array.isArray(t?.reasons) && t.reasons.length) {
    return { selected: t.reasons.map(canonicalReason), othersText: t.reasonOthersText || "" };
  }
  const split = splitSavedReason(t?.reason);
  return split.category ? { selected: [split.category], othersText: split.othersText } : { selected: [], othersText: "" };
}
// Structured fields saved alongside `reason` on a suspension / time out.
function multiReasonFields(d) {
  const reasons = REASON_OPTIONS.filter((r) => (d.reasons || []).includes(r));
  return { reasons, reasonOthersText: reasons.includes("Others") ? (d.reasonOthersText || "").trim() : "" };
}
// Wires a renderMultiReasonPicker checklist inside `form` to draft `d`.
function attachMultiReasonListeners(form, d) {
  if (!Array.isArray(d.reasons)) d.reasons = [];
  form.querySelectorAll(".dd-multi-reason-cb").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) { if (!d.reasons.includes(cb.value)) d.reasons.push(cb.value); }
    else d.reasons = d.reasons.filter((x) => x !== cb.value);
    renderKeepingModalScroll();
  }));
  const othersEl = form.querySelector(".dd-multi-reason-others-input");
  if (othersEl) othersEl.addEventListener("input", () => { d.reasonOthersText = othersEl.value; });
}
// Builds both the structured `reasons` array (one entry per selected
// offence, with its own Victim/Offender/Both/NA status where applicable)
// and a backward-compatible composed `reason` display string, from a
// draft's reasons/reasonStatuses/reasonOthersText fields. `prefix` picks
// which set of fields to read: "" for the standalone Parent Meet
// draft, "pm" for the tagged-parent-meeting fields nested inside the
// Suspension draft (pmReasons/pmReasonStatuses/pmReasonOthersText).
function composePmReasonData(d, prefix) {
  const selected = (prefix ? d.pmReasons : d.reasons) || [];
  const statuses = (prefix ? d.pmReasonStatuses : d.reasonStatuses) || {};
  const othersText = ((prefix ? d.pmReasonOthersText : d.reasonOthersText) || "").trim();
  const reasons = selected.map((category) => {
    const needsStatus = !NO_STATUS_PM_REASONS.has(category);
    const entry = { category, status: needsStatus ? (statuses[category] || "NA") : null };
    if (category === "Others") entry.othersText = othersText;
    return entry;
  });
  const reason = reasons.map((r) => {
    const label = r.category === "Others" ? (r.othersText ? `Others — ${r.othersText}` : "Others") : r.category;
    return r.status && r.status !== "NA" ? `${label} (${r.status})` : label;
  }).join("; ");
  return { reasons, reason };
}
// Rehydrates a saved parent meeting's reason(s) into draft fields for
// editing. New-format records carry a structured `reasons` array;
// pre-migration records only ever had the old single-string `reason`
// (parsed with splitSavedReason), with no status ever recorded for them.
function pmReasonsFromSaved(m) {
  if (Array.isArray(m?.reasons) && m.reasons.length) {
    const selected = m.reasons.map((r) => canonicalReason(r.category));
    const statuses = {};
    let othersText = "";
    m.reasons.forEach((r) => {
      if (r.status) statuses[canonicalReason(r.category)] = r.status;
      if (r.category === "Others") othersText = r.othersText || "";
    });
    return { selected, statuses, othersText };
  }
  if (m?.reason) {
    const split = splitSavedReason(m.reason);
    if (!split.category) return { selected: [], statuses: {}, othersText: "" };
    return { selected: [split.category], statuses: {}, othersText: split.othersText };
  }
  return { selected: [], statuses: {}, othersText: "" };
}
// Renders the multi-select "Reason(s) for meeting" checklist shared by the
// standalone Parent Meet form and the "tag a parent meeting" block
// inside the Suspension form. A compact scrollable checklist (not a big
// pill grid) since the offence list runs to ~40 options. Each checked
// reason shows its own Victim/Offender/Both/NA status pills directly
// beneath it, except Academic Matters and Learning Needs, which skip
// status entirely since they aren't disciplinary offences.
function renderPmReasonPicker(d, prefix) {
  const selected = (prefix ? d.pmReasons : d.reasons) || [];
  const statuses = (prefix ? d.pmReasonStatuses : d.reasonStatuses) || {};
  const othersText = (prefix ? d.pmReasonOthersText : d.reasonOthersText) || "";
  return `
    <label class="dd-label">Reason(s) for meeting <span class="dd-mono-muted" style="font-size:11px;text-transform:none">select all that apply</span></label>
    <div class="dd-pm-reason-list">
      ${[...OFFENCE_GROUPS, { title: "", items: PM_REASON_EXTRA_OPTIONS }].map((g) => `
      ${g.title ? `<div class="dd-reason-group-head">${escapeHtml(g.title)}</div>` : `<div class="dd-reason-group-head dd-reason-group-head-blank"></div>`}
      ${g.items.map((r) => {
        const checked = selected.includes(r);
        const needsStatus = !NO_STATUS_PM_REASONS.has(r);
        const status = statuses[r] || "NA";
        const isOthers = r === "Others";
        return `
        <div class="dd-pm-reason-row">
          <label class="dd-pm-reason-check">
            <input type="checkbox" class="dd-pm-reason-cb" data-pm-prefix="${prefix}" value="${escapeHtml(r)}" ${checked ? "checked" : ""} />
            <span>${escapeHtml(r)}</span>
          </label>
          ${checked && (needsStatus || isOthers) ? `
          <div class="dd-pm-reason-extra">
            ${needsStatus ? `
            <div class="dd-pm-status-row">
              ${PM_STATUS_OPTIONS.map((st) => `<button type="button" class="dd-pm-status-pill ${status === st ? "active" : ""}" data-action="set-pm-reason-status" data-pm-prefix="${prefix}" data-reason="${escapeHtml(r)}" data-status="${st}">${st}</button>`).join("")}
            </div>` : ""}
            ${isOthers ? `<input class="dd-input dd-pm-others-input" data-pm-prefix="${prefix}" placeholder="Please specify" value="${escapeHtml(othersText)}" />` : ""}
          </div>` : ""}
        </div>`;
      }).join("")}`).join("")}
    </div>`;
}
const ATTENDEE_OPTIONS = ["Father", "Mother", "Grandfather", "Grandmother", "Guardian", "Others"];
// Offence list, grouped by category. Group headers are display-only (bold,
// never selectable) — only the items underneath are stored as reasons.
const OFFENCE_GROUPS = [
  { title: "1. Physical Aggression & Bullying", items: ["Hurtful Behaviour", "Assault", "Physical Bullying", "Fighting"] },
  { title: "2. Respect & Verbal Conduct", items: ["Insensitive Acts/Remarks", "Vulgar/Abusive Language or Gestures", "Verbal Bullying"] },
  { title: "3. Behaviour & Defiance", items: ["Disruptive/Playful Behaviour", "Uncooperative Behaviour", "Open Defiance"] },
  { title: "4. Attendance & School Boundaries", items: ["Skipping Classes", "Truancy", "Leaving School Grounds Without Permission"] },
  { title: "5. Property & Environment", items: ["Littering", "Negligent Damage of Property", "Vandalism"] },
  { title: "6. Device Use", items: ["Unauthorised Device Use"] },
  { title: "7. Learning & Academic Integrity", items: ["Cheating", "Forgery"] },
  { title: "8. Online Conduct", items: ["Online Insensitive Misconduct", "Cyberbullying"] },
  { title: "9. Theft", items: ["Theft"] },
  { title: "10. Smoking, Vaping & Substance-Related Offences", items: ["Smoking", "Vape-Related Offences", "Vaping with Etomidate", "Inhalant Abuse"] },
  { title: "11. Sexual & Explicit Conduct", items: ["Pornography-Related Offence", "Sexual Misconduct"] },
  { title: "12. Other High-Alert Offences", items: ["Gambling", "Scams", "Gangsterism", "Arson", "Possession of Weapons", "Other Illegal / Criminal Offences Causing Grievous Hurt"] },
];
const OFFENCE_LIST = OFFENCE_GROUPS.flatMap((g) => g.items);
// Extra (ungrouped) options listed after the offence groups.
const REASON_EXTRA_OPTIONS = ["Others"];
// The Parent Meet picker also offers two non-disciplinary reasons.
const PM_REASON_EXTRA_OPTIONS = ["Academic Matters", "Learning Needs", "Others"];
const REASON_OPTIONS = [...OFFENCE_LIST, ...REASON_EXTRA_OPTIONS];
const PM_REASON_OPTIONS = [...OFFENCE_LIST, ...PM_REASON_EXTRA_OPTIONS];
// Reasons renamed in the updated offence list — old saved records map onto
// the new name when opened for editing, instead of falling into "Others".
const LEGACY_REASON_ALIASES = {
  "Illegal / Criminal Offences Causing Grievous Hurt": "Other Illegal / Criminal Offences Causing Grievous Hurt",
};
const canonicalReason = (r) => LEGACY_REASON_ALIASES[r] || r;
// Academic Matters/Learning Needs aren't disciplinary offences, so they
// never show or store a Victim/Offender/Both/NA status.
const NO_STATUS_PM_REASONS = new Set(["Academic Matters", "Learning Needs"]);
const PM_STATUS_OPTIONS = ["Victim", "Offender", "Both", "NA"];
// Whether the meeting itself went ahead — separate from the per-reason
// Victim/Offender/Both/NA status above. Cancelled/Postponed meetings stay
// visible in the log, but are excluded from every parent-meeting tally
// (P-level counters, This Week/Upcoming/Completed counts, calendar and
// annual-report totals) via isPmCounted() below, so they don't inflate
// how many meetings actually took place.
// "Scheduled" (the default/normal state) isn't a selectable pill — it's
// just what a meeting is when neither Postponed nor Cancelled is active.
// Clicking an already-active pill toggles it back off (to Scheduled).
const PM_MEETING_STATUS_OPTIONS = ["Postponed", "Cancelled"];
const PM_MEETING_STATUS_STYLE = {
  Postponed: { ink: "#B8863B", label: "POSTPONED" },
  Cancelled: { ink: "#8A8571", label: "CANCELLED" },
};
// A postponed meeting that has its new date set is a live meeting again —
// it counts (calendar dot, totals, This Week/Upcoming/Completed, reports)
// on the NEW date. One with no new date yet, or a cancelled one, doesn't
// count anywhere. pmDate() is the date a meeting counts on.
function isPmRescheduled(m) {
  return m.pmStatus === "Postponed" && !!m.postponedTo;
}
function pmDate(m) {
  return isPmRescheduled(m) ? m.postponedTo : m.date;
}
function isPmCounted(m) {
  return !m.deleted && m.pmStatus !== "Cancelled" && (m.pmStatus !== "Postponed" || !!m.postponedTo);
}

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
  "Improper Earrings/Hair Accessories", "Make Up/Improper Facial Patches",
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
  "Make Up/Improper Facial Patches": { days: [1, 1, 1], parentFrom: 2, finalAction: "facilitated", note: "Student To Remove Immediately" },
  "Religious Items": { days: [1, 1, 1], parentFrom: 1, finalAction: "shsm-only" },
  "Others": { days: [3, 3, 1], parentFrom: 2, finalAction: "facilitated" },
};
// Existing saved issues may still carry the old type string from before
// this was renamed — keep it pointing at the same config so their
// day-counts and parent-contact rules don't silently change underfoot.
GROOMING_ISSUE_CONFIG["Wearing Make Up/Improper Facial Patches"] = GROOMING_ISSUE_CONFIG["Make Up/Improper Facial Patches"];
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
// Delays calling `fn` until `delayMs` has passed with no further calls —
// used on the search boxes so a full page re-render only happens once
// typing pauses, not on every single keystroke.
function debounce(fn, delayMs) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delayMs);
  };
}
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
  // Drop focus first so any on-screen keyboard starts collapsing before the
  // modal is drawn, rather than shifting the modal underneath the finger
  // once it's already up (see the note in handleDelegatedTap).
  try { document.activeElement?.blur?.(); } catch (e) { /* non-fatal */ }
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
  if (target.type === "setPostponeDate") { render(); await setPmPostponedDate(target.id, target.date || ""); return; }
  if (target.type === "incident") await deleteIncident(target.id);
  else if (target.type === "suspension") await deleteSuspension(target.id);
  else if (target.type === "timeOut") await deleteTimeOut(target.id);
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
  } else if (target.type === "authorizedUser") await removeAuthorizedEmail(target.id);
  else if (target.type === "adminUser") await removeAdminEmail(target.id);
  else if (target.type === "transferOwnership") await transferOwnership(target.id);
  else if (target.type === "addAuthorized") await addAuthorizedEmail(target.id);
  else if (target.type === "addAdmin") await addAdminEmail(target.id);
  else if (target.type === "addAllExisting") await addExistingUsersBulk(target.emails || []);
  else if (target.type === "removeMember") await removeMemberFully(target.id);
}
// ---------- Access management (Authorized Teachers / Admins) ----------
// Valid email shape only — the @moe.edu.sg suffix is enforced by
// firestore.rules anyway (isMoeUser() requires it before any of this
// matters), this is just a friendlier client-side check.
function isValidMoeEmail(email) {
  return /^[^\s@]+@moe\.edu\.sg$/i.test(email);
}
// Small "OWNER"/"ADMIN" pill shown beside an email anywhere it appears in
// the Manage Access page, so the account's tier is visible at a glance
// regardless of which list it's found in.
const ACCESS_PILL_STYLE = {
  OWNER: "#1B2A41",
  ADMIN: "#B8863B",
};
function accessPill(label) {
  const ink = ACCESS_PILL_STYLE[label];
  return `<span class="dd-issue-stage-badge" style="background:${ink}22;color:${ink};margin-left:6px">${label}</span>`;
}
async function addAuthorizedEmail(rawEmail) {
  const email = (rawEmail || "").trim().toLowerCase();
  if (!isValidMoeEmail(email)) { state.accessFormError = "Enter a valid @moe.edu.sg email."; render(); return; }
  state.accessFormError = "";
  try {
    await setDoc(doc(db, "authorizedUsers", email), { email, addedAt: Date.now(), addedBy: teacherName() || state.authUser?.email || "" });
  } catch (err) {
    console.error("addAuthorizedEmail failed:", err);
    state.accessFormError = `Couldn't add ${email} — ${err?.code || err?.message || String(err)}`;
  }
  render();
}
async function removeAuthorizedEmail(email) {
  try { await deleteDoc(doc(db, "authorizedUsers", email)); }
  catch (err) { console.error("removeAuthorizedEmail failed:", err); state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
// "Remove User" from the Authorised Teachers List's "⋮" menu — a full
// revoke, distinct from "Remove Admin" (which only demotes and leaves
// their teacher access alone). Clears both collections since either one
// alone is enough to keep someone signed in (isMoeUser() allows either).
// A plain Admin can only ever reach this for a non-admin row, so their
// attempt to delete admins/{email} is expected to be rejected by
// firestore.rules (only the Owner may write there) — harmless, since
// there's nothing to remove from that collection for them anyway.
async function removeMemberFully(email) {
  try {
    await Promise.all([
      deleteDoc(doc(db, "authorizedUsers", email)).catch((err) => console.warn("removeMemberFully: authorizedUsers delete failed (may not exist):", err)),
      deleteDoc(doc(db, "admins", email)).catch((err) => console.warn("removeMemberFully: admins delete failed (expected if caller isn't Owner):", err)),
    ]);
  } catch (err) { console.error("removeMemberFully failed:", err); state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
// Anyone who has ever actually signed in (users/{uid} docs, one per person,
// tracked in state.userList) but isn't yet on the Authorised Teachers List,
// nor already an admin or the owner — i.e. teachers from before this
// allowlist existed who'd otherwise be locked out the next time the
// permission rules cut them off. Used both to show the "Add Existing Users"
// shortcut and to actually perform that bulk add.
function existingUsersNotYetAuthorized() {
  const authorizedEmailSet = new Set((state.authorizedList || []).map((a) => a.id));
  const adminEmailSet = new Set((state.adminsList || []).map((a) => a.id));
  const effectiveOwner = (state.currentOwnerEmail || OWNER_EMAIL).toLowerCase();
  const known = new Set([...authorizedEmailSet, ...adminEmailSet, effectiveOwner]);
  const emails = (state.userList || [])
    .map((u) => (u.email || "").toLowerCase())
    .filter((e) => e && known.has(e) === false);
  return [...new Set(emails)];
}
async function addExistingUsersBulk(emails) {
  if (!emails.length) return;
  state.accessFormError = "";
  try {
    await Promise.all(emails.map((email) =>
      setDoc(doc(db, "authorizedUsers", email), { email, addedAt: Date.now(), addedBy: teacherName() || state.authUser?.email || "", addedFrom: "existingUsers" })
    ));
  } catch (err) { console.error("addExistingUsersBulk failed:", err); state.accessFormError = `Couldn't add everyone — ${err?.code || err?.message || String(err)}`; }
  render();
}
async function addAdminEmail(rawEmail) {
  if (!state.isOwner) return; // firestore.rules is the real gate; this just matches the UI
  const email = (rawEmail || "").trim().toLowerCase();
  if (!isValidMoeEmail(email)) { state.accessFormError = "Enter a valid @moe.edu.sg email."; render(); return; }
  state.accessFormError = "";
  try {
    await setDoc(doc(db, "admins", email), { email, addedAt: Date.now(), addedBy: teacherName() || state.authUser?.email || "" });
  } catch (err) { console.error("addAdminEmail failed:", err); state.accessFormError = `Couldn't add ${email} as admin — ${err?.code || err?.message || String(err)}`; }
  render();
}
async function removeAdminEmail(email) {
  if (!state.isOwner) return;
  try { await deleteDoc(doc(db, "admins", email)); }
  catch (err) { console.error("removeAdminEmail failed:", err); state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
// Hands the day-to-day Owner role to a new email. Writes the outgoing
// owner into admins FIRST (while they still hold owner rights) so they
// keep admin access rather than being cut off, then writes the new owner
// to settings/owner LAST, since that write is what actually gives up the
// current owner's own elevated rights under firestore.rules — reversing
// this order would make the second write get rejected by the rules the
// moment the first one takes effect. OWNER_EMAIL (the hardcoded
// break-glass account) is unaffected either way and remains a permanent
// fallback regardless of how many times ownership is handed over.
async function transferOwnership(rawEmail) {
  if (!state.isOwner) return;
  const email = (rawEmail || "").trim().toLowerCase();
  if (!isValidMoeEmail(email)) { state.accessFormError = "Enter a valid @moe.edu.sg email."; render(); return; }
  state.accessFormError = "";
  const outgoing = state.authUser?.email || "";
  try {
    if (outgoing && outgoing !== OWNER_EMAIL) {
      await setDoc(doc(db, "admins", outgoing), { email: outgoing, addedAt: Date.now(), addedBy: outgoing });
    }
    await setDoc(doc(db, "settings", "owner"), { email, transferredAt: Date.now(), transferredBy: outgoing });
  } catch (err) { console.error("transferOwnership failed:", err); state.accessFormError = `Couldn't transfer ownership — ${err?.code || err?.message || String(err)}`; }
  render();
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
  const msg = state.confirmDeleteTarget?.message || "Delete the entry?";
  return `
    <div class="dd-modal-backdrop" id="confirm-delete-backdrop">
      <div class="dd-modal" style="max-width:340px;text-align:center">
        <div class="dd-modal-title" style="margin-bottom:18px">${escapeHtml(msg)}</div>
        <div style="display:flex;gap:8px">
          <button class="dd-add-btn" style="flex:1;background:#8A8571" id="btn-confirm-delete-no">No</button>
          <button class="dd-add-btn" style="flex:1;background:${state.confirmDeleteTarget?.tone === "confirm" ? "#1B2A41" : "#A3372B"}" id="btn-confirm-delete-yes">Yes</button>
        </div>
      </div>
    </div>`;
}
// The "⋮" action sheet on an Authorised Teachers List row. Never performs
// anything itself — every option here just closes this menu and opens the
// existing Yes/No confirmation modal (requestDeleteConfirmation), so every
// access change still goes through one confirmation, same as before.
function renderMemberActionModal() {
  const t = state.memberActionTarget;
  if (!t) return "";
  const isAdminTier = t.tier === "ADMIN";
  const who = t.name || t.email;
  const rows = [{ label: "Remove User", action: "member-remove-user", danger: true }];
  if (state.isOwner) {
    rows.push(isAdminTier
      ? { label: "Remove Admin", action: "member-remove-admin" }
      : { label: "Make Admin", action: "member-make-admin" });
    rows.push({ label: "Make Owner", action: "member-make-owner" });
  }
  return `
    <div class="dd-modal-backdrop" id="member-action-backdrop">
      <div class="dd-modal" style="max-width:320px">
        <div class="dd-modal-title" style="font-size:17px;margin-bottom:2px">${escapeHtml(who)}</div>
        <div class="dd-mono-muted" style="font-size:12px;margin-bottom:16px">${escapeHtml(t.email)}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${rows.map((r) => `<button type="button" class="dd-add-btn" style="${r.danger ? "background:#A3372B" : "background:#1B2A41"}" data-action="${r.action}" data-id="${escapeHtml(t.email)}" data-name="${escapeHtml(t.name || "")}">${r.label}</button>`).join("")}
          <button type="button" class="dd-add-btn" style="background:#8A8571" id="member-action-cancel">Cancel</button>
        </div>
      </div>
    </div>`;
}
// Same-day duplicate-entry guard, shared by the "new entry" saves on all
// three logs. `existing` is the duplicate record found (or null/undefined
// — nothing to guard). If found, stashes `proceedFn` (a zero-arg function
// that performs the actual save) behind a confirmation modal and returns
// true so the caller stops there; returns false when it's safe to save
// immediately. `proceedFn` is a live closure, not serialized data — fine
// since state only ever lives in memory for this session.
function guardDuplicate(existing, message, proceedFn) {
  if (!existing) return false;
  state.pendingDuplicateConfirm = { message, proceedFn };
  render();
  return true;
}
async function confirmDuplicateYes() {
  const target = state.pendingDuplicateConfirm;
  if (!target) return;
  state.pendingDuplicateConfirm = null;
  if (target.proceedFn) await target.proceedFn();
}
function cancelDuplicateConfirm() {
  state.pendingDuplicateConfirm = null;
  render();
}
function renderDuplicateConfirmModal() {
  const target = state.pendingDuplicateConfirm;
  if (!target) return "";
  return `
    <div class="dd-modal-backdrop" id="confirm-duplicate-backdrop">
      <div class="dd-modal" style="max-width:360px;text-align:center">
        <div class="dd-modal-title" style="margin-bottom:10px">Possible duplicate</div>
        <div class="dd-sans" style="font-size:14px;color:#4A4536;margin-bottom:18px;line-height:1.5">${escapeHtml(target.message)}</div>
        <div style="display:flex;gap:8px">
          <button class="dd-add-btn" style="flex:1;background:#8A8571" id="btn-confirm-duplicate-no">Cancel</button>
          <button class="dd-add-btn" style="flex:1;background:#B8863B" id="btn-confirm-duplicate-yes">Log Anyway</button>
        </div>
      </div>
    </div>`;
}
// Same-day, same-student duplicate detectors for each log, keyed on
// name+class (studentKey) so a same-named student in a different class
// isn't flagged. Grooming/Parent Meet match on a single date;
// Suspension matches when the new suspension's day range overlaps an
// existing one, since suspensions span multiple days. `excludeId` lets an
// edit-save check for a collision with some *other* entry without always
// matching itself.
function findDuplicateGroomingEntry(name, studentClass, date, excludeId) {
  const key = studentKey(name, studentClass);
  return state.incidents.find((i) => !i.deleted && i.id !== excludeId && i.date === date && studentKey(i.studentName, i.studentClass) === key) || null;
}
function findDuplicateParentMeeting(name, studentClass, date, excludeId) {
  const key = studentKey(name, studentClass);
  return state.parentMeetings.find((m) => !m.deleted && m.id !== excludeId && m.date === date && studentKey(m.studentName, m.studentClass) === key) || null;
}
function findDuplicateSuspension(name, studentClass, dates, excludeId) {
  const key = studentKey(name, studentClass);
  const dateSet = new Set(dates);
  return state.suspensions.find((s) => {
    if (s.deleted || s.id === excludeId || studentKey(s.studentName, s.studentClass) !== key) return false;
    return suspensionDayEntries(s).some((e) => dateSet.has(e.date));
  }) || null;
}
// Time Outs share the suspension record shape (per-day ISS/OSS entries),
// so the same overlap check applies — just against the Time Out log only.
function findDuplicateTimeOut(name, studentClass, dates, excludeId) {
  const key = studentKey(name, studentClass);
  const dateSet = new Set(dates);
  return state.timeOuts.find((t) => {
    if (t.deleted || t.id === excludeId || studentKey(t.studentName, t.studentClass) !== key) return false;
    return suspensionDayEntries(t).some((e) => dateSet.has(e.date));
  }) || null;
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

// ---------- App state ----------
const state = {
  authReady: false,
  authUser: null,
  authError: "",
  userList: [],
  isOwner: false,
  isAdmin: false,
  isAdminExplicit: false,
  currentOwnerEmail: "",
  adminsList: [],
  authorizedList: [],
  accessFormError: "",
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
  confirmDeleteTarget: null,
  pendingDuplicateConfirm: null,
  undoToast: null,
  studentViewName: null,
  studentViewClass: null,
  studentViewFromSection: "dashboard",
  showWatchlistInfo: false,
  backupError: "",
  postponePicker: null,
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
  disciplineFilter: "all", // 'all' | 'Monitoring' | 'Resolved'
  selectedIncidentId: null,
  showNewForm: false,
  editingIncidentId: null,
  historyOpen: {},
  entryExpanded: {},
  // The teacher currently targeted by the Authorised Teachers List's "⋮"
  // action menu, e.g. { email, name, tier }. Set when that button is
  // tapped, cleared when the menu is dismissed or an action is chosen
  // (choosing one hands off to the existing Yes/No confirmation modal).
  memberActionTarget: null,
  followDraft: {},
  editingFollowUpId: null,
  followEditDraft: {},

  suspensions: [],
  suspLoaded: false,
  suspTab: "All", // 'All' | 'This Week' | 'Upcoming' | 'Completed' | 'Deleted'
  suspQuery: "",
  selectedSuspId: null,
  showNewSuspForm: false,
  editingSuspensionId: null,
  _suspDraft: null,

  // Time Out log — mirrors the Suspension log's state one-for-one.
  timeOuts: [],
  toLoaded: false,
  toTab: "All", // 'All' | 'This Week' | 'Upcoming' | 'Completed'
  toQuery: "",
  selectedToId: null,
  showNewToForm: false,
  editingTimeOutId: null,
  _toDraft: null,
  toFormError: "",
  timeOutExpandedLevel: null, // read by renderLevelBreakdown("timeOut", …)
  timeOutSelectedClass: null, // read by renderClassPillsRow("timeOut", …)
  chartIncludeTimeOut: true,

  parentMeetings: [],
  pmLoaded: false,
  pmTab: "All", // 'All' | 'This Week' | 'Upcoming' | 'Completed' | 'Deleted'
  pmQuery: "",
  selectedPmId: null,
  showNewPmForm: false,
  editingPmId: null,
  _pmDraft: null,
  pmFormError: "",
  suspFormError: "",
  newIncidentFormError: "",

  saveError: false,
  saveErrorDetail: "",
  saving: false,
};

const root = document.getElementById("app");
let unsubIncidents = null;
let unsubSuspensions = null;
let unsubTimeOuts = null;
let unsubHolidays = null;
let unsubParentMeetings = null;
let unsubUsers = null;
let unsubAdmins = null;
let unsubAuthorized = null;
let unsubOwner = null;

const ALLOWED_EMAIL_DOMAIN = "moe.edu.sg";
// Permanent "break-glass" account — always allowed in no matter what,
// even if the Authorized Teachers/Admins/Owner data is empty or wrong, so
// there's always a way to recover access management. Changing this
// requires editing the code (here) AND firestore.rules, then redeploying
// both — it's intentionally not manageable from inside the app.
//
// The *day-to-day* Owner is separate and IS handed over from inside the
// app (Settings → Manage Access → Transfer Ownership), stored in the
// settings/owner Firestore doc and reflected live in state.currentOwnerEmail.
// This constant stays valid as a permanent fallback even after a transfer.
const OWNER_EMAIL = "wong_jun_kai@moe.edu.sg";
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
  if (unsubTimeOuts) { unsubTimeOuts(); unsubTimeOuts = null; }
  if (unsubHolidays) { unsubHolidays(); unsubHolidays = null; }
  if (unsubParentMeetings) { unsubParentMeetings(); unsubParentMeetings = null; }
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  if (unsubAdmins) { unsubAdmins(); unsubAdmins = null; }
  if (unsubAuthorized) { unsubAuthorized(); unsubAuthorized = null; }
  if (unsubOwner) { unsubOwner(); unsubOwner = null; }
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
  // Provisional — corrected (possibly to true, if ownership was handed to
  // this account) once the live settings/owner listener starts below.
  state.isOwner = email === OWNER_EMAIL;
  try {
    const userDoc = await getDoc(doc(db, "users", u.uid));
    state.teacherName = (userDoc.exists() && userDoc.data().name) ? userDoc.data().name : "";
  } catch (e) {
    // A permission-denied read here (the "users" collection only requires
    // being signed in AND authorized — see firestore.rules) means this
    // account isn't on the Authorized Teachers list and isn't an admin,
    // i.e. their access has been removed. Sign them out with a clear
    // message rather than silently falling back to an empty app. Any
    // other kind of error (offline, etc.) keeps the old local fallback.
    if (e?.code === "permission-denied") {
      state.authError = "Your access to Discipline Diary has been removed. Contact your school's Discipline Diary admin if you believe this is a mistake.";
      state.authUser = null;
      await signOutOfApp();
      render();
      return;
    }
    state.teacherName = localStorage.getItem("dd-teacher-name") || "";
  }
  state.isAdminExplicit = false;
  if (!state.isOwner) {
    try {
      const adminDoc = await getDoc(doc(db, "admins", email));
      state.isAdminExplicit = adminDoc.exists();
    } catch (e) { state.isAdminExplicit = false; }
  }
  state.isAdmin = state.isOwner || state.isAdminExplicit;
  if (state.teacherName) startListening();
  render();
});

// Fires on any live Firestore listener's error callback. A permission-
// denied error here (as opposed to offline/network errors) means this
// account's access was just revoked while they were mid-session — the
// Authorized Teachers/Admins removal takes effect on Firestore's side in
// real time, so this is how an active "unauthorized user" session actually
// gets kicked out immediately, not just blocked on their next sign-in.
function handleRealtimePermissionError(err) {
  if (err?.code === "permission-denied" && state.authUser) {
    state.authError = "Your access to Discipline Diary has been removed. Contact your school's Discipline Diary admin if you believe this is a mistake.";
    state.authUser = null;
    signOutOfApp();
    render();
    return true;
  }
  return false;
}
// Starts/stops the admin-only listeners (Admins list, Authorized Teachers
// list) to match the current state.isAdmin. Called at initial sign-in and
// again every time the live Owner listener fires, since a mid-session
// ownership transfer can flip state.isAdmin for both the outgoing and
// incoming owner without either of them signing out and back in.
// Every signed-in authorized user can now VIEW the Admins/Authorized
// Teachers lists (Settings → Authorized Teachers / Manage Access) — only
// managing them (add/remove/transfer) is restricted to admins/owner, and
// that's enforced separately in the UI (state.isAdmin/state.isOwner gates
// on the buttons) and in firestore.rules (writes require isAdmin()/
// isOwner()). So these listeners just always run once signed in; nothing
// left to start/stop reactively, but the function name stays for the one
// call site that re-invokes it when ownership changes.
function ensureAccessSubscriptions() {
  if (!unsubAdmins) {
    unsubAdmins = onSnapshot(
      collection(db, "admins"),
      (snap) => {
        state.adminsList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        // Keep this account's own admin flag live off the same snapshot,
        // rather than only the one-shot getDoc at sign-in: otherwise
        // someone promoted to Admin mid-session sees no admin controls
        // until they sign out and back in, and someone demoted keeps
        // seeing controls whose writes firestore.rules then rejects.
        const myEmail = state.authUser?.email || "";
        state.isAdminExplicit = !!myEmail && snap.docs.some((d) => d.id === myEmail);
        state.isAdmin = state.isOwner || state.isAdminExplicit;
        render();
      },
      (err) => { handleRealtimePermissionError(err); }
    );
  }
  if (!unsubAuthorized) {
    unsubAuthorized = onSnapshot(
      collection(db, "authorizedUsers"),
      (snap) => { state.authorizedList = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
      (err) => { handleRealtimePermissionError(err); }
    );
  }
}
function startListening() {
  state.dataLoaded = false;
  state.suspLoaded = false;
  state.toLoaded = false;
  state.pmLoaded = false;
  if (unsubUsers) unsubUsers();
  unsubUsers = onSnapshot(
    collection(db, "users"),
    (snap) => { state.userList = snap.docs.map((d) => d.data()); render(); },
    (err) => { handleRealtimePermissionError(err); }
  );
  if (unsubOwner) unsubOwner();
  unsubOwner = onSnapshot(
    doc(db, "settings", "owner"),
    (snap) => {
      state.currentOwnerEmail = snap.exists() ? (snap.data().email || "").toLowerCase() : "";
      state.isOwner = !!state.authUser && (state.authUser.email === OWNER_EMAIL || state.authUser.email === state.currentOwnerEmail);
      state.isAdmin = state.isOwner || state.isAdminExplicit;
      ensureAccessSubscriptions();
      render();
    },
    () => {}
  );
  ensureAccessSubscriptions();
  unsubIncidents = onSnapshot(
    collection(db, "incidents"),
    (snap) => {
      state.incidents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.dataLoaded = true;
      writeBackupSnapshot();
      render();
    },
    (err) => { if (!handleRealtimePermissionError(err)) { state.dataLoaded = true; render(); } }
  );
  unsubTimeOuts = onSnapshot(
    collection(db, "timeOuts"),
    (snap) => {
      state.timeOuts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.toLoaded = true;
      writeBackupSnapshot();
      render();
    },
    // Unlike the other three logs this collection is new, so until the
    // updated firestore.rules are published every read is denied. Treat
    // that as "no Time Outs yet" rather than signing everyone out — the
    // permission-denied from a missing rule would otherwise be read as
    // "your access was revoked" by handleRealtimePermissionError.
    // Leaves whatever was already loaded in place rather than blanking it,
    // so a transient failure can't wipe the list (or the backup snapshot,
    // which is written from this same state).
    (err) => { state.toLoaded = true; console.error("Time Out log listener failed:", err); render(); }
  );
  unsubSuspensions = onSnapshot(
    collection(db, "suspensions"),
    (snap) => {
      state.suspensions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.suspLoaded = true;
      writeBackupSnapshot();
      render();
    },
    (err) => { if (!handleRealtimePermissionError(err)) { state.suspLoaded = true; render(); } }
  );
  unsubParentMeetings = onSnapshot(
    collection(db, "parentMeetings"),
    (snap) => {
      state.parentMeetings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.pmLoaded = true;
      writeBackupSnapshot();
      render();
    },
    (err) => { if (!handleRealtimePermissionError(err)) { state.pmLoaded = true; render(); } }
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

// ---------- Rolling Firestore backup ----------
// Firestore caps a single document at 1 MB, so the backup is split: one
// document per log per year ("backups/incidents-2026"), and a year that
// grows past BACKUP_CHUNK_BYTES is further split into numbered parts
// ("backups/incidents-2026-p2"). "backups/index" lists every current part.
// Only parts whose content actually changed are rewritten. If a write
// fails, state.backupError shows a warning bar instead of failing silently.
const BACKUP_CHUNK_BYTES = 700000;
const BACKUP_COLLECTIONS = [
  { key: "incidents", dateField: "date" },
  { key: "suspensions", dateField: "startDate" },
  { key: "timeOuts", dateField: "startDate" },
  { key: "parentMeetings", dateField: "date" },
];
let backupTimer = null;
const lastBackupJson = {};
let backupIndexIds = null;
// Groups every record into backup parts: { "incidents-2026": [...], ... }.
function buildBackupParts() {
  const parts = {};
  BACKUP_COLLECTIONS.forEach(({ key, dateField }) => {
    const byYear = {};
    (state[key] || []).forEach((r) => {
      const year = /^\d{4}/.test(r[dateField] || "") ? r[dateField].slice(0, 4) : "undated";
      (byYear[year] = byYear[year] || []).push(r);
    });
    Object.entries(byYear).forEach(([year, records]) => {
      records.sort((x, y) => String(x.id).localeCompare(String(y.id)));
      const chunks = [[]];
      let size = 0;
      records.forEach((r) => {
        const len = JSON.stringify(r).length;
        if (size + len > BACKUP_CHUNK_BYTES && chunks[chunks.length - 1].length) { chunks.push([]); size = 0; }
        chunks[chunks.length - 1].push(r);
        size += len;
      });
      chunks.forEach((c, i) => { parts[`${key}-${year}${i ? `-p${i + 1}` : ""}`] = c; });
    });
  });
  return parts;
}
function writeBackupSnapshot() {
  if (!state.dataLoaded || !state.suspLoaded || !state.toLoaded || !state.pmLoaded) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    const parts = buildBackupParts();
    const now = Date.now();
    try {
      if (backupIndexIds === null) {
        const snap = await getDoc(doc(db, "backups", "index"));
        backupIndexIds = snap.exists() ? (snap.data().parts || []) : [];
      }
      // Parts that no longer exist (e.g. a year shrank back to one part)
      // are emptied rather than deleted — the rules never allow deleting
      // backups from the app.
      const stale = backupIndexIds.filter((id) => !(id in parts));
      for (const [id, records] of Object.entries(parts)) {
        const json = JSON.stringify(records);
        if (lastBackupJson[id] === json) continue;
        await setDoc(doc(db, "backups", id), { updatedAt: now, records });
        lastBackupJson[id] = json;
      }
      for (const id of stale) {
        await setDoc(doc(db, "backups", id), { updatedAt: now, records: [], emptiedAt: now });
      }
      const ids = Object.keys(parts).sort();
      if (JSON.stringify(ids) !== JSON.stringify(backupIndexIds) || stale.length) {
        await setDoc(doc(db, "backups", "index"), { updatedAt: now, parts: ids });
        backupIndexIds = ids;
      }
      // The old single-document backup is replaced by a small pointer so it
      // can't hit the 1 MB limit (everything it held is in the parts above).
      if (!lastBackupJson.__legacyPointer) {
        await setDoc(doc(db, "backups", "latest"), { updatedAt: now, movedTo: "backups/index" });
        lastBackupJson.__legacyPointer = "1";
      }
      if (state.backupError) { state.backupError = ""; render(); }
    } catch (e) {
      const msg = e?.code || e?.message || String(e);
      if (state.backupError !== msg) { state.backupError = msg; render(); }
    }
  }, 1500);
}
function downloadBackupFile() {
  const payload = {
    exportedAt: new Date().toISOString(),
    incidents: state.incidents,
    suspensions: state.suspensions,
    timeOuts: state.timeOuts,
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
  return { studentName: "", studentClass: "", date: todayISO(), selectedIssues: [], othersText: "", linkedSuspensionIds: [], linkedTimeOutIds: [], linkedPmIds: [], extraStudents: [] };
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
  if (issue.type === "Others" && issue.othersText) return `Others — ${issue.othersText}`;
  // Older saved issues may still carry the pre-rename type string —
  // display the current name without needing to migrate stored data.
  return issue.type === "Wearing Make Up/Improper Facial Patches" ? "Make Up/Improper Facial Patches" : issue.type;
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
    syncIncidentToSheet(entry);
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  finally { state.saving = false; render(); }
}
function findRelatedRecords(studentName) {
  const name = normalizeName(studentName);
  if (!name) return { suspensions: [], timeOuts: [], parentMeetings: [] };
  return {
    suspensions: state.suspensions.filter((s) => !s.deleted && normalizeName(s.studentName) === name),
    timeOuts: state.timeOuts.filter((t) => !t.deleted && normalizeName(t.studentName) === name),
    parentMeetings: state.parentMeetings.filter((m) => !m.deleted && normalizeName(m.studentName) === name),
  };
}

// ---------- New Case wizard: Discipline -> Suspension? -> Parent Meet? -> Submit ----------
// Creates one grooming incident doc for a single student (issues shared
// across a multi-student batch save) and syncs it to the Sheet. Used both
// for the form's primary student and for every "also logging" extra
// student — factored out so a batch save doesn't repeat the same block
// per student.
// `links` carries the related records ticked in the form — only ever passed
// for the primary student. It used to be hard-coded empty here, so the
// grooming entry's own "Related" box never showed the links even though the
// suspension/meeting side had them.
async function createIncidentDocForStudent(name, studentClass, date, selectedIssues, othersText, now, links) {
  const issues = selectedIssues.map((type) => freshGroomingIssue(type, othersText, date, classLevel(studentClass)));
  const issueSummary = issues.map((x) => groomingIssueLabel(x)).join(", ");
  const docRef = await addDoc(collection(db, "incidents"), {
    studentName: name, studentClass, date, issues,
    linkedSuspensionIds: (links?.suspensionIds || []).slice(),
    linkedTimeOutIds: (links?.timeOutIds || []).slice(),
    linkedPmIds: (links?.pmIds || []).slice(),
    loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
    history: [{ id: uid(), type: "created", detail: `Entry created — ${issueSummary}`, by: teacherName(), at: now }],
  });
  syncIncidentToSheet({ id: docRef.id, studentName: name, studentClass, date, issue: issueSummary, actionTaken: "", status: "Monitoring", followUps: [], loggedBy: teacherName(), deleted: false });
  return { docRef, issueSummary };
}
async function submitNewIncident() {
  const container = document.getElementById("new-form");
  const d = state._newIncidentDraft;
  const studentName = (container.querySelector('[name="studentName"]')?.value || "").trim().replace(/\s+/g, " ");
  const studentClass = container.querySelector('[name="studentClass"]')?.value || "";
  const date = container.querySelector('[name="date"]')?.value || d.date;
  const selectedIssues = d.selectedIssues || [];
  // Extra students added via "+ Add another student" — same issue(s) and
  // date as the primary student, but no auto-linking to related
  // suspensions/meetings (that box is only shown for the primary name).
  // Fully-empty rows (never filled in) are dropped silently.
  const extraStudents = (d.extraStudents || [])
    .map((s) => ({ name: (s.name || "").trim().replace(/\s+/g, " "), studentClass: s.studentClass || "" }))
    .filter((s) => s.name || s.studentClass);
  if (!studentName) { state.newIncidentFormError = "Enter the student's name."; render(); return; }
  if (!studentClass) { state.newIncidentFormError = "Select a class."; render(); return; }
  if (selectedIssues.length === 0) { state.newIncidentFormError = "Select at least one issue."; render(); return; }
  if (selectedIssues.includes("Others") && !(d.othersText || "").trim()) { state.newIncidentFormError = "Specify what \"Others\" means for this entry."; render(); return; }
  if (extraStudents.some((s) => !s.name || !s.studentClass)) { state.newIncidentFormError = "Fill in the name and class for every added student, or remove the empty row."; render(); return; }
  const allStudents = [{ name: studentName, studentClass }, ...extraStudents];
  // The same student listed twice in one batch is always a mistake (it
  // would create two identical entries), so this is a hard stop rather
  // than the "log anyway" warning used for a clash with an already-saved
  // entry.
  const batchKeys = allStudents.map((s) => studentKey(s.name, s.studentClass));
  const repeatedIdx = batchKeys.findIndex((k, i) => batchKeys.indexOf(k) !== i);
  if (repeatedIdx !== -1) {
    state.newIncidentFormError = `${allStudents[repeatedIdx].name} is listed twice — remove the duplicate row.`;
    render();
    return;
  }
  state.newIncidentFormError = "";

  const dupNames = [...new Set(allStudents.filter((s) => findDuplicateGroomingEntry(s.name, s.studentClass, date)).map((s) => s.name))];

  const doSave = async () => {
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      const { docRef, issueSummary } = await createIncidentDocForStudent(studentName, studentClass, date, selectedIssues, d.othersText, now, {
        suspensionIds: d.linkedSuspensionIds, timeOutIds: d.linkedTimeOutIds || [], pmIds: d.linkedPmIds,
      });
      // Reflect the link on the other side too, so it shows up on the
      // suspension/meeting record itself, not just this new entry.
      // (Only the primary student's entry can carry these — the related-
      // records box is only ever shown for them.)
      for (const sId of d.linkedSuspensionIds) {
        try {
          await updateDoc(doc(db, "suspensions", sId), {
            linkedIncidentIds: arrayUnion(docRef.id),
            history: arrayUnion({ id: uid(), type: "linked", detail: `Linked to grooming entry: "${issueSummary}"`, by: teacherName(), at: now }),
          });
        } catch (err) { /* non-fatal, main entry already saved */ }
      }
      for (const tId of (d.linkedTimeOutIds || [])) {
        try {
          await updateDoc(doc(db, "timeOuts", tId), {
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
      // Same issue(s), no auto-linking, for every additional student in
      // the batch — one bad row shouldn't block the rest.
      for (const s of extraStudents) {
        try { await createIncidentDocForStudent(s.name, s.studentClass, date, selectedIssues, d.othersText, Date.now()); }
        catch (err) { /* non-fatal */ }
      }
      state.showNewForm = false;
      state._newIncidentDraft = null;
      state.section = "log";
      state.disciplineFilter = "all";
      state.selectedIncidentId = docRef.id;
      state.entryExpanded[docRef.id] = true;
    } catch (err) {
      state.saveError = true;
      state.saveErrorDetail = err?.message || String(err);
    } finally {
      state.saving = false;
      render();
    }
  };

  if (dupNames.length > 0) {
    const message = dupNames.length === 1
      ? `${dupNames[0]} already has a grooming entry logged today. Log another anyway?`
      : `${dupNames.join(", ")} already have a grooming entry logged today. Log anyway for all of them?`;
    if (guardDuplicate(true, message, doSave)) return;
  }
  await doSave();
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
  try {
    await setDoc(doc(db, t.collectionName, t.id), t.data);
    const restored = { ...t.data, id: t.id, deleted: false };
    if (t.collectionName === "incidents") syncIncidentToSheet(restored);
    else if (t.collectionName === "suspensions") syncSuspensionToSheet(restored);
    else if (t.collectionName === "timeOuts") syncTimeOutToSheet(restored);
    else if (t.collectionName === "parentMeetings") syncParentMeetingToSheet(restored);
  }
  catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
async function deleteIncident(id) {
  const entry = state.incidents.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "incidents", id));
    if (entry) {
      const { id: _drop, ...data } = entry;
      showUndoToast("incidents", id, data);
      syncIncidentToSheet({ ...entry, deleted: true });
    }
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
  const trimmedName = d.studentName.trim().replace(/\s+/g, " ");

  const doSave = async () => {
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
        studentName: trimmedName, studentClass: d.studentClass, date: d.date, issues: finalIssues,
        history: arrayUnion({ id: uid(), type: "edited", detail: `Entry edited — issues now: ${finalIssues.map(groomingIssueLabel).join(", ")}`, by: teacherName(), at: now }),
      });
      syncIncidentToSheet({ ...it, studentName: trimmedName, studentClass: d.studentClass, date: d.date, issues: finalIssues });
      state.editingIncidentId = null;
      state._editIncidentDraft = null;
      state.saving = false;
      render();
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); state.saving = false; render(); }
  };

  // Only worth flagging when the edit actually changes who/when this
  // entry is for — tweaking just the issues on an entry that hasn't
  // moved shouldn't re-trigger this on every save.
  const identityChanged = trimmedName !== it.studentName || d.studentClass !== it.studentClass || d.date !== it.date;
  if (identityChanged) {
    const dup = findDuplicateGroomingEntry(trimmedName, d.studentClass, d.date, it.id);
    if (guardDuplicate(dup, `${trimmedName} already has a grooming entry logged on ${formatDate(d.date)} (by ${dup?.loggedBy || "another teacher"}). Save anyway?`, doSave)) return;
  }
  await doSave();
}

// ==================== SUSPENSIONS (new unified per-day model) ====================
function freshSuspDraft() {
  return {
    studentName: "", studentClass: "", reasons: [], reasonOthersText: "", startDate: todayISO(),
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [], issOverridden: [], issVenues: {},
    tagPm: false, pmAttendees: [], pmOthersText: "",
    pmReasons: [], pmReasonStatuses: {}, pmReasonOthersText: "",
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
// Suspension in-school days only: the General Office / MPR 1 room list and
// its fixed capacity is a Suspension-only concept. A Time Out's location is
// wherever that student is actually sent that period (a free-text field,
// not booked from this fixed list), so it has no capacity to track here.
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
  const studentName = f.studentName.value.trim().replace(/\s+/g, " ");
  const studentClass = f.studentClass.value;
  const reason = composeMultiReason(d.reasons, d.reasonOthersText);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.suspFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if ((d.reasons || []).includes("Others") && !(d.reasonOthersText || "").trim()) {
    state.suspFormError = "Specify what \"Others\" means in the reason.";
    render();
    return;
  }
  if (!d.issDates.every((dt) => d.issVenues[dt])) {
    state.suspFormError = `Book a location for all ${d.issDays} in-school day${d.issDays === 1 ? "" : "s"} before saving (${d.issDates.filter((dt) => d.issVenues[dt]).length} booked so far).`;
    render();
    return;
  }
  const pmReasonData = d.tagPm ? composePmReasonData(d, "pm") : { reasons: [], reason: "" };
  if (d.tagPm && (d.pmAttendees.length === 0 || pmReasonData.reasons.length === 0)) {
    state.suspFormError = "Fill in who's attending and the reason for the tagged parent meeting.";
    render();
    return;
  }
  if (d.tagPm && pmReasonData.reasons.some((r) => r.category === "Others") && !(d.pmReasonOthersText || "").trim()) {
    state.suspFormError = "Specify what \"Others\" means for the tagged parent meeting.";
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

  const doSave = async () => {
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      const docRef = await addDoc(collection(db, "suspensions"), {
        studentName, studentClass, reason, ...multiReasonFields(d), startDate: d.startDate,
        totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays,
        days,
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `Suspension created — ${d.totalDays} day${d.totalDays > 1 ? "s" : ""} total (${d.ossDays} out-of-school, ${d.issDays} in-school)`, by: teacherName(), at: now }],
      });
      if (d.tagPm) {
        try {
          const pmRef = await addDoc(collection(db, "parentMeetings"), {
            studentName, studentClass, date: d.startDate, attendees: d.pmAttendees.slice(),
            othersText: d.pmOthersText || "", reason: pmReasonData.reason, reasons: pmReasonData.reasons,
            linkedSuspensionIds: [docRef.id],
            loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
            history: [{ id: uid(), type: "created", detail: "Parent meeting tagged from a suspension entry", by: teacherName(), at: now }],
          });
          await updateDoc(doc(db, "suspensions", docRef.id), { linkedPmIds: arrayUnion(pmRef.id) });
          syncParentMeetingToSheet({ id: pmRef.id, studentName, studentClass, date: d.startDate, attendees: d.pmAttendees, othersText: d.pmOthersText || "", reason: pmReasonData.reason, loggedBy: teacherName(), deleted: false });
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
  };

  const dup = findDuplicateSuspension(studentName, studentClass, days.map((x) => x.date));
  if (guardDuplicate(dup, `${studentName} already has an overlapping suspension logged (by ${dup?.loggedBy || "another teacher"}). Log another anyway?`, doSave)) return;
  await doSave();
}
async function deleteSuspension(id) {
  const entry = state.suspensions.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "suspensions", id));
    if (entry) {
      const { id: _drop, ...data } = entry;
      showUndoToast("suspensions", id, data);
      syncSuspensionToSheet({ ...entry, deleted: true });
    }
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
  const reasonMulti = multiReasonsFromSaved(s);
  state._suspDraft = {
    studentName: s.studentName, studentClass: s.studentClass, reasons: reasonMulti.selected, reasonOthersText: reasonMulti.othersText,
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
  const studentName = f.studentName.value.trim().replace(/\s+/g, " ");
  const studentClass = f.studentClass.value;
  const reason = composeMultiReason(d.reasons, d.reasonOthersText);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.suspFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if ((d.reasons || []).includes("Others") && !(d.reasonOthersText || "").trim()) {
    state.suspFormError = "Specify what \"Others\" means in the reason.";
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
  const updated = { studentName, studentClass, reason, ...multiReasonFields(d), startDate: d.startDate, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days };
  const changes = diffText(s, updated, [
    { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
    { key: "reason", label: "Reason" }, { key: "totalDays", label: "Total days" },
  ]);
  const oldDaysKey = JSON.stringify(suspensionDayEntries(s));
  const newDaysKey = JSON.stringify(days);
  if (oldDaysKey !== newDaysKey) changes.push("Day-by-day schedule updated");
  if (changes.length === 0) { state.editingSuspensionId = null; state._suspDraft = null; render(); return; }

  const doSave = async () => {
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
  };

  // Only worth flagging when the edit actually moves who/when this
  // suspension covers — editing just the reason or a booked location
  // shouldn't re-trigger this on every save.
  const identityChanged = studentName !== s.studentName || studentClass !== s.studentClass || oldDaysKey !== newDaysKey;
  if (identityChanged) {
    const dup = findDuplicateSuspension(studentName, studentClass, days.map((x) => x.date), id);
    if (guardDuplicate(dup, `${studentName} already has an overlapping suspension logged (by ${dup?.loggedBy || "another teacher"}). Save anyway?`, doSave)) return;
  }
  await doSave();
}

// ==================== TIME OUTS ====================
// Started as a one-for-one copy of the Suspension log, so a Time Out record
// has exactly the same shape (total/ISS/OSS days, per-day entries with a
// booked location for in-school days, reason, optional tagged parent
// meeting). That means the pure record helpers — suspensionDayEntries,
// suspensionDateRange, suspensionStatus, regenerateSuspDates — work on it
// unchanged and are shared rather than duplicated. Everything tied to the
// collection, state, or wording lives here, so the two logs can diverge
// independently later.
function freshTimeOutDraft() {
  return {
    studentName: "", studentClass: "", reasons: [], reasonOthersText: "", startDate: todayISO(),
    toType: "Recess",
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [], issOverridden: [], issVenues: {}, issAdministrators: {},
    tagPm: false, pmAttendees: [], pmOthersText: "",
    pmReasons: [], pmReasonStatuses: {}, pmReasonOthersText: "",
  };
}
// Same day-generation logic as a suspension (regenerateSuspDates), but for
// Recess/Lesson time outs the in-school/out-of-school split isn't left to
// the teacher — it's forced to "every day in school" first. Also keeps
// issAdministrators in step with issVenues as the day list changes, the
// same way regenerateSuspDates already trims issVenues.
function regenerateTimeOutDates(d) {
  if (toTypeInfo(d.toType).alwaysInSchool) {
    d.issDays = d.totalDays || 0;
    d.ossDays = 0;
  }
  regenerateSuspDates(d);
  const keptAdmins = {};
  (d.issDates || []).forEach((dt) => { if (d.issAdministrators && d.issAdministrators[dt]) keptAdmins[dt] = d.issAdministrators[dt]; });
  d.issAdministrators = keptAdmins;
  return d;
}
async function submitNewTimeOut(e) {
  e.preventDefault();
  const f = e.target;
  const d = state._toDraft;
  const studentName = f.studentName.value.trim().replace(/\s+/g, " ");
  const studentClass = f.studentClass.value;
  const reason = composeMultiReason(d.reasons, d.reasonOthersText);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.toFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if ((d.reasons || []).includes("Others") && !(d.reasonOthersText || "").trim()) {
    state.toFormError = "Specify what \"Others\" means in the reason.";
    render();
    return;
  }
  if (!d.issDates.every((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim())) {
    const done = d.issDates.filter((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim()).length;
    state.toFormError = `Fill in the location and administrator for all ${d.issDays} in-school day${d.issDays === 1 ? "" : "s"} before saving (${done} of ${d.issDays} done).`;
    render();
    return;
  }
  const pmReasonData = d.tagPm ? composePmReasonData(d, "pm") : { reasons: [], reason: "" };
  if (d.tagPm && (d.pmAttendees.length === 0 || pmReasonData.reasons.length === 0)) {
    state.toFormError = "Fill in who's attending and the reason for the tagged parent meeting.";
    render();
    return;
  }
  if (d.tagPm && pmReasonData.reasons.some((r) => r.category === "Others") && !(d.pmReasonOthersText || "").trim()) {
    state.toFormError = "Specify what \"Others\" means for the tagged parent meeting.";
    render();
    return;
  }
  state.toFormError = "";
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: (d.issVenues[date] || "").trim(),
    administrator: (d.issAdministrators[date] || "").trim(),
  }));
  const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));

  const doSave = async () => {
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      const docRef = await addDoc(collection(db, "timeOuts"), {
        studentName, studentClass, reason, ...multiReasonFields(d), startDate: d.startDate, toType: d.toType,
        totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays,
        days,
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `${toTypeLabel(d.toType)} created — ${d.totalDays} day${d.totalDays > 1 ? "s" : ""} total (${d.ossDays} out-of-school, ${d.issDays} in-school)`, by: teacherName(), at: now }],
      });
      if (d.tagPm) {
        try {
          const pmRef = await addDoc(collection(db, "parentMeetings"), {
            studentName, studentClass, date: d.startDate, attendees: d.pmAttendees.slice(),
            othersText: d.pmOthersText || "", reason: pmReasonData.reason, reasons: pmReasonData.reasons,
            linkedTimeOutIds: [docRef.id],
            loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
            history: [{ id: uid(), type: "created", detail: "Parent meeting tagged from a time out entry", by: teacherName(), at: now }],
          });
          await updateDoc(doc(db, "timeOuts", docRef.id), { linkedPmIds: arrayUnion(pmRef.id) });
          syncParentMeetingToSheet({ id: pmRef.id, studentName, studentClass, date: d.startDate, attendees: d.pmAttendees, othersText: d.pmOthersText || "", reason: pmReasonData.reason, loggedBy: teacherName(), deleted: false });
        } catch (err) { /* non-fatal — time out already saved */ }
      }
      state.showNewToForm = false;
      state._toDraft = null;
      state.section = "timeOuts";
      state.toTab = "All";
      state.selectedToId = docRef.id;
      state.entryExpanded[docRef.id] = true;
      syncTimeOutToSheet({ id: docRef.id, studentName, studentClass, toType: d.toType, reason, startDate: d.startDate, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days, loggedBy: teacherName(), deleted: false });
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
  };

  const dup = findDuplicateTimeOut(studentName, studentClass, days.map((x) => x.date));
  if (guardDuplicate(dup, `${studentName} already has an overlapping time out logged (by ${dup?.loggedBy || "another teacher"}). Log another anyway?`, doSave)) return;
  await doSave();
}
async function deleteTimeOut(id) {
  const entry = state.timeOuts.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "timeOuts", id));
    if (entry) {
      const { id: _drop, ...data } = entry;
      showUndoToast("timeOuts", id, data);
      syncTimeOutToSheet({ ...entry, deleted: true });
    }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}
function openEditTimeOut(id) {
  const t = state.timeOuts.find((i) => i.id === id);
  if (!t) return;
  state.editingTimeOutId = id;
  const entries = suspensionDayEntries(t);
  const ossDates = entries.filter((x) => x.type === "OSS").map((x) => x.date).sort();
  const issEntries = entries.filter((x) => x.type === "ISS").sort((a, b) => a.date.localeCompare(b.date));
  const issDates = issEntries.map((x) => x.date);
  const issVenues = {};
  const issAdministrators = {};
  issEntries.forEach((x) => { issVenues[x.date] = x.venue || ""; issAdministrators[x.date] = x.administrator || ""; });
  const reasonMulti = multiReasonsFromSaved(t);
  state._toDraft = {
    studentName: t.studentName, studentClass: t.studentClass, reasons: reasonMulti.selected, reasonOthersText: reasonMulti.othersText,
    startDate: t.startDate || (entries[0] && entries[0].date) || todayISO(),
    toType: t.toType || "Recess",
    totalDays: t.totalDays || entries.length, issDays: issDates.length, ossDays: ossDates.length,
    ossDates, issDates, issOverridden: issDates.map(() => false), issVenues, issAdministrators,
  };
  state.toFormError = "";
  render();
}
async function submitEditTimeOut(e) {
  e.preventDefault();
  const f = e.target;
  const id = state.editingTimeOutId;
  const t = state.timeOuts.find((i) => i.id === id);
  if (!t) return;
  const d = state._toDraft;
  const studentName = f.studentName.value.trim().replace(/\s+/g, " ");
  const studentClass = f.studentClass.value;
  const reason = composeMultiReason(d.reasons, d.reasonOthersText);
  if (!studentName || !studentClass || !reason || !d.totalDays) {
    state.toFormError = "Fill in every required field before saving.";
    render();
    return;
  }
  if ((d.reasons || []).includes("Others") && !(d.reasonOthersText || "").trim()) {
    state.toFormError = "Specify what \"Others\" means in the reason.";
    render();
    return;
  }
  if (!d.issDates.every((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim())) {
    const done = d.issDates.filter((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim()).length;
    state.toFormError = `Fill in the location and administrator for all ${d.issDays} in-school day${d.issDays === 1 ? "" : "s"} before saving (${done} of ${d.issDays} done).`;
    render();
    return;
  }
  state.toFormError = "";
  const ossEntries = d.ossDates.map((date) => ({ date, type: "OSS" }));
  const issEntries = d.issDates.map((date) => ({
    date, type: "ISS",
    venue: (d.issVenues[date] || "").trim(),
    administrator: (d.issAdministrators[date] || "").trim(),
  }));
  const days = [...ossEntries, ...issEntries].sort((a, b) => a.date.localeCompare(b.date));
  const updated = { studentName, studentClass, reason, ...multiReasonFields(d), startDate: d.startDate, toType: d.toType, totalDays: d.totalDays, issDays: d.issDays, ossDays: d.ossDays, days };
  const changes = diffText(
    { ...t, toType: toTypeLabel(t.toType) }, { ...updated, toType: toTypeLabel(updated.toType) },
    [
      { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
      { key: "reason", label: "Reason" }, { key: "totalDays", label: "Total days" },
      { key: "toType", label: "Type" },
    ]);
  const oldDaysKey = JSON.stringify(suspensionDayEntries(t));
  const newDaysKey = JSON.stringify(days);
  if (oldDaysKey !== newDaysKey) changes.push("Day-by-day schedule updated");
  if (changes.length === 0) { state.editingTimeOutId = null; state._toDraft = null; render(); return; }

  const doSave = async () => {
    const now = Date.now();
    state.saveError = false;
    state.saving = true;
    render();
    try {
      await updateDoc(doc(db, "timeOuts", id), {
        ...updated,
        history: arrayUnion({ id: uid(), type: "edited", detail: `Time out edited — ${changes.join("; ")}`, by: teacherName(), at: now }),
      });
      syncTimeOutToSheet({ ...t, ...updated });
      state.editingTimeOutId = null;
      state._toDraft = null;
    } catch (err) { state.saveError = true; } finally { state.saving = false; render(); }
  };

  const identityChanged = studentName !== t.studentName || studentClass !== t.studentClass || oldDaysKey !== newDaysKey;
  if (identityChanged) {
    const dup = findDuplicateTimeOut(studentName, studentClass, days.map((x) => x.date), id);
    if (guardDuplicate(dup, `${studentName} already has an overlapping time out logged (by ${dup?.loggedBy || "another teacher"}). Save anyway?`, doSave)) return;
  }
  await doSave();
}

// ==================== PARENT MEETINGS ====================
function freshPmDraft(m) {
  const r = pmReasonsFromSaved(m);
  return {
    studentName: m?.studentName || "", studentClass: m?.studentClass || "",
    date: m?.date || todayISO(),
    reasons: r.selected, reasonStatuses: r.statuses, reasonOthersText: r.othersText,
    attendees: (m?.attendees || []).slice(), othersText: m?.othersText || "",
    meetingStatus: m?.pmStatus || "Scheduled",
    postponedTo: m?.postponedTo || "",
  };
}
async function submitNewParentMeeting(e) {
  e.preventDefault();
  const f = e.target;
  const studentName = f.studentName.value.trim().replace(/\s+/g, " ");
  const studentClass = f.studentClass.value;
  const date = f.date.value;
  const { reasons, reason } = composePmReasonData(state._pmDraft, "");
  const attendees = state._pmDraft.attendees.slice();
  const othersText = state._pmDraft.othersText.trim();
  const pmStatus = state._pmDraft.meetingStatus || "Scheduled";
  const postponedTo = pmStatus === "Postponed" ? (state._pmDraft.postponedTo || "") : "";
  if (!studentName || !studentClass || !date || reasons.length === 0 || attendees.length === 0) {
    state.pmFormError = attendees.length === 0 ? "Select at least one attendee before saving."
      : reasons.length === 0 ? "Select at least one reason for the meeting before saving."
      : "Fill in every required field before saving.";
    render();
    return;
  }
  if (reasons.some((r) => r.category === "Others") && !state._pmDraft.reasonOthersText.trim()) {
    state.pmFormError = "Specify what \"Others\" means for this meeting.";
    render();
    return;
  }
  state.pmFormError = "";

  const doSave = async () => {
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      const attendeeSummaryStr = attendees.map((a) => a === "Others" && othersText ? `Others (${othersText})` : a).join(", ");
      const docRef = await addDoc(collection(db, "parentMeetings"), {
        studentName, studentClass, date, reason, reasons, attendees, othersText, pmStatus, postponedTo,
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `Meeting logged — attendees: ${attendeeSummaryStr}${pmStatus !== "Scheduled" ? ` (${pmStatus}${postponedTo ? ` to ${formatDate(postponedTo)}` : ""})` : ""}`, by: teacherName(), at: now }],
      });
      state.showNewPmForm = false;
      state._pmDraft = null;
      state.section = "parentMeetings";
      state.pmTab = "All";
      state.selectedPmId = docRef.id;
      state.entryExpanded[docRef.id] = true;
      syncParentMeetingToSheet({ id: docRef.id, studentName, studentClass, date, reason, attendees, othersText, pmStatus, postponedTo, loggedBy: teacherName(), deleted: false });
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
  };

  const dup = findDuplicateParentMeeting(studentName, studentClass, date);
  if (guardDuplicate(dup, `${studentName} already has a parent meeting logged today (by ${dup?.loggedBy || "another teacher"}). Log another anyway?`, doSave)) return;
  await doSave();
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
  const { reasons, reason } = composePmReasonData(state._pmDraft, "");
  const updated = {
    studentName: f.studentName.value.trim().replace(/\s+/g, " "), studentClass: f.studentClass.value,
    date: f.date.value, reason, reasons,
    attendees: state._pmDraft.attendees.slice(), othersText: state._pmDraft.othersText.trim(),
    pmStatus: state._pmDraft.meetingStatus || "Scheduled",
  };
  updated.postponedTo = updated.pmStatus === "Postponed" ? (state._pmDraft.postponedTo || "") : "";
  if (!updated.studentName || !updated.studentClass || !updated.date || reasons.length === 0 || updated.attendees.length === 0) {
    state.pmFormError = updated.attendees.length === 0 ? "Select at least one attendee before saving."
      : reasons.length === 0 ? "Select at least one reason for the meeting before saving."
      : "Fill in every required field before saving.";
    render();
    return;
  }
  if (reasons.some((r) => r.category === "Others") && !state._pmDraft.reasonOthersText.trim()) {
    state.pmFormError = "Specify what \"Others\" means for this meeting.";
    render();
    return;
  }
  state.pmFormError = "";
  const changes = diffText({ ...m, pmStatus: m.pmStatus || "Scheduled" }, updated, [
    { key: "studentName", label: "Student name" }, { key: "studentClass", label: "Class" },
    { key: "date", label: "Date" }, { key: "reason", label: "Reason" }, { key: "pmStatus", label: "Meeting status" },
  ]);
  if (JSON.stringify((m.attendees || []).slice().sort()) !== JSON.stringify(updated.attendees.slice().sort())) changes.push("Attendees updated");
  if ((m.postponedTo || "") !== updated.postponedTo) changes.push(updated.postponedTo ? `Postponed meeting date set to ${formatDate(updated.postponedTo)}` : "Postponed meeting date cleared");
  if (changes.length === 0) { state.editingPmId = null; state._pmDraft = null; render(); return; }

  const doSave = async () => {
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
  };

  // Only worth flagging when the edit actually moves who/when this
  // meeting is for — editing just the reason or attendees shouldn't
  // re-trigger this on every save.
  const identityChanged = updated.studentName !== m.studentName || updated.studentClass !== m.studentClass || updated.date !== m.date;
  if (identityChanged) {
    const dup = findDuplicateParentMeeting(updated.studentName, updated.studentClass, updated.date, id);
    if (guardDuplicate(dup, `${updated.studentName} already has a parent meeting logged on ${formatDate(updated.date)} (by ${dup?.loggedBy || "another teacher"}). Save anyway?`, doSave)) return;
  }
  await doSave();
}
// Quick status toggle straight from the (possibly still-collapsed) log
// card — no need to open the Edit meeting modal just to mark a meeting
// Postponed or Cancelled. Clicking the already-active pill reverts to
// Scheduled (there's no separate "Scheduled" pill to click instead).
async function setPmStatusQuick(id, status) {
  const m = state.parentMeetings.find((x) => x.id === id);
  if (!m || m.deleted) return;
  const current = m.pmStatus || "Scheduled";
  const next = current === status ? "Scheduled" : status;
  if (next === current) return;
  const now = Date.now();
  state.saveError = false;
  render();
  // The postponed-to date only means something while the meeting is
  // Postponed, so it's cleared when the status moves away from that.
  const patch = { pmStatus: next };
  if (next !== "Postponed" && m.postponedTo) patch.postponedTo = "";
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      ...patch,
      history: arrayUnion({ id: uid(), type: "edited", detail: `Meeting status changed to ${next}`, by: teacherName(), at: now }),
    });
    syncParentMeetingToSheet({ ...m, ...patch });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}
// Sets (or clears, with "") the new date for a postponed meeting — used by
// the date box on the log card and on the Dashboard's "Pending Parent
// Meeting Date" list. Optional: a postponed meeting can wait without one.
async function setPmPostponedDate(id, date) {
  const m = state.parentMeetings.find((x) => x.id === id);
  if (!m || m.deleted || m.pmStatus !== "Postponed") return;
  date = date || "";
  if ((m.postponedTo || "") === date) return;
  const now = Date.now();
  state.saveError = false;
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      postponedTo: date,
      history: arrayUnion({ id: uid(), type: "edited", detail: date ? `Postponed meeting date set to ${formatDate(date)}` : "Postponed meeting date cleared", by: teacherName(), at: now }),
    });
    syncParentMeetingToSheet({ ...m, postponedTo: date });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}
// "Postponed to" control (log card + Dashboard). Opens the in-app date
// picker rather than the phone's own one: on iPhones the native picker
// fills in today's date the moment it opens, which used to save straight
// away and close the picker. `editable: false` (Dashboard, once a date is
// set) shows the date as plain text — changes are made in the log.
function renderPostponeDateField(m, opts) {
  const editable = !opts || opts.editable !== false;
  if (m.postponedTo && !editable) {
    return `<div class="dd-pm-postpone-row"><span class="dd-sans" style="font-size:14px">${formatDate(m.postponedTo)}</span><div class="dd-mono-muted" style="font-size:11px;margin-top:2px">To change it, edit the meeting in the Parent Meet log.</div></div>`;
  }
  return `
    <div class="dd-issue-due-row dd-pm-postpone-row">
      <button type="button" class="dd-date-icon-btn" data-pp-open="save" data-id="${m.id}" title="Choose the postponed meeting date">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
      </button>
      ${m.postponedTo
        ? `<span class="dd-sans" style="font-size:14px">${formatDate(m.postponedTo)}</span><button type="button" class="dd-followup-icon-btn" data-pp-clear="save" data-id="${m.id}" title="Clear this date">✕</button>`
        : `<span class="dd-mono-muted" style="font-size:12px">Not set yet</span>`}
    </div>`;
}

// ---------- In-app date picker for the postponed meeting date ----------
// Nothing is pre-selected: tap a day, then ✓. From the log card or the
// Dashboard ("save" mode) a confirmation pops up before anything is saved;
// in the Edit meeting form ("draft" mode) ✓ just fills the field, and the
// form's own Save button is the confirmation. Days on or before the
// original meeting date can't be picked.
// Re-render without losing the scroll position of the Edit meeting form
// (when open) or of the page underneath.
function ppRender() { if (state._pmDraft && (state.editingPmId || state.showNewPmForm)) renderKeepingModalScroll(); else renderKeepingPageScroll(); }
function openPostponePicker(mode, pmId) {
  let original, current;
  if (mode === "draft") {
    if (!state._pmDraft) return;
    original = state._pmDraft.date || todayISO();
    current = state._pmDraft.postponedTo || "";
  } else {
    const m = state.parentMeetings.find((x) => x.id === pmId);
    if (!m) return;
    original = m.date || todayISO();
    current = m.postponedTo || "";
  }
  const start = current || [todayISO(), addDays(original, 1)].sort().pop();
  try { document.activeElement?.blur?.(); } catch (e) { /* non-fatal */ }
  state.postponePicker = { mode, pmId: pmId || null, minExclusive: original, current, selected: "", month: start.slice(0, 7) };
  ppRender();
}
function renderPostponePicker() {
  const pp = state.postponePicker;
  const [y, mo] = pp.month.split("-").map(Number);
  const lead = new Date(y, mo - 1, 1).getDay();
  const daysIn = new Date(y, mo, 0).getDate();
  const today = todayISO();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<span></span>`);
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${pp.month}-${String(d).padStart(2, "0")}`;
    const disabled = iso <= pp.minExclusive;
    const cls = ["dd-pp-day", iso === pp.selected ? "selected" : "", iso === pp.current ? "current" : "", iso === today ? "today" : ""].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-pp="day" data-date="${iso}" ${disabled ? "disabled" : ""}>${d}</button>`);
  }
  return `
    <div class="dd-modal-backdrop" id="pp-backdrop">
      <div class="dd-modal dd-pp-modal" role="dialog" aria-label="Choose the postponed meeting date">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Postponed meeting date</div>
          <button type="button" class="dd-modal-close" data-pp="cancel">✕</button>
        </div>
        <div class="dd-mono-muted" style="font-size:11px;margin:-6px 0 10px">Original meeting: ${formatDate(pp.minExclusive)}${pp.current ? ` · currently ${formatDate(pp.current)}` : ""}</div>
        <div class="dd-pp-nav">
          <button type="button" class="dd-pp-navbtn" data-pp="prev" title="Previous month">‹</button>
          <div class="dd-pp-month">${monthLabelFromKey(pp.month)}</div>
          <button type="button" class="dd-pp-navbtn" data-pp="next" title="Next month">›</button>
        </div>
        <div class="dd-pp-grid">
          ${["S", "M", "T", "W", "T", "F", "S"].map((w) => `<span class="dd-pp-wd">${w}</span>`).join("")}
          ${cells.join("")}
        </div>
        <div class="dd-pp-picked">${pp.selected ? `Selected: <b>${formatDate(pp.selected)}</b>` : "Tap a date, then ✓"}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button type="button" class="dd-add-btn" style="flex:1;background:#8A8571" data-pp="cancel">Cancel</button>
          <button type="button" class="dd-add-btn dd-pp-ok" style="flex:1" data-pp="ok" ${pp.selected ? "" : "disabled"} title="Use this date">✓</button>
        </div>
      </div>
    </div>`;
}
function shiftPickerMonth(delta) {
  const pp = state.postponePicker;
  const [y, m] = pp.month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  pp.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  ppRender();
}
function confirmPostponePick() {
  const pp = state.postponePicker;
  if (!pp || !pp.selected) return;
  state.postponePicker = null;
  if (pp.mode === "draft") {
    if (state._pmDraft) state._pmDraft.postponedTo = pp.selected;
    ppRender();
    return;
  }
  const m = state.parentMeetings.find((x) => x.id === pp.pmId);
  if (!m) { ppRender(); return; }
  requestDeleteConfirmation("setPostponeDate", pp.pmId, {
    date: pp.selected, tone: "confirm",
    message: `Set ${m.studentName}'s postponed parent meeting to ${formatDate(pp.selected)}?`,
  });
}
function requestClearPostponeDate(mode, pmId) {
  if (mode === "draft") { if (state._pmDraft) state._pmDraft.postponedTo = ""; ppRender(); return; }
  const m = state.parentMeetings.find((x) => x.id === pmId);
  if (!m) return;
  requestDeleteConfirmation("setPostponeDate", pmId, { date: "", message: `Clear the postponed meeting date for ${m.studentName}?` });
}
// Picker taps go through the always-live delegated handler (like the other
// pop-up confirmations). On touch devices the follow-up "click" is
// cancelled, so the tap on ✓ can't also land on the confirmation's Yes
// button that appears in the same spot.
function handlePostponePickerTap(e) {
  const el = e.target.closest && e.target.closest("[data-pp],[data-pp-open],[data-pp-clear]");
  if (!el) return false;
  if (e.type === "touchend") e.preventDefault();
  if (el.disabled) return true;
  if (el.dataset.ppOpen) { runDelegatedAction("pp-open", () => openPostponePicker(el.dataset.ppOpen, el.dataset.id)); return true; }
  if (el.dataset.ppClear) { runDelegatedAction("pp-clear", () => requestClearPostponeDate(el.dataset.ppClear, el.dataset.id)); return true; }
  if (!state.postponePicker) return true;
  const a = el.dataset.pp;
  if (a === "day") runDelegatedAction("pp-day-" + el.dataset.date, () => { state.postponePicker.selected = el.dataset.date; ppRender(); });
  else if (a === "prev") runDelegatedAction("pp-prev", () => shiftPickerMonth(-1));
  else if (a === "next") runDelegatedAction("pp-next", () => shiftPickerMonth(1));
  else if (a === "ok") runDelegatedAction("pp-ok", () => confirmPostponePick());
  else if (a === "cancel") runDelegatedAction("pp-cancel", () => { state.postponePicker = null; ppRender(); });
  return true;
}
async function deleteParentMeeting(id) {
  const entry = state.parentMeetings.find((i) => i.id === id);
  try {
    await deleteDoc(doc(db, "parentMeetings", id));
    if (entry) {
      const { id: _drop, ...data } = entry;
      showUndoToast("parentMeetings", id, data);
      syncParentMeetingToSheet({ ...entry, deleted: true });
    }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}

// ==================== RENDER ====================
// Which access-error message we've already scrolled into view (see render()).
let lastScrolledAccessError = "";
// Shown on the loading screens when the device has no connection — the
// app shell opens offline (service worker), but entries need the network.
const OFFLINE_NOTE = `<div class="dd-mono-muted" style="font-size:12px;margin-top:10px;text-align:center;max-width:280px">You're offline. Entries will load once you're connected again.</div>`;
function isOffline() { return typeof navigator !== "undefined" && navigator.onLine === false; }
window.addEventListener("online", () => render());
window.addEventListener("offline", () => render());
function render() {
  if (!state.authReady) { root.innerHTML = `<div class="dd-center" style="flex-direction:column"><div class="dd-mono">Opening the log…</div>${isOffline() ? OFFLINE_NOTE : ""}</div>`; return; }
  if (!state.authUser) { root.innerHTML = renderSignInScreen(); attachSignInListeners(); return; }
  if (!state.teacherName) { root.innerHTML = renderNameScreen(); attachNameListeners(); return; }
  if (!state.dataLoaded || !state.suspLoaded || !state.toLoaded || !state.pmLoaded) { root.innerHTML = `<div class="dd-center" style="flex-direction:column"><div class="dd-mono">Loading entries…</div>${isOffline() ? OFFLINE_NOTE : ""}</div>`; return; }
  updateFollowUpBadge();
  root.innerHTML = renderMain();
  attachMainListeners();
  // The Authorised Teachers List's add/remove/promote actions can fail
  // silently-looking otherwise (e.g. a rules rejection) — the confirm
  // modal closes either way, so without this the only sign of trouble is
  // small text below the compose bar, easy to miss if it's off-screen.
  // Only scroll when the message itself changes: every live Firestore
  // snapshot triggers a re-render, and scrolling on each one would keep
  // yanking the page while the error is on screen.
  if (state.accessFormError) {
    if (lastScrolledAccessError !== state.accessFormError) {
      const errEl = document.getElementById("access-form-error");
      if (errEl) { lastScrolledAccessError = state.accessFormError; errEl.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  } else {
    lastScrolledAccessError = "";
  }
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
  else if (state.section === "timeOuts") html = renderTimeOutSection();
  else if (state.section === "settings") html = renderSettingsSection();
  else html = renderParentMeetingSection();
  if (state._publicHolidayDraft) html += renderPublicHolidayModal();
  if (state._schoolHolidayDraft) html += renderSchoolHolidayEditModal();
  if (state._extraSchoolHolidayDraft) html += renderExtraSchoolHolidayModal();
  if (state._closureModalDraft) html += renderClosureDayModal();
  html += state.memberActionTarget ? renderMemberActionModal() : "";
  html += state.postponePicker ? renderPostponePicker() : "";
  html += state.confirmDeleteTarget ? renderDeleteConfirmModal() : "";
  html += state.pendingDuplicateConfirm ? renderDuplicateConfirmModal() : "";
  html += state.undoToast ? renderUndoToast() : "";
  return html + renderKnownStudentsDatalist();
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
  // Each label is split in two so phones can stack it ("Suspension" / "Log")
  // — four full-length pills don't fit one line at phone width. On wider
  // screens the two halves sit side by side as before (see .dd-pill-l1/-l2).
  const items = [
    { key: "log", l1: "Grooming", l2: "Log" },
    { key: "suspensions", l1: "Suspension", l2: "Log" },
    { key: "timeOuts", l1: "Time Out", l2: "Log" },
    { key: "parentMeetings", l1: "Parent", l2: "Meet" },
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
          ${items.map((it) => `<button class="dd-pill-tab dd-pill-tab-sm ${state.section === it.key ? "active" : ""}" data-action="set-section" data-section="${it.key}"><span class="dd-pill-l1">${it.l1}</span> <span class="dd-pill-l2">${it.l2}</span></button>`).join("")}
        </div>
      </div>
    </div>
    ${isOffline() ? `<div class="dd-backup-warning" role="status">You're offline — new entries and changes can't be saved until you're connected again.</div>` : ""}
    ${state.backupError ? `<div class="dd-backup-warning" role="alert">Automatic backup failed (${escapeHtml(state.backupError)}). Your entries are still saved — but please tap the download button (top right) to keep a backup file, and let the app owner know.</div>` : ""}
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
          <p>The home icon shows trend charts (Day/Week/Month/Year, Term 1–4, or a Custom range) and the Students' Watchlist — High/Medium/Low Risk, based on grooming warnings, suspensions and time outs this semester. Tap the ⓘ next to the watchlist heading to see exactly what puts a student in each tier. Tap a student's name anywhere in the app to see everything on file for them across all four logs.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Grooming Log</div>
          <p>Pick one or more issues when logging an entry (Long Hair, Uniform, etc.) — each gets its own 1st/2nd/Final Warning countdown with its own deadline, and a "same day, over the weekend" rule automatically pushes a 4-day deadline to the next school day. Adding several students at once for the same issue(s) is one tap away ("+ Add another student") — each still gets their own independent entry. Resolve an issue any time, or mark it unresolved to escalate to the next warning; deadlines can be moved if the student or parent proposes a different date. Edit Entry lets you change the student, date, and which issues are selected. An entry only shows Resolved once every issue in it is resolved.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Suspension Log</div>
          <p>Tick one or more reasons (grouped by offence category). Set the total number of days, then how many are in-school vs out-of-school — the other side calculates itself. Pick the actual dates for each, and book a location (General Office or MPR 1, with live availability) for in-school days. You can tag a Parent Meet to a suspension right after entering its details.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Time Out Log</div>
          <p>Tick one or more reasons, then pick the type — Recess, Lesson, CCA or Learning Experience. Recess and Lesson time outs are always in school; CCA and Learning Experience can be split into in-school and out-of-school days. For each in-school day, type where it's held and who's supervising (free text — Time Outs don't use the Suspension room booking). You can also tag a Parent Meet.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Parent Meet</div>
          <p>Log who attended (multiple people allowed) and why — you can tick more than one reason for the same meeting. Each reason gets its own Victim/Offender/Both/NA status, except Academic Matters and Learning Needs, which aren't disciplinary offences and skip that. "Others" lets you type in specifics, for both the reason and who attended. Tap Postponed or Cancelled right on a meeting's card (no need to open it) — tap again to set it back to scheduled. A postponed meeting gets an optional "Postponed to" date box, to fill in once the new date is known; until then it's listed on the Dashboard under Pending Parent Meeting Date, where the date can be set too: tap the calendar, pick a day, tap ✓, then confirm. After that, any change to the date is made in the Parent Meet log. Once a new date is set, the meeting counts on that new date (calendar, totals, reports) and its original date shows "Postponed to …". Cancelled meetings, and postponed ones with no new date yet, stay in the log but aren't counted in any totals.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Status dots</div>
          <p>The dot on each entry card works the same in every log: <b style="color:#3C6E47">green</b> = completed, <b style="color:#D98F2B">orange</b> = ongoing (upcoming, active or in progress), <b style="color:#A3372B">red</b> = cancelled, or postponed with no new date yet (once a new date is set, the dot follows that date).</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Same-day duplicate warning</div>
          <p>Saving a new or edited entry checks whether that student already has something logged for the same day (or, for suspensions and time outs, an overlapping day) — you'll see who logged the earlier one and can save anyway if it's intentional.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Reports</div>
          <p>The Annual Report (Settings → Annual Summary Reports) breaks discipline load down by month, plus repeat-vs-unique students, escalation rate, repeat suspension and time out intervals, and day-of-week/term patterns. The Print/Export PDF button opens your device's own print dialog, so "Save as PDF" works the same on phone, tablet, or computer.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Editing, removing, backups</div>
          <p>Every entry in all four logs can be edited — changes are tracked in the audit trail. Deleting an entry is immediate and permanent; a toast with a 5-second countdown appears right after so you can Undo, but once that closes it's gone for good. The app also keeps an automatic backup copy in the database (a warning bar appears at the top if that ever fails), and the download icon (top right) saves everything as a file — worth doing before any large cleanup. Signing in is restricted to @moe.edu.sg accounts on the Authorised Teachers List — see Settings for who's on it and, for Owners/Admins, how to add, remove, or hand over access.</p>
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
// Time Outs mirror the suspension ISS/OSS split with their own pair of
// colours: teal for in-school days (= the Time Out category colour, the
// way gold doubles as both ISS and the Suspension category), plum for
// out-of-school days.
const TO_OSS_DOT_COLOR = "#6B4A8A";
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
    counts[iso] = { discipline: 0, suspensionISS: 0, suspensionOSS: 0, timeOutISS: 0, timeOutOSS: 0, parentMeeting: 0 };
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
  state.timeOuts.forEach((t) => {
    if (t.deleted) return;
    suspensionDayEntries(t).forEach((e) => {
      if (!counts[e.date]) return;
      if (e.type === "OSS") counts[e.date].timeOutOSS++;
      else counts[e.date].timeOutISS++;
    });
  });
  state.parentMeetings.forEach((m) => { if (!isPmCounted(m)) return; const d = pmDate(m); if (counts[d]) counts[d].parentMeeting++; });
  return counts;
}
function suspensionEntryCountForMonth(monthKeyStr) {
  return state.suspensions.filter((s) => !s.deleted && monthKey(s.startDate) === monthKeyStr).length;
}
function timeOutEntryCountForMonth(monthKeyStr) {
  return state.timeOuts.filter((t) => !t.deleted && monthKey(t.startDate) === monthKeyStr).length;
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
  keys.forEach((k) => { counts[k] = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 }; });
  state.incidents.forEach((i) => { if (i.deleted) return; const k = monthKey(i.date); if (counts[k]) counts[k].discipline++; });
  state.suspensions.forEach((s) => { if (s.deleted) return; const k = monthKey(s.startDate); if (counts[k]) counts[k].suspension++; });
  state.timeOuts.forEach((t) => { if (t.deleted) return; const k = monthKey(t.startDate); if (counts[k]) counts[k].timeOut++; });
  state.parentMeetings.forEach((m) => { if (!isPmCounted(m)) return; const k = monthKey(pmDate(m)); if (counts[k]) counts[k].parentMeeting++; });
  return keys.map((k) => ({ key: k, label: monthLabelFromKey(k), ...counts[k] }));
}
const CHART_COLORS = { discipline: "#1B2A41", suspension: "#B8863B", timeOut: "#2E6E8E", parentMeeting: "#3C6E47" };
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
const CATEGORY_META = {
  discipline: { label: "Grooming", checkboxLabel: "Grooming" },
  suspension: { label: "Suspension", checkboxLabel: "Suspension" },
  timeOut: { label: "Time Out", checkboxLabel: "Time Out" },
  parentMeeting: { label: "Parent Meet", checkboxLabel: "Parent Meet" },
};
function renderCategoryToggles(incl) {
  const cats = [
    { key: "discipline", label: "Grooming" },
    { key: "suspension", label: "Suspension" },
    { key: "timeOut", label: "Time Out" },
    { key: "parentMeeting", label: "Parent Meet" },
  ];
  return `
    <div class="dd-show-box">
      <div class="dd-show-header">Show…</div>
      <div class="dd-show-buttons">
        ${cats.map((c) => `<button type="button" class="dd-show-btn ${incl[c.key] ? "active" : ""}" data-action="toggle-chart-cat" data-cat="${c.key}" style="${incl[c.key] ? `background:${CHART_COLORS[c.key]};border-color:${CHART_COLORS[c.key]}` : ""}">${c.label}</button>`).join("")}
      </div>
    </div>`;
}
// Shared across Discipline/Suspension/Parent Meet logs: a row of 6
// level counters (P1-P6), one of which can be expanded into a table of
// that level's classes vs the current year's four school terms. Only one
// level stays expanded at a time (per page — each page tracks its own).
// ---------- Annual Summary Reports ----------
function availableReportYears() {
  const years = new Set([new Date().getFullYear()]);
  state.incidents.forEach((i) => { if (!i.deleted && i.date) years.add(parseInt(i.date.slice(0, 4), 10)); });
  state.suspensions.forEach((s) => { if (!s.deleted && s.startDate) years.add(parseInt(s.startDate.slice(0, 4), 10)); });
  state.timeOuts.forEach((t) => { if (!t.deleted && t.startDate) years.add(parseInt(t.startDate.slice(0, 4), 10)); });
  state.parentMeetings.forEach((m) => { if (!m.deleted && m.date) years.add(parseInt(m.date.slice(0, 4), 10)); if (!m.deleted && isPmRescheduled(m)) years.add(parseInt(m.postponedTo.slice(0, 4), 10)); });
  return Array.from(years).sort((a, b) => b - a);
}
function computeYearlyCategoryTotals(year) {
  const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`)).length;
  const parentMeeting = state.parentMeetings.filter((m) => isPmCounted(m) && pmDate(m) && pmDate(m).startsWith(`${year}-`)).length;
  const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`)).length;
  const timeOut = state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`)).length;
  return { discipline, suspension, timeOut, parentMeeting };
}
function computeYearMonthlyTrend(year) {
  const keys = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const counts = {};
  keys.forEach((k) => { counts[k] = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 }; });
  state.incidents.forEach((i) => { if (i.deleted) return; const k = monthKey(i.date); if (counts[k]) counts[k].discipline++; });
  state.suspensions.forEach((s) => { if (s.deleted) return; const k = monthKey(s.startDate); if (counts[k]) counts[k].suspension++; });
  state.timeOuts.forEach((t) => { if (t.deleted) return; const k = monthKey(t.startDate); if (counts[k]) counts[k].timeOut++; });
  state.parentMeetings.forEach((m) => { if (!isPmCounted(m)) return; const k = monthKey(pmDate(m)); if (counts[k]) counts[k].parentMeeting++; });
  return keys.map((k) => ({ label: monthLabelFromKey(k), ...counts[k] }));
}
function computeYearTermTrend(year) {
  const moe = computeMoeCalendar(year);
  return moe.terms.map((t) => {
    const termTimeOuts = state.timeOuts.filter((x) => !x.deleted && x.startDate >= t.start && x.startDate <= t.end);
    return {
      label: t.label,
      discipline: state.incidents.filter((i) => !i.deleted && i.date >= t.start && i.date <= t.end).length,
      suspension: state.suspensions.filter((s) => !s.deleted && s.startDate >= t.start && s.startDate <= t.end).length,
      timeOut: termTimeOuts.length,
      timeOutByType: timeOutTypeBreakdown(termTimeOuts),
      parentMeeting: state.parentMeetings.filter((m) => isPmCounted(m) && pmDate(m) >= t.start && pmDate(m) <= t.end).length,
    };
  });
}
// "Cases" for the level/class rankings = grooming + suspensions + time outs
// (parent meetings are follow-up, not a case in themselves).
function computeYearLevelRanking(year) {
  return [1, 2, 3, 4, 5, 6].map((lvl) => {
    const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`) && classLevel(i.studentClass) === lvl).length;
    const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`) && classLevel(s.studentClass) === lvl).length;
    const timeOut = state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`) && classLevel(t.studentClass) === lvl).length;
    return { label: `P${lvl}`, discipline, suspension, timeOut, total: discipline + suspension + timeOut };
  }).sort((a, b) => b.total - a.total);
}
function computeYearClassRanking(year) {
  return CLASS_OPTIONS.map((cls) => {
    const discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`) && i.studentClass === cls).length;
    const suspension = state.suspensions.filter((s) => !s.deleted && s.startDate && s.startDate.startsWith(`${year}-`) && s.studentClass === cls).length;
    const timeOut = state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`) && t.studentClass === cls).length;
    return { label: cls, discipline, suspension, timeOut, total: discipline + suspension + timeOut };
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
    it.issues.forEach((issue) => {
      const label = issue.type === "Wearing Make Up/Improper Facial Patches" ? "Make Up/Improper Facial Patches" : issue.type;
      tally[label] = (tally[label] || 0) + 1;
    });
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
  const hasLastYear = lastYear.discipline + lastYear.suspension + lastYear.timeOut + lastYear.parentMeeting > 0;
  const topIssue = computeTopGroomingIssueType(year);
  const levelRanking = computeYearLevelRanking(year);
  const classRanking = computeYearClassRanking(year);

  const withinYear = terms.every((t) => t.discipline + t.suspension + t.timeOut + t.parentMeeting === 0)
    ? `No grooming, suspension, time out, or parent meeting entries were logged for ${year} yet, so a within-year trend can't be drawn.`
    : `Across the four terms, grooming issues ${describeTrend(terms[0].discipline, terms[3].discipline)} (Term 1: ${terms[0].discipline}, Term 4: ${terms[3].discipline}), suspensions ${describeTrend(terms[0].suspension, terms[3].suspension)} (Term 1: ${terms[0].suspension}, Term 4: ${terms[3].suspension}), time outs ${describeTrend(terms[0].timeOut, terms[3].timeOut)} (Term 1: ${terms[0].timeOut}, Term 4: ${terms[3].timeOut}), and parent meetings ${describeTrend(terms[0].parentMeeting, terms[3].parentMeeting)} (Term 1: ${terms[0].parentMeeting}, Term 4: ${terms[3].parentMeeting}).` +
      (topIssue ? ` The most common grooming issue this year was ${topIssue.type}, logged ${topIssue.count} time${topIssue.count === 1 ? "" : "s"}.` : "");

  const acrossYears = !hasLastYear
    ? `There isn't a prior year on record yet to compare ${year} against.`
    : `Compared to ${year - 1}, grooming issues are ${pctChangeLabel(lastYear.discipline, thisYear.discipline)}, suspensions are ${pctChangeLabel(lastYear.suspension, thisYear.suspension)}, time outs are ${pctChangeLabel(lastYear.timeOut, thisYear.timeOut)}, and parent meetings are ${pctChangeLabel(lastYear.parentMeeting, thisYear.parentMeeting)}.`;

  const improvements = [];
  const concerns = [];
  if (terms.length === 4) {
    if (terms[3].discipline < terms[0].discipline) improvements.push("grooming issues eased off by Term 4 compared to Term 1");
    else if (terms[3].discipline > terms[0].discipline) concerns.push("grooming issues were higher in Term 4 than Term 1 — worth watching whether this continues into next year");
    if (terms[3].suspension < terms[0].suspension) improvements.push("suspensions were less frequent by Term 4");
    else if (terms[3].suspension > terms[0].suspension) concerns.push("suspensions picked up later in the year rather than easing off");
    if (terms[3].timeOut < terms[0].timeOut) improvements.push("time outs were less frequent by Term 4");
    else if (terms[3].timeOut > terms[0].timeOut) concerns.push("time outs picked up later in the year rather than easing off");
  }
  if (hasLastYear) {
    const casesThis = thisYear.discipline + thisYear.suspension + thisYear.timeOut;
    const casesLast = lastYear.discipline + lastYear.suspension + lastYear.timeOut;
    if (casesThis < casesLast) improvements.push(`overall discipline cases (grooming + suspensions + time outs) are down from ${year - 1}`);
    else if (casesThis > casesLast) concerns.push(`overall discipline cases (grooming + suspensions + time outs) are up from ${year - 1}`);
  }
  // Only when there's actually something to rank — otherwise every level is
  // tied at 0 and this used to single out P1 as "most cases (0 combined)".
  if (levelRanking.length && levelRanking[0].total > 0) concerns.push(`${levelRanking[0].label} recorded the most cases of any level (${levelRanking[0].total} combined) and may benefit from closer attention`);
  if (classRanking.length) concerns.push(`${classRanking[0].label} was the single most-flagged class this year (${classRanking[0].total} combined cases)`);

  const improvementsPara = improvements.length ? `Improvements: ${improvements.join("; ")}.` : "No clear year-over-year or in-year improvement stood out from the numbers alone.";
  const concernsPara = concerns.length ? `Areas for improvement: ${concerns.join("; ")}.` : "No particular class or level stood out as needing extra attention this year.";

  return { withinYear, acrossYears, improvementsPara, concernsPara };
}

// Per-student tally for any start-dated log (suspensions or time outs).
function computeYearRoster(records, year) {
  const rows = {};
  records.forEach((s) => {
    if (s.deleted || !s.startDate || !s.startDate.startsWith(`${year}-`)) return;
    const key = studentKey(s.studentName, s.studentClass);
    rows[key] = rows[key] || { name: s.studentName, cls: s.studentClass, count: 0 };
    rows[key].count++;
  });
  return Object.values(rows).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function computeYearSuspensionRoster(year) { return computeYearRoster(state.suspensions, year); }
function computeYearTimeOutRoster(year) { return computeYearRoster(state.timeOuts, year); }
// How much of this year's load is a few repeat students versus many
// different students hitting the log once — a school-culture problem
// and a small-group-needs-support problem look identical in a raw
// total, but very different once split this way.
function computeRepeatVsUnique(year) {
  const suspRoster = computeYearSuspensionRoster(year);
  const toRoster = computeYearTimeOutRoster(year);
  const groomingCounts = {};
  state.incidents.forEach((it) => {
    if (it.deleted || !it.date || !it.date.startsWith(`${year}-`) || !Array.isArray(it.issues)) return;
    const key = studentKey(it.studentName, it.studentClass);
    groomingCounts[key] = (groomingCounts[key] || 0) + it.issues.length;
  });
  const groomingStudents = Object.values(groomingCounts);
  return {
    suspension: {
      totalCount: suspRoster.reduce((s, r) => s + r.count, 0),
      uniqueStudents: suspRoster.length,
      repeatStudents: suspRoster.filter((r) => r.count > 1).length,
    },
    timeOut: {
      totalCount: toRoster.reduce((s, r) => s + r.count, 0),
      uniqueStudents: toRoster.length,
      repeatStudents: toRoster.filter((r) => r.count > 1).length,
    },
    grooming: {
      totalCount: groomingStudents.reduce((s, c) => s + c, 0),
      uniqueStudents: groomingStudents.length,
      repeatStudents: groomingStudents.filter((c) => c > 1).length,
    },
  };
}
// How far grooming issues actually get before they stop moving — a
// direct read on whether 1st Warning alone is doing its job. Uses each
// issue's current stage (its highest reached so far), regardless of
// whether it's since resolved, since that's the honest answer to "did
// this need to escalate."
function computeEscalationRate(year) {
  const counts = { 1: 0, 2: 0, 3: 0 };
  let total = 0;
  state.incidents.forEach((it) => {
    if (it.deleted || !it.date || !it.date.startsWith(`${year}-`) || !Array.isArray(it.issues)) return;
    it.issues.forEach((issue) => { counts[issue.stage] = (counts[issue.stage] || 0) + 1; total++; });
  });
  if (total === 0) return null;
  return {
    total,
    stayedAt1st: counts[1], pct1st: Math.round((counts[1] / total) * 100),
    reached2nd: counts[2], pct2nd: Math.round((counts[2] / total) * 100),
    reachedFinal: counts[3], pctFinal: Math.round((counts[3] / total) * 100),
  };
}
// For students suspended more than once, how many days sit between
// consecutive suspensions — a shrinking gap is a real warning sign that
// whatever's being done between suspensions isn't holding. Uses each
// student's full suspension history (not just this report year), since
// a Dec-to-Jan gap shouldn't be invisible just because it crosses a
// year boundary, but only surfaces students with a suspension that
// actually falls in this report year.
function computeRepeatSuspensionIntervals(year) { return computeRepeatIntervals(state.suspensions, year); }
function computeRepeatTimeOutIntervals(year) { return computeRepeatIntervals(state.timeOuts, year); }
function computeRepeatIntervals(records, year) {
  const byStudent = {};
  records.forEach((s) => {
    if (s.deleted || !s.startDate) return;
    // Deliberately name-only (not name+class) — this tracks a student
    // across their full history, and their class will legitimately
    // differ between suspensions a year or more apart.
    const key = normalizeName(s.studentName);
    (byStudent[key] = byStudent[key] || []).push(s);
  });
  const results = [];
  Object.values(byStudent).forEach((list) => {
    if (list.length < 2) return;
    const inThisYear = list.some((s) => s.startDate.startsWith(`${year}-`));
    if (!inThisYear) return;
    const sorted = list.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1].startDate, sorted[i].startDate));
    results.push({
      name: sorted[sorted.length - 1].studentName, studentClass: sorted[sorted.length - 1].studentClass,
      count: sorted.length, shortestGap: Math.min(...gaps), averageGap: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length),
    });
  });
  return results.sort((a, b) => a.shortestGap - b.shortestGap);
}
// When during the week discipline incidents cluster — combines grooming
// entries and suspension start dates, since both are "an incident
// happened on this date." Weekends are included for completeness but
// should normally sit at zero, since scheduling already avoids them.
function computeDayOfWeekPattern(year) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  state.incidents.forEach((it) => {
    if (!it.deleted && Array.isArray(it.issues) && it.date && it.date.startsWith(`${year}-`)) counts[weekdayOf(it.date)]++;
  });
  [...state.suspensions, ...state.timeOuts].forEach((s) => {
    if (!s.deleted && s.startDate && s.startDate.startsWith(`${year}-`)) counts[weekdayOf(s.startDate)]++;
  });
  return dayNames.map((day, i) => ({ day, count: counts[i] }));
}
// Where in each term incidents cluster — every term is split into
// thirds (Early / Mid / Late) by calendar position, then combined
// across all 4 terms, to spot whether issues bunch up as a term wears
// on (e.g. near exams) rather than being evenly spread.
function computeTermPositionPattern(year) {
  const moe = computeMoeCalendar(year);
  const buckets = { Early: 0, Mid: 0, Late: 0 };
  const classify = (iso) => {
    for (const term of moe.terms) {
      if (iso >= term.start && iso <= term.end) {
        const termLen = daysBetween(term.start, term.end) || 1;
        const pos = daysBetween(term.start, iso) / termLen;
        if (pos < 1 / 3) buckets.Early++;
        else if (pos < 2 / 3) buckets.Mid++;
        else buckets.Late++;
        return;
      }
    }
  };
  state.incidents.forEach((it) => {
    if (!it.deleted && Array.isArray(it.issues) && it.date && it.date.startsWith(`${year}-`)) classify(it.date);
  });
  [...state.suspensions, ...state.timeOuts].forEach((s) => {
    if (!s.deleted && s.startDate && s.startDate.startsWith(`${year}-`)) classify(s.startDate);
  });
  return buckets;
}
// Stacked area chart of discipline load over time:
// bottom, suspensions stack on top, so the filled height is total
// incidents and the upper band shows how much of that was serious.
// Parent meetings are deliberately excluded — they're a response to
// issues rather than an issue themselves, so mixing them in would
// overstate the incident count.
// Bands, bottom to top: grooming, suspensions, time outs.
function renderStackedAreaChart(rows) {
  if (!rows.length) return `<div class="dd-dash-empty">No data for this period.</div>`;
  const totals = rows.map((r) => r.discipline + r.suspension + (r.timeOut || 0));
  const groomPlusSusp = rows.map((r) => r.discipline + r.suspension);
  const axisMax = niceAxisMax(Math.max(1, ...totals));
  const W = 320, H = 158, padL = 26, padB = 20, padT = 16;
  const plotW = W - padL, plotH = H - padB - padT;
  const x = (i) => rows.length === 1 ? padL + plotW / 2 : padL + (i / (rows.length - 1)) * plotW;
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const lineFor = (vals) => vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const areaFor = (upper, lower) =>
    `${upper.map((v, i) => `${x(i)},${y(v)}`).join(" ")} ` +
    `${lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join(" ")}`;
  const zeros = rows.map(() => 0);
  const grooming = rows.map((r) => r.discipline);
  const ticks = [0, axisMax * 0.5, axisMax].map((n) => Math.round(n));
  // Only label every Nth point when there are many, so they don't collide.
  const labelEvery = rows.length > 6 ? Math.ceil(rows.length / 6) : 1;
  return `
    <div class="dd-area-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="dd-area-chart" preserveAspectRatio="xMidYMid meet">
        ${ticks.map((t) => `
          <line x1="${padL}" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="#E4E1D4" stroke-width="1"></line>
          <text x="${padL - 5}" y="${y(t) + 3}" text-anchor="end" font-size="8" font-family="'IBM Plex Mono', monospace" fill="#8A8571">${t}</text>`).join("")}
        <polygon points="${areaFor(grooming, zeros)}" fill="${CHART_COLORS.discipline}" fill-opacity="0.75"></polygon>
        <polygon points="${areaFor(groomPlusSusp, grooming)}" fill="${OSS_DOT_COLOR}" fill-opacity="0.85"></polygon>
        <polygon points="${areaFor(totals, groomPlusSusp)}" fill="${CHART_COLORS.timeOut}" fill-opacity="0.85"></polygon>
        <polyline points="${lineFor(totals)}" fill="none" stroke="${CHART_COLORS.timeOut}" stroke-width="1.5"></polyline>
        <polyline points="${lineFor(groomPlusSusp)}" fill="none" stroke="${OSS_DOT_COLOR}" stroke-width="1.5"></polyline>
        <polyline points="${lineFor(grooming)}" fill="none" stroke="${CHART_COLORS.discipline}" stroke-width="1.5"></polyline>
        ${totals.map((t, i) => `<circle cx="${x(i)}" cy="${y(t)}" r="2.2" fill="#FBFAF6" stroke="${CHART_COLORS.timeOut}" stroke-width="1.3"></circle>`).join("")}
        ${totals.map((t, i) => t > 0
          ? `<text x="${x(i)}" y="${y(t) - 6}" text-anchor="middle" font-size="9" font-weight="700" font-family="'IBM Plex Mono', monospace" fill="#1B2A41">${t}</text>`
          : "").join("")}
        ${rows.map((r, i) => i % labelEvery === 0
          ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="8" font-family="'IBM Plex Mono', monospace" fill="#8A8571">${escapeHtml(String(r.label).slice(0, 3))}</text>`
          : "").join("")}
      </svg>
      <div class="dd-cal-legend dd-daytype-legend" style="margin-top:8px;padding-top:8px">
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${CHART_COLORS.discipline}"></span>Grooming</div>
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${OSS_DOT_COLOR}"></span>Suspension</div>
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${CHART_COLORS.timeOut}"></span>Time Out</div>
      </div>
    </div>`;
}
// Exact per-month figures to accompany the trend chart. Parent meetings
// appear here as their own column — they're excluded from the chart
// (where stacking them would overstate the incident count) but in a
// table nothing is being summed, so showing follow-up volume alongside
// the load is useful rather than misleading.
function renderMonthlyBreakdownTable(rows) {
  const withData = rows.filter((r) => r.discipline + r.suspension + (r.timeOut || 0) + r.parentMeeting > 0);
  if (!withData.length) return `<div class="dd-dash-empty">Nothing logged this year yet.</div>`;
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return `
    <div class="dd-level-breakdown" style="margin-top:10px">
      <div class="dd-level-row dd-level-row-header">
        <div class="dd-level-cell-class" style="width:auto;flex:0.8 1 0">Month</div>
        <div class="dd-level-cell-term">Grooming</div>
        <div class="dd-level-cell-term">Suspension</div>
        <div class="dd-level-cell-term">Time Out</div>
        <div class="dd-level-cell-term">Meetings</div>
      </div>
      ${withData.map((r) => `
      <div class="dd-level-row">
        <div class="dd-level-cell-class" style="width:auto;flex:0.8 1 0">${escapeHtml(r.label)}</div>
        <div class="dd-level-cell-term">${r.discipline}</div>
        <div class="dd-level-cell-term">${r.suspension}</div>
        <div class="dd-level-cell-term">${r.timeOut || 0}</div>
        <div class="dd-level-cell-term">${r.parentMeeting}</div>
      </div>`).join("")}
      <div class="dd-level-row dd-level-row-total">
        <div class="dd-level-cell-class" style="width:auto;flex:0.8 1 0">Total</div>
        <div class="dd-level-cell-term">${sum("discipline")}</div>
        <div class="dd-level-cell-term">${sum("suspension")}</div>
        <div class="dd-level-cell-term">${sum("timeOut")}</div>
        <div class="dd-level-cell-term">${sum("parentMeeting")}</div>
      </div>
    </div>`;
}
function renderReportBarRows(rows) {
  const cats = [
    { key: "discipline", label: "Grooming" },
    { key: "suspension", label: "Suspension" },
    { key: "timeOut", label: "Time Out" },
    { key: "parentMeeting", label: "Parent Meet" },
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
          <div class="dd-rank-detail">${r.discipline} discipline · ${r.suspension} suspension · ${r.timeOut || 0} time out</div>
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
      ${renderTallyGrid(["discipline", "suspension", "timeOut", "parentMeeting"], totals, timeOutTypeBreakdown(state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`))))}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By term</div>
      <div class="dd-level-breakdown dd-level-breakdown-byterm">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class">Term</div>
          <div class="dd-level-cell-term dd-level-cell-term-groom" style="color:${CHART_COLORS.discipline}">Groom</div>
          <div class="dd-level-cell-term dd-level-cell-term-susp" style="color:${CHART_COLORS.suspension}">Susp</div>
          <div class="dd-level-cell-term dd-level-cell-term-timeout dd-level-cell-term-timeout-first" style="flex:4;color:${CHART_COLORS.timeOut}">Time Out</div>
          <div class="dd-level-cell-term dd-level-cell-term-meet" style="color:${CHART_COLORS.parentMeeting}">Meet</div>
        </div>
        <div class="dd-level-row dd-level-row-header dd-level-row-subheader">
          <div class="dd-level-cell-class"></div>
          <div class="dd-level-cell-term dd-level-cell-term-groom"></div><div class="dd-level-cell-term dd-level-cell-term-susp"></div>
          ${TO_TYPES.map((t, i) => `<div class="dd-level-cell-term dd-level-cell-term-sub dd-level-cell-term-timeout${i === 0 ? " dd-level-cell-term-timeout-first" : ""}" style="color:${CHART_COLORS.timeOut}">${t.abbrev}</div>`).join("")}
          <div class="dd-level-cell-term dd-level-cell-term-meet"></div>
        </div>
        ${computeYearTermTrend(year).map((t) => `
          <div class="dd-level-row">
            <div class="dd-level-cell-class">${t.label.replace("Term ", "T")}</div>
            <div class="dd-level-cell-term dd-level-cell-term-groom">${t.discipline}</div><div class="dd-level-cell-term dd-level-cell-term-susp">${t.suspension}</div>
            ${TO_TYPES.map((ty, i) => `<div class="dd-level-cell-term dd-level-cell-term-sub dd-level-cell-term-timeout${i === 0 ? " dd-level-cell-term-timeout-first" : ""}">${t.timeOutByType[ty.key] || 0}</div>`).join("")}
            <div class="dd-level-cell-term dd-level-cell-term-meet">${t.parentMeeting}</div>
          </div>`).join("")}
      </div>
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Discipline load by month</div>
      ${(() => {
        const monthly = computeYearMonthlyTrend(year);
        return renderStackedAreaChart(monthly) + renderMonthlyBreakdownTable(monthly);
      })()}
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By term (chart)</div>
      ${renderReportBarRows(computeYearTermTrend(year))}
      ${(() => {
        const n = computeYearNarrative(year);
        return `
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Trend analysis</div>
      <div class="dd-panel" style="background:#F7F5EE;border:1px solid #E4E1D4;padding:12px;margin-bottom:4px">
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 10px">${escapeHtml(n.withinYear)}</p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 10px">${escapeHtml(n.acrossYears)}</p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 8px"><b>${escapeHtml(n.improvementsPara)}</b></p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0">${escapeHtml(n.concernsPara)}</p>
      </div>`;
      })()}
      ${(() => {
        const ru = computeRepeatVsUnique(year);
        const esc = computeEscalationRate(year);
        const intervals = computeRepeatSuspensionIntervals(year);
        const toIntervals = computeRepeatTimeOutIntervals(year);
        const intervalsTable = (list) => `
      <div class="dd-level-breakdown">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class" style="width:auto;flex:1.4 1 0">Student</div>
          <div class="dd-level-cell-term">Times</div>
          <div class="dd-level-cell-term">Shortest gap</div>
          <div class="dd-level-cell-term">Average gap</div>
        </div>
        ${list.map((r) => `
        <div class="dd-level-row">
          <div class="dd-level-cell-class" style="width:auto;flex:1.4 1 0">${escapeHtml(r.name)} <span class="dd-mono-muted" style="font-size:10px">${escapeHtml(r.studentClass || "")}</span></div>
          <div class="dd-level-cell-term">${r.count}</div>
          <div class="dd-level-cell-term">${r.shortestGap}d</div>
          <div class="dd-level-cell-term">${r.averageGap}d</div>
        </div>`).join("")}
      </div>`;
        const dow = computeDayOfWeekPattern(year);
        const termPos = computeTermPositionPattern(year);
        const maxDow = Math.max(1, ...dow.map((d) => d.count));
        const maxTermPos = Math.max(1, termPos.Early, termPos.Mid, termPos.Late);
        const barRow = (label, count, max, color) => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div class="dd-mono-muted" style="font-size:11px;width:34px;flex-shrink:0">${label}</div>
            <div style="flex:1;background:#F2EFE6;border-radius:2px;overflow:hidden;height:14px">
              <div style="width:${Math.max(count > 0 ? 4 : 0, (count / max) * 100)}%;height:100%;background:${color}"></div>
            </div>
            <div class="dd-mono-muted" style="font-size:11px;width:18px;text-align:right;flex-shrink:0">${count}</div>
          </div>`;
        return `
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Repeat vs. unique students</div>
      <div class="dd-panel" style="background:#F7F5EE;border:1px solid #E4E1D4;padding:12px;margin-bottom:4px">
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 6px">
          <b>Suspensions:</b> ${ru.suspension.totalCount} suspension${ru.suspension.totalCount === 1 ? "" : "s"} across ${ru.suspension.uniqueStudents} student${ru.suspension.uniqueStudents === 1 ? "" : "s"}${ru.suspension.repeatStudents > 0 ? ` — ${ru.suspension.repeatStudents} of them suspended more than once` : ""}.
        </p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0 0 6px">
          <b>Time Outs:</b> ${ru.timeOut.totalCount} time out${ru.timeOut.totalCount === 1 ? "" : "s"} across ${ru.timeOut.uniqueStudents} student${ru.timeOut.uniqueStudents === 1 ? "" : "s"}${ru.timeOut.repeatStudents > 0 ? ` — ${ru.timeOut.repeatStudents} of them given more than one` : ""}.
        </p>
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0">
          <b>Grooming:</b> ${ru.grooming.totalCount} issue${ru.grooming.totalCount === 1 ? "" : "s"} across ${ru.grooming.uniqueStudents} student${ru.grooming.uniqueStudents === 1 ? "" : "s"}${ru.grooming.repeatStudents > 0 ? ` — ${ru.grooming.repeatStudents} flagged more than once` : ""}.
        </p>
      </div>

      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Grooming escalation rate</div>
      ${!esc ? `<div class="dd-dash-empty">No grooming issues logged this year.</div>` : `
      <div class="dd-panel" style="background:#F7F5EE;border:1px solid #E4E1D4;padding:12px;margin-bottom:4px">
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0">
          Of ${esc.total} issue${esc.total === 1 ? "" : "s"} logged this year: <b>${esc.pct1st}%</b> never went past 1st Warning, <b>${esc.pct2nd}%</b> reached 2nd Warning, and <b>${esc.pctFinal}%</b> reached Final Warning.
        </p>
      </div>`}

      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Repeat suspension intervals</div>
      ${intervals.length === 0 ? `<div class="dd-dash-empty">No student was suspended more than once.</div>` : intervalsTable(intervals)}

      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">Repeat time out intervals</div>
      ${toIntervals.length === 0 ? `<div class="dd-dash-empty">No student was given more than one time out.</div>` : intervalsTable(toIntervals)}

      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By day of week</div>
      <div class="dd-panel" style="padding:12px;margin-bottom:4px">
        ${dow.filter((d) => d.day !== "Sun" && d.day !== "Sat").map((d) => barRow(d.day, d.count, maxDow, CHART_COLORS.discipline)).join("")}
        ${(dow[0].count + dow[6].count) > 0 ? barRow("Wknd", dow[0].count + dow[6].count, maxDow, "#8A8571") : ""}
      </div>

      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">By position within term</div>
      <div class="dd-panel" style="padding:12px;margin-bottom:4px">
        ${barRow("Early", termPos.Early, maxTermPos, CHART_COLORS.discipline)}
        ${barRow("Mid", termPos.Mid, maxTermPos, CHART_COLORS.discipline)}
        ${barRow("Late", termPos.Late, maxTermPos, CHART_COLORS.discipline)}
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
      <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">All time outs this year</div>
      ${(() => {
        const roster = computeYearTimeOutRoster(year);
        if (!roster.length) return `<div class="dd-dash-empty">No time outs this year.</div>`;
        return `<div style="display:flex;flex-direction:column;gap:6px">
          ${roster.map((r) => `
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #E4E1D4;padding-bottom:6px">
              <div class="dd-sans" style="font-size:14px">${escapeHtml(truncateName(r.name))}${r.cls ? ` <span class="dd-mono-muted" style="font-size:11px">Class ${escapeHtml(r.cls)}</span>` : ""}</div>
              <span class="dd-mono-muted" style="font-size:12px">${r.count} time out${r.count === 1 ? "" : "s"}</span>
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
  } else if (state.settingsView === "manageAccess") {
    const admins = (state.adminsList || []).slice().sort((a, b) => a.email.localeCompare(b.email));
    const authorized = (state.authorizedList || []).slice().sort((a, b) => a.email.localeCompare(b.email));
    const effectiveOwner = (state.currentOwnerEmail || OWNER_EMAIL).toLowerCase();
    const ownerWasTransferred = effectiveOwner !== OWNER_EMAIL;
    // The "users" collection gets a doc written the first time someone
    // actually signs in and picks a display name (see freshSignIn/rename
    // flow) — matching an authorized email against it is how we tell
    // "added to the list" apart from "has actually signed in".
    const onboardedByEmail = {};
    (state.userList || []).forEach((u) => { if (u.email) onboardedByEmail[u.email.toLowerCase()] = u; });
    const existingNotYetAuthorized = existingUsersNotYetAuthorized();

    // One combined "participants" list, chat-group style — Owner and
    // Admins come from their own Firestore collections but are shown
    // inline with everyone else rather than in separate boxes, each just
    // carrying a role pill. A Map (keyed by email) lets the Owner's/
    // Admin's higher tier take over a plain Authorised Teacher entry if
    // that same email also happens to be on the authorizedUsers list.
    const memberMap = new Map();
    authorized.forEach((u) => memberMap.set(u.id, { email: u.id, tier: null }));
    admins.forEach((a) => memberMap.set(a.id, { email: a.id, tier: "ADMIN" }));
    memberMap.set(effectiveOwner, { email: effectiveOwner, tier: "OWNER" });
    const tierRank = { OWNER: 0, ADMIN: 1 };
    const members = [...memberMap.values()].sort((a, b) => {
      const r = (tierRank[a.tier] ?? 2) - (tierRank[b.tier] ?? 2);
      return r !== 0 ? r : a.email.localeCompare(b.email);
    });

    // Only Owners/Admins ever get a "⋮" — regular viewers just see the
    // plain list. Which of the three actions that "⋮" offers depends on
    // who's looking and what tier the row is: any admin can remove a
    // plain Authorised Teacher, but only the Owner can act on an Admin
    // row, promote/demote admins, or hand over ownership. The Owner's own
    // row never gets a "⋮" — none of these actions apply to yourself.
    const memberRow = (m) => {
      const onboarded = onboardedByEmail[m.email];
      const name = onboarded?.name || "";
      const pill = m.tier ? accessPill(m.tier) : "";
      const canManage = m.tier === "OWNER" ? false : m.tier === "ADMIN" ? state.isOwner : state.isAdmin;
      const moreBtn = canManage
        ? `<button type="button" class="dd-more-btn" data-action="open-member-actions" data-id="${escapeHtml(m.email)}" data-tier="${m.tier || ""}" data-name="${escapeHtml(name)}" title="More">⋮</button>`
        : "";
      const dot = `<span class="dd-onboard-dot ${onboarded ? "dd-onboard-dot-on" : "dd-onboard-dot-off"}" title="${onboarded ? "Onboarded" : "Not onboarded yet"}"></span>`;
      return `
      <div class="dd-contact-row">
        ${dot}
        <div class="dd-contact-body">
          <div class="dd-contact-name">${escapeHtml(name || m.email)}${pill}</div>
          <div class="dd-contact-sub">${name ? escapeHtml(m.email) : ""}</div>
        </div>
        ${moreBtn}
      </div>`;
    };
    body = `
      ${backBtn("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Authorised Teachers List</div>

      <div class="dd-contact-list">${members.map(memberRow).join("")}</div>

      ${state.isAdmin && existingNotYetAuthorized.length > 0 ? `
      <div class="dd-mono-muted" style="font-size:12px;margin-top:16px">${existingNotYetAuthorized.length} previously signed-in teacher${existingNotYetAuthorized.length === 1 ? "" : "s"} not yet on this list:</div>
      <div class="dd-contact-list" style="margin-top:2px">
        ${existingNotYetAuthorized.map((email) => {
          const u = onboardedByEmail[email];
          return `<div class="dd-contact-row dd-contact-row-pending"><span class="dd-onboard-dot dd-onboard-dot-on" title="Onboarded"></span><div class="dd-contact-body"><div class="dd-contact-name">${escapeHtml(u?.name || email)}</div>${u?.name ? `<div class="dd-contact-sub">${escapeHtml(email)}</div>` : ""}</div></div>`;
        }).join("")}
      </div>
      <button class="dd-add-btn" type="button" id="btn-add-existing-users" style="margin-top:8px;background:#3C6E47;border-radius:999px">Add Existing Users</button>
      ` : ""}

      ${state.isAdmin ? `
      <div class="dd-compose-bar" style="margin-top:18px">
        <span class="dd-compose-avatar" style="background:#3C6E47">+</span>
        <input class="dd-compose-input" id="new-authorized-email" value="@${ALLOWED_EMAIL_DOMAIN}" autocomplete="off" />
        <button class="dd-compose-send" type="button" id="btn-add-authorized" style="background:#3C6E47" title="Add">➤</button>
      </div>` : ""}
      ${ownerWasTransferred ? `<div class="dd-mono-muted" style="font-size:11px;margin-top:10px">${escapeHtml(OWNER_EMAIL)} remains a permanent fallback and can always regain access if needed — it can only be changed by editing the app's code.</div>` : ""}
      ${state.accessFormError ? `<div class="dd-error" style="margin-top:14px;padding:10px 12px;border:1px solid #A3372B;border-radius:6px;background:#A3372B11" id="access-form-error">${escapeHtml(state.accessFormError)}</div>` : ""}`;
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
        ${menuRow("Authorised Teachers List", "settings-open-access")}
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
function renderLevelBreakdown(pageKey, items, dateField, isActive) {
  const year = new Date().getFullYear();
  const moe = computeMoeCalendar(year);
  const today = todayISO();
  const active = items.filter(isActive || ((it) => !it.deleted));
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
// `timeOutBreakdown`, when given (the Annual Report passes it; the
// dashboard's tally calls don't), nests the 4 Time Out types as one row of
// 4 small blocks inside the Time Out tile itself, right under its number —
// not a separate section below the whole grid. Every block stays the
// single Time Out teal rather than getting its own color, so it reads as
// "Time Out, opened up" rather than a second row of categories. Since that
// extra row makes the Time Out tile taller than the other three, the other
// three categories' own numbers are sized up (not Time Out's) so their
// number visually fills down toward the same base the Time Out tile's
// nested row reaches, instead of leaving a gap of empty space beneath them.
function renderTallyGrid(cats, totals, timeOutBreakdown) {
  if (!cats.length) return `<div class="dd-dash-empty">Nothing selected above.</div>`;
  // The "big" number only fits its enlarged size while it's 1-2 digits —
  // a 3-digit total in the same narrow tile would run into the next
  // column, so it steps back down toward the normal size as digits grow.
  const bigSizeClass = (n) => (String(n).length >= 3 ? " dd-tally-number-big-3" : " dd-tally-number-big");
  return `
    <div class="dd-tally-grid" style="grid-template-columns:repeat(${cats.length}, 1fr)">
      ${cats.map((c) => `
        <div class="dd-tally-col">
          <div class="dd-tally-label" style="color:${CHART_COLORS[c]}">${CATEGORY_META[c].label}</div>
          <div class="dd-tally-number${c !== "timeOut" && timeOutBreakdown ? bigSizeClass(totals[c]) : ""}" style="color:${CHART_COLORS[c]}">${totals[c]}</div>
          ${c === "timeOut" && timeOutBreakdown ? `
          <div class="dd-tally-nested">
            ${TO_TYPES.map((t) => `
              <div class="dd-tally-nested-block">
                <div class="dd-tally-nested-label">${t.abbrev}</div>
                <div class="dd-tally-nested-number">${timeOutBreakdown[t.key] || 0}</div>
              </div>`).join("")}
          </div>` : ""}
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
  if (incl.timeOut) {
    state.timeOuts.forEach((t) => {
      if (t.deleted) return;
      suspensionDayEntries(t).forEach((e) => {
        if (e.date === dateISO) items.push({ type: e.type === "OSS" ? "toOss" : "toIss", name: t.studentName, cls: t.studentClass, location: e.venue });
      });
    });
  }
  if (incl.parentMeeting) {
    state.parentMeetings.forEach((m) => {
      if (m.deleted) return;
      if (m.date === dateISO) {
        const note = m.pmStatus === "Cancelled" ? "(Cancelled)" : m.pmStatus === "Postponed" ? (m.postponedTo ? `(Postponed to ${formatDate(m.postponedTo)})` : "(Postponed)") : "";
        items.push({ type: "parentMeeting", name: m.studentName, cls: m.studentClass, note });
      }
      // The rescheduled meeting itself, on its new date.
      if (isPmRescheduled(m) && m.postponedTo === dateISO && m.date !== dateISO) {
        items.push({ type: "parentMeeting", name: m.studentName, cls: m.studentClass, note: `(Postponed from ${formatDate(m.date)})`, noteKind: "moved" });
      }
    });
  }
  const typeOrder = { discipline: 0, iss: 1, oss: 2, toIss: 3, toOss: 4, parentMeeting: 5 };
  items.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (classLevel(a.cls) - classLevel(b.cls)));
  const typeColor = { discipline: CHART_COLORS.discipline, iss: CHART_COLORS.suspension, oss: OSS_DOT_COLOR, toIss: CHART_COLORS.timeOut, toOss: TO_OSS_DOT_COLOR, parentMeeting: CHART_COLORS.parentMeeting };
  return `
    <div class="dd-day-detail">
      <div class="dd-day-detail-title">${formatDate(dateISO)}</div>
      ${items.length === 0 ? `<div class="dd-mono-muted" style="font-size:12px;font-style:italic">Nothing logged this day.</div>` : items.map((it) => `
        <div class="dd-day-detail-row">
          <span class="dd-cal-dot" style="background:${typeColor[it.type]}"></span>
          <span class="dd-day-detail-name">${escapeHtml(it.name)}</span>
          <span class="dd-day-detail-class">${escapeHtml(it.cls || "")}</span>
          ${it.note ? `<span class="dd-day-detail-note${it.noteKind === "moved" ? " dd-day-detail-note-moved" : ""}">${escapeHtml(it.note)}</span>` : ""}
          ${it.location ? `<span class="dd-day-detail-location">${escapeHtml(it.location)}</span>` : ""}
        </div>`).join("")}
    </div>`;
}
// Per-day breakdown, split ISS/OSS like the month calendar — used for
// Today, and for each day-cell in the This Week view.
function computeCountsForDate(dateISO) {
  const c = { discipline: 0, suspensionISS: 0, suspensionOSS: 0, timeOutISS: 0, timeOutOSS: 0, parentMeeting: 0 };
  state.incidents.forEach((i) => { if (!i.deleted && i.date === dateISO) c.discipline++; });
  state.suspensions.forEach((s) => {
    if (s.deleted) return;
    suspensionDayEntries(s).forEach((e) => { if (e.date === dateISO) { if (e.type === "OSS") c.suspensionOSS++; else c.suspensionISS++; } });
  });
  state.timeOuts.forEach((t) => {
    if (t.deleted) return;
    suspensionDayEntries(t).forEach((e) => { if (e.date === dateISO) { if (e.type === "OSS") c.timeOutOSS++; else c.timeOutISS++; } });
  });
  state.parentMeetings.forEach((m) => { if (isPmCounted(m) && pmDate(m) === dateISO) c.parentMeeting++; });
  return c;
}
function suspensionEntryCountForRange(fromISO, toISO) {
  return state.suspensions.filter((s) => !s.deleted && s.startDate >= fromISO && s.startDate <= toISO).length;
}
function timeOutEntryCountForRange(fromISO, toISO) {
  return state.timeOuts.filter((t) => !t.deleted && t.startDate >= fromISO && t.startDate <= toISO).length;
}
function renderCalLegend(incl) {
  // Left column: the three categories that never split by in/out-of-school
  // (Time Out included — its ISS/OSS split isn't shown separately here, just
  // one triangle marker for "logged that day"). Right column: Suspension's
  // two square markers, since that's the one category whose in/out-of-school
  // split still shows separately on the calendar.
  const legendLeft = [];
  const legendRight = [];
  if (incl.discipline) legendLeft.push({ color: CHART_COLORS.discipline, label: "Grooming" });
  if (incl.parentMeeting) legendLeft.push({ color: CHART_COLORS.parentMeeting, label: "Parent Meet" });
  if (incl.timeOut) legendLeft.push({ color: CHART_COLORS.timeOut, label: "Time Out", triangle: true });
  if (incl.suspension) legendRight.push({ color: CHART_COLORS.suspension, label: "In-School Suspension", square: true });
  if (incl.suspension) legendRight.push({ color: OSS_DOT_COLOR, label: "Out-of-School Suspension", square: true });
  const shapeClass = (li) => li.square ? " dd-cal-dot-suspension" : li.triangle ? " dd-cal-dot-timeout" : "";
  const col = (items) => items.map((li) => `<div class="dd-cal-legend-item"><span class="dd-cal-dot${shapeClass(li)}" style="background:${li.color}"></span>${li.label}</div>`).join("");
  if (!legendLeft.length && !legendRight.length) return "";
  return `<div class="dd-cal-legend dd-cal-legend-2col"><div class="dd-cal-legend-col">${col(legendLeft)}</div><div class="dd-cal-legend-col">${col(legendRight)}</div></div>`;
}
function renderTodayView(incl) {
  const viewDate = state.dayViewDate || todayISO();
  const c = computeCountsForDate(viewDate);
  const totals = { discipline: c.discipline, suspension: c.suspensionISS + c.suspensionOSS, timeOut: c.timeOutISS + c.timeOutOSS, parentMeeting: c.parentMeeting };
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((x) => incl[x]);
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
  const totals = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 };
  days.forEach((d) => {
    const c = computeCountsForDate(d);
    totals.discipline += c.discipline;
    totals.parentMeeting += c.parentMeeting;
    totals.suspension += c.suspensionISS + c.suspensionOSS;
    totals.timeOut += c.timeOutISS + c.timeOutOSS;
  });
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((x) => incl[x]);
  const today = todayISO();
  const cells = days.map((d) => {
    const c = computeCountsForDate(d);
    const dots = [];
    if (incl.discipline && c.discipline > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.discipline}"></span>`);
    if (incl.suspension && c.suspensionISS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${CHART_COLORS.suspension}"></span>`);
    if (incl.suspension && c.suspensionOSS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${OSS_DOT_COLOR}"></span>`);
    if (incl.timeOut && (c.timeOutISS + c.timeOutOSS) > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-timeout" style="background:${CHART_COLORS.timeOut}"></span>`);
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
    if (incl.timeOut && c.timeOutISS > 0) segs.push(CHART_COLORS.timeOut);
    if (incl.timeOut && c.timeOutOSS > 0) segs.push(TO_OSS_DOT_COLOR);
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
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((c) => incl[c]);
  const totals = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 };
  totals.discipline = state.incidents.filter((i) => !i.deleted && i.date && i.date.startsWith(`${year}-`)).length;
  totals.parentMeeting = state.parentMeetings.filter((m) => isPmCounted(m) && pmDate(m) && pmDate(m).startsWith(`${year}-`)).length;
  totals.suspension = suspensionEntryCountForRange(`${year}-01-01`, `${year}-12-31`);
  totals.timeOut = timeOutEntryCountForRange(`${year}-01-01`, `${year}-12-31`);
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
  const totals = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 };
  Object.values(daily).forEach((c) => { totals.discipline += c.discipline; totals.parentMeeting += c.parentMeeting; });
  totals.suspension = suspensionEntryCountForMonth(monthKeyStr);
  totals.timeOut = timeOutEntryCountForMonth(monthKeyStr);
  const today = todayISO();
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((c) => incl[c]);

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="dd-cal-cell dd-cal-cell-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKeyStr}-${String(d).padStart(2, "0")}`;
    const c = daily[iso];
    const dots = [];
    if (incl.discipline && c.discipline > 0) dots.push(`<span class="dd-cal-dot" style="background:${CHART_COLORS.discipline}" title="${c.discipline} discipline"></span>`);
    if (incl.suspension && c.suspensionISS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${CHART_COLORS.suspension}" title="${c.suspensionISS} in-school suspension"></span>`);
    if (incl.suspension && c.suspensionOSS > 0) dots.push(`<span class="dd-cal-dot dd-cal-dot-suspension" style="background:${OSS_DOT_COLOR}" title="${c.suspensionOSS} out-of-school suspension"></span>`);
    if (incl.timeOut && (c.timeOutISS + c.timeOutOSS) > 0) {
      const toParts = [c.timeOutISS > 0 ? `${c.timeOutISS} in-school` : "", c.timeOutOSS > 0 ? `${c.timeOutOSS} out-of-school` : ""].filter(Boolean).join(", ");
      dots.push(`<span class="dd-cal-dot dd-cal-dot-timeout" style="background:${CHART_COLORS.timeOut}" title="${toParts} time out"></span>`);
    }
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
    timeOut: state.chartIncludeTimeOut !== false,
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
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((c) => incl[c]);
  const catObjs = cats.map((key) => ({ key, label: CATEGORY_META[key].label }));
  const rawMax = Math.max(1, ...data.flatMap((d) => catObjs.map((c) => d[c.key])));
  const axisMax = niceAxisMax(rawMax);
  const pct = (v) => Math.max(v > 0 ? 3 : 0, Math.round((v / axisMax) * 100));
  const ticks = [0, axisMax * 0.25, axisMax * 0.5, axisMax * 0.75, axisMax].map((n) => Math.round(n));
  const rangeTotals = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 };
  data.forEach((d) => { rangeTotals.discipline += d.discipline; rangeTotals.suspension += d.suspension; rangeTotals.timeOut += d.timeOut; rangeTotals.parentMeeting += d.parentMeeting; });

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

// A "semester" is 2 terms — Term1+2, or Term3+4 — whichever contains
// today (falling back to whichever half of the year today is closer to,
// if today happens to land in a between-term holiday gap).
// Plain-language watchlist criteria for the info box — must match
// riskTierFor() in renderDashboardSection.
const RISK_TIER_CRITERIA = [
  { tier: "High Risk", criteria: ["2 or more suspensions", "3 or more final warnings", "7 or more 2nd warnings", "4 or more time outs"] },
  { tier: "Medium Risk", criteria: ["1 suspension", "2 final warnings", "4–6 2nd warnings", "2–3 time outs"] },
  { tier: "Low Risk", criteria: ["1 final warning", "1–3 2nd warnings", "1 time out"] },
];
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
  // Multiple issues due the same day for the same student become one
  // card (name shown once) with each issue listed underneath, rather
  // than repeating the name in a separate card per issue.
  const groupByStudent = (rows) => {
    const groups = [];
    const byKey = {};
    rows.forEach((r) => {
      const key = `${r.name}|${r.studentClass || ""}`;
      if (!byKey[key]) { byKey[key] = { name: r.name, studentClass: r.studentClass, incidentId: r.incidentId, items: [] }; groups.push(byKey[key]); }
      byKey[key].items.push(r);
    });
    return groups;
  };
  const renderGroup = (g) => `
    <div class="dd-followup-row-item" data-action="jump-to-incident" data-id="${g.incidentId}">
      <span class="dd-sans" style="font-size:14px;font-weight:600">${escapeHtml(truncateName(g.name))}</span>
      ${g.studentClass ? `<div class="dd-mono-muted" style="font-size:11px;margin-top:1px">${escapeHtml(g.studentClass)}</div>` : ""}
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
        ${g.items.map((r) => `
        <div style="border-top:1px solid #E4E1D4;padding-top:6px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span class="dd-sans" style="font-size:12px">${escapeHtml(r.issueLabel)}</span>
            <span class="dd-issue-stage-badge ${r.deadline < today ? "dd-issue-overdue" : ""}">${WARNING_STAGE_LABEL[r.stage]}</span>
          </div>
          ${(() => {
            const daysOverdue = daysBetween(r.deadline, today);
            return daysOverdue > 0 ? `<div class="dd-mono-muted" style="font-size:11px;color:#A3372B">Overdue for ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}</div>` : "";
          })()}
        </div>`).join("")}
      </div>
    </div>`;
  const renderDaySection = (label, dateIso, rows) => `
    <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;display:flex;justify-content:space-between;align-items:baseline;margin-top:14px">
      <span class="dd-mono-muted" style="font-size:12px;font-weight:400">${formatDate(dateIso)}</span>
      <span>(${label})</span>
    </div>
    ${rows.length === 0 ? `<div class="dd-dash-empty" style="margin-top:6px">Nothing here.</div>` : `
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${groupByStudent(rows).map(renderGroup).join("")}</div>`}`;
  return `
    <div class="dd-panel" style="margin-bottom:16px">
      <div class="dd-dash-title" style="color:#1B2A41">Grooming Follow-Up List</div>
      ${renderDaySection("Today", today, buckets.today)}
      ${renderDaySection("Tomorrow", addDays(today, 1), buckets.tomorrow)}
      ${renderDaySection("2 Days Later", addDays(today, 2), buckets.dayAfter)}
    </div>`;
}
// Postponed parent meetings still waiting to happen: no new date yet, or a
// new date that hasn't passed. Undated ones come first (they need chasing),
// then by the new date. Once the new date has passed, the meeting drops off.
function pendingPostponedMeetings() {
  const today = todayISO();
  return state.parentMeetings
    .filter((m) => !m.deleted && m.pmStatus === "Postponed" && (!m.postponedTo || m.postponedTo >= today))
    .sort((a, b) => (a.postponedTo ? 1 : 0) - (b.postponedTo ? 1 : 0) || (a.postponedTo || "").localeCompare(b.postponedTo || "") || (a.date || "").localeCompare(b.date || ""));
}
function renderPendingPmDates() {
  const list = pendingPostponedMeetings();
  // Nothing waiting → no box at all, rather than an empty panel.
  if (list.length === 0) return "";
  return `
    <div class="dd-panel" style="margin-bottom:16px">
      <div class="dd-dash-title" style="color:#1B2A41">Pending Parent Meeting Date</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${list.map((m) => `
        <div class="dd-followup-row-item dd-pending-pm-row">
          <span class="dd-sans dd-card-student-link" style="font-size:14px;font-weight:600" data-action="view-student" data-name="${escapeHtml(m.studentName)}" data-class="${escapeHtml(m.studentClass || "")}">${escapeHtml(truncateName(m.studentName))}</span>
          ${m.studentClass ? `<div class="dd-mono-muted" style="font-size:11px;margin-top:1px">${escapeHtml(m.studentClass)}</div>` : ""}
          <div class="dd-pending-pm-grid">
            <div class="dd-field-label">Original meeting</div>
            <div class="dd-sans" style="font-size:14px">${formatDate(m.date)}</div>
            <div class="dd-field-label">Postponed to</div>
            <div>${renderPostponeDateField(m, { editable: false })}</div>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
}
function renderDashboardSection() {
  const activeIncidents = state.incidents.filter((i) => !i.deleted);
  const activeSusp = state.suspensions.filter((s) => !s.deleted);
  const activeTo = state.timeOuts.filter((t) => !t.deleted);
  const activePm = state.parentMeetings.filter((m) => !m.deleted);

  const semester = computeCurrentSemesterBounds();
  const watchCounts = {};
  const watchClass = {};
  const watchName = {};
  activeIncidents.forEach((i) => {
    if (i.date < semester.start || i.date > semester.end) return;
    const isLegacy = !Array.isArray(i.issues);
    const maxStage = isLegacy ? 0 : groomingEntryMaxStage(i);
    const key = studentKey(i.studentName, i.studentClass);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    if (maxStage >= 3) watchCounts[key].third++;
    else if (maxStage >= 2) watchCounts[key].second++;
    watchClass[key] = i.studentClass || watchClass[key];
    watchName[key] = i.studentName || watchName[key];
  });
  activeSusp.forEach((s) => {
    if (s.startDate < semester.start || s.startDate > semester.end) return;
    const key = studentKey(s.studentName, s.studentClass);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    watchCounts[key].suspension++;
    watchClass[key] = s.studentClass || watchClass[key];
    watchName[key] = s.studentName || watchName[key];
  });
  // Time outs count toward risk tiers too (1 = Low, 2-3 = Medium, 4+ = High),
  // as an extra "or" criterion alongside suspensions and warnings.
  activeTo.forEach((t) => {
    if (t.startDate < semester.start || t.startDate > semester.end) return;
    const key = studentKey(t.studentName, t.studentClass);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    watchCounts[key].timeOut++;
    watchClass[key] = t.studentClass || watchClass[key];
    watchName[key] = t.studentName || watchName[key];
  });
  // Risk tiers (per semester, counted by entry not by issue). Meeting ANY
  // one criterion in a tier is enough (and/or). Checked in priority order so
  // someone qualifying for a higher tier is never also shown as a lower one.
  // RISK_TIER_CRITERIA below is the matching plain-language list for the
  // info box — keep the two in step.
  const riskTierFor = (c) => {
    if (c.suspension >= 2 || c.third >= 3 || c.second >= 7 || c.timeOut >= 4) return "high";
    if (c.suspension === 1 || (c.second >= 4 && c.second <= 6) || c.third === 2 || (c.timeOut >= 2 && c.timeOut <= 3)) return "medium";
    if ((c.second >= 1 && c.second <= 3) || c.third === 1 || c.timeOut === 1) return "low";
    return null;
  };
  const watchTier = state.watchTier || "high";
  let watchlist = Object.entries(watchCounts)
    .map(([key, c]) => ({ name: watchName[key] || key, studentClass: watchClass[key] || "", ...c, tier: riskTierFor(c) }))
    .filter((t) => t.tier === watchTier);
  watchlist = watchlist.sort((a, b) => b.suspension - a.suspension || b.third - a.third || b.second - a.second);

  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${!state.classConfig?.classesByYear?.[String(new Date().getFullYear())] ? `
        <div class="dd-error" style="margin-bottom:12px" data-action="goto-classes-for-year">Classes for ${new Date().getFullYear()} haven't been reviewed yet — <button type="button" class="dd-back-link" data-action="goto-classes-for-year" style="text-decoration:underline">tap here to set them up</button>.</div>` : ""}
        <div class="dd-new-entry-row">
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-case" style="flex:1">+ Grooming</button>
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-susp-only" style="flex:1">+ Suspension</button>
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-to-only" style="flex:1">+ Time Out</button>
          <button class="dd-newbtn dd-newbtn-compact" id="btn-new-pm-only" style="flex:1">+ Parent Meet</button>
        </div>

        ${renderGroomingFollowUpList()}

        ${renderPendingPmDates()}

        ${renderMonthlyChart()}

        <div class="dd-panel" style="margin-top:16px">
          <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px;display:flex;align-items:center;gap:6px">
            Students' Watchlist
            <button type="button" class="dd-info-icon-btn" data-action="toggle-watchlist-info" title="How risk is worked out">i</button>
          </div>
          ${state.showWatchlistInfo ? `
          <div class="dd-risk-info">
            <div class="dd-risk-info-note">Counted per semester. A student only needs to meet <b>any one</b> of the criteria in a tier (and/or) — and is shown in the highest tier they qualify for.</div>
            ${RISK_TIER_CRITERIA.map((t) => `
            <div class="dd-risk-info-tier">${t.tier}</div>
            <ul class="dd-risk-info-list">${t.criteria.map((c) => `<li>${c}</li>`).join("")}</ul>`).join("")}
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
              if (t.timeOut > 0) stats.push(`${t.timeOut} time out${t.timeOut === 1 ? "" : "s"}`);
              if (t.third > 0) stats.push(`${t.third} final warning${t.third === 1 ? "" : "s"}`);
              if (t.second > 0) stats.push(`${t.second} 2nd warning${t.second === 1 ? "" : "s"}`);
              return `
              <div style="border-bottom:1px solid #E4E1D4;padding-bottom:8px">
                <div class="dd-sans dd-card-student-link" style="font-size:14px" data-action="view-student" data-name="${escapeHtml(t.name)}" data-class="${escapeHtml(t.studentClass || "")}">${escapeHtml(truncateName(t.name))}${t.studentClass ? ` <span class="dd-mono-muted" style="font-size:11px">${escapeHtml(t.studentClass)}</span>` : ""}</div>
                ${stats.map((s) => `<div class="dd-mono-muted" style="font-size:12px;margin-top:2px">${s}</div>`).join("")}
              </div>`;
            }).join("")}
          </div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
      ${state.showNewPmForm ? renderPmForm(false) : ""}
    </div>`;
}


// ---------- Discipline Log ----------
// Student identity is name-only in this app (no student ID system), so
// the same student can otherwise appear as several different "people"
// just from typos in casing or stray whitespace — this is the single
// source of truth for turning a raw name into a comparable key.
function normalizeName(name) {
  return (name || "").trim().replace(/\s+/g, " ").toLowerCase();
}
// For matching within a single time period (a semester, a report year)
// where a student's class shouldn't change — name+class together are
// far less likely to collide than name alone (two students can share a
// first name; they're very unlikely to also share a class).
function studentKey(name, studentClass) {
  return `${normalizeName(name)}|${(studentClass || "").trim().toUpperCase()}`;
}
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
    list = list.filter((it) =>
      it.studentName.toLowerCase().includes(q) ||
      (it.studentClass || "").toLowerCase().includes(q) ||
      (it.loggedBy || "").toLowerCase().includes(q) ||
      incidentSummaryLabel(it).toLowerCase().includes(q));
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
            <input class="dd-input dd-search" id="search-input" placeholder="Search by name, class, issue, or teacher…" value="${escapeHtml(state.query)}" />
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
  const cls = state.studentViewClass || "";
  const matches = (rec) => studentKey(rec.studentName, rec.studentClass) === studentKey(name, cls);
  const grooming = state.incidents.filter((i) => !i.deleted && matches(i)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const suspensions = state.suspensions.filter((s) => !s.deleted && matches(s)).sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const timeOuts = state.timeOuts.filter((t) => !t.deleted && matches(t)).sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  const meetings = state.parentMeetings.filter((m) => !m.deleted && matches(m)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latestClass = (grooming[0]?.studentClass) || (suspensions[0]?.studentClass) || (timeOuts[0]?.studentClass) || (meetings[0]?.studentClass) || cls;
  const sectionBlock = (title, count, items, renderFn) => `
    <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:20px 0 8px">${title} (${count})</div>
    ${count === 0 ? `<div class="dd-dash-empty">Nothing on file.</div>` : `<div style="display:flex;flex-direction:column;gap:12px">${items.map(renderFn).join("")}</div>`}`;
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <button type="button" class="dd-back-link" data-action="student-view-back">‹ Back</button>
        <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">${escapeHtml(name)}${latestClass ? ` <span class="dd-mono-muted" style="font-size:14px;font-weight:400">${escapeHtml(latestClass)}</span>` : ""}</div>
        <div class="dd-mono-muted" style="font-size:12px;margin-bottom:6px">Everything on file for this student, across all four logs.</div>
        ${sectionBlock("Grooming Log", grooming.length, grooming, renderIncidentDetail)}
        ${sectionBlock("Suspension Log", suspensions.length, suspensions, renderSuspensionDetail)}
        ${sectionBlock("Time Out Log", timeOuts.length, timeOuts, renderTimeOutDetail)}
        ${sectionBlock("Parent Meets", meetings.length, meetings, renderParentMeetingDetail)}
      </div>
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
      ${state.editingSuspensionId ? renderSuspForm(true) : ""}
      ${state.editingTimeOutId ? renderTimeOutForm(true) : ""}
      ${state.editingPmId ? renderPmForm(true) : ""}
    </div>`;
}

function renderIncidentDetail(it) {
  const isLegacy = !Array.isArray(it.issues);
  const issues = isLegacy ? [] : it.issues;
  const resolved = isLegacy ? it.status === "Resolved" : groomingEntryResolved(it);
  const dotColor = resolved ? STATUS_DOT.completed : STATUS_DOT.ongoing;
  const summaryLabel = isLegacy ? (it.issue || "") : issues.map((x) => groomingIssueLabel(x)).join(", ");
  const followUps = it.followUps || [];
  const history = it.history || [];
  const linkedSusp = (it.linkedSuspensionIds || []).map((id) => state.suspensions.find((x) => x.id === id)).filter(Boolean);
  const linkedTo = (it.linkedTimeOutIds || []).map((id) => state.timeOuts.find((x) => x.id === id)).filter(Boolean);
  const linkedPm = (it.linkedPmIds || []).map((id) => state.parentMeetings.find((x) => x.id === id)).filter(Boolean);
  const expanded = !!state.entryExpanded[it.id];
  const today = todayISO();
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(it.studentName)}" data-class="${escapeHtml(it.studentClass || "")}">${escapeHtml(it.studentName)}</div>
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
      ${linkedSusp.length || linkedTo.length || linkedPm.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related records</div>
        ${linkedSusp.map((x) => `<div class="dd-related-link" data-action="jump-to-suspension" data-id="${x.id}">Suspension — ${formatDateShort(x.startDate)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
        ${linkedTo.map((x) => `<div class="dd-related-link" data-action="jump-to-timeout" data-id="${x.id}">Time Out — ${formatDateShort(x.startDate)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
        ${linkedPm.map((x) => `<div class="dd-related-link" data-action="jump-to-pm" data-id="${x.id}">Parent Meet — ${formatDateShort(x.date)} — ${escapeHtml(truncateName(x.reason || "", 30))}</div>`).join("")}
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

// The classes actually available this year, if configured under Settings
// → Classes For The Year — falls back to the full roster if nothing has
// been set for this year yet (e.g. before the feature was ever used).
function classOptionsForCurrentYear() {
  const year = String(new Date().getFullYear());
  const configured = state.classConfig?.classesByYear?.[year];
  return Array.isArray(configured) && configured.length ? configured : CLASS_OPTIONS;
}
// A single shared <datalist> of every student name seen across all
// three logs, for the "Student name" fields to offer as suggestions —
// this is what actually prevents new typos/casing variants from being
// introduced in the first place, rather than just cleaning them up
// after the fact in the analysis functions.
function renderKnownStudentsDatalist() {
  const seen = new Set();
  const names = [];
  const addAll = (list) => list.forEach((r) => {
    if (r.deleted || !r.studentName) return;
    const key = normalizeName(r.studentName);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(r.studentName.trim());
  });
  addAll(state.incidents);
  addAll(state.suspensions);
  addAll(state.timeOuts);
  addAll(state.parentMeetings);
  names.sort((a, b) => a.localeCompare(b));
  return `<datalist id="known-students">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("")}</datalist>`;
}
function classOptionsHtml(selected) {
  const options = classOptionsForCurrentYear();
  // If an entry's saved class isn't in this year's active list (e.g. an
  // older record, or the list changed after it was logged), still show it
  // so editing doesn't silently blank out the field.
  const withSelected = selected && !options.includes(selected) ? [...options, selected] : options;
  return `<option value="">Select class…</option>` + withSelected.map((c) => `<option value="${escapeHtml(c)}" ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
}

function renderNewForm() {
  const d = state._newIncidentDraft;
  const related = findRelatedRecords(d.studentName);
  const hasRelated = related.suspensions.length > 0 || related.timeOuts.length > 0 || related.parentMeetings.length > 0;
  return `
    <div class="dd-modal-backdrop" id="modal-backdrop">
      <div class="dd-modal" id="new-form">
        <div class="dd-modal-head"><div class="dd-modal-title">New grooming issue</div><button type="button" class="dd-modal-close" id="modal-close">✕</button></div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" id="new-incident-student-name" required value="${escapeHtml(d.studentName)}" list="known-students" autocomplete="off" />
        ${hasRelated ? `
        <div class="dd-related-box">
          <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related records found for ${escapeHtml(d.studentName)} — tick any to link</div>
          ${related.suspensions.map((s) => `
            <label class="dd-checkbox-pill" style="display:flex;margin-bottom:4px">
              <input type="checkbox" class="dd-link-susp-cb" value="${s.id}" ${d.linkedSuspensionIds.includes(s.id) ? "checked" : ""} />
              <span>Suspension — ${formatDateShort(s.startDate)} — ${escapeHtml(truncateName(s.reason || "", 30))}</span>
            </label>`).join("")}
          ${related.timeOuts.map((t) => `
            <label class="dd-checkbox-pill" style="display:flex;margin-bottom:4px">
              <input type="checkbox" class="dd-link-to-cb" value="${t.id}" ${(d.linkedTimeOutIds || []).includes(t.id) ? "checked" : ""} />
              <span>Time Out — ${formatDateShort(t.startDate)} — ${escapeHtml(truncateName(t.reason || "", 30))}</span>
            </label>`).join("")}
          ${related.parentMeetings.map((m) => `
            <label class="dd-checkbox-pill" style="display:flex;margin-bottom:4px">
              <input type="checkbox" class="dd-link-pm-cb" value="${m.id}" ${d.linkedPmIds.includes(m.id) ? "checked" : ""} />
              <span>Parent Meet — ${formatDateShort(m.date)} — ${escapeHtml(truncateName(m.reason || "", 30))}</span>
            </label>`).join("")}
        </div>` : ""}
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(d.studentClass)}</select>
        ${(d.extraStudents || []).length > 0 ? `
        <label class="dd-label">Also logging (same issue(s), below)</label>
        ${d.extraStudents.map((s, idx) => `
          <div class="dd-extra-student-row">
            <input class="dd-input dd-extra-student-name" data-idx="${idx}" placeholder="Student name" value="${escapeHtml(s.name)}" list="known-students" autocomplete="off" />
            <select class="dd-input dd-extra-student-class" data-idx="${idx}">${classOptionsHtml(s.studentClass)}</select>
            <button type="button" class="dd-expand-toggle" data-action="remove-extra-student" data-idx="${idx}" title="Remove">✕</button>
          </div>`).join("")}` : ""}
        <button type="button" class="dd-back-link" id="btn-add-extra-student">+ Add another student (same issue(s))</button>
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
        <input class="dd-input" id="edit-incident-student-name" value="${escapeHtml(d.studentName)}" list="known-students" autocomplete="off" />
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
    list = list.filter((s) =>
      s.studentName.toLowerCase().includes(q) ||
      (s.studentClass || "").toLowerCase().includes(q) ||
      (s.loggedBy || "").toLowerCase().includes(q) ||
      (s.reason || "").toLowerCase().includes(q));
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
            <input class="dd-input dd-search" id="susp-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.suspQuery)}" />
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
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(s.studentName)}" data-class="${escapeHtml(s.studentClass || "")}">${escapeHtml(s.studentName)}</div>
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
        <div class="dd-field-label">Reason(s)</div>
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

// Suspension-only now — Time Out grew its own type selector, free-text
// location and administrator field, so it forked into
// renderTimeOutFieldsBody instead of sharing this one.
function renderSuspFieldsBody(d, idPrefix, excludeSuspensionId, noun = "suspension") {
  const totalOptions = Array.from({ length: 14 }, (_, i) => i + 1);
  const dayCountOptions = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const showDatePickers = d.totalDays && (d.issDays + d.ossDays === d.totalDays) && (d.ossDates.length === d.ossDays);
  return `
        ${renderMultiReasonPicker(d.reasons, d.reasonOthersText, "susp")}
        <label class="dd-label">Start date (used to suggest default days)</label>
        <div class="dd-issue-due-row">
          <div class="dd-date-icon-btn" title="Change the start date">
            <input class="dd-input" type="date" id="${idPrefix}-start-date" value="${d.startDate}" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </div>
          <span class="dd-sans" style="font-size:15px">${formatDate(d.startDate)}</span>
        </div>

        <label class="dd-label">Total days of ${noun}</label>
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
  // The Parent Meet "Reason(s) for meeting" checklist scrolls inside
  // its own box, nested inside the modal — a fresh element after every
  // re-render starts back at scrollTop 0, which is what made it keep
  // jumping back to the top of the list on every tap. Preserved
  // separately from the modal's own scroll position above.
  const nestedList = modal ? modal.querySelector(".dd-pm-reason-list") : null;
  const nestedScrollTop = nestedList ? nestedList.scrollTop : null;
  render();
  if (scrollTop !== null) {
    const newModal = document.querySelector(".dd-modal");
    if (newModal) newModal.scrollTop = scrollTop;
    if (nestedScrollTop !== null) {
      const newNestedList = newModal ? newModal.querySelector(".dd-pm-reason-list") : null;
      if (newNestedList) newNestedList.scrollTop = nestedScrollTop;
    }
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
      else if (idPrefix === "to") state.toFormError = "";
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
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" list="known-students" autocomplete="off" />
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
          ${renderPmReasonPicker(d, "pm")}
        </div>` : ""}` : ""}
        ${state.suspFormError ? `<div class="dd-error">${escapeHtml(state.suspFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save suspension"}</button>
      </form>
    </div>`;
}

// ---------- Time Out Log ----------
// Mirrors the Suspension Log page. suspensionWeekCategory/suspensionStatus
// only read the record's dates, so they apply to Time Outs unchanged.
function filteredTimeOuts() {
  let list = state.timeOuts.map((t) => ({ ...t, _week: suspensionWeekCategory(t) })).filter((t) => !t.deleted);
  if (state.toTab !== "All") list = list.filter((t) => t._week === state.toTab);
  if (state.timeOutExpandedLevel) {
    list = list.filter((t) => classLevel(t.studentClass) === state.timeOutExpandedLevel);
    if (state.timeOutSelectedClass) list = list.filter((t) => t.studentClass === state.timeOutSelectedClass);
  }
  if (state.toQuery.trim()) {
    const q = state.toQuery.trim().toLowerCase();
    list = list.filter((t) =>
      t.studentName.toLowerCase().includes(q) ||
      (t.studentClass || "").toLowerCase().includes(q) ||
      (t.loggedBy || "").toLowerCase().includes(q) ||
      (t.reason || "").toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
}
function timeOutCounts() {
  const c = { "This Week": 0, Upcoming: 0, Completed: 0, Deleted: 0 };
  state.timeOuts.forEach((t) => { if (t.deleted) { c.Deleted++; return; } c[suspensionWeekCategory(t)]++; });
  return c;
}
function renderTimeOutSection() {
  const list = filteredTimeOuts();
  const c = timeOutCounts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${renderLevelBreakdown("timeOut", state.timeOuts, "startDate")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.toTab === t ? "active" : ""}" data-action="set-to-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.timeOutExpandedLevel ? renderClassPillsRow("timeOut", state.timeOutExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="to-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.toQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.timeOuts.length === 0 ? "No time outs logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderTimeOutDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
      ${state.editingTimeOutId ? renderTimeOutForm(true) : ""}
    </div>`;
}
function renderTimeOutDetail(t) {
  const statusStyle = t.deleted ? { ink: "#8A8571", label: "REMOVED" } : SUSP_STATUS_STYLE[suspensionStatus(t)];
  const entries = suspensionDayEntries(t).slice().sort((a, b) => a.date.localeCompare(b.date));
  const history = t.history || [];
  const linkedIncidents = (t.linkedIncidentIds || []).map((id) => state.incidents.find((x) => x.id === id)).filter(Boolean);
  const expanded = !!state.entryExpanded[t.id];
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(t.studentName)}" data-class="${escapeHtml(t.studentClass || "")}">${escapeHtml(t.studentName)}</div>
          <div class="dd-card-meta dd-card-meta-primary">${t.startDate ? formatDate(t.startDate) : ""}${t.studentClass ? ` · ${escapeHtml(t.studentClass)}` : ""}${t.toType ? ` · ${escapeHtml(toTypeLabel(t.toType))}` : ""}</div>
          <div class="dd-card-meta">logged by ${escapeHtml(t.loggedBy)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0">
          <span class="dd-status-dot" style="background:${statusStyle.ink}" title="${escapeHtml(statusStyle.label)}"></span>
          <button class="dd-expand-toggle" data-action="toggle-entry-expanded" data-id="${t.id}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▲" : "▼"}</button>
        </div>
      </div>
      ${expanded ? `
      ${linkedIncidents.length ? `
      <div class="dd-related-box" style="margin-top:12px">
        <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:6px">Related grooming entries</div>
        ${linkedIncidents.map((x) => `<div class="dd-related-link" data-action="jump-to-incident" data-id="${x.id}">${formatDateShort(x.date)} — ${escapeHtml(truncateName(incidentSummaryLabel(x), 30))}</div>`).join("")}
      </div>` : ""}
      <div style="margin:12px 0">
        <div class="dd-field-label">Type</div>
        <div class="dd-field-value">${escapeHtml(toTypeLabel(t.toType))}</div>
      </div>
      <div style="margin:12px 0">
        <div class="dd-field-label">Reason(s)</div>
        <div class="dd-field-value">${escapeHtml(t.reason || "")}</div>
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Day-by-day (${entries.length} day${entries.length === 1 ? "" : "s"})</div>
      <div class="dd-followups" style="margin-bottom:16px">
        ${entries.map((e) => `<div class="dd-followup"><div class="dd-followup-note">${SUSP_TYPE_STYLE[e.type].label}${e.type === "ISS" && e.venue ? ` — ${escapeHtml(e.venue)}${e.administrator ? ` (${escapeHtml(e.administrator)})` : ""}` : ""}</div><div class="dd-followup-meta">${formatDate(e.date)}</div></div>`).join("")}
      </div>
      <button class="dd-history-toggle" data-action="toggle-to-history" data-id="${t.id}">${state.historyOpen[t.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[t.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="font-style:italic;color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="dd-add-btn" data-action="edit-timeout" data-id="${t.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-timeout" data-id="${t.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}
// Time Out's own field body — forked from the shared Suspension one once
// the two diverged: a Time Out's location is wherever the student is
// actually sent that period (free text, no fixed room list or capacity),
// and it needs to record who is administering it, which a suspension never
// asked for. Recess/Lesson time outs are always in-school, so their
// in-school/out-of-school split is hidden rather than left editable.
function renderTimeOutFieldsBody(d, idPrefix) {
  const totalOptions = Array.from({ length: 14 }, (_, i) => i + 1);
  const dayCountOptions = (max) => Array.from({ length: max + 1 }, (_, i) => i);
  const typeInfo = toTypeInfo(d.toType);
  const showDatePickers = d.totalDays && (d.issDays + d.ossDays === d.totalDays) && (d.ossDates.length === d.ossDays);
  return `
        ${renderMultiReasonPicker(d.reasons, d.reasonOthersText, "to")}
        <label class="dd-label">Type of time out</label>
        <select class="dd-input" id="${idPrefix}-to-type">
          ${TO_TYPES.map((t) => `<option value="${t.key}" ${d.toType === t.key ? "selected" : ""}>${t.label}</option>`).join("")}
        </select>

        <label class="dd-label">Start date (used to suggest default days)</label>
        <div class="dd-issue-due-row">
          <div class="dd-date-icon-btn" title="Change the start date">
            <input class="dd-input" type="date" id="${idPrefix}-start-date" value="${d.startDate}" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </div>
          <span class="dd-sans" style="font-size:15px">${formatDate(d.startDate)}</span>
        </div>

        <label class="dd-label">Total days of time out</label>
        <select class="dd-input" id="${idPrefix}-total-days">
          <option value="">Select total days…</option>
          ${totalOptions.map((n) => `<option value="${n}" ${d.totalDays === n ? "selected" : ""}>${n} day${n > 1 ? "s" : ""}</option>`).join("")}
        </select>

        ${d.totalDays && !typeInfo.alwaysInSchool ? `
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
        ${d.totalDays && typeInfo.alwaysInSchool ? `
        <div class="dd-mono-muted" style="font-size:11px;margin-top:10px">${escapeHtml(typeInfo.label)} keeps the student in school every day — all ${d.totalDays} day${d.totalDays > 1 ? "s" : ""} need a location and who's administering it.</div>` : ""}

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
          const bookedCount = d.issDates.filter((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim()).length;
          const issRows = d.issDates.map((dt, i) => ({ dt, i })).sort((a, b) => a.dt.localeCompare(b.dt));
          return `
        <label class="dd-label" style="margin-top:12px">In-school days filled in: ${bookedCount} of ${d.issDays}</label>
        <div id="${idPrefix}-iss-date-rows" style="display:flex;flex-direction:column;gap:10px">
          ${issRows.map(({ dt, i }) => `
            <div class="dd-related-box" style="padding:10px">
              <div class="dd-venue-row" style="margin-bottom:8px">
                <div class="dd-date-icon-btn" title="Change this day's date">
                  <input type="date" class="${idPrefix}-iss-date-input" data-idx="${i}" value="${dt}" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
                </div>
                <span class="dd-venue-date">${formatDate(dt)}</span>
              </div>
              <label class="dd-label" style="margin-top:0;font-size:11px">Where is the student going?</label>
              <input class="dd-input ${idPrefix}-iss-venue-input" data-date="${dt}" placeholder="e.g. General Office" value="${escapeHtml(d.issVenues[dt] || "")}" />
              <label class="dd-label" style="font-size:11px">Who is administering it?</label>
              <input class="dd-input ${idPrefix}-iss-admin-input" data-date="${dt}" placeholder="Teacher's name" value="${escapeHtml(d.issAdministrators[dt] || "")}" />
            </div>`).join("")}
        </div>`;
        })() : ""}`;
}
// Same "avoid re-rendering on every keystroke" pattern as the studentName
// field's syncField helper — venue/administrator are free text, so a
// render-on-input would yank focus out of the box after every character.
function attachTimeOutFieldListeners(form, idPrefix, d) {
  const onChange = renderKeepingModalScroll;
  const typeEl = document.getElementById(`${idPrefix}-to-type`);
  if (typeEl) typeEl.addEventListener("change", () => { d.toType = typeEl.value; regenerateTimeOutDates(d); onChange(); });

  const startDateEl = document.getElementById(`${idPrefix}-start-date`);
  if (startDateEl) startDateEl.addEventListener("change", () => { d.startDate = startDateEl.value; regenerateTimeOutDates(d); onChange(); });

  const totalEl = document.getElementById(`${idPrefix}-total-days`);
  if (totalEl) totalEl.addEventListener("change", () => {
    const total = parseInt(totalEl.value, 10) || null;
    d.totalDays = total;
    if (total) {
      if (d.issDays + d.ossDays !== total) { d.issDays = total; d.ossDays = 0; }
      regenerateTimeOutDates(d);
    } else { d.ossDates = []; d.issDates = []; d.issAdministrators = {}; }
    onChange();
  });

  const issEl = document.getElementById(`${idPrefix}-iss-days`);
  if (issEl) issEl.addEventListener("change", () => {
    const n = parseInt(issEl.value, 10) || 0;
    d.issDays = n; d.ossDays = d.totalDays - n;
    regenerateTimeOutDates(d); onChange();
  });
  const ossEl = document.getElementById(`${idPrefix}-oss-days`);
  if (ossEl) ossEl.addEventListener("change", () => {
    const n = parseInt(ossEl.value, 10) || 0;
    d.ossDays = n; d.issDays = d.totalDays - n;
    regenerateTimeOutDates(d); onChange();
  });

  form.querySelectorAll(`.${idPrefix}-oss-date-input`).forEach((el) =>
    el.addEventListener("change", () => { d.ossDates[parseInt(el.dataset.idx, 10)] = el.value; regenerateTimeOutDates(d); onChange(); }));

  form.querySelectorAll(`.${idPrefix}-iss-date-input`).forEach((el) =>
    el.addEventListener("change", () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (!Array.isArray(d.issOverridden)) d.issOverridden = [];
      d.issDates[idx] = el.value;
      d.issOverridden[idx] = true;
      regenerateTimeOutDates(d);
      onChange();
    }));

  form.querySelectorAll(`.${idPrefix}-iss-venue-input`).forEach((el) =>
    el.addEventListener("input", () => { d.issVenues[el.dataset.date] = el.value; state.toFormError = ""; }));
  form.querySelectorAll(`.${idPrefix}-iss-admin-input`).forEach((el) =>
    el.addEventListener("input", () => { d.issAdministrators[el.dataset.date] = el.value; state.toFormError = ""; }));
}
function renderTimeOutForm(isEdit) {
  const d = state._toDraft;
  return `
    <div class="dd-modal-backdrop" id="to-modal-backdrop">
      <form class="dd-modal" id="to-form">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${isEdit ? "Edit time out" : "New time out"}</div>
          <button type="button" class="dd-modal-close" id="to-modal-close">✕</button>
        </div>
        <label class="dd-label">Student name</label>
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" list="known-students" autocomplete="off" />
        <label class="dd-label">Class</label>
        <select class="dd-input" name="studentClass" required>${classOptionsHtml(d.studentClass)}</select>
        ${renderTimeOutFieldsBody(d, "to")}
        ${!isEdit ? `
        <label class="dd-checkbox-pill" style="display:flex;margin-top:14px">
          <input type="checkbox" id="to-tag-pm-cb" ${d.tagPm ? "checked" : ""} />
          <span>Meeting Parents</span>
        </label>
        ${d.tagPm ? `
        <div class="dd-related-box" style="margin-top:8px">
          <label class="dd-label" style="margin-top:0">Who is attending?</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${ATTENDEE_OPTIONS.map((a) => `
              <label class="dd-checkbox-pill">
                <input type="checkbox" class="dd-to-pm-attendee-cb" value="${a}" ${d.pmAttendees.includes(a) ? "checked" : ""} />
                <span>${a}</span>
              </label>`).join("")}
          </div>
          ${d.pmAttendees.includes("Others") ? `<input class="dd-input" id="to-pm-others-text" style="margin-top:8px" placeholder="Please specify" value="${escapeHtml(d.pmOthersText)}" />` : ""}
          ${renderPmReasonPicker(d, "pm")}
        </div>` : ""}` : ""}
        ${state.toFormError ? `<div class="dd-error">${escapeHtml(state.toFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        <div class="dd-mono-muted" style="font-size:11px;margin-top:8px">Any changes here are recorded in this entry's audit trail.</div>
        <button class="dd-btn-primary" type="submit" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "Save time out"}</button>
      </form>
    </div>`;
}

// ---------- Parent Meet ----------
function parentMeetingWeekCategory(m) {
  const { monday, sunday } = currentWeekBounds();
  const d = pmDate(m);
  if (!d) return "This Week";
  if (d < monday) return "Completed";
  if (d > sunday) return "Upcoming";
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
    list = list.filter((m) =>
      m.studentName.toLowerCase().includes(q) ||
      (m.studentClass || "").toLowerCase().includes(q) ||
      (m.loggedBy || "").toLowerCase().includes(q) ||
      (m.reason || "").toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (pmDate(b) + b.createdAt).localeCompare(pmDate(a) + a.createdAt));
}
function pmCounts() {
  const c = { "This Week": 0, Upcoming: 0, Completed: 0, Deleted: 0 };
  state.parentMeetings.forEach((m) => {
    if (m.deleted) { c.Deleted++; return; }
    if (!isPmCounted(m)) return; // Cancelled/Postponed stay in the log but don't tally
    c[parentMeetingWeekCategory(m)]++;
  });
  return c;
}

function renderParentMeetingSection() {
  const list = filteredParentMeetings();
  const c = pmCounts();
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        ${renderLevelBreakdown("pm", state.parentMeetings.map((m) => ({ ...m, countDate: pmDate(m) })), "countDate", isPmCounted)}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.pmTab === t ? "active" : ""}" data-action="set-pm-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.pmExpandedLevel ? renderClassPillsRow("pm", state.pmExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" id="pm-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.pmQuery)}" />
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
  // Red while cancelled, or postponed with no new date yet. Once the new
  // date is set the meeting is live again, so its dot follows that date.
  const stopped = m.pmStatus === "Cancelled" || (m.pmStatus === "Postponed" && !m.postponedTo);
  const dotColor = m.deleted ? STATUS_DOT.removed : stopped ? STATUS_DOT.stopped : weekCat === "Completed" ? STATUS_DOT.completed : STATUS_DOT.ongoing;
  const dotLabel = m.deleted ? "Removed" : stopped ? m.pmStatus : weekCat;
  return `
    <div class="dd-detail-card">
      <div class="dd-detail-head">
        <div style="min-width:0">
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(m.studentName)}" data-class="${escapeHtml(m.studentClass || "")}">${escapeHtml(m.studentName)}${(m.pmStatus === "Cancelled" || m.pmStatus === "Postponed") ? ` <span class="dd-issue-stage-badge" style="background:${PM_MEETING_STATUS_STYLE[m.pmStatus].ink}22;color:${PM_MEETING_STATUS_STYLE[m.pmStatus].ink}">${PM_MEETING_STATUS_STYLE[m.pmStatus].label}</span>` : ""}</div>
          <div class="dd-card-meta dd-card-meta-primary">${isPmRescheduled(m) ? `<s>${formatDate(m.date)}</s> → ${formatDate(m.postponedTo)}` : formatDate(m.date)}${m.studentClass ? ` · ${escapeHtml(m.studentClass)}` : ""}</div>
          <div class="dd-card-meta">logged by ${escapeHtml(m.loggedBy)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:space-between;flex-shrink:0">
          <span class="dd-status-dot" style="background:${dotColor}" title="${escapeHtml(dotLabel)}"></span>
          <button class="dd-expand-toggle" data-action="toggle-entry-expanded" data-id="${m.id}" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▲" : "▼"}</button>
        </div>
      </div>
      ${!m.deleted ? `
      <div class="dd-pm-status-row" style="margin-top:8px">
        ${PM_MEETING_STATUS_OPTIONS.map((s) => `<button type="button" class="dd-pm-status-pill dd-pm-status-pill-sm ${(m.pmStatus || "Scheduled") === s ? "active" : ""}" style="${(m.pmStatus || "Scheduled") === s ? `background:${PM_MEETING_STATUS_STYLE[s].ink};border-color:${PM_MEETING_STATUS_STYLE[s].ink}` : ""}" data-action="set-pm-status-quick" data-id="${m.id}" data-status="${s}">${s}</button>`).join("")}
      </div>
      ${m.pmStatus === "Postponed" ? `
      <div class="dd-pm-postpone-block">
        <div class="dd-field-label" style="margin-bottom:4px">Postponed to <span style="text-transform:none;letter-spacing:0">(optional — add when known)</span></div>
        ${renderPostponeDateField(m)}
      </div>` : ""}` : ""}
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
        <input class="dd-input" name="studentName" required value="${escapeHtml(d.studentName)}" list="known-students" autocomplete="off" />
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
        <label class="dd-label">Meeting status <span class="dd-mono-muted" style="font-size:11px;text-transform:none">cancelled/postponed meetings stay in the log but aren't counted in tallies</span></label>
        <div class="dd-pm-status-row" style="margin-bottom:12px">
          ${PM_MEETING_STATUS_OPTIONS.map((s) => `<button type="button" class="dd-pm-status-pill ${(d.meetingStatus || "Scheduled") === s ? "active" : ""}" style="${(d.meetingStatus || "Scheduled") === s ? `background:${PM_MEETING_STATUS_STYLE[s].ink};border-color:${PM_MEETING_STATUS_STYLE[s].ink}` : ""}" data-action="set-pm-meeting-status" data-status="${s}">${s}</button>`).join("")}
        </div>
        ${d.meetingStatus === "Postponed" ? `
        <label class="dd-label" style="margin-top:0">Postponed to <span class="dd-mono-muted" style="font-size:11px;text-transform:none">optional — add when known</span></label>
        <div class="dd-issue-due-row" style="margin-bottom:12px">
          <button type="button" class="dd-date-icon-btn" data-pp-open="draft" id="pm-postponed-to-btn" title="Choose the postponed meeting date">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </button>
          ${d.postponedTo ? `<span class="dd-sans" style="font-size:15px">${formatDate(d.postponedTo)}</span><button type="button" class="dd-followup-icon-btn" data-pp-clear="draft" title="Clear this date">✕</button>` : `<span class="dd-mono-muted" style="font-size:12px">Not set yet</span>`}
        </div>` : ""}
        ${renderPmReasonPicker(d, "")}
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
      state.studentViewClass = el.dataset.class || "";
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
  document.querySelectorAll('[data-action="jump-to-timeout"]').forEach((el) =>
    el.addEventListener("click", () => { state.section = "timeOuts"; state.selectedToId = el.dataset.id; state.entryExpanded[el.dataset.id] = true; render(); }));
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

  const backupBtn = document.getElementById("btn-backup");
  if (backupBtn) backupBtn.addEventListener("click", downloadBackupFile);

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

  document.querySelectorAll('[data-action="settings-open-access"]').forEach((el) =>
    el.addEventListener("click", () => { state.accessFormError = ""; state.settingsView = "manageAccess"; render(); }));

  // Authorised Teachers List "⋮" menu: tapping a row's button opens the
  // action-picker modal; every option in that modal just hands off to the
  // existing Yes/No confirmation flow (requestDeleteConfirmation), same as
  // the old ✕/swipe actions did — nothing here writes to Firestore itself.
  document.querySelectorAll('[data-action="open-member-actions"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.memberActionTarget = { email: el.dataset.id, name: el.dataset.name || "", tier: el.dataset.tier || null };
      render();
    }));
  const memberActionBackdrop = document.getElementById("member-action-backdrop");
  if (memberActionBackdrop) memberActionBackdrop.addEventListener("click", (e) => {
    if (e.target === memberActionBackdrop) { state.memberActionTarget = null; render(); }
  });
  const memberActionCancel = document.getElementById("member-action-cancel");
  if (memberActionCancel) memberActionCancel.addEventListener("click", () => { state.memberActionTarget = null; render(); });
  document.querySelectorAll('[data-action="member-remove-user"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.memberActionTarget = null;
      requestDeleteConfirmation("removeMember", el.dataset.id, { message: `Remove ${el.dataset.name || el.dataset.id}? They won't be able to sign in again until re-added.` });
    }));
  document.querySelectorAll('[data-action="member-make-admin"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.memberActionTarget = null;
      requestDeleteConfirmation("addAdmin", el.dataset.id, { message: `Make ${el.dataset.name || el.dataset.id} an admin? They'll be able to add/remove Authorised Teachers.` });
    }));
  document.querySelectorAll('[data-action="member-remove-admin"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.memberActionTarget = null;
      requestDeleteConfirmation("adminUser", el.dataset.id, { message: `Remove ${el.dataset.name || el.dataset.id} as an admin? They'll keep their teacher access unless also removed.` });
    }));
  document.querySelectorAll('[data-action="member-make-owner"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.memberActionTarget = null;
      requestDeleteConfirmation("transferOwnership", el.dataset.id, { message: `Transfer ownership to ${el.dataset.name || el.dataset.id}? They become the primary Owner. You'll keep admin access.` });
    }));

  const addAuthorizedBtn = document.getElementById("btn-add-authorized");
  const newAuthorizedInput = document.getElementById("new-authorized-email");
  // The field comes prefilled with "@moe.edu.sg" — put the cursor before
  // it on focus so typing a name just slots in ahead of the domain,
  // rather than the person having to select/delete it first.
  if (newAuthorizedInput) newAuthorizedInput.addEventListener("focus", () => {
    const atIndex = newAuthorizedInput.value.indexOf("@");
    newAuthorizedInput.setSelectionRange(atIndex === -1 ? 0 : atIndex, atIndex === -1 ? 0 : atIndex);
  });
  // Force lowercase as they type (or paste) — emails are matched
  // case-sensitively against Firestore doc IDs elsewhere, so keeping the
  // field itself lowercase (not just at submit) avoids "Jane@..." and
  // "jane@..." ever being treated as different people.
  if (newAuthorizedInput) newAuthorizedInput.addEventListener("input", () => {
    const pos = newAuthorizedInput.selectionStart;
    newAuthorizedInput.value = newAuthorizedInput.value.toLowerCase();
    newAuthorizedInput.setSelectionRange(pos, pos);
  });
  if (addAuthorizedBtn) addAuthorizedBtn.addEventListener("click", () => {
    const email = (newAuthorizedInput?.value || "").trim().toLowerCase();
    if (!isValidMoeEmail(email)) { state.accessFormError = "Enter a valid @moe.edu.sg email."; render(); return; }
    state.accessFormError = "";
    requestDeleteConfirmation("addAuthorized", email, { message: `Add ${email} to Authorised Teachers? They'll be able to sign in right away.` });
  });
  const addExistingUsersBtn = document.getElementById("btn-add-existing-users");
  if (addExistingUsersBtn) addExistingUsersBtn.addEventListener("click", () => {
    const emails = existingUsersNotYetAuthorized();
    if (!emails.length) return;
    requestDeleteConfirmation("addAllExisting", null, {
      message: `Add ${emails.length} previously signed-in teacher${emails.length === 1 ? "" : "s"} to the Authorised Teachers List? They'll be able to sign in right away.`,
      emails,
    });
  });
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
  else if (state.section === "timeOuts") attachTimeOutListeners();
  else if (state.section === "parentMeetings") attachPmListeners();
  else if (state.section === "log") attachGroomingListeners();
  else if (state.section === "dashboard") attachDashboardListeners();
  else if (state.section === "studentView") { attachGroomingListeners(); attachSuspListeners(); attachTimeOutListeners(); attachPmListeners(); }
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
  if (search) search.addEventListener("input", debounce(() => {
    if (!search.isConnected) return; // page re-rendered from elsewhere while the timer was pending
    state.query = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  }, 300));

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
      const key = { parentMeeting: "chartIncludeParentMeeting", suspension: "chartIncludeSuspension", timeOut: "chartIncludeTimeOut" }[el.dataset.cat] || "chartIncludeDiscipline";
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
  const newToOnlyBtn = document.getElementById("btn-new-to-only");
  if (newToOnlyBtn) newToOnlyBtn.addEventListener("click", () => {
    state.showNewToForm = true;
    state.editingTimeOutId = null;
    state._toDraft = freshTimeOutDraft();
    state.toFormError = "";
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

  attachSuspFormModalListeners();
  attachTimeOutFormModalListeners();
  attachPmFormModalListeners();
}



function attachSuspListeners() {
  document.querySelectorAll('[data-action="set-susp-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.suspTab = el.dataset.tab; render(); }));

  const search = document.getElementById("susp-search-input");
  if (search) search.addEventListener("input", debounce(() => {
    if (!search.isConnected) return; // page re-rendered from elsewhere while the timer was pending
    state.suspQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("susp-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  }, 300));

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
    // Guarded because the screens that render this modal and the ones
    // that attach its listeners are decided in two separate places — the
    // student cross-log view, for one, renders only the *edit* variant.
    // Without this, a mismatch would throw here and silently abandon
    // every listener still queued behind it.
    const form = document.getElementById("susp-form");
    if (!form) return;
    form.addEventListener("submit", state.editingSuspensionId ? submitEditSuspension : submitNewSuspension);
    document.getElementById("susp-modal-close").addEventListener("click", () => { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); });
    document.getElementById("susp-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "susp-modal-backdrop") { state.showNewSuspForm = false; state.editingSuspensionId = null; state._suspDraft = null; render(); }
    });

    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._suspDraft[name] = el.value; }); };
    syncField("studentName");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._suspDraft.studentClass = classEl.value; regenerateSuspDates(state._suspDraft); renderKeepingModalScroll(); });
    attachMultiReasonListeners(form, state._suspDraft);

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
    attachPmReasonPickerListeners(form, state._suspDraft, "pm");
  }
}

function attachTimeOutListeners() {
  document.querySelectorAll('[data-action="set-to-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.toTab = el.dataset.tab; render(); }));

  const search = document.getElementById("to-search-input");
  if (search) search.addEventListener("input", debounce(() => {
    if (!search.isConnected) return; // page re-rendered from elsewhere while the timer was pending
    state.toQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("to-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  }, 300));

  document.querySelectorAll('[data-action="delete-timeout"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("timeOut", el.dataset.id)));
  document.querySelectorAll('[data-action="edit-timeout"]').forEach((el) =>
    el.addEventListener("click", () => { openEditTimeOut(el.dataset.id); state.showNewToForm = false; }));
  document.querySelectorAll('[data-action="toggle-to-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));

  attachTimeOutFormModalListeners();
}

// Shared between the Time Out Log page (editing), the Dashboard's
// "+ Time Out" button (creating), and the student cross-log view.
function attachTimeOutFormModalListeners() {
  if (state.showNewToForm || state.editingTimeOutId) {
    // Same guard as the suspension form: the screen that renders this modal
    // and the one attaching its listeners are decided separately.
    const form = document.getElementById("to-form");
    if (!form) return;
    form.addEventListener("submit", state.editingTimeOutId ? submitEditTimeOut : submitNewTimeOut);
    document.getElementById("to-modal-close").addEventListener("click", () => { state.showNewToForm = false; state.editingTimeOutId = null; state._toDraft = null; render(); });
    document.getElementById("to-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "to-modal-backdrop") { state.showNewToForm = false; state.editingTimeOutId = null; state._toDraft = null; render(); }
    });

    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._toDraft[name] = el.value; }); };
    syncField("studentName");
    const classEl = form.elements["studentClass"];
    if (classEl) classEl.addEventListener("change", () => { state._toDraft.studentClass = classEl.value; regenerateSuspDates(state._toDraft); renderKeepingModalScroll(); });
    attachMultiReasonListeners(form, state._toDraft);

    attachTimeOutFieldListeners(form, "to", state._toDraft);

    const tagPmCb = document.getElementById("to-tag-pm-cb");
    if (tagPmCb) tagPmCb.addEventListener("change", () => { state._toDraft.tagPm = tagPmCb.checked; renderKeepingModalScroll(); });
    form.querySelectorAll(".dd-to-pm-attendee-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const list = state._toDraft.pmAttendees;
        if (cb.checked) { if (!list.includes(cb.value)) list.push(cb.value); }
        else { state._toDraft.pmAttendees = list.filter((x) => x !== cb.value); }
        renderKeepingModalScroll();
      }));
    const pmOthersEl = document.getElementById("to-pm-others-text");
    if (pmOthersEl) pmOthersEl.addEventListener("input", () => { state._toDraft.pmOthersText = pmOthersEl.value; });
    attachPmReasonPickerListeners(form, state._toDraft, "pm");
  }
}

function attachPmListeners() {
  const search = document.getElementById("pm-search-input");
  if (search) search.addEventListener("input", debounce(() => {
    if (!search.isConnected) return; // page re-rendered from elsewhere while the timer was pending
    state.pmQuery = search.value;
    const cursor = search.selectionStart;
    render();
    const ns = document.getElementById("pm-search-input");
    if (ns) { ns.focus(); ns.setSelectionRange(cursor, cursor); }
  }, 300));

  document.querySelectorAll('[data-action="set-pm-tab"]').forEach((el) =>
    el.addEventListener("click", () => { state.pmTab = el.dataset.tab; render(); }));

  document.querySelectorAll('[data-action="delete-pm"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("parentMeeting", el.dataset.id)));
  document.querySelectorAll('[data-action="edit-pm"]').forEach((el) =>
    el.addEventListener("click", () => { openEditParentMeeting(el.dataset.id); state.showNewPmForm = false; }));
  document.querySelectorAll('[data-action="toggle-pm-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));
  document.querySelectorAll('[data-action="set-pm-status-quick"]').forEach((el) =>
    el.addEventListener("click", () => setPmStatusQuick(el.dataset.id, el.dataset.status)));

  attachPmFormModalListeners();
}

// Attaches listeners for the multi-select "Reason(s) for meeting"
// checklist rendered by renderPmReasonPicker — shared by the standalone
// Parent Meet form and the Suspension form's tagged-parent-meeting
// block. `prefix` ("" or "pm") picks which draft fields to mutate,
// matching renderPmReasonPicker/composePmReasonData.
function attachPmReasonPickerListeners(form, d, prefix) {
  const reasonsKey = prefix ? `${prefix}Reasons` : "reasons";
  const statusesKey = prefix ? `${prefix}ReasonStatuses` : "reasonStatuses";
  const othersKey = prefix ? `${prefix}ReasonOthersText` : "reasonOthersText";
  // The edit-suspension draft is built without these fields (its tagged-
  // meeting block never renders), so make sure they exist before any
  // handler below tries to read or delete through them.
  if (!Array.isArray(d[reasonsKey])) d[reasonsKey] = [];
  if (!d[statusesKey]) d[statusesKey] = {};
  form.querySelectorAll(`.dd-pm-reason-cb[data-pm-prefix="${prefix}"]`).forEach((cb) =>
    cb.addEventListener("change", () => {
      const list = d[reasonsKey];
      if (cb.checked) { if (!list.includes(cb.value)) list.push(cb.value); }
      else { d[reasonsKey] = list.filter((x) => x !== cb.value); delete d[statusesKey][cb.value]; }
      renderKeepingModalScroll();
    }));
  form.querySelectorAll(`[data-action="set-pm-reason-status"][data-pm-prefix="${prefix}"]`).forEach((el) =>
    el.addEventListener("click", () => {
      d[statusesKey][el.dataset.reason] = el.dataset.status;
      renderKeepingModalScroll();
    }));
  const othersEl = form.querySelector(`.dd-pm-others-input[data-pm-prefix="${prefix}"]`);
  if (othersEl) othersEl.addEventListener("input", () => { d[othersKey] = othersEl.value; });
}

// Shared between the Parent Meet Log page (editing) and the Dashboard's
// "+ New Meeting Only" button (creating standalone, no discipline entry).
function attachPmFormModalListeners() {
  if (state.showNewPmForm || state.editingPmId) {
    // Same guard as the suspension form — see the note there.
    const form = document.getElementById("pm-form");
    if (!form) return;
    form.addEventListener("submit", state.editingPmId ? submitEditParentMeeting : submitNewParentMeeting);
    document.getElementById("pm-modal-close").addEventListener("click", () => { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); });
    document.getElementById("pm-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "pm-modal-backdrop") { state.showNewPmForm = false; state.editingPmId = null; state._pmDraft = null; render(); }
    });
    const syncField = (name) => { const el = form.elements[name]; if (el) el.addEventListener("input", () => { state._pmDraft[name] = el.value; }); };
    syncField("studentName");
    attachPmReasonPickerListeners(form, state._pmDraft, "");
    form.querySelectorAll('[data-action="set-pm-meeting-status"]').forEach((el) =>
      el.addEventListener("click", () => {
        const clicked = el.dataset.status;
        state._pmDraft.meetingStatus = (state._pmDraft.meetingStatus || "Scheduled") === clicked ? "Scheduled" : clicked;
        renderKeepingModalScroll();
      }));

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
  if (handlePostponePickerTap(e)) return;
  const yesBtn = e.target.closest && e.target.closest("#btn-confirm-delete-yes");
  if (yesBtn) { runDelegatedAction("confirm-delete-yes", () => confirmDeleteYes()); return; }
  // Deliberately NOT dismissing on a backdrop tap. These confirmations can
  // appear straight after typing (adding a teacher, saving an entry), so the
  // on-screen keyboard is still collapsing as the modal appears — the
  // vertically-centred box slides downwards while the viewport grows back.
  // A tap aimed at "Yes" could land on the backdrop a moment later and
  // silently cancel, which looked exactly like "I pressed Yes and nothing
  // happened, nobody got added". Yes/No must be tapped explicitly now.
  const noBtn = e.target.closest && e.target.closest("#btn-confirm-delete-no");
  if (noBtn) { runDelegatedAction("confirm-delete-no", () => cancelDeleteConfirmation()); return; }
  // Same-day duplicate-entry warning — shared across Grooming, Suspension
  // and Parent Meet "new entry" saves (see guardDuplicate), so it's
  // wired here in the one handler that's always live, rather than in any
  // one section's per-render attach*Listeners.
  const dupYesBtn = e.target.closest && e.target.closest("#btn-confirm-duplicate-yes");
  if (dupYesBtn) { runDelegatedAction("confirm-duplicate-yes", () => confirmDuplicateYes()); return; }
  // Same reasoning as the delete confirmation above — this one pops up right
  // after filling in a form, so a backdrop tap is even likelier to be a
  // mis-landed "Yes".
  const dupNoBtn = e.target.closest && e.target.closest("#btn-confirm-duplicate-no");
  if (dupNoBtn) { runDelegatedAction("confirm-duplicate-no", () => cancelDuplicateConfirm()); return; }
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
      const extraStudents = state._newIncidentDraft.extraStudents || [];
      container.querySelectorAll(".dd-extra-student-name").forEach((el) => {
        const idx = parseInt(el.dataset.idx, 10);
        if (extraStudents[idx]) extraStudents[idx].name = el.value;
      });
      container.querySelectorAll(".dd-extra-student-class").forEach((el) => {
        const idx = parseInt(el.dataset.idx, 10);
        if (extraStudents[idx]) extraStudents[idx].studentClass = el.value;
      });
    }
  }
  const addStudentBtn = e.target.closest && e.target.closest("#btn-add-extra-student");
  if (addStudentBtn && state._newIncidentDraft) {
    runDelegatedAction("add-extra-student", () => {
      if (!Array.isArray(state._newIncidentDraft.extraStudents)) state._newIncidentDraft.extraStudents = [];
      state._newIncidentDraft.extraStudents.push({ name: "", studentClass: "" });
      renderKeepingModalScroll();
    });
    return;
  }
  const removeStudentBtn = e.target.closest && e.target.closest('[data-action="remove-extra-student"]');
  if (removeStudentBtn && state._newIncidentDraft) {
    const idx = parseInt(removeStudentBtn.dataset.idx, 10);
    runDelegatedAction("remove-extra-student-" + idx, () => {
      state._newIncidentDraft.extraStudents.splice(idx, 1);
      renderKeepingModalScroll();
    });
    return;
  }
  const saveBtn = e.target.closest && e.target.closest("#btn-save-new-incident");
  if (saveBtn && !saveBtn.disabled) { runDelegatedAction("save-new-incident", () => submitNewIncident()); return; }
  // Matched on the data-action, not the .dd-issue-tag class: that class is
  // shared by four different button groups (closure type, HBL levels, new
  // issue tags, edit issue tags), and a class match would let any of the
  // others push an undefined issue into this draft.
  const tagBtn = e.target.closest && e.target.closest('[data-action="toggle-grooming-issue"]');
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

// New grooming entry → "Related records found — tick any to link". These
// checkboxes previously had no listener at all, so a tick was never written
// to the draft: it vanished on the next re-render and was never saved, and
// no link was ever created. Delegated on document (like the rest of this
// form's controls) since the modal is re-rendered from scratch constantly.
// No render() needed: the checkbox already shows its own state, and any
// later re-render reads it back from the draft.
const LINK_CHECKBOX_FIELDS = {
  "dd-link-susp-cb": "linkedSuspensionIds",
  "dd-link-to-cb": "linkedTimeOutIds",
  "dd-link-pm-cb": "linkedPmIds",
};
document.addEventListener("change", (e) => {
  const cb = e.target;
  const d = state._newIncidentDraft;
  if (!d || !cb || !cb.classList) return;
  const cls = Object.keys(LINK_CHECKBOX_FIELDS).find((c) => cb.classList.contains(c));
  if (!cls) return;
  const field = LINK_CHECKBOX_FIELDS[cls];
  const list = Array.isArray(d[field]) ? d[field] : [];
  d[field] = cb.checked ? [...new Set([...list, cb.value])] : list.filter((id) => id !== cb.value);
});

render();
