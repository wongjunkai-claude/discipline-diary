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

const APP_VERSION = "3.35.2";

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
// Escalation follow-up notes (one per issue, written when moving it to the
// next warning stage) accumulated across every issue in the entry, in
// chronological order — this is what the Sheet's follow-ups column now
// reflects, replacing the old free-form thread.
function formatFollowUpsForSheet(issues) {
  if (!Array.isArray(issues)) return "";
  const lines = [];
  issues.forEach((issue) => {
    (issue.history || []).forEach((h) => {
      if (h.note) lines.push(`${formatDate(h.at)} (${groomingIssueLabel(issue)} → ${WARNING_STAGE_LABEL[h.stage]}): ${h.note} — ${h.by || ""}`);
    });
  });
  return lines.join("\n");
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
    followUpsText: formatFollowUpsForSheet(it.issues),
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
    date: [m.date, formatTimeRange(m.time, m.endTime), m.location].filter(Boolean).join(" · "),
    reason: (m.deleted ? "Removed — " : "") + (m.pmStatus === "Cancelled" ? "[Cancelled] " : m.pmStatus === "Postponed" ? (m.postponedTo ? `[Postponed to ${formatDate(m.postponedTo)}${m.postponedTime ? `, ${pmSlotLabel(m.postponedTime, m.postponedEndTime, m.postponedLocation)}` : ""}] ` : "[Postponed] ") : "") + (m.reason || ""),
    loggedBy: m.loggedBy,
  });
}

// ---------- Constants ----------
// "Open" removed as a selectable status — new entries default straight to
// "In Progress" (internally "Monitoring", kept for backward compatibility
// with existing data). STATUS_TEXT still maps Open for display, so any
// pre-existing "Open" entries keep rendering correctly.
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
  { key: "Recess", label: "Time Out (Recess)", abbrev: "R", alwaysInSchool: true },
  { key: "Lesson", label: "Time Out (Lesson)", abbrev: "L", alwaysInSchool: true },
  { key: "CCA", label: "Time Out (CCA)", abbrev: "CCA", alwaysInSchool: false },
  { key: "LearningExperience", label: "Time Out (Learning Experience)", abbrev: "LE", dashLabel: "Time Out (LE)", alwaysInSchool: false },
];
function toTypeInfo(key) { return TO_TYPES.find((t) => t.key === key) || TO_TYPES[0]; }
// Dashboard day list: "Time Out (CCA)", with Learning Experience shortened to "Time Out (LE)".
function toTypeDashLabel(key) { const t = toTypeInfo(key); return t.dashLabel || t.label; }
function toTypeLabel(key) { return toTypeInfo(key).label; }
// Tallies a list of already-filtered Time Out records by type (one record
// = one count) for the level/term table and the Annual Report. An unrecognized/missing toType (old
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
// A suspension's / time out's reasons as display lines (one bullet each).
function entryReasonLines(rec) {
  if (Array.isArray(rec.reasons) && rec.reasons.length) {
    return rec.reasons.map((r) => r === "Others" ? (rec.reasonOthersText ? `Others — ${rec.reasonOthersText}` : "Others") : r);
  }
  return String(rec.reason || "").split("; ").filter(Boolean);
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
    return r.status && r.status !== "NA" ? `${label} (${pmStatusWords(r.status)})` : label;
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
    <label class="dd-label">Reason(s) for Meeting <span class="dd-mono-muted" style="font-size:11px;text-transform:none">select all that apply</span></label>
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
// How a reason's status reads outside the picker: "Both" is spelt out.
function pmStatusWords(status) { return status === "Both" ? "Victim & Offender" : status; }
// A meeting's reasons as display lines, e.g. "Fighting (Victim & Offender)".
// Uses the structured `reasons` list; older records only have the combined
// `reason` text, which is split on "; ".
function pmReasonLines(m) {
  if (Array.isArray(m.reasons) && m.reasons.length) {
    return m.reasons.map((r) => {
      const label = r.category === "Others" ? (r.othersText ? `Others — ${r.othersText}` : "Others") : r.category;
      return r.status && r.status !== "NA" ? `${label} (${pmStatusWords(r.status)})` : label;
    });
  }
  return String(m.reason || "").split("; ").filter(Boolean).map((x) => x.replace(/\(Both\)$/, "(Victim & Offender)"));
}
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
// Just the (local) date of a millisecond timestamp, e.g. "28 Sep 2026".
function formatDateFromMs(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}
function formatDateTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const datePart = formatDateFromMs(ms);
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
  // Several entries can cover the same day (e.g. P3/P4 HBL 24–29 Sep plus
  // P5 HBL 24–25 Sep), so the day's levels are combined from all of them:
  // 24–25 Sep → P3/P4/P5, 28–29 Sep → P3/P4. Always in level order.
  const levels = new Set();
  (state.schoolClosureDays?.entries || []).forEach((e) => {
    const start = e.startDate || e.date;
    const end = e.endDate || e.date;
    if (start && iso >= start && iso <= end) (e.levels || []).forEach((l) => levels.add(Number(l)));
  });
  if (!levels.size) return null;
  return { startDate: iso, endDate: iso, levels: [...levels].sort((x, y) => x - y) };
}
// "School Closure" when every level is off, otherwise e.g. "P3/P4/P5 HBL".
function closureLabel(levels) {
  const sorted = [...(levels || [])].map(Number).sort((x, y) => x - y);
  return sorted.length >= 6 ? "School Closure" : `${sorted.map((l) => "P" + l).join("/")} HBL`;
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
  if (target.type === "setPostponeDate") { render(); await setPmPostponedDate(target.id, target.date || "", target.slot); return; }
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
  else if (target.type === "undoStudentLink") await undoStudentLink(target.id);
  else if (target.type === "changeStudentLink") await changeStudentLink(target.id);
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
  try {
    await deleteDoc(doc(db, "authorizedUsers", email));
    await purgeUserDocs(email);
  } catch (err) { console.error("removeAuthorizedEmail failed:", err); state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
// Removing someone also deletes their sign-in record (users/{uid}: name
// and email), so they disappear from the app completely and don't come
// back under "Add Existing Users". Skipped while they're still an admin
// or the owner (they keep access that way). If they're added again later,
// they're asked for their name the next time they sign in.
async function purgeUserDocs(email, adminAlsoRemoved = false) {
  const e = (email || "").toLowerCase();
  const owner = (state.currentOwnerEmail || OWNER_EMAIL).toLowerCase();
  if (!e || e === owner || e === OWNER_EMAIL.toLowerCase()) return;
  // Still an admin (they keep access that way): leave their record alone.
  if ((state.adminsList || []).some((a) => a.id === e) && !adminAlsoRemoved) return;
  const uids = (state.userList || []).filter((u) => (u.email || "").toLowerCase() === e && u._uid).map((u) => u._uid);
  await Promise.all(uids.map((id) => deleteDoc(doc(db, "users", id))));
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
    let adminRemoved = false;
    await Promise.all([
      deleteDoc(doc(db, "authorizedUsers", email)).catch((err) => console.warn("removeMemberFully: authorizedUsers delete failed (may not exist):", err)),
      deleteDoc(doc(db, "admins", email)).then(() => { adminRemoved = true; }).catch((err) => console.warn("removeMemberFully: admins delete failed (expected if caller isn't Owner):", err)),
    ]);
    await purgeUserDocs(email, adminRemoved);
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
        <div class="dd-modal-title" style="margin-bottom:${state.confirmDeleteTarget?.details ? "12px" : "18px"}">${escapeHtml(msg)}</div>
        ${state.confirmDeleteTarget?.details ? `<div class="dd-confirm-details">${state.confirmDeleteTarget.details.map(([k, val]) => `<div class="dd-confirm-k">${escapeHtml(k)}</div><div class="dd-confirm-v">${escapeHtml(val)}</div>`).join("")}</div>` : ""}
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
  // A teacher who hasn't signed in yet has no name on record — say so
  // rather than repeating their email (which is shown on the next line).
  const who = t.name || "Pending User Onboarding";
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
        <div class="dd-modal-title" style="font-size:17px;margin-bottom:2px;overflow-wrap:anywhere">${escapeHtml(who)}</div>
        <div class="dd-mono-muted" style="font-size:12px;margin-bottom:16px;overflow-wrap:anywhere">${escapeHtml(t.email)}</div>
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
  // Uses the date the meeting actually happens on (a rescheduled meeting
  // counts on its new date); cancelled meetings, and postponed ones with
  // no new date yet, aren't duplicates.
  return state.parentMeetings.find((m) => m.id !== excludeId && isPmCounted(m) && pmDate(m) === date && studentKey(m.studentName, m.studentClass) === key) || null;
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
  studentViewYear: null, // year of the specific record that was tapped, so linking starts from the right year
  studentViewFromSection: "dashboard",
  studentViewOpenYears: {}, // past years opened in the student view
  studentLinks: {}, // studentLinks/{id}: confirmed same-student links across years
  linkPromptQueue: [], // students to ask about right after saving an entry
  linkError: "",
  linkSearch: "", // Settings → Student Links search
  linkArchiveOpen: false, // Settings → Student Links: graduated students shown
  linkYearsOpen: {}, // Settings → Student Links: which year headers are open
  showWatchlistInfo: false,
  backupError: "",
  postponePicker: null,
  pmQuickError: null, // { id, message } — shown on that meeting's card
  timePop: null,
  _classDraft: null,
  calendarViewMonth: null, // set on first render to the current month
  dayViewDate: null, // set on first render to today
  weekViewMonday: null, // set on first render to this week's Monday
  yearViewYear: null, // set on first render to the current year
  selectedCalendarDay: null,
  // Custom range, as full dates (YYYY-MM-DD).
  chartCustomFrom: `${lastNMonthKeys(3)[0]}-01`,
  chartCustomTo: todayISO(),
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
  // Escalating a grooming issue now requires writing a follow-up note first
  // (item 13's redesign) — this holds which issue is mid-way through that
  // (its Resolve/Escalate buttons swap for a note input + tick), the
  // in-progress note text, and whether an empty-note error should show.
  escalatingIssue: null, // { entryId, issueId } | null
  escalateNoteDraft: {},
  escalateNoteError: null, // issueId whose note was empty when confirmed
  // Editing an already-written escalation note (a completed stage's note,
  // reached via its pencil icon) — keyed separately from the above so
  // editing an old note doesn't interfere with escalating the current one.
  editingEscalationNote: null, // { entryId, issueId, stage } | null
  escalateNoteEditDraft: {}, // keyed "issueId_stage"
  escalateNoteEditError: null, // "issueId_stage" key whose edited note was empty
  // Grooming issues open collapsed (latest stage only); an issue id set to
  // true here shows its earlier stages and follow-up notes too.
  issueExpanded: {},

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
  deletedItems: [], // trash copies of deleted log records — see trashRecord/restoreDeletedItem
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
let unsubDeletedItems = null;
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
    (snap) => { state.userList = snap.docs.map((d) => ({ ...d.data(), _uid: d.id })); render(); },
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
  // Trash copies of deleted discipline-log records (see trashRecord/
  // restoreDeletedItem) — kept independent of the live collections and the
  // rolling backup snapshot, so a delete stays recoverable even after the
  // 5-second undo toast is gone and even once the backup has rewritten
  // itself without that record.
  if (unsubDeletedItems) unsubDeletedItems();
  unsubDeletedItems = onSnapshot(
    collection(db, "deletedItems"),
    (snap) => { state.deletedItems = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    (err) => { console.warn("deletedItems listener failed:", err); state.deletedItems = state.deletedItems || []; }
  );
  ensureHolidaysSeeded();
  checkAnnualPublicHolidayFetch();
  // Same-student links. Denied until the updated rules are published —
  // treated as "no links yet" rather than as lost access.
  onSnapshot(
    collection(db, "studentLinks"),
    (snap) => { const m = {}; snap.docs.forEach((d) => { m[d.id] = d.data(); }); state.studentLinks = m; render(); },
    (err) => { console.warn("studentLinks listener failed:", err); state.studentLinks = {}; }
  );
  unsubHolidays = onSnapshot(
    doc(db, "holidays", "singapore"),
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const raw = data.publicHolidayEntries || [];
      const clean = dedupePublicHolidayEntries(raw);
      state.holidays = { ...data, publicHolidayEntries: clean };
      render();
      if (clean.length < raw.length && state.isAdmin) {
        setDoc(doc(db, "holidays", "singapore"), { publicHolidayEntries: clean }, { merge: true }).catch(() => {});
      }
    },
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

// Both background holiday jobs write to the shared calendar, which only
// admins and the owner may change — so they only run for them.
// ---- Public holiday duplicates ----
// The same holiday can arrive from two places (the data.gov.sg fetch and
// "Load known public holidays") with names that differ only in punctuation,
// e.g. "New Year’s Day" vs "New Year's Day", or as one 2-day range vs two
// single days. Names are compared ignoring case, spacing and apostrophe
// style, and a holiday counts as already listed if every date it covers is
// already covered by an entry of the same name.
function normHolidayName(n) {
  return String(n || "").replace(/[\u2018\u2019\u02BC`´]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}
function holidayDates(e) {
  const out = [];
  for (let d = e.startDate; d && d <= (e.endDate || e.startDate) && out.length < 40; d = addDays(d, 1)) out.push(d);
  return out;
}
// Every date already covered by any entry (any name).
function coveredHolidayDates(entries) {
  const set = new Set();
  (entries || []).forEach((e) => holidayDates(e).forEach((d) => set.add(d)));
  return set;
}
// The list with repeats removed (first one kept).
function dedupePublicHolidayEntries(entries) {
  const seen = new Set(); // "date|name"
  return (entries || []).filter((e) => {
    const name = normHolidayName(e.name);
    const keys = holidayDates(e).map((d) => `${d}|${name}`);
    if (keys.length && keys.every((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}
async function ensureHolidaysSeeded() {
  if (!state.isAdmin) return;
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
  if (!state.isAdmin) return;
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
    const existingDates = coveredHolidayDates(existingEntries);
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
const TRASH_TYPE_LABEL = { incidents: "Grooming", suspensions: "Suspension", timeOuts: "Time Out", parentMeetings: "Parent Meet" };
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

// ---------- Download a log as Excel (.xlsx) ----------
// A small .xlsx writer: one worksheet, bold header row frozen at the top
// with filters, real dates (so Excel sorts them), wrapped multi-line cells.
// Built by hand (an .xlsx is a zip of a few XML files) rather than loading a
// spreadsheet library of ~1 MB for this one job.
const XLSX_DATE = "date";
function xlsxEscape(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}
function xlsxColName(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function isoToExcelSerial(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}
function buildXlsxSheetXml(columns, rows) {
  const cell = (ref, v, kind, header) => {
    if (v === null || v === undefined || v === "") return "";
    if (kind === XLSX_DATE && /^\d{4}-\d{2}-\d{2}$/.test(v)) return `<c r="${ref}" s="3"><v>${isoToExcelSerial(v)}</v></c>`;
    if (typeof v === "number") return `<c r="${ref}" s="${header ? 1 : 2}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr" s="${header ? 1 : 2}"><is><t xml:space="preserve">${xlsxEscape(v)}</t></is></c>`;
  };
  const head = `<row r="1">${columns.map((c, i) => cell(`${xlsxColName(i)}1`, c.label, null, true)).join("")}</row>`;
  const body = rows.map((r, ri) => `<row r="${ri + 2}">${columns.map((c, i) => cell(`${xlsxColName(i)}${ri + 2}`, r[i], c.kind)).join("")}</row>`).join("");
  const lastCol = xlsxColName(columns.length - 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join("")}</cols>
<sheetData>${head}${body}</sheetData>
<autoFilter ref="A1:${lastCol}${Math.max(1, rows.length + 1)}"/>
</worksheet>`;
}
function buildXlsxFiles(sheetName, sheetXml) {
  const safeName = xlsxEscape(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${safeName.replace(/'/g, "''")}'!$A$1:$A$1</definedName></definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd mmm yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1B2A41"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    "xl/worksheets/sheet1.xml": sheetXml,
  };
}
// Minimal zip writer (files stored uncompressed — Excel reads that fine).
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
// What goes in each log's spreadsheet: one row per entry (removed entries
// left out), oldest first, within the chosen dates.
const EXPORT_LOGS = {
  discipline: { title: "Grooming Log" },
  suspension: { title: "Suspension Log" },
  timeOut: { title: "Time Out Log" },
  pm: { title: "Parent Meet Log" },
};
function exportLogTable(kind, from, to) {
  const inRange = (d) => d && d >= from && d <= to;
  const byDate = (f) => (a, b) => (f(a) || "").localeCompare(f(b) || "");
  const D = XLSX_DATE;
  if (kind === "discipline") {
    const cols = [{ label: "Date", kind: D, width: 13 }, { label: "Student", width: 24 }, { label: "Class", width: 8 }, { label: "Issues", width: 40 }, { label: "Status", width: 12 }, { label: "Follow-up notes", width: 50 }, { label: "Logged by", width: 18 }];
    const rows = state.incidents.filter((i) => !i.deleted && inRange(i.date)).sort(byDate((i) => i.date)).map((it) => {
      const legacy = !Array.isArray(it.issues);
      const issues = legacy ? (it.issue || "") : it.issues.map((x) => `${groomingIssueLabel(x)} — ${WARNING_STAGE_LABEL[x.stage] || ""}${x.resolved ? " (Resolved)" : ""}`).join("\n");
      const status = legacy ? (STATUS_TEXT[it.status] || it.status || "") : (groomingEntryResolved(it) ? "Resolved" : "In Progress");
      return [it.date, it.studentName, it.studentClass || "", issues, status, formatFollowUpsForSheet(it.issues), it.loggedBy || ""];
    });
    return { cols, rows };
  }
  if (kind === "suspension" || kind === "timeOut") {
    const isTo = kind === "timeOut";
    const list = isTo ? state.timeOuts : state.suspensions;
    const cols = [{ label: "Start date", kind: D, width: 13 }, { label: "Student", width: 24 }, { label: "Class", width: 8 },
      ...(isTo ? [{ label: "Time Out type", width: 26 }] : []),
      { label: "Reason", width: 34 }, { label: "Total days", width: 10 }, { label: "In-school days", width: 13 }, { label: "Out-of-school days", width: 16 }, { label: "Day by day", width: 46 }, { label: "Logged by", width: 18 }];
    const rows = list.filter((x) => !x.deleted && inRange(x.startDate)).sort(byDate((x) => x.startDate)).map((x) => [
      x.startDate, x.studentName, x.studentClass || "", ...(isTo ? [toTypeLabel(x.toType)] : []),
      x.reason || (Array.isArray(x.reasons) ? x.reasons.join("; ") : ""),
      Number(x.totalDays) || suspensionDayEntries(x).length, Number(x.issDays) || 0, Number(x.ossDays) || 0,
      formatScheduleForSheet(suspensionDayEntries(x)), x.loggedBy || "",
    ]);
    return { cols, rows };
  }
  const cols = [{ label: "Date", kind: D, width: 13 }, { label: "Time", width: 14 }, { label: "Location", width: 18 }, { label: "Student", width: 24 }, { label: "Class", width: 8 }, { label: "Attendees", width: 30 }, { label: "Reason", width: 36 }, { label: "Status", width: 30 }, { label: "Logged by", width: 18 }];
  const rows = state.parentMeetings.filter((m) => !m.deleted && inRange(m.date || pmDate(m))).sort(byDate((m) => m.date)).map((m) => {
    const status = m.pmStatus === "Cancelled" ? "Cancelled"
      : m.pmStatus === "Postponed" ? (m.postponedTo ? `Postponed to ${formatDate(m.postponedTo)}${m.postponedTime ? `, ${pmSlotLabel(m.postponedTime, m.postponedEndTime, m.postponedLocation)}` : ""}` : "Postponed (new date not set)")
      : "Scheduled";
    return [m.date, formatTimeRange(m.time, m.endTime) || "", m.location || "", m.studentName, m.studentClass || "", formatAttendeesForSheet(m.attendees, m.othersText), pmReasonLines(m).join("\n"), status, m.loggedBy || ""];
  });
  return { cols, rows };
}
function downloadLogExcel(kind, from, to) {
  const { cols, rows } = exportLogTable(kind, from, to);
  const title = EXPORT_LOGS[kind].title;
  const blob = buildZip(buildXlsxFiles(title, buildXlsxSheetXml(cols, rows)));
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title} ${from} to ${to}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return rows.length;
}
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>`;
// Right-aligned "Download Excel" button on each log tab.
function renderExportButton(kind) {
  return `<div class="dd-export-row"><button type="button" class="dd-print-btn" data-action="open-export" data-kind="${kind}">${ICON_DOWNLOAD}<span>Download Excel</span></button></div>`;
}
function renderExportModal() {
  const ex = state.exportDraft;
  const count = exportLogTable(ex.kind, ex.from, ex.to).rows.length;
  return `
    <div class="dd-modal-backdrop" id="export-backdrop">
      <div class="dd-modal" id="export-modal">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Download ${EXPORT_LOGS[ex.kind].title}</div>
          <button type="button" class="dd-modal-close" id="export-close">✕</button>
        </div>
        <label class="dd-label" style="margin-top:0">From</label>
        ${renderDateField("export-from", ex.from)}
        <label class="dd-label">To</label>
        ${renderDateField("export-to", ex.to, `min="${ex.from}"`)}
        <div class="dd-mono-muted dd-custom-hint">${count} ${count === 1 ? "entry" : "entries"} in these dates. Removed entries aren't included.</div>
        <button class="dd-btn-primary" type="button" id="export-go" ${count ? "" : "disabled"}>Download Excel file</button>
      </div>
    </div>`;
}
function attachExportListeners() {
  document.querySelectorAll('[data-action="open-export"]').forEach((el) => el.addEventListener("click", () => {
    const y = new Date().getFullYear();
    state.exportDraft = { kind: el.dataset.kind, from: `${y}-01-01`, to: todayISO() };
    render();
  }));
  if (!state.exportDraft) return;
  const close = () => { state.exportDraft = null; render(); };
  const x = document.getElementById("export-close"); if (x) x.addEventListener("click", close);
  const bd = document.getElementById("export-backdrop"); if (bd) bd.addEventListener("click", (e) => { if (e.target.id === "export-backdrop") close(); });
  const f = document.getElementById("export-from"), t = document.getElementById("export-to");
  if (f) f.addEventListener("change", () => { if (f.value) { state.exportDraft.from = f.value; if (state.exportDraft.to < f.value) state.exportDraft.to = f.value; } renderKeepingModalScroll(); });
  if (t) t.addEventListener("change", () => { if (t.value) state.exportDraft.to = t.value < state.exportDraft.from ? state.exportDraft.from : t.value; renderKeepingModalScroll(); });
  const go = document.getElementById("export-go");
  if (go) go.addEventListener("click", () => { const ex = state.exportDraft; downloadLogExcel(ex.kind, ex.from, ex.to); close(); });
}

// ---------- "New version available" bar ----------
// The app checks for a newer release when it opens, whenever it's brought
// back to the front, and every 30 minutes. When one has been downloaded
// and taken over (sw.js installs straight away), a bar offers to reload
// into it — so nobody sits on an old version without knowing.
function watchForAppUpdates() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller; // first-ever visit: nothing to update from
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || state.updateReady) return;
    state.updateReady = true;
    render();
  });
  const check = () => navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") check(); });
  window.addEventListener("focus", check);
  setInterval(check, 30 * 60 * 1000);
  setTimeout(check, 4000);
}
function renderUpdateBar() {
  return `
    <div class="dd-update-bar" role="status">
      <span>A new version of Discipline Diary is ready.</span>
      <button type="button" id="btn-app-update">Update</button>
    </div>`;
}
watchForAppUpdates();

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
// resumes. Any other duration is added as calendar days, and a deadline
// that lands on a weekend, holiday or the student's HBL/closure day moves
// to the next school day.
function computeGroomingDeadline(cfg, stage, catchDate, level) {
  let d = cfg.days[stage - 1] === 4 ? strictNextWeekday(catchDate, 1) : addDays(catchDate, cfg.days[stage - 1]);
  while (isNonSchoolDay(d, level)) d = nextSchoolDay(d, level);
  return d;
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
// The Resolved button stays visible afterwards in a pressed/selected state,
// so tapping it again un-resolves — see unresolveGroomingIssue below.
function resolveGroomingIssue(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  const before = JSON.parse(JSON.stringify(entry.issues));
  issue.resolved = true;
  issue.resolvedAt = todayISO();
  issue.history.push({ stage: issue.stage, action: "Resolved", at: todayISO(), by: teacherName() });
  saveIncidentIssueUpdate(entry, before);
}
// Tapping the (now pressed) Resolved button again un-resolves the issue,
// putting it back at its current stage exactly as it was — this is the
// Resolved button acting as its own undo, so there's no separate Undo
// control for it.
function unresolveGroomingIssue(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue || !issue.resolved) return;
  const before = JSON.parse(JSON.stringify(entry.issues));
  issue.resolved = false;
  issue.resolvedAt = null;
  if (issue.history[issue.history.length - 1]?.action === "Resolved") issue.history.pop();
  saveIncidentIssueUpdate(entry, before);
}
// Escalate one issue to the next warning stage (or, if already at Final,
// re-issue Final with a fresh deadline — SH/SM keeps calling until it's
// resolved, there's no stage beyond Final). Escalating always carries a
// follow-up note (required — the UI won't call this without one) explaining
// what happened at the stage being left; it's stored on the transition
// entry itself so the now-completed stage can show it read-only.
function escalateGroomingIssue(entryId, issueId, note) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  const cfg = GROOMING_ISSUE_CONFIG[issue.type] || GROOMING_ISSUE_CONFIG.Others;
  const today = todayISO();
  const nextStage = Math.min(issue.stage + 1, 3);
  const before = JSON.parse(JSON.stringify(entry.issues));
  issue.stage = nextStage;
  issue.deadline = computeGroomingDeadline(cfg, nextStage, today, classLevel(entry.studentClass));
  issue.overriddenBy = null;
  if (cfg.parentFrom <= nextStage) issue.parentContacted = true;
  issue.history.push({ stage: nextStage, deadline: issue.deadline, action: `${WARNING_STAGE_LABEL[nextStage]} issued`, at: today, note: (note || "").trim(), by: teacherName() });
  saveIncidentIssueUpdate(entry, before);
}
// The due date a stage actually had while it was active: the deadline on
// the last history entry logged for that stage (an override made while at
// that stage moves this forward, same as it always did for the current one).
function issueStageDueDate(issue, stage) {
  const entries = (issue.history || []).filter((h) => h.stage === stage && h.deadline);
  return entries.length ? entries[entries.length - 1].deadline : null;
}
// The follow-up note written when escalating INTO a stage (i.e. explaining
// why the stage before it was left) — undefined if there isn't one (stage 1
// was never escalated into, and older entries predate this feature).
function issueEscalationNote(issue, intoStage) {
  return (issue.history || []).find((h) => h.stage === intoStage && /Warning issued/.test(h.action) && h.note) || null;
}
// A student/parent can propose their own date instead of the computed
// deadline — this fully replaces it, no limit on how many times.
function overrideGroomingIssueDeadline(entryId, issueId, newDate) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  const before = JSON.parse(JSON.stringify(entry.issues));
  issue.deadline = newDate;
  issue.history.push({ stage: issue.stage, deadline: newDate, action: `Deadline moved to ${formatDate(newDate)}`, at: todayISO() });
  saveIncidentIssueUpdate(entry, before);
}
// Edits the follow-up note written when escalating into a stage (the note
// shown on that now-completed stage's read-only card) — the stage
// transition itself (which stage, its deadline) isn't editable, only the
// note text, and the edit is logged as "Edited by <name>" under the
// original "Logged by" line.
function editEscalationNote(entryId, issueId, intoStage, newNote) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue) return;
  const target = issue.history.find((h) => h.stage === intoStage && /Warning issued/.test(h.action));
  if (!target) return;
  const before = JSON.parse(JSON.stringify(entry.issues));
  target.note = (newNote || "").trim();
  target.editedAt = Date.now();
  target.editedBy = teacherName();
  saveIncidentIssueUpdate(entry, before);
}
// Reverses the most recent escalation — reached from the same pencil used
// to edit that stage's note, not a separate control. Only walks back one
// step (to the stage right before the current one), and only while the
// issue isn't resolved; drops the note along with the stage transition
// itself, restoring the earlier stage's own due date.
function unescalateGroomingIssue(entryId, issueId) {
  const entry = state.incidents.find((i) => i.id === entryId);
  if (!entry) return;
  const issue = (entry.issues || []).find((x) => x.id === issueId);
  if (!issue || issue.resolved || issue.stage <= 1) return;
  const before = JSON.parse(JSON.stringify(entry.issues));
  const prevStage = issue.stage - 1;
  for (let i = issue.history.length - 1; i >= 0; i--) {
    if (issue.history[i].stage === issue.stage && /Warning issued/.test(issue.history[i].action)) { issue.history.splice(i, 1); break; }
  }
  issue.stage = prevStage;
  issue.deadline = issueStageDueDate(issue, prevStage) || issue.deadline;
  saveIncidentIssueUpdate(entry, before);
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
// Resolve/Escalate/override-deadline/undo all mutate `entry.issues` in
// place, optimistically, before this save even starts — so the card
// already shows "Resolved", the next stage, etc. If the write then fails,
// showing the error banner alone isn't enough: without also putting
// `entry.issues` back the way it was, the card keeps showing the change as
// if it had gone through, and only a reload would reveal it never saved.
// `issuesBefore` is that pre-mutation snapshot, restored on failure.
async function saveIncidentIssueUpdate(entry, issuesBefore) {
  state.saving = true; render();
  try {
    await updateDoc(doc(db, "incidents", entry.id), { issues: entry.issues });
    syncIncidentToSheet(entry);
  } catch (err) {
    state.saveError = true; state.saveErrorDetail = err?.message || String(err);
    if (issuesBefore) entry.issues = issuesBefore;
  }
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
  queueStudentLinkCheck(name, studentClass, date);
  const docRef = await addDoc(collection(db, "incidents"), {
    studentName: name, studentClass, date, issues,
    linkedSuspensionIds: (links?.suspensionIds || []).slice(),
    linkedTimeOutIds: (links?.timeOutIds || []).slice(),
    linkedPmIds: (links?.pmIds || []).slice(),
    loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
    history: [{ id: uid(), type: "created", detail: `Entry created — ${issueSummary}`, by: teacherName(), at: now }],
  });
  syncIncidentToSheet({ id: docRef.id, studentName: name, studentClass, date, issue: issueSummary, actionTaken: "", status: "Monitoring", loggedBy: teacherName(), deleted: false });
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
      // the batch — one bad row shouldn't block the rest, but a row that
      // fails needs to be SEEN failing rather than silently dropped, since
      // the teacher has no other way to notice that student never got an
      // entry.
      const failedExtraStudents = [];
      for (const s of extraStudents) {
        try { await createIncidentDocForStudent(s.name, s.studentClass, date, selectedIssues, d.othersText, Date.now()); }
        catch (err) { failedExtraStudents.push(s.name); }
      }
      if (failedExtraStudents.length) {
        state.saveError = true;
        state.saveErrorDetail = `Saved for ${studentName}, but couldn't save for ${failedExtraStudents.join(", ")} — log ${failedExtraStudents.length === 1 ? "them" : "those"} separately.`;
      }
      state.showNewForm = false;
      state._newIncidentDraft = null;
      state.section = "log";
      state.disciplineFilter = "all";
      state.selectedIncidentId = docRef.id;
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
      ? `${dupNames[0]} already has a grooming entry on ${formatDate(date)}. Log another anyway?`
      : `${dupNames.join(", ")} already have a grooming entry on ${formatDate(date)}. Log anyway for all of them?`;
    if (guardDuplicate(true, message, doSave)) return;
  }
  await doSave();
}
// Tapping Escalate no longer escalates immediately — it toggles into a
// "selected" state that swaps that issue's Escalate button + Resolved
// button for a note input + tick, so the follow-up note is captured as
// part of the escalation itself (item 13). Tapping the (now selected)
// Escalate button again backs out, discarding the draft note — this is the
// button acting as its own cancel, so there's no separate Cancel control.
function startEscalateIssue(entryId, issueId) {
  if (state.escalatingIssue && state.escalatingIssue.issueId === issueId) {
    delete state.escalateNoteDraft[issueId];
    state.escalatingIssue = null;
    state.escalateNoteError = null;
  } else {
    state.escalatingIssue = { entryId, issueId };
    state.escalateNoteError = null;
  }
  render();
}
function confirmEscalateIssue() {
  const target = state.escalatingIssue;
  if (!target) return;
  const note = (state.escalateNoteDraft[target.issueId] || "").trim();
  if (!note) { state.escalateNoteError = target.issueId; render(); return; }
  escalateGroomingIssue(target.entryId, target.issueId, note);
  delete state.escalateNoteDraft[target.issueId];
  state.escalatingIssue = null;
  state.escalateNoteError = null;
  render();
}
// Editing a completed stage's follow-up note — its own small note-input +
// tick flow, separate from the escalating-issue state above (a teacher
// could in principle be escalating the current stage while also fixing a
// typo in an older stage's note).
function startEditEscalationNote(entryId, issueId, stage, currentNote) {
  state.editingEscalationNote = { entryId, issueId, stage };
  state.escalateNoteEditDraft[`${issueId}_${stage}`] = currentNote || "";
  state.escalateNoteEditError = null;
  render();
}
function cancelEditEscalationNote() {
  state.editingEscalationNote = null;
  state.escalateNoteEditError = null;
  render();
}
function confirmEditEscalationNote() {
  const target = state.editingEscalationNote;
  if (!target) return;
  const key = `${target.issueId}_${target.stage}`;
  const note = (state.escalateNoteEditDraft[key] || "").trim();
  if (!note) { state.escalateNoteEditError = key; render(); return; }
  editEscalationNote(target.entryId, target.issueId, target.stage, note);
  state.editingEscalationNote = null;
  state.escalateNoteEditError = null;
  render();
}
function unescalateIssueFromEdit(entryId, issueId) {
  unescalateGroomingIssue(entryId, issueId);
  state.editingEscalationNote = null;
  state.escalateNoteEditError = null;
  render();
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
    // The trash copy (see trashRecord) is now stale — mark it restored so
    // "Recently Deleted" doesn't also offer to restore something that's
    // already back.
    markTrashRestored(t.collectionName, t.id).catch(() => {});
  }
  catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  render();
}
// Writes a full copy of a record to the deletedItems trash collection just
// before it's deleted. This is independent of both the 5-second undo toast
// (in-memory, gone on reload) and the rolling backup snapshot (rewritten
// from live data ~1.5s after any change, so a deleted record drops out of
// it immediately) — it's the only copy that survives past those two.
async function trashRecord(collectionName, id, entry) {
  const { id: _drop, ...data } = entry;
  try {
    await setDoc(doc(db, "deletedItems", `${collectionName}_${id}`), {
      collectionName, docId: id, data,
      deletedAt: Date.now(), deletedBy: teacherName(),
      restoredAt: null,
    });
  } catch (e) {
    // deletedItems is a new collection — until firestore.rules is
    // republished, writes to it are denied. Deleting must still work as
    // it always has rather than being blocked on that redeploy, so this
    // failure is swallowed (not re-thrown): the record just won't be
    // recoverable from Settings → Recently Deleted until the rules land.
    console.warn("trashRecord failed (firestore.rules for deletedItems not yet published?):", e);
  }
}
// Marks a trash copy restored (rather than deleting it — Firestore rules
// only let Admins/Owner delete deletedItems docs) once its record is back
// in its live collection, whether that happened via the 5-second undo
// toast or via "Recently Deleted" itself.
async function markTrashRestored(collectionName, id) {
  await updateDoc(doc(db, "deletedItems", `${collectionName}_${id}`), {
    restoredAt: Date.now(), restoredBy: teacherName(),
  });
}
// Restores a record from Settings → Recently Deleted, any time after the
// 5-second undo toast has gone — recreates the original document (with its
// original id, so anything that still refers to it keeps working) and
// marks the trash copy restored.
async function restoreDeletedItem(trashId) {
  const item = (state.deletedItems || []).find((d) => d.id === trashId);
  if (!item || item.restoredAt) return;
  state.trashRestoringId = trashId;
  render();
  try {
    await setDoc(doc(db, item.collectionName, item.docId), item.data);
    await markTrashRestored(item.collectionName, item.docId);
    const restored = { ...item.data, id: item.docId, deleted: false };
    if (item.collectionName === "incidents") syncIncidentToSheet(restored);
    else if (item.collectionName === "suspensions") syncSuspensionToSheet(restored);
    else if (item.collectionName === "timeOuts") syncTimeOutToSheet(restored);
    else if (item.collectionName === "parentMeetings") syncParentMeetingToSheet(restored);
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); }
  state.trashRestoringId = null;
  render();
}
async function deleteIncident(id) {
  const entry = state.incidents.find((i) => i.id === id);
  try {
    if (entry) await trashRecord("incidents", id, entry);
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
    studentName: "", studentClass: "", reasons: [], reasonOthersText: "", startDate: firstSchoolDayFrom(todayISO(), null), autoStart: true,
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [], issOverridden: [], issVenues: {},
    tagPm: false, pmAttendees: [], pmOthersText: "",
    pmReasons: [], pmReasonStatuses: {}, pmReasonOthersText: "",
    pmTime: "", pmEndTime: "", pmLocation: "",
  };
}
// OSS dates are chosen (default to the earliest school days from the start
// date, each individually overridable via a calendar icon). ISS dates are
// *auto-derived* by default — whichever of the suspension's total school
// days aren't used for OSS — but any individual ISS day can also be
// manually overridden via its own calendar icon (tracked in
// d.issOverridden by slot index); an overridden slot keeps its date across
// further recalculation, while every other slot keeps auto-deriving.
// A new start date or class re-lays every day from the new start (for the
// new class's school days), dropping any hand-picked dates, so no
// out-of-school or in-school day is left behind on the old dates.
// The first school day on or after `iso` for this level (today, if today
// is one) — the default start date for a new suspension or time out.
function firstSchoolDayFrom(iso, level) {
  return isNonSchoolDay(iso, level) ? nextSchoolDay(iso, level) : iso;
}
// Class chosen or changed: the default start (not one the teacher picked)
// moves off a non-school day for the new level, and the days are laid out
// again only when the level actually changed (a class fix within the same
// level keeps rooms and dates).
function onSuspClassChange(d, newClass, isTimeOut) {
  const oldLevel = classLevel(d.studentClass);
  d.studentClass = newClass;
  const level = classLevel(newClass);
  // Only the automatic default start moves; a date the teacher picked stays.
  const movedStart = d.autoStart && d.startDate && isNonSchoolDay(d.startDate, level);
  if (movedStart) d.startDate = nextSchoolDay(d.startDate, level);
  if (movedStart || oldLevel !== level) resetSuspDays(d);
  if (isTimeOut) regenerateTimeOutDates(d); else regenerateSuspDates(d);
}
function resetSuspDays(d) {
  d.ossDates = [];
  d.issDates = [];
  d.issOverridden = [];
  return d;
}
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
// Re-checks every in-school day's booked location still has room, the same
// way a tagged Parent Meet's room/time is re-checked at save (slotError) —
// the picker only guards against picking a full room at the moment it's
// picked, so a room filled by someone else afterwards, or a form left open
// for a while, went to save unchecked. `excludeSuspensionId` is this
// suspension's own id when editing (so its own existing days don't
// self-block), or null for a new one.
function issRoomBookingError(issDates, issVenues, excludeSuspensionId) {
  for (const dt of issDates) {
    const venue = issVenues[dt];
    if (!venue) continue;
    const row = locationOccupancyForDate(dt, excludeSuspensionId).find((o) => o.location === venue);
    if (row && row.remaining <= 0) {
      return `${venue} is now full on ${formatDate(dt)} (booked by ${row.occupants.join(", ")}) — pick another location or day.`;
    }
  }
  return "";
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
  const issRoomErr = issRoomBookingError(d.issDates, d.issVenues, null);
  if (issRoomErr) {
    state.suspFormError = issRoomErr;
    render();
    return;
  }
  const pmReasonData = d.tagPm ? composePmReasonData(d, "pm") : { reasons: [], reason: "" };
  if (d.tagPm && (d.pmAttendees.length === 0 || pmReasonData.reasons.length === 0)) {
    state.suspFormError = "Fill in who's attending and the reason for the tagged parent meeting.";
    render();
    return;
  }
  if (d.tagPm && slotError("susp-pm", true)) {
    state.suspFormError = slotError("susp-pm", true);
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
    // A duplicate-booking confirm dialog can sit open for a while before the
    // teacher answers it, so the room/slot check done above (right after
    // typing) can be stale by the time this actually runs. Re-check against
    // the latest bookings right before saving, not just before the prompt.
    const finalIssErr = issRoomBookingError(d.issDates, d.issVenues, null);
    if (finalIssErr) { state.saveError = true; state.saveErrorDetail = finalIssErr; render(); return; }
    if (d.tagPm) {
      const finalPmErr = slotError("susp-pm", true);
      if (finalPmErr) { state.saveError = true; state.saveErrorDetail = finalPmErr; render(); return; }
    }
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      queueStudentLinkCheck(studentName, studentClass, d.startDate);
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
            studentName, studentClass, date: d.startDate, time: d.pmTime, endTime: d.pmEndTime, location: d.pmLocation, attendees: d.pmAttendees.slice(),
            othersText: d.pmOthersText || "", reason: pmReasonData.reason, reasons: pmReasonData.reasons,
            linkedSuspensionIds: [docRef.id],
            loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
            history: [{ id: uid(), type: "created", detail: "Parent meeting tagged from a suspension entry", by: teacherName(), at: now }],
          });
          await updateDoc(doc(db, "suspensions", docRef.id), { linkedPmIds: arrayUnion(pmRef.id) });
          syncParentMeetingToSheet({ id: pmRef.id, studentName, studentClass, date: d.startDate, time: d.pmTime, endTime: d.pmEndTime, location: d.pmLocation, attendees: d.pmAttendees, othersText: d.pmOthersText || "", reason: pmReasonData.reason, loggedBy: teacherName(), deleted: false });
        } catch (err) {
          // The suspension itself is already saved, so this doesn't roll
          // that back or re-throw — but silently swallowing it left the
          // teacher believing the tagged meeting was logged when it
          // wasn't. Surface it as a save error (shown once the form below
          // closes) so they know to log the parent meeting separately.
          state.saveError = true;
          state.saveErrorDetail = `Suspension saved, but the tagged parent meeting couldn't be saved — log it separately. (${err?.message || String(err)})`;
        }
      }
      state.showNewSuspForm = false;
      state._suspDraft = null;
      state.section = "suspensions";
      state.suspTab = "All";
      state.selectedSuspId = docRef.id;
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
    if (entry) await trashRecord("suspensions", id, entry);
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
  const issRoomErr = issRoomBookingError(d.issDates, d.issVenues, id);
  if (issRoomErr) {
    state.suspFormError = issRoomErr;
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
    // Re-check the booked room(s) right before saving — a duplicate-booking
    // prompt (below) can sit open for a while before it's answered, and the
    // check done above can be stale by then.
    const finalIssErr = issRoomBookingError(d.issDates, d.issVenues, id);
    if (finalIssErr) { state.saveError = true; state.saveErrorDetail = finalIssErr; render(); return; }
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
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
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
// has the same shape (total/ISS/OSS days, per-day entries, reasons,
// optional tagged parent meeting); in-school days take a free-text
// location and supervising administrator instead of a booked room. That means the pure record helpers — suspensionDayEntries,
// suspensionDateRange, suspensionStatus, regenerateSuspDates — work on it
// unchanged and are shared rather than duplicated. Everything tied to the
// collection, state, or wording lives here, so the two logs can diverge
// independently later.
function freshTimeOutDraft() {
  return {
    studentName: "", studentClass: "", reasons: [], reasonOthersText: "", startDate: firstSchoolDayFrom(todayISO(), null), autoStart: true,
    toType: "Recess",
    totalDays: null, issDays: 0, ossDays: 0,
    ossDates: [], issDates: [], issOverridden: [], issVenues: {}, issAdministrators: {},
    tagPm: false, pmAttendees: [], pmOthersText: "",
    pmReasons: [], pmReasonStatuses: {}, pmReasonOthersText: "",
    pmTime: "", pmEndTime: "", pmLocation: "",
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
  if (d.tagPm && slotError("to-pm", true)) {
    state.toFormError = slotError("to-pm", true);
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
    // Same reasoning as Suspension: the duplicate-booking prompt below can
    // be left open a while, so re-check the tagged meeting's room right
    // before saving rather than trusting the earlier check.
    if (d.tagPm) {
      const finalPmErr = slotError("to-pm", true);
      if (finalPmErr) { state.saveError = true; state.saveErrorDetail = finalPmErr; render(); return; }
    }
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      queueStudentLinkCheck(studentName, studentClass, d.startDate);
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
            studentName, studentClass, date: d.startDate, time: d.pmTime, endTime: d.pmEndTime, location: d.pmLocation, attendees: d.pmAttendees.slice(),
            othersText: d.pmOthersText || "", reason: pmReasonData.reason, reasons: pmReasonData.reasons,
            linkedTimeOutIds: [docRef.id],
            loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
            history: [{ id: uid(), type: "created", detail: "Parent meeting tagged from a time out entry", by: teacherName(), at: now }],
          });
          await updateDoc(doc(db, "timeOuts", docRef.id), { linkedPmIds: arrayUnion(pmRef.id) });
          syncParentMeetingToSheet({ id: pmRef.id, studentName, studentClass, date: d.startDate, time: d.pmTime, endTime: d.pmEndTime, location: d.pmLocation, attendees: d.pmAttendees, othersText: d.pmOthersText || "", reason: pmReasonData.reason, loggedBy: teacherName(), deleted: false });
        } catch (err) {
          // The time out itself is already saved — this doesn't roll that
          // back — but silently swallowing it left the teacher believing
          // the tagged meeting was logged when it wasn't.
          state.saveError = true;
          state.saveErrorDetail = `Time out saved, but the tagged parent meeting couldn't be saved — log it separately. (${err?.message || String(err)})`;
        }
      }
      state.showNewToForm = false;
      state._toDraft = null;
      state.section = "timeOuts";
      state.toTab = "All";
      state.selectedToId = docRef.id;
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
    if (entry) await trashRecord("timeOuts", id, entry);
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
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
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
    time: m?.time || "", endTime: m?.endTime || "", location: m?.location || "",
    postponedTo: m?.postponedTo || "",
    postponedTime: m?.postponedTime || "", postponedEndTime: m?.postponedEndTime || "", postponedLocation: m?.postponedLocation || "",
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
  const pmStatus = "Scheduled"; // new meetings are always scheduled
  const postponedTo = pmStatus === "Postponed" ? (state._pmDraft.postponedTo || "") : "";
  const dd = state._pmDraft;
  const slotFields = pmStatus === "Scheduled" ? { time: dd.time || "", endTime: dd.endTime || "", location: dd.location || "" } : { time: "", endTime: "", location: "" };
  const postponedSlot = postponedTo ? { postponedTime: dd.postponedTime || "", postponedEndTime: dd.postponedEndTime || "", postponedLocation: dd.postponedLocation || "" } : { postponedTime: "", postponedEndTime: "", postponedLocation: "" };
  const slotProblem = pmStatus === "Scheduled" ? slotError("pm", true) : postponedTo ? postponedDraftError(dd, null) : "";
  if (studentName && studentClass && date && slotProblem) {
    state.pmFormError = slotProblem;
    render();
    return;
  }
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
    // The duplicate-meeting prompt below can sit open for a while before
    // it's answered, so re-check the room/slot right before saving — the
    // check done above (right after typing) can be stale by then.
    const finalSlotErr = pmStatus === "Scheduled" ? slotError("pm", true) : postponedTo ? postponedDraftError(dd, null) : "";
    if (finalSlotErr) { state.saveError = true; state.saveErrorDetail = finalSlotErr; render(); return; }
    state.saveError = false;
    state.saving = true;
    render();
    try {
      const now = Date.now();
      const attendeeSummaryStr = attendees.map((a) => a === "Others" && othersText ? `Others (${othersText})` : a).join(", ");
      queueStudentLinkCheck(studentName, studentClass, postponedTo || date);
      const docRef = await addDoc(collection(db, "parentMeetings"), {
        studentName, studentClass, date, reason, reasons, attendees, othersText, pmStatus, postponedTo, ...slotFields, ...postponedSlot,
        loggedBy: teacherName(), loggedByUid: auth.currentUser?.uid || null, createdAt: now,
        history: [{ id: uid(), type: "created", detail: `Meeting logged — ${slotFields.time ? `${pmSlotLabel(slotFields.time, slotFields.endTime, slotFields.location)}, ` : ""}attendees: ${attendeeSummaryStr}${pmStatus !== "Scheduled" ? ` (${pmStatus}${postponedTo ? ` to ${formatDate(postponedTo)}` : ""})` : ""}`, by: teacherName(), at: now }],
      });
      state.showNewPmForm = false;
      state._pmDraft = null;
      state.section = "parentMeetings";
      state.pmTab = "All";
      state.selectedPmId = docRef.id;
      syncParentMeetingToSheet({ id: docRef.id, studentName, studentClass, date, reason, attendees, othersText, pmStatus, postponedTo, ...slotFields, ...postponedSlot, loggedBy: teacherName(), deleted: false });
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
  };

  const dup = findDuplicateParentMeeting(studentName, studentClass, date);
  if (guardDuplicate(dup, `${studentName} already has a parent meeting on ${formatDate(date)} (logged by ${dup?.loggedBy || "another teacher"}). Log another anyway?`, doSave)) return;
  await doSave();
}
function openEditParentMeeting(id) {
  const m = state.parentMeetings.find((i) => i.id === id);
  if (!m) return;
  state.pmQuickError = null;
  state.editingPmId = id;
  state._pmDraft = freshPmDraft(m);
  state.pmFormError = "";
  render();
}
// Re-checks a postponed meeting's new slot (set via the picker) at save time.
function postponedDraftError(d, excludeId) {
  if (!d.postponedTo) return "";
  if (!d.postponedTime || !d.postponedEndTime || !d.postponedLocation) return "Set the postponed meeting's time and location (tap the calendar next to \"Postponed to\").";
  const clash = roomClash(d.postponedLocation, d.postponedTo, d.postponedTime, d.postponedEndTime, excludeId);
  if (!clash) return "";
  const cb = pmBooking(clash);
  return `${d.postponedLocation} is already booked ${formatTimeRange(cb.start, cb.end)} on ${formatDate(d.postponedTo)} (${clash.studentName}). Pick another time or room for the postponed meeting.`;
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
  const dd = state._pmDraft;
  Object.assign(updated, {
    time: dd.time || "", endTime: dd.endTime || "", location: dd.location || "",
    postponedTime: updated.postponedTo ? (dd.postponedTime || "") : "",
    postponedEndTime: updated.postponedTo ? (dd.postponedEndTime || "") : "",
    postponedLocation: updated.postponedTo ? (dd.postponedLocation || "") : "",
  });
  // Time and room are required for a scheduled meeting that's today or later
  // (older meetings logged before this field existed can be left blank).
  const slotProblem = updated.pmStatus === "Scheduled" ? slotError("pm", updated.date >= todayISO())
    : updated.postponedTo ? postponedDraftError(dd, id) : "";
  if (slotProblem) { state.pmFormError = slotProblem; render(); return; }
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
    { key: "time", label: "Start time" }, { key: "endTime", label: "End time" }, { key: "location", label: "Location" },
  ]);
  if (JSON.stringify((m.attendees || []).slice().sort()) !== JSON.stringify(updated.attendees.slice().sort())) changes.push("Attendees updated");
  const oldPp = [m.postponedTo || "", m.postponedTime || "", m.postponedEndTime || "", m.postponedLocation || ""].join("|");
  const newPp = [updated.postponedTo, updated.postponedTime, updated.postponedEndTime, updated.postponedLocation].join("|");
  if (oldPp !== newPp) changes.push(updated.postponedTo ? `Postponed meeting set to ${formatDate(updated.postponedTo)}, ${pmSlotLabel(updated.postponedTime, updated.postponedEndTime, updated.postponedLocation)}` : "Postponed meeting date cleared");
  if (changes.length === 0) { state.editingPmId = null; state._pmDraft = null; render(); return; }

  const doSave = async () => {
    // Same reasoning as the other logs: the duplicate-meeting prompt below
    // can sit open a while, so re-check the room/slot right before saving.
    const finalSlotErr = updated.pmStatus === "Scheduled" ? slotError("pm", updated.date >= todayISO())
      : updated.postponedTo ? postponedDraftError(dd, id) : "";
    if (finalSlotErr) { state.saveError = true; state.saveErrorDetail = finalSlotErr; render(); return; }
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
    } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); } finally { state.saving = false; render(); }
  };

  // Only worth flagging when the edit actually moves who/when this
  // meeting is for — editing just the reason or attendees shouldn't
  // re-trigger this on every save.
  // Uses the date the meeting actually happens on, so setting or moving a
  // "Postponed to" date onto another meeting's day is caught too.
  const newOn = { ...m, ...updated };
  const identityChanged = updated.studentName !== m.studentName || updated.studentClass !== m.studentClass || pmDate(newOn) !== pmDate(m) || isPmCounted(newOn) !== isPmCounted(m);
  if (identityChanged && isPmCounted(newOn)) {
    const dup = findDuplicateParentMeeting(updated.studentName, updated.studentClass, pmDate(newOn), id);
    if (guardDuplicate(dup, `${updated.studentName} already has a parent meeting on ${formatDate(pmDate(newOn))} (logged by ${dup?.loggedBy || "another teacher"}). Save anyway?`, doSave)) return;
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
  // Going back to Scheduled takes the original time and room again, so
  // make sure nobody else has booked that slot in the meantime.
  if (next === "Scheduled") {
    const clash = roomClash(m.location, m.date, m.time, m.endTime, m.id);
    if (clash) {
      state.pmQuickError = { id, message: `Can't set back to scheduled: the ${m.location} is already booked at ${formatTimeRange(pmBooking(clash).start, pmBooking(clash).end)} on ${formatDate(m.date)} (${clash.studentName || "another meeting"}). Tap Edit entry to choose another time or room.` };
      render();
      return;
    }
  }
  state.pmQuickError = null;
  const now = Date.now();
  state.saveError = false;
  render();
  // The postponed-to date only means something while the meeting is
  // Postponed, so it's cleared when the status moves away from that.
  const patch = { pmStatus: next };
  if (next !== "Postponed" && (m.postponedTo || m.postponedTime || m.postponedLocation)) Object.assign(patch, { postponedTo: "", postponedTime: "", postponedEndTime: "", postponedLocation: "" });
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
async function setPmPostponedDate(id, date, slot) {
  const m = state.parentMeetings.find((x) => x.id === id);
  if (!m || m.deleted || m.pmStatus !== "Postponed") return;
  date = date || "";
  const sl = date ? (slot || {}) : {};
  const patch = { postponedTo: date, postponedTime: sl.time || "", postponedEndTime: sl.endTime || "", postponedLocation: sl.location || "" };
  if ((m.postponedTo || "") === patch.postponedTo && (m.postponedTime || "") === patch.postponedTime && (m.postponedEndTime || "") === patch.postponedEndTime && (m.postponedLocation || "") === patch.postponedLocation) return;
  // Hard booking: re-check against the latest bookings right before saving,
  // in case another teacher took the room while the picker was open.
  if (date) {
    const clash = roomClash(patch.postponedLocation, date, patch.postponedTime, patch.postponedEndTime, id);
    if (clash) {
      const cb = pmBooking(clash);
      state.saveError = true;
      state.saveErrorDetail = `${patch.postponedLocation} was just booked ${formatTimeRange(cb.start, cb.end)} on ${formatDate(date)} (${clash.studentName}) — pick another time or room`;
      render();
      return;
    }
  }
  const now = Date.now();
  state.saveError = false;
  try {
    await updateDoc(doc(db, "parentMeetings", id), {
      ...patch,
      history: arrayUnion({ id: uid(), type: "edited", detail: date ? `Postponed meeting set to ${formatDate(date)}, ${pmSlotLabel(patch.postponedTime, patch.postponedEndTime, patch.postponedLocation)}` : "Postponed meeting date cleared", by: teacherName(), at: now }),
    });
    syncParentMeetingToSheet({ ...m, ...patch });
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}
// "Postponed to" control (log card + Dashboard). Opens the in-app date
// picker rather than the phone's own one: on iPhones the native picker
// fills in today's date the moment it opens, which used to save straight
// away and close the picker. The Dashboard only ever shows meetings with no
// date yet; once set, the meeting leaves that list and changes are made in
// the log.
function renderPostponeDateField(m) {
  return `
    <div class="dd-pm-postpone-row">
      ${m.postponedTo
        ? `<div class="dd-sans dd-fit-line" style="font-size:14px" data-fit="">${formatDate(m.postponedTo)}${m.postponedTime ? ` · ${escapeHtml(pmSlotLabel(m.postponedTime, m.postponedEndTime, m.postponedLocation))}` : ""}</div>`
        : `<div class="dd-mono-muted" style="font-size:12px">Not set yet</div>`}
      <button type="button" class="dd-date-icon-btn" data-pp-open="save" data-id="${m.id}" title="Choose the postponed meeting date">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
      </button>
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
function ppRender() { if (document.querySelector(".dd-modal:not(.dd-pp-modal):not(.dd-tp-modal)")) renderKeepingModalScroll(); else renderKeepingPageScroll(); }
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
  // Editing an existing new date: open on it, with its date, time and room
  // already selected, so the teacher changes from there.
  const src = mode === "draft" ? { t: state._pmDraft.postponedTime, e: state._pmDraft.postponedEndTime, l: state._pmDraft.postponedLocation }
    : (() => { const m = state.parentMeetings.find((x) => x.id === pmId); return { t: m.postponedTime, e: m.postponedEndTime, l: m.postponedLocation }; })();
  state.postponePicker = { mode, context: "pm", pmId: pmId || null, minExclusive: original, selected: current || "", month: start.slice(0, 7),
    time: src.t || "", endTime: src.e || "", location: src.l || "" };
  ppRender();
}
// The same calendar for the ordinary date fields on the Parent Meet,
// Suspension and Time Out forms (in place of the phone's own date picker,
// which can't show holidays). ✓ writes the date into the form's hidden
// date input and fires its usual "change" handling.
function openFieldDatePicker(input) {
  // A grooming issue's follow-up deadline (on the Grooming Log entry card).
  if (input.classList.contains("dd-issue-override-input")) {
    const it = state.incidents.find((x) => x.id === input.dataset.id);
    const current = input.value || "";
    try { document.activeElement?.blur?.(); } catch (e) { /* non-fatal */ }
    state.postponePicker = { mode: "field", context: "grooming", title: "Follow-up deadline",
      selector: `.dd-issue-override-input[data-id="${input.dataset.id}"][data-issue="${input.dataset.issue}"]`,
      level: classLevel(it?.studentClass) || null, minExclusive: "", selected: current, month: (current || todayISO()).slice(0, 7) };
    if (current && pickerDayState(current, state.postponePicker).blocked) state.postponePicker.selected = "";
    ppRender();
    return;
  }
  const form = input.closest("form, #new-form, #edit-form");
  if (!form) return;
  // Keep anything typed on the new grooming form before the re-render.
  if (form.id === "new-form") syncNewIncidentDraftFromDom();
  const context = form.id === "pm-form" ? "pm" : form.id === "susp-form" ? "susp" : form.id === "to-form" ? "to" : "grooming";
  const draft = { "pm-form": state._pmDraft, "susp-form": state._suspDraft, "to-form": state._toDraft, "new-form": state._newIncidentDraft, "edit-form": state._editIncidentDraft }[form.id];
  const selector = input.id ? `#${input.id}`
    : input.name ? `#${form.id} [name="${input.name}"]`
    : `#${form.id} .${input.classList[0]}[data-idx="${input.dataset.idx}"]`;
  const current = input.value || "";
  const start = current || todayISO();
  try { document.activeElement?.blur?.(); } catch (e) { /* non-fatal */ }
  // Suspension, Time Out and Grooming dates depend on the student's level
  // (HBL / closure days), so the class has to be chosen first.
  if (context !== "pm" && !draft?.studentClass) {
    state.postponePicker = { mode: "needClass" };
    ppRender();
    return;
  }
  state.postponePicker = { mode: "field", context, selector, level: classLevel(draft?.studentClass) || null,
    minExclusive: "", selected: current, month: start.slice(0, 7) };
  // Don't pre-select a day that can't be chosen (e.g. today is an HBL day
  // for this student's level).
  if (current && pickerDayState(current, state.postponePicker).blocked) state.postponePicker.selected = "";
  ppRender();
}

// Short labels for the school-holiday blocks inside the small calendar cells
// (Settings keeps the full names).
const SHORT_HOLIDAY_NAMES = {
  "March Holidays": "Mar Hols", "June Holidays": "Jun Hols",
  "September Holidays": "Sep Hols", "December Holidays": "Dec Hols",
};
// What a calendar day is, for colouring and blocking in the date pickers:
// public holiday (pink) / school holiday (yellow) / weekend (grey) /
// school closure or HBL day (blue) — with the holiday's name where it has one.
function calendarDayInfo(iso) {
  const pub = publicHolidayEntryFor(iso);
  if (pub || (state.holidays?.publicHolidays || []).includes(iso)) return { kind: "public", name: (pub && pub.name) || "Public Holiday" };
  const wknd = isWeekend(iso);
  if (!wknd) {
    const year = parseInt(iso.slice(0, 4), 10);
    const moe = computeMoeCalendar(year);
    const si = moe.singleDays.indexOf(iso);
    if (si >= 0) return { kind: "school", name: moe.singleDayLabels[si] || "School Holiday" };
    const r = moe.ranges.find((x) => iso >= x.start && iso <= x.end);
    if (r) return { kind: "school", name: SHORT_HOLIDAY_NAMES[r.label] || r.label || "School Holiday" };
    const ex = (state.schoolCalendarOverrides?.[year]?.extraHolidays || []).find((e) => iso >= e.startDate && iso <= e.endDate);
    if (ex) return { kind: "school", name: ex.name || "School Holiday" };
  }
  if (wknd) return { kind: "weekend", name: "" };
  const c = schoolClosureEntryFor(iso);
  if (c) return { kind: "closure", name: closureLabel(c.levels), levels: c.levels };
  return { kind: null, name: "" };
}
// How a day behaves in a picker. Weekends, public and school holidays are
// named and coloured everywhere. On Grooming and Parent Meet they can't be
// picked; closure/HBL days are blocked on Grooming for the student's level
// and just a note for parent meetings. On Suspension and Time Out every day
// can be picked (colours still shown) — only the automatic defaults avoid
// non-school days.
function pickerDayState(iso, pp) {
  const info = calendarDayInfo(iso);
  let kind = info.kind, name = info.name, blocked = kind === "weekend" || kind === "public" || kind === "school";
  if (kind === "closure") {
    if (pp.context === "pm") blocked = false;
    else blocked = pp.level ? info.levels.includes(pp.level) : info.levels.length >= 6;
  }
  if (pp.context === "susp" || pp.context === "to") blocked = false;
  if (pp.minExclusive && iso <= pp.minExclusive) blocked = true;
  return { kind, name, blocked };
}
function renderPostponePicker() {
  const pp = state.postponePicker;
  if (pp.mode === "needClass") return `
    <div class="dd-modal-backdrop" id="pp-backdrop">
      <div class="dd-modal dd-pp-modal" role="alertdialog" aria-label="Choose the class first">
        <div class="dd-modal-head">
          <div class="dd-modal-title">Choose the class first</div>
          <button type="button" class="dd-modal-close" data-pp="cancel">✕</button>
        </div>
        <div class="dd-sans" style="font-size:14px;line-height:1.45">Select the student's class before choosing a date, so the calendar can show that level's HBL and school closure days.</div>
        <div style="display:flex;margin-top:14px">
          <button type="button" class="dd-add-btn" style="flex:1" data-pp="cancel">OK</button>
        </div>
      </div>
    </div>`;
  const isField = pp.mode === "field";
  const [y, mo] = pp.month.split("-").map(Number);
  const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7; // Monday-first
  const daysIn = new Date(y, mo, 0).getDate();
  const today = todayISO();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<span></span>`);
  for (let d = 1; d <= daysIn; d++) {
    const iso = `${pp.month}-${String(d).padStart(2, "0")}`;
    const ds = pickerDayState(iso, pp);
    const cls = ["dd-pp-day", ds.kind ? `dd-pp-${ds.kind}` : "", iso === pp.selected ? "selected" : "", iso === today ? "today" : ""].filter(Boolean).join(" ");
    cells.push(`<button type="button" class="${cls}" data-pp="day" data-date="${iso}" ${ds.blocked ? "disabled" : ""} ${ds.name ? `title="${escapeHtml(ds.name)}"` : ""}><span class="dd-pp-num">${d}</span>${ds.name ? `<span class="dd-pp-hol">${escapeHtml(ds.name)}</span>` : ""}</button>`);
  }
  return `
    <div class="dd-modal-backdrop" id="pp-backdrop">
      <div class="dd-modal dd-pp-modal" role="dialog" aria-label="${isField ? "Choose a date" : "Choose the postponed meeting date"}">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${isField ? (pp.title || "Choose a date") : "Postponed meeting date"}</div>
          <button type="button" class="dd-modal-close" data-pp="cancel">✕</button>
        </div>
        ${isField ? "" : `<div class="dd-mono-muted" style="font-size:11px;margin:-6px 0 10px">Original meeting: ${formatDate(pp.minExclusive)}</div>`}
        <div class="dd-pp-nav">
          <button type="button" class="dd-pp-navbtn" data-pp="prev" title="Previous month">‹</button>
          <div class="dd-pp-month">${monthLabelFromKey(pp.month)}</div>
          <button type="button" class="dd-pp-navbtn" data-pp="next" title="Next month">›</button>
        </div>
        <div class="dd-pp-grid">
          ${["M", "T", "W", "T", "F", "S", "S"].map((w) => `<span class="dd-pp-wd">${w}</span>`).join("")}
          ${cells.join("")}
        </div>
        <div class="dd-pp-legend">
          <span><i class="dd-pp-sw dd-pp-weekend"></i>Weekend</span>
          <span><i class="dd-pp-sw dd-pp-public"></i>Public Holiday</span>
          <span><i class="dd-pp-sw dd-pp-school"></i>School Holiday</span>
          <span><i class="dd-pp-sw dd-pp-closure"></i>Closure / HBL Day</span>
        </div>
        ${isField ? "" : `<div style="margin-top:2px">${renderSlotPicker("pp")}</div>`}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="button" class="dd-add-btn" style="flex:1;background:#8A8571" data-pp="cancel">Cancel</button>
          <button type="button" class="dd-add-btn dd-pp-ok" style="flex:1" data-pp="ok" ${postponeReady() ? "" : "disabled"} title="${isField ? "Use this date" : "Use this date, time and room"}">✓</button>
        </div>
      </div>
    </div>`;
}
// ✓ needs a date plus a complete, free time slot and room.
function postponeReady() {
  const pp = state.postponePicker;
  if (!pp || !pp.selected || pickerDayState(pp.selected, pp).blocked) return false;
  return pp.mode === "field" ? true : !slotError("pp", true);
}
function updatePostponeOkButton() {
  const ok = document.querySelector('[data-pp="ok"]');
  if (ok) ok.disabled = !postponeReady();
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
  if (!pp || !postponeReady()) return;
  state.postponePicker = null;
  if (pp.mode === "field") {
    const input = document.querySelector(pp.selector);
    if (input) {
      input.value = pp.selected;
      // The new grooming form reads its fields from state, not change events.
      if (input.closest("#new-form") && state._newIncidentDraft) state._newIncidentDraft.date = pp.selected;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (document.getElementById("pp-backdrop")) ppRender();
    return;
  }
  const slot = { time: pp.time, endTime: pp.endTime, location: pp.location };
  if (pp.mode === "draft") {
    if (state._pmDraft) Object.assign(state._pmDraft, { postponedTo: pp.selected, postponedTime: slot.time, postponedEndTime: slot.endTime, postponedLocation: slot.location });
    ppRender();
    return;
  }
  const m = state.parentMeetings.find((x) => x.id === pp.pmId);
  if (!m) { ppRender(); return; }
  const dupPm = findDuplicateParentMeeting(m.studentName, m.studentClass, pp.selected, m.id);
  requestDeleteConfirmation("setPostponeDate", pp.pmId, {
    date: pp.selected, slot, tone: "confirm",
    message: "Confirm this meeting booking?",
    details: [
      ["Student", `${m.studentName}${m.studentClass ? ` (${m.studentClass})` : ""}`],
      ["Date", `${formatDate(pp.selected)} (${weekdayName(pp.selected)})`],
      ["Time", formatTimeRange(slot.time, slot.endTime)],
      ["Location", slot.location],
      ...(dupPm ? [["Note", `${m.studentName} already has a parent meeting on this day (logged by ${dupPm.loggedBy || "another teacher"}).`]] : []),
    ],
  });
}
// Picker taps go through the always-live delegated handler (like the other
// pop-up confirmations). On touch devices the follow-up "click" is
// cancelled, so the tap on ✓ can't also land on the confirmation's Yes
// button that appears in the same spot.
function handlePostponePickerTap(e) {
  // Only the log forms and a grooming issue's follow-up deadline use the
  // in-app calendar. Settings and the chart's Custom range keep the
  // phone's own date picker (they set holidays themselves, so there's
  // nothing to colour or block).
  const fieldBtn = e.target.closest && e.target.closest("#pm-form .dd-date-icon-btn, #susp-form .dd-date-icon-btn, #to-form .dd-date-icon-btn, #new-form .dd-date-icon-btn, #edit-form .dd-date-icon-btn, .dd-issue-due-row .dd-date-icon-btn");
  const fieldInput = fieldBtn && fieldBtn.querySelector('input[type="date"]');
  if (fieldInput && !fieldInput.closest("#pm-form, #susp-form, #to-form, #new-form, #edit-form") && !fieldInput.classList.contains("dd-issue-override-input")) return false;
  if (fieldInput) {
    if (e.type === "touchend") e.preventDefault();
    runDelegatedAction("pp-field-open", () => openFieldDatePicker(fieldInput));
    return true;
  }
  const el = e.target.closest && e.target.closest("[data-pp],[data-pp-open]");
  if (!el) return false;
  if (e.type === "touchend") e.preventDefault();
  if (el.disabled) return true;
  if (el.dataset.ppOpen) { runDelegatedAction("pp-open", () => openPostponePicker(el.dataset.ppOpen, el.dataset.id)); return true; }
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
    if (entry) await trashRecord("parentMeetings", id, entry);
    await deleteDoc(doc(db, "parentMeetings", id));
    if (entry) {
      const { id: _drop, ...data } = entry;
      showUndoToast("parentMeetings", id, data);
      syncParentMeetingToSheet({ ...entry, deleted: true });
    }
  } catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
}

// ---------- Parent meeting time + room booking ----------
// Every parent meeting set-up (Parent Meet form, the "Meeting Parents" tag
// on Suspension/Time Out forms, and a postponed meeting's new date) picks a
// start and end time on scroll wheels (24-hour, 15-minute steps) and one of
// two rooms. Each room holds one meeting at a time: a room is unavailable
// for any time that overlaps an existing booking on the same day, and an
// unavailable room can't be selected (checked again when saving).
// Cancelled meetings, and postponed ones with no new date yet, free their
// room; a rescheduled meeting holds its room at the new date and time.
const PM_ROOMS = ["Meeting Room", "Conference Room"];
const WHEEL_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const WHEEL_MINUTES = ["00", "15", "30", "45"];
const WHEEL_ITEM_H = 44;
const LAST_SLOT_MIN = 23 * 60 + 45;
function timeToMin(t) { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; }
function minToTime(n) { return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`; }
function formatTimeRange(start, end) { return start && end ? `${start}–${end}` : ""; }

// The room booking a meeting currently holds, or null if it holds none.
function pmBooking(m) {
  if (!m || !isPmCounted(m)) return null;
  const b = isPmRescheduled(m)
    ? { date: m.postponedTo, start: m.postponedTime, end: m.postponedEndTime, location: m.postponedLocation }
    : { date: m.date, start: m.time, end: m.endTime, location: m.location };
  return b.date && b.start && b.end && b.location ? b : null;
}
// The meeting already holding `room` at an overlapping time that day, if any.
function roomClash(room, date, start, end, excludeId) {
  if (!room || !date || !start || !end) return null;
  const s = timeToMin(start), e = timeToMin(end);
  return state.parentMeetings.find((m) => {
    if (m.id === excludeId) return false;
    const b = pmBooking(m);
    return b && b.location === room && b.date === date && timeToMin(b.start) < e && s < timeToMin(b.end);
  }) || null;
}
// "14:00–15:00 · Conference Room" for a meeting's original or new slot.
function pmSlotLabel(start, end, location) {
  return [formatTimeRange(start, end), location || ""].filter(Boolean).join(" · ");
}

// Where each picker reads/writes its values, which date it books on, and
// which meeting (if any) to ignore when checking clashes (itself).
function slotBinding(key) {
  if (key === "pm") {
    const d = state._pmDraft; if (!d) return null;
    return { obj: d, f: { start: "time", end: "endTime", loc: "location" }, date: d.date, excludeId: state.editingPmId || null };
  }
  if (key === "susp-pm" || key === "to-pm") {
    const d = key === "susp-pm" ? state._suspDraft : state._toDraft; if (!d) return null;
    return { obj: d, f: { start: "pmTime", end: "pmEndTime", loc: "pmLocation" }, date: d.startDate, excludeId: null };
  }
  if (key === "pp") {
    const p = state.postponePicker; if (!p) return null;
    return { obj: p, f: { start: "time", end: "endTime", loc: "location" }, date: p.selected, excludeId: p.pmId || state.editingPmId || null };
  }
  return null;
}
function slotValues(key) {
  const b = slotBinding(key);
  if (!b) return null;
  return { b, start: b.obj[b.f.start] || "", end: b.obj[b.f.end] || "", loc: b.obj[b.f.loc] || "" };
}
// "" when the slot is complete, free and valid; otherwise the problem.
// With required=false an entirely empty slot is also fine.
function slotError(key, required) {
  const v = slotValues(key);
  if (!v) return "";
  if (!v.start && !v.end && !v.loc && !required) return "";
  if (!v.start || !v.end) return "Set the meeting's start and end time.";
  if (timeToMin(v.end) <= timeToMin(v.start)) return "The meeting's end time must be after its start time.";
  if (!v.loc) return "Choose where the meeting will be held (Meeting Room or Conference Room).";
  if (!v.b.date) return "Choose the meeting date first.";
  const clash = roomClash(v.loc, v.b.date, v.start, v.end, v.b.excludeId);
  if (clash) {
    const cb = pmBooking(clash);
    return `${v.loc} is already booked ${formatTimeRange(cb.start, cb.end)} on ${formatDate(v.b.date)} (${clash.studentName}). Pick another time or room.`;
  }
  return "";
}

function renderSlotPicker(key) {
  const v = slotValues(key);
  if (!v) return "";
  const box = (which, value, placeholder) => `
    <button type="button" class="dd-time-box${value ? " set" : ""}" data-tp-open="${key}" data-which="${which}" aria-label="${placeholder}${value ? `: ${value}` : ""}">${value || placeholder}</button>`;
  return `
    <div class="dd-slot" data-slot-root="${key}">
      <label class="dd-label">Meeting Time</label>
      <div class="dd-time-boxes">
        ${box("start", v.start, "Start Time")}
        <span class="dd-time-arrow" aria-hidden="true">→</span>
        ${box("end", v.end, "End Time")}
      </div>
      <label class="dd-label">Location</label>
      <div class="dd-room-row" data-slot-rooms="${key}">${renderRoomButtons(key)}</div>
    </div>`;
}
// Rooms use the same colours as the Suspension location selector: green =
// available, red = not available (and can't be tapped), navy = chosen.
function renderRoomButtons(key) {
  const v = slotValues(key);
  const timeOk = v.start && v.end && timeToMin(v.end) > timeToMin(v.start);
  return PM_ROOMS.map((r) => {
    const clash = timeOk && v.b.date ? roomClash(r, v.b.date, v.start, v.end, v.b.excludeId) : null;
    const disabled = !v.b.date || !timeOk || !!clash;
    const status = !v.b.date ? "Choose a date first" : !timeOk ? "Set the time first" : clash ? "Not available" : "Available";
    const selected = v.loc === r && !disabled;
    const cls = selected ? "dd-avail-chip-selected" : clash ? "dd-avail-chip-full" : disabled ? "dd-room-waiting" : "dd-avail-chip-free";
    return `<button type="button" class="dd-room-btn ${cls}" data-room-slot="${key}" data-room="${r}" ${disabled ? "disabled" : ""} aria-pressed="${selected}">
      <span class="dd-room-name" data-fit="rooms-${key}">${r}</span><span class="dd-room-status">${status}</span></button>`;
  }).join("");
}
// Text that must stay on one line (marked data-fit) is shrunk just enough
// to fit the width it has on this phone. Elements sharing a data-fit name
// all take the same (smallest needed) size, so e.g. both room buttons
// match. An element's own inline size is remembered and restored first.
// Search boxes (data-fit-placeholder) get a placeholder size that shows
// the whole hint.
const FIT_MIN_PX = 9;
let fitCanvas = null;
function fitOneLine() {
  const groups = new Map();
  document.querySelectorAll("[data-fit]").forEach((el, i) => {
    if (el.dataset.fitBase === undefined) el.dataset.fitBase = el.style.fontSize || "";
    el.style.fontSize = el.dataset.fitBase;
    el.classList.remove("dd-fit-wrapped");
    const key = el.dataset.fit || `_solo${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(el);
  });
  groups.forEach((els) => {
    let size = Infinity;
    els.forEach((el) => {
      if (!el.clientWidth) return;
      const base = parseFloat(getComputedStyle(el).fontSize);
      if (el.scrollWidth <= el.clientWidth) { size = Math.min(size, base); return; }
      // An element with data-fit-min won't shrink below that size: if it
      // still doesn't fit there, it wraps onto a second line at its normal
      // size instead (and doesn't pull the rest of its group down with it).
      const min = parseFloat(el.dataset.fitMin) || FIT_MIN_PX;
      if (el.dataset.fitMin) {
        el.style.fontSize = `${min}px`;
        const fitsAtMin = el.scrollWidth <= el.clientWidth;
        el.style.fontSize = el.dataset.fitBase;
        if (!fitsAtMin) { el.classList.add("dd-fit-wrapped"); return; }
      }
      // Largest size (to 0.5px) that fits, found in a few halvings.
      let lo = min, hi = base;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (el.scrollWidth <= el.clientWidth) lo = mid; else hi = mid;
      }
      size = Math.min(size, Math.floor(lo * 2) / 2);
      el.style.fontSize = el.dataset.fitBase;
    });
    if (size !== Infinity) els.forEach((el) => { if (parseFloat(getComputedStyle(el).fontSize) > size) el.style.fontSize = `${size}px`; });
  });
  document.querySelectorAll("[data-fit-placeholder]").forEach((el) => {
    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    if (avail <= 0) return;
    fitCanvas = fitCanvas || document.createElement("canvas");
    const ctx = fitCanvas.getContext("2d");
    ctx.font = `400 16px ${cs.fontFamily}`;
    const w16 = ctx.measureText(el.placeholder).width;
    el.style.setProperty("--ph-size", `${Math.max(10, Math.min(16, Math.floor((avail / w16) * 16 * 2) / 2))}px`);
  });
}
window.addEventListener("resize", () => fitOneLine());
// Re-measure once fonts are in, and whenever another weight finishes
// loading (sizes measured with the fallback font would be off).
if (document.fonts) {
  if (document.fonts.ready) document.fonts.ready.then(() => fitOneLine());
  if (document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", () => fitOneLine());
}
// Refreshes a picker's rooms (and the postponed picker's ✓) in place.
function updateSlotDom(key) {
  const v = slotValues(key);
  if (!v) return;
  // A room that's become unavailable for the new time is dropped.
  if (v.loc && (!v.start || !v.end || timeToMin(v.end) <= timeToMin(v.start) || roomClash(v.loc, v.b.date, v.start, v.end, v.b.excludeId))) v.b.obj[v.b.f.loc] = "";
  const rooms = document.querySelector(`[data-slot-rooms="${key}"]`);
  if (rooms) { rooms.innerHTML = renderRoomButtons(key); fitOneLine(); }
  if (key === "pp") updatePostponeOkButton();
}

// ---- Pop-up time selector (one per box: Start Time / End Time) ----
// Apple-style wheels (hour 00–23, minutes 00/15/30/45) in a small pop-up;
// nothing changes until ✓. The End Time ✓ stays disabled unless the time
// is after the start.
function openTimePop(key, which) {
  const v = slotValues(key);
  if (!v) return;
  const current = which === "start" ? v.start : v.end;
  const fallback = which === "start" ? "08:00" : minToTime(Math.min(timeToMin(v.start || "08:00") + 60, LAST_SLOT_MIN));
  const t = current || fallback;
  try { document.activeElement?.blur?.(); } catch (e) { /* non-fatal */ }
  state.timePop = { key, which, h: t.slice(0, 2), m: t.slice(3) };
  renderKeepingModalScroll();
}
function timePopValue() { const tp = state.timePop; return `${tp.h}:${tp.m}`; }
function timePopProblem() {
  const tp = state.timePop;
  if (!tp || tp.which !== "end") return "";
  const v = slotValues(tp.key);
  return v && v.start && timeToMin(timePopValue()) <= timeToMin(v.start) ? `End time must be after ${v.start}` : "";
}
function renderTimePop() {
  const tp = state.timePop;
  const wheel = (part, values, current) => `
    <div class="dd-wheel-wrap"><div class="dd-wheel" data-part="${part}" data-current="${current}" aria-label="${part === "h" ? "Hour" : "Minutes"}">
      ${values.map((x) => `<div class="dd-wheel-item" data-v="${x}">${x}</div>`).join("")}
    </div></div>`;
  const problem = timePopProblem();
  return `
    <div class="dd-modal-backdrop dd-tp-backdrop" id="tp-backdrop">
      <div class="dd-modal dd-tp-modal" role="dialog" aria-label="${tp.which === "start" ? "Start Time" : "End Time"}">
        <div class="dd-modal-head">
          <div class="dd-modal-title">${tp.which === "start" ? "Start Time" : "End Time"}</div>
          <button type="button" class="dd-modal-close" data-tp="cancel">✕</button>
        </div>
        <div class="dd-wheel-pair">${wheel("h", WHEEL_HOURS, tp.h)}<span class="dd-wheel-colon">:</span>${wheel("m", WHEEL_MINUTES, tp.m)}</div>
        <div class="dd-tp-note" data-tp-note>${escapeHtml(problem)}</div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button type="button" class="dd-add-btn" style="flex:1;background:#8A8571" data-tp="cancel">Cancel</button>
          <button type="button" class="dd-add-btn dd-pp-ok" style="flex:1" data-tp="ok" ${problem ? "disabled" : ""} title="Use this time">✓</button>
        </div>
      </div>
    </div>`;
}
function confirmTimePop() {
  const tp = state.timePop;
  if (!tp || timePopProblem()) return;
  const v = slotValues(tp.key);
  const t = timePopValue();
  state.timePop = null;
  if (v) {
    if (tp.which === "start") {
      v.b.obj[v.b.f.start] = t;
      // A start at/after the current end pushes the end to an hour later.
      const end = v.b.obj[v.b.f.end];
      if (end && timeToMin(end) <= timeToMin(t)) v.b.obj[v.b.f.end] = minToTime(Math.min(timeToMin(t) + 60, LAST_SLOT_MIN));
    } else {
      v.b.obj[v.b.f.end] = t;
    }
    const n = slotValues(tp.key);
    if (n.loc && (!n.start || !n.end || roomClash(n.loc, n.b.date, n.start, n.end, n.b.excludeId))) n.b.obj[n.b.f.loc] = "";
  }
  renderKeepingModalScroll();
}
function wheelIndex(el) {
  const n = el.querySelectorAll(".dd-wheel-item").length;
  return Math.max(0, Math.min(n - 1, Math.round(el.scrollTop / WHEEL_ITEM_H)));
}
function setWheel(el, value) {
  const items = [...el.querySelectorAll(".dd-wheel-item")];
  const i = Math.max(0, items.findIndex((x) => x.dataset.v === value));
  // Remember where the app itself put the wheel, so the scroll event this
  // causes isn't mistaken for a choice.
  el._progTop = i * WHEEL_ITEM_H;
  el.scrollTop = el._progTop;
  items.forEach((x, j) => x.classList.toggle("on", j === i));
}
// A wheel in the pop-up came to rest (or an item was tapped).
function commitTimePopWheel(el) {
  const tp = state.timePop;
  if (!tp) return;
  const i = wheelIndex(el);
  const items = el.querySelectorAll(".dd-wheel-item");
  items.forEach((x, j) => x.classList.toggle("on", j === i));
  tp[el.dataset.part] = items[i].dataset.v;
  const problem = timePopProblem();
  const note = document.querySelector("[data-tp-note]");
  if (note) note.textContent = problem;
  const ok = document.querySelector('[data-tp="ok"]');
  if (ok) ok.disabled = !!problem;
}
// Runs after every render: puts the pop-up's wheels on their values and
// listens for the scroll settling (scroll-snap does the "click into place").
function attachSlotPickers() {
  document.querySelectorAll(".dd-tp-modal .dd-wheel").forEach((el) => {
    setWheel(el, el.dataset.current);
    let t = null;
    el.addEventListener("scroll", () => {
      if (Math.abs(el.scrollTop - (el._progTop ?? -999)) < 1 && !t) return;
      clearTimeout(t);
      t = setTimeout(() => { t = null; commitTimePopWheel(el); }, 140);
    }, { passive: true });
    el.querySelectorAll(".dd-wheel-item").forEach((item) => item.addEventListener("click", () => {
      setWheel(el, item.dataset.v);
      commitTimePopWheel(el);
    }));
  });
}
// Box taps, pop-up buttons and room taps. Touch "click" follow-ups are
// cancelled for the box/pop-up buttons so a tap can't fall through onto
// whatever the pop-up opens or closes over. Rooms react to click only, so
// a scroll that ends on a room button doesn't count.
function handleRoomTap(e) {
  const tpEl = e.target.closest && e.target.closest("[data-tp-open],[data-tp]");
  if (tpEl) {
    if (e.type === "touchend") e.preventDefault();
    if (tpEl.disabled) return true;
    if (tpEl.dataset.tpOpen) runDelegatedAction("tp-open", () => openTimePop(tpEl.dataset.tpOpen, tpEl.dataset.which));
    else if (tpEl.dataset.tp === "ok") runDelegatedAction("tp-ok", () => confirmTimePop());
    else if (tpEl.dataset.tp === "cancel") runDelegatedAction("tp-cancel", () => { state.timePop = null; renderKeepingModalScroll(); });
    return true;
  }
  if (e.type !== "click") return false;
  const el = e.target.closest && e.target.closest("[data-room-slot]");
  if (!el) return false;
  if (el.disabled) return true;
  const v = slotValues(el.dataset.roomSlot);
  if (!v) return true;
  v.b.obj[v.b.f.loc] = v.loc === el.dataset.room ? "" : el.dataset.room;
  updateSlotDom(el.dataset.roomSlot);
  return true;
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
// Every re-render (a tick, a pill, a live update from another teacher)
// rebuilds the page, which would reset scrolled pop-ups and lists back to
// the top. Remember each pop-up's and checklist's scroll position and put
// it back, so lists never "bounce" after a selection.
const SCROLL_KEEP_SELECTOR = ".dd-modal, .dd-pm-reason-list";
function scrollKey(el, i) { return el.id || `${el.className}#${i}`; }
function captureScrollPositions() {
  const out = {};
  const seen = {};
  document.querySelectorAll(SCROLL_KEEP_SELECTOR).forEach((el) => {
    const c = el.className; seen[c] = (seen[c] || 0);
    if (el.scrollTop) out[scrollKey(el, seen[c])] = el.scrollTop;
    seen[c]++;
  });
  return out;
}
function restoreScrollPositions(saved) {
  if (!Object.keys(saved).length) return;
  const seen = {};
  document.querySelectorAll(SCROLL_KEEP_SELECTOR).forEach((el) => {
    const c = el.className; seen[c] = (seen[c] || 0);
    const k = scrollKey(el, seen[c]);
    if (saved[k] != null) el.scrollTop = saved[k];
    seen[c]++;
  });
}
function render() {
  if (!state.authReady) { root.innerHTML = `<div class="dd-center" style="flex-direction:column"><div class="dd-mono">Opening the log…</div>${isOffline() ? OFFLINE_NOTE : ""}</div>`; return; }
  if (!state.authUser) { root.innerHTML = renderSignInScreen(); attachSignInListeners(); return; }
  if (!state.teacherName) { root.innerHTML = renderNameScreen(); attachNameListeners(); return; }
  if (!state.dataLoaded || !state.suspLoaded || !state.toLoaded || !state.pmLoaded) { root.innerHTML = `<div class="dd-center" style="flex-direction:column"><div class="dd-mono">Loading entries…</div>${isOffline() ? OFFLINE_NOTE : ""}</div>`; return; }
  updateFollowUpBadge();
  const scrolls = captureScrollPositions();
  root.innerHTML = renderMain();
  attachMainListeners();
  attachSlotPickers();
  fitOneLine();
  restoreScrollPositions(scrolls);
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
  html += state.timePop ? renderTimePop() : "";
  html += state.confirmDeleteTarget ? renderDeleteConfirmModal() : "";
  html += state.pendingDuplicateConfirm ? renderDuplicateConfirmModal() : "";
  if (!state.saving && !state.pendingDuplicateConfirm && !state.confirmDeleteTarget && (state.linkPromptQueue || []).length) html += renderLinkPromptModal();
  html += state.undoToast ? renderUndoToast() : "";
  html += state.exportDraft ? renderExportModal() : "";
  html += state.updateReady ? renderUpdateBar() : "";
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
          <p>The home icon shows trend charts (Day/Week/Month/Year, Term 1–4, or a Custom range) and the Students' Watchlist — High/Medium/Low Risk, based on grooming warnings, suspensions and time outs this semester (Terms 1–2 until Term 3 starts, then Terms 3–4). Tap the ⓘ next to the watchlist heading to see exactly what puts a student in each tier. Tap a student's name anywhere in the app to see this year's records for them across all four logs, with earlier years listed at the bottom (tap a year to open it). Because two students can share a name and classes change every year, an earlier year is only added after a teacher confirms it's the same student: the app asks once (right after saving, and in the student's view) and remembers the answer for everyone. It also asks when the same name appears in another class of the same level in the same year (a mid-year class change); Yes counts both classes as one student, including on the Students' Watchlist. All answers are listed under Settings → Student Links, where Admins and the Owner can change or remove them. The P1–P6 boxes at the top of each log count this year's entries only.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Grooming Log</div>
          <p>Pick one or more issues when logging an entry (Long Hair, Uniform, etc.) — each gets its own 1st/2nd/Final Warning countdown with its own deadline, and a "same day, over the weekend" rule automatically pushes a 4-day deadline to the next school day. Every deadline falls on a school day: one that would land on a weekend, holiday or the student's HBL/closure day moves to the next school day. Adding several students at once for the same issue(s) is one tap away ("+ Add another student") — each still gets their own independent entry. Resolve an issue any time, or mark it unresolved to escalate to the next warning; deadlines can be moved if the student or parent proposes a different date. Edit Entry lets you change the student, date, and which issues are selected. An entry only shows Resolved once every issue in it is resolved.</p>
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
          <p>Log who attended (multiple people allowed) and why — you can tick more than one reason for the same meeting. Each reason gets its own Victim/Offender/Both/NA status, except Academic Matters and Learning Needs, which aren't disciplinary offences and skip that. "Others" lets you type in specifics, for both the reason and who attended. Every meeting needs a Meeting Time (tap Start Time or End Time to pick it on a 24-hour wheel, in 15-minute steps) and a room: Meeting Room or Conference Room. A room holds one meeting at a time, so a room that's already booked for any overlapping time shows "Not available" and can't be chosen. Tap Postponed or Cancelled right on a meeting's card (no need to open it) — tap again to set it back to scheduled. A postponed meeting gets an optional "Postponed to" date box, to fill in once the new date is known; until then it's listed on the Dashboard under Pending Parent Meeting Date, where the date can be set too: tap the calendar, pick a day, set the time and room, tap ✓, then confirm. Once set, the meeting leaves that list, and any later change to the date is made in the Parent Meet log. Once a new date is set, the meeting counts on that new date (calendar, totals, reports) and its original date shows "Postponed to …". Cancelled meetings, and postponed ones with no new date yet, stay in the log but aren't counted in any totals.</p>
        </div>
        <div class="dd-help-section">
          <div class="dd-help-heading">Choosing dates</div>
          <p>Date fields on the Grooming, Suspension, Time Out and Parent Meet forms — and a grooming issue's follow-up deadline — open the app's own calendar. Weekends (grey), public holidays (pink) and school holidays (yellow) are shown with their names; on Grooming and Parent Meet they can't be picked. School closure and HBL days (blue) are shown too: on Grooming they're blocked for the levels affected; for parent meetings they're just a note and can still be picked. Overlapping HBL entries are combined per day (e.g. P3/P4/P5 HBL). When changing a date, the calendar opens on the one already chosen. On Grooming, Suspension and Time Out, choose the student's class first, since HBL and closure days depend on the level. On Suspension and Time Out any day can be picked (the colours still show weekends, holidays and HBL days), but the default start and the days filled in automatically are always school days. Changing the start date, or changing the class to a different level, lays the days out again from the new start.</p>
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
function weekLabelForMonday(monday) {
  const year = parseInt(monday.slice(0, 4), 10);
  const moe = computeMoeCalendar(year);
  for (let i = 0; i < moe.terms.length; i++) {
    const t = moe.terms[i];
    if (monday >= t.start && monday <= t.end) {
      const weekNum = Math.floor(daysBetween(t.start, monday) / 7) + 1;
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
    case "custom": return monthKeysInRange(monthKey(customRangeBounds().from), monthKey(customRangeBounds().to));
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
  { key: "all", label: "All" },
  { key: "custom", label: "Custom" },
];
const CATEGORY_META = {
  discipline: { label: "Grooming" },
  suspension: { label: "Suspension" },
  timeOut: { label: "Time Out" },
  parentMeeting: { label: "Parent Meet" },
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
      label: t.label, start: t.start, end: t.end,
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
  // Only completed terms are compared — mid-year, a term that's barely
  // started (or not started) would otherwise read as near-0 and make
  // everything look like it fell.
  const today = todayISO();
  const allTerms = computeYearTermTrend(year);
  const terms = allTerms.filter((t) => t.end < today);
  const inProgress = allTerms.find((t) => t.start <= today && t.end >= today);
  const thisYear = computeYearlyCategoryTotals(year);
  const lastYear = computeYearlyCategoryTotals(year - 1);
  const hasLastYear = lastYear.discipline + lastYear.suspension + lastYear.timeOut + lastYear.parentMeeting > 0;
  const topIssue = computeTopGroomingIssueType(year);
  const levelRanking = computeYearLevelRanking(year);
  const classRanking = computeYearClassRanking(year);
  const first = terms[0], lastT = terms[terms.length - 1];
  const soFar = allTerms.some((t) => t.end >= today);
  const inProgressNote = inProgress ? ` ${inProgress.label} is still in progress, so it's left out of the comparison.` : "";

  const withinYear = allTerms.every((t) => t.discipline + t.suspension + t.timeOut + t.parentMeeting === 0)
    ? `No grooming, suspension, time out, or parent meeting entries were logged for ${year} yet, so a within-year trend can't be drawn.`
    : terms.length < 2
      ? `Fewer than two terms have finished so far, so there isn't a term-to-term trend to describe yet.` + (topIssue ? ` The most common grooming issue so far is ${topIssue.type}, logged ${topIssue.count} time${topIssue.count === 1 ? "" : "s"}.` : "")
      : `From ${first.label} to ${lastT.label}, grooming issues ${describeTrend(first.discipline, lastT.discipline)} (${first.discipline} → ${lastT.discipline}), suspensions ${describeTrend(first.suspension, lastT.suspension)} (${first.suspension} → ${lastT.suspension}), time outs ${describeTrend(first.timeOut, lastT.timeOut)} (${first.timeOut} → ${lastT.timeOut}), and parent meetings ${describeTrend(first.parentMeeting, lastT.parentMeeting)} (${first.parentMeeting} → ${lastT.parentMeeting}).` +
        inProgressNote +
        (topIssue ? ` The most common grooming issue this year was ${topIssue.type}, logged ${topIssue.count} time${topIssue.count === 1 ? "" : "s"}.` : "");

  const acrossYears = !hasLastYear
    ? `There isn't a prior year on record yet to compare ${year} against.`
    : `Compared to ${year - 1}${soFar ? " (a full year, against this year so far)" : ""}, grooming issues are ${pctChangeLabel(lastYear.discipline, thisYear.discipline)}, suspensions are ${pctChangeLabel(lastYear.suspension, thisYear.suspension)}, time outs are ${pctChangeLabel(lastYear.timeOut, thisYear.timeOut)}, and parent meetings are ${pctChangeLabel(lastYear.parentMeeting, thisYear.parentMeeting)}.`;

  const improvements = [];
  const concerns = [];
  if (terms.length >= 2) {
    const by = `by ${lastT.label} compared to ${first.label}`;
    if (lastT.discipline < first.discipline) improvements.push(`grooming issues eased off ${by}`);
    else if (lastT.discipline > first.discipline) concerns.push(`grooming issues were higher in ${lastT.label} than ${first.label} — worth watching whether this continues`);
    if (lastT.suspension < first.suspension) improvements.push(`suspensions were less frequent ${by}`);
    else if (lastT.suspension > first.suspension) concerns.push("suspensions picked up later in the year rather than easing off");
    if (lastT.timeOut < first.timeOut) improvements.push(`time outs were less frequent ${by}`);
    else if (lastT.timeOut > first.timeOut) concerns.push("time outs picked up later in the year rather than easing off");
  }
  if (hasLastYear && !soFar) {
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

  return { withinYear, acrossYears, hasLastYear, soFar, startedTerms: terms, improvements, concerns, improvementsPara, concernsPara };
}
// Most frequent reasons across one log's records for a year (a record with
// several reasons counts once towards each).
function computeTopReasons(records, year) {
  const tally = {};
  records.forEach((r) => {
    if (r.deleted || !r.startDate || !r.startDate.startsWith(`${year}-`)) return;
    multiReasonsFromSaved(r).selected.forEach((x) => { if (x) tally[x] = (tally[x] || 0) + 1; });
  });
  return Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}
const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || word + "s")}`;
// Everything the Trend Analysis page says, worked out from the same counts
// shown elsewhere in the report (no AI writing — a template filled in from
// data, so every figure can be traced back to real records). Also builds
// the Recommendations list: each one only appears when the numbers that
// justify it are there, and quotes those numbers.
// School days in a year's terms up to today (all of them for a past year) —
// the base for "how often" figures, so holidays and weekends don't dilute them.
function schoolDaysSoFar(year) {
  const today = todayISO();
  let n = 0;
  computeMoeCalendar(year).terms.forEach((t) => {
    for (let d = t.start; d <= t.end && d <= today; d = addDays(d, 1)) if (!isNonSchoolDay(d, null)) n++;
  });
  return n;
}
// Each time out type on its own: how many, how many days served, how often
// (per school week), and the most students on that type on one day — what
// decides whether it needs a standing arrangement (a set room, a duty
// roster) rather than being arranged case by case. The type is what the
// student is kept out of (recess, lessons, CCA, a learning experience),
// not where the behaviour happened.
const TO_TYPE_FROM = { Recess: "recess", Lesson: "lessons", CCA: "CCA", LearningExperience: "learning experiences" };
function computeTimeOutTypeStats(year) {
  const recs = state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`));
  const schoolWeeks = schoolDaysSoFar(year) / 5;
  const typeOf = (t) => (TO_TYPES.some((x) => x.key === t.toType) ? t.toType : "Recess");
  const types = TO_TYPES.map((ty) => {
    const list = recs.filter((t) => typeOf(t) === ty.key);
    const perDay = {};
    let days = 0;
    list.forEach((t) => suspensionDayEntries(t).forEach((e) => { days++; perDay[e.date] = (perDay[e.date] || 0) + 1; }));
    return { key: ty.key, from: TO_TYPE_FROM[ty.key], count: list.length, days, perWeek: schoolWeeks > 0 ? list.length / schoolWeeks : 0, maxSameDay: Math.max(0, ...Object.values(perDay)) };
  });
  return { schoolWeeks, types };
}
function howOftenLabel(perWeek) {
  if (perWeek <= 0) return "";
  if (perWeek >= 1.05) return `about ${Math.round(perWeek * 10) / 10} a school week`;
  const every = Math.round(1 / perWeek);
  return every <= 1 ? "about once a school week" : `about once every ${every} school weeks`;
}
function computeYearInsights(year) {
  const n = computeYearNarrative(year);
  const totals = computeYearlyCategoryTotals(year);
  const last = computeYearlyCategoryTotals(year - 1);
  const cases = totals.discipline + totals.suspension + totals.timeOut;
  const casesLast = last.discipline + last.suspension + last.timeOut;
  const terms = n.startedTerms.map((t) => ({ ...t, cases: t.discipline + t.suspension + t.timeOut }));
  const months = computeYearMonthlyTrend(year).map((m) => ({ ...m, cases: m.discipline + m.suspension + m.timeOut }));
  const levels = computeYearLevelRanking(year);
  const classes = computeYearClassRanking(year);
  const dow = computeDayOfWeekPattern(year).filter((d) => d.day !== "Sat" && d.day !== "Sun");
  const pos = computeTermPositionPattern(year);
  const ru = computeRepeatVsUnique(year);
  const esc = computeEscalationRate(year);
  const suspIntervals = computeRepeatSuspensionIntervals(year);
  const suspRoster = computeYearSuspensionRoster(year);
  const toRoster = computeYearTimeOutRoster(year);
  const topIssue = computeTopGroomingIssueType(year);
  const suspReasons = computeTopReasons(state.suspensions, year);
  const toReasons = computeTopReasons(state.timeOuts, year);
  const yearTimeOuts = state.timeOuts.filter((t) => !t.deleted && t.startDate && t.startDate.startsWith(`${year}-`));
  const sections = [];
  const recs = [];
  if (cases + totals.parentMeeting === 0) {
    sections.push({ title: "Year at a glance", paras: [`No grooming, suspension, time out or parent meeting entries were logged for ${year}, so there's nothing to analyse yet.`] });
    recs.push("Keep logging every case as it happens, so next year's report has a full picture to work from.");
    return { sections, wentWell: [], toWatch: [], recs };
  }

  // Year at a glance
  sections.push({ title: "Year at a glance", paras: [
    `${year} recorded ${plural(cases, "discipline case")}: ${plural(totals.discipline, "grooming entry", "grooming entries")}, ${plural(totals.suspension, "suspension")} and ${plural(totals.timeOut, "time out")}.` +
    (n.soFar ? ` The year is still in progress, so these are figures to date.` : "") +
    (n.hasLastYear ? ` Overall cases are ${pctChangeLabel(casesLast, cases)} on ${year - 1}${n.soFar ? " (all of last year)" : ""}.` : ""),
  ] });

  // How the year unfolded
  const busiestTerm = terms.slice().sort((a, b) => b.cases - a.cases)[0];
  const quietestTerm = terms.slice().sort((a, b) => a.cases - b.cases)[0];
  const busiestMonth = months.slice().sort((a, b) => b.cases - a.cases)[0];
  const unfold = [];
  if (cases > 0 && busiestTerm && busiestTerm.cases > 0) {
    unfold.push(`Of the ${terms.length === 4 ? "four" : "completed"} terms, ${busiestTerm.label} was the busiest (${plural(busiestTerm.cases, "case")}, ${pctOf(busiestTerm.cases, cases)}% of the year's cases)` +
      (quietestTerm && quietestTerm.label !== busiestTerm.label ? ` and ${quietestTerm.label} the quietest (${quietestTerm.cases}).` : ".") +
      (busiestMonth && busiestMonth.cases > 0 ? ` The single busiest month was ${busiestMonth.label} with ${plural(busiestMonth.cases, "case")}.` : ""));
  }
  if (unfold.length) sections.push({ title: "How the year unfolded", paras: unfold });

  // Compared with last year
  sections.push({ title: `Compared with ${year - 1}`, paras: [n.acrossYears] });

  // Where cases concentrated
  const where = [];
  if (cases > 0) {
    if (levels[0] && levels[0].total > 0) where.push(`${levels[0].label} had the most cases of any level (${levels[0].total}, ${pctOf(levels[0].total, cases)}% of the year).`);
    if (classes[0]) where.push(`The most-flagged class was ${classes[0].label} (${classes[0].total}, ${pctOf(classes[0].total, cases)}%)${classes[1] ? `, followed by ${classes[1].label} (${classes[1].total})` : ""}.`);
    const weekTotal = dow.reduce((s2, d) => s2 + d.count, 0);
    const busiestDay = dow.slice().sort((a, b) => b.count - a.count)[0];
    if (weekTotal > 0) where.push(`${busiestDay.day === "Mon" ? "Monday" : busiestDay.day === "Tue" ? "Tuesday" : busiestDay.day === "Wed" ? "Wednesday" : busiestDay.day === "Thu" ? "Thursday" : "Friday"} was the busiest school day (${pctOf(busiestDay.count, weekTotal)}% of weekday incidents).`);
  }
  if (where.length) sections.push({ title: "Where cases concentrated", paras: [where.join(" ")] });

  // Students involved
  const who = [];
  const suspRepeatCount = suspRoster.filter((r) => r.count > 1).reduce((s2, r) => s2 + r.count, 0);
  const toRepeatCount = toRoster.filter((r) => r.count > 1).reduce((s2, r) => s2 + r.count, 0);
  if (ru.suspension.totalCount > 0) who.push(`${plural(ru.suspension.uniqueStudents, "student")} ${ru.suspension.uniqueStudents === 1 ? "was" : "were"} suspended${ru.suspension.repeatStudents > 0 ? `; the ${plural(ru.suspension.repeatStudents, "student")} suspended more than once ${ru.suspension.repeatStudents === 1 ? "accounts" : "account"} for ${pctOf(suspRepeatCount, ru.suspension.totalCount)}% of all suspensions` : ", none more than once"}.`);
  if (ru.timeOut.totalCount > 0) who.push(`${plural(ru.timeOut.uniqueStudents, "student")} ${ru.timeOut.uniqueStudents === 1 ? "was" : "were"} given a time out${ru.timeOut.repeatStudents > 0 ? `; repeat students account for ${pctOf(toRepeatCount, ru.timeOut.totalCount)}% of time outs` : ", none more than once"}.`);
  if (ru.grooming.totalCount > 0) who.push(`${plural(ru.grooming.uniqueStudents, "student")} had grooming issues logged${ru.grooming.repeatStudents > 0 ? `, ${ru.grooming.repeatStudents} of them more than once` : ""}.`);
  const minGap = suspIntervals.length ? Math.min(...suspIntervals.map((r) => r.shortestGap)) : null;
  if (minGap !== null) who.push(`The shortest gap between two suspensions for the same student was ${plural(minGap, "day")}.`);
  if (who.length) sections.push({ title: "Students involved", paras: [who.join(" ")] });

  // Grooming
  const groom = [];
  if (esc) {
    if (topIssue) groom.push(`The most common grooming issue was ${topIssue.type} (${topIssue.count} of ${esc.total} issues, ${pctOf(topIssue.count, esc.total)}%).`);
    groom.push(`${esc.pct1st}% of issues were settled at 1st Warning, ${esc.pct2nd}% reached 2nd Warning and ${esc.pctFinal}% reached Final Warning.`);
  }
  if (groom.length) sections.push({ title: "Grooming", paras: [groom.join(" ")] });

  // Suspensions and time outs
  const serious = [];
  if (suspReasons.length) serious.push(`The most common reason for suspension was ${suspReasons[0].reason} (${plural(suspReasons[0].count, "suspension")})${suspReasons[1] ? `, then ${suspReasons[1].reason} (${suspReasons[1].count})` : ""}.`);
  if (toReasons.length) serious.push(`For time outs it was ${toReasons[0].reason} (${toReasons[0].count}).`);
  if (serious.length) sections.push({ title: "Suspensions and time outs", paras: [serious.join(" ")] });
  if (totals.parentMeeting > 0) {
    const pmTop = computeReportPmReasons(year)[0];
    sections.push({ title: "Parent meetings", paras: [`${plural(totals.parentMeeting, "parent meeting")} ${totals.parentMeeting === 1 ? "was" : "were"} held${totals.suspension > 0 ? `, against ${plural(totals.suspension, "suspension")}` : ""}.${pmTop ? ` The most common reason was ${pmTop.cat} (${pmTop.count}).` : ""}`] });
  }

  // Time outs by type — each type's own count and frequency.
  const toStats = computeTimeOutTypeStats(year);
  if (yearTimeOuts.length) {
    const wk = Math.round(toStats.schoolWeeks);
    sections.push({
      title: "Time outs by type",
      paras: [`Over ${plural(wk, "school week")}${n.soFar ? " so far" : ""}: ` + toStats.types.filter((t) => t.count > 0).map((t) => `from ${t.from} ${t.count} (${howOftenLabel(t.perWeek)}${t.maxSameDay >= 2 ? `, up to ${t.maxSameDay} on one day` : ""})`).join("; ") + "."],
    });
  }

  // What went well / areas to watch
  const wentWell = n.improvements.map((x) => x.charAt(0).toUpperCase() + x.slice(1) + ".");
  if (esc && esc.pct1st >= 70) wentWell.push(`Most grooming issues (${esc.pct1st}%) were settled at 1st Warning.`);
  if (ru.suspension.totalCount > 0 && ru.suspension.repeatStudents === 0) wentWell.push("No student was suspended more than once.");
  const toWatch = n.concerns.map((x) => x.charAt(0).toUpperCase() + x.slice(1) + ".");

  // Recommendations — only where the numbers call for it.
  const suspRepeatShare = pctOf(suspRepeatCount, ru.suspension.totalCount);
  if (ru.suspension.repeatStudents > 0 && suspRepeatShare >= 30) recs.push(`Put an individual support plan in place for the ${plural(ru.suspension.repeatStudents, "student")} suspended more than once — they account for ${suspRepeatShare}% of this year's suspensions. For example: regular check-ins with one named staff member, and involving parents early.`);
  if (minGap !== null && minGap <= 30) recs.push(`At least one student was suspended again within ${plural(minGap, "day")}. Consider a re-entry meeting after every suspension and closer follow-up in the first weeks back.`);
  // A time out type happening every school week or more is frequent enough
  // to warrant a standing arrangement rather than arranging each one ad hoc.
  const STRUCTURE = {
    Recess: "a fixed supervised room and a recess duty roster",
    Lesson: "a set place and a timetabled duty teacher for students taken out of lessons",
    CCA: "a set place and a named supervisor for students kept out of CCA",
    LearningExperience: "a set plan for who supervises students kept out of learning experiences",
  };
  toStats.types.filter((t) => t.count > 0 && t.perWeek >= 1).forEach((t) => recs.push(`Time outs from ${t.from} averaged ${Math.round(t.perWeek * 10) / 10} a school week${t.maxSameDay >= 2 ? `, with up to ${t.maxSameDay} students on the same day` : ""}. At that frequency, a standing arrangement — ${STRUCTURE[t.key]} — may work better than arranging each one as it comes.`));
  if (totals.suspension > 0 && totals.parentMeeting < totals.suspension) recs.push(`Only ${plural(totals.parentMeeting, "parent meeting")} ${totals.parentMeeting === 1 ? "was" : "were"} logged against ${plural(totals.suspension, "suspension")}. Consider meeting parents after every suspension, and logging the meeting so it counts here.`);
  if (esc && esc.pctFinal >= 20) recs.push(`${esc.pctFinal}% of grooming issues went all the way to Final Warning. Contacting parents earlier, at 1st or 2nd Warning, may stop more of them before they escalate.`);
  if (topIssue && esc && topIssue.count >= 3 && pctOf(topIssue.count, esc.total) >= 30) recs.push(`${topIssue.type} made up ${pctOf(topIssue.count, esc.total)}% of grooming issues. A reminder about it before each term starts (at assembly or through form teachers) could cut repeat cases.`);
  if (suspReasons.length && suspReasons[0].count >= 2 && pctOf(suspReasons[0].count, totals.suspension) >= 40) recs.push(`${suspReasons[0].reason} was behind ${pctOf(suspReasons[0].count, totals.suspension)}% of suspensions. A programme aimed at this behaviour${/fight|assault|aggress|bully/i.test(suspReasons[0].reason) ? " (for example conflict resolution or peer mediation)" : ""} could be worth planning for next year.`);
  const posTotal = pos.Early + pos.Mid + pos.Late;
  if (posTotal >= 5) {
    const [pk, pv] = Object.entries(pos).sort((a, b) => b[1] - a[1])[0];
    if (pctOf(pv, posTotal) >= 45) recs.push(pk === "Late" ? `${pctOf(pv, posTotal)}% of incidents came in the last third of a term. Plan extra reminders and supervision for the final weeks of each term.` : pk === "Early" ? `${pctOf(pv, posTotal)}% of incidents came in the first third of a term. Setting expectations clearly in the first week back may help.` : `${pctOf(pv, posTotal)}% of incidents came mid-term. Keep reminders going through the middle weeks, not just at the start.`);
  }
  const weekTotal = dow.reduce((s2, d) => s2 + d.count, 0);
  const busiestDay = dow.slice().sort((a, b) => b.count - a.count)[0];
  if (weekTotal >= 5 && pctOf(busiestDay.count, weekTotal) >= 30) {
    const dayName = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" }[busiestDay.day];
    recs.push(`${dayName} had ${pctOf(busiestDay.count, weekTotal)}% of weekday incidents. It may help to look at what's different on ${dayName}s — for example the timetable, PE or CCA, or recess arrangements.`);
  }
  if (classes[0] && classes[0].total >= 5 && pctOf(classes[0].total, cases) >= 20) recs.push(`${classes[0].label} accounted for ${pctOf(classes[0].total, cases)}% of cases. Consider a class-level plan with its form teachers.`);
  if (levels[0] && levels[0].total >= 5 && pctOf(levels[0].total, cases) >= 30) recs.push(`${levels[0].label} accounted for ${pctOf(levels[0].total, cases)}% of cases. A level-wide talk or programme may reach more students than following up case by case.`);
  if (busiestTerm && cases >= 5 && pctOf(busiestTerm.cases, cases) >= 40) recs.push(`${busiestTerm.label} had ${pctOf(busiestTerm.cases, cases)}% of the year's cases. Plan ahead for the same period next year.`);
  if (n.hasLastYear && casesLast > 0 && cases > casesLast && pctOf(cases - casesLast, casesLast) >= 20) recs.push(`Cases rose ${pctOf(cases - casesLast, casesLast)}% on ${year - 1}. Before planning next year, it's worth reviewing what changed between the two years (programmes, staffing or the cohort).`);
  if (!recs.length) recs.push("Nothing in this year's numbers stands out as needing a change. Keep logging consistently so next year's comparison is meaningful.");
  // Listed most-important first; kept to the top seven so it stays actionable.
  return { sections, wentWell, toWatch, recs: recs.slice(0, 7) };
}
function renderTrendAnalysis(year) {
  const ins = computeYearInsights(year);
  const p = (t) => `<p class="dd-sans dd-ta-p">${escapeHtml(t)}</p>`;
  const list = (items) => `<ul class="dd-ta-list">${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  return `
      ${reportSectionTitle("Trend Analysis")}
      <div class="dd-panel dd-ta-panel">
        ${ins.sections.map((sct) => `<div class="dd-ta-head">${escapeHtml(sct.title)}</div>${sct.paras.map(p).join("")}${sct.list ? list(sct.list) : ""}`).join("")}
        ${ins.wentWell.length ? `<div class="dd-ta-head">What went well</div>${list(ins.wentWell)}` : ""}
        ${ins.toWatch.length ? `<div class="dd-ta-head">Areas to watch</div>${list(ins.toWatch)}` : ""}
      </div>`;
}

// Per-student tally for any start-dated log (suspensions or time outs).
function computeYearRoster(records, year) {
  const rows = {};
  records.forEach((s) => {
    if (s.deleted || !s.startDate || !s.startDate.startsWith(`${year}-`)) return;
    // One row per student: classes confirmed as a mid-year class change
    // count as one student (shown under the latest class).
    const key = `${normalizeName(s.studentName)}|${normCls(sameYearGroup(year, s.studentName, s.studentClass || "")[0])}`;
    rows[key] = rows[key] || { name: s.studentName, cls: s.studentClass, count: 0, last: "" };
    if (s.startDate >= rows[key].last) { rows[key].cls = s.studentClass; rows[key].last = s.startDate; }
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
    const key = `${normalizeName(it.studentName)}|${normCls(sameYearGroup(year, it.studentName, it.studentClass || "")[0])}`;
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
// ---- Annual Report line charts (same look as the dashboard graphs) ----
// Five lines (Grooming, Parent Meet, Time Out, In-/Out-of-School
// Suspension) on an even scale, drawn as a fixed-size SVG so it prints and
// exports to PDF like the other report chart. No numbers on the points
// (they'd pile up); `totals` adds one row of totals under the labels.
// Points whose period hasn't started (`r.future`) are left off the lines.
// Parent meetings have their own page, so these charts show the four
// discipline lines only.
function reportLines() { return TREND_LINES.filter((l) => l.cat !== "parentMeeting"); }
function renderReportLineChart(rows, { totals = false } = {}) {
  if (!rows.length) return `<div class="dd-dash-empty">No data for this period.</div>`;
  const lines = reportLines();
  const W = 320, padL = 24, padR = 10, padT = 10, padB = totals ? 30 : 18;
  const plotH = 86, H = padT + plotH + padB, plotW = W - padL - padR;
  const n = rows.length;
  const lastPast = rows.reduce((acc, r, i) => (r.future ? acc : i), -1);
  const maxV = Math.max(1, ...rows.slice(0, lastPast + 1).flatMap((r) => lines.map((l) => r[l.key] || 0)));
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((st) => Math.ceil(maxV / st) <= 5) || Math.ceil(maxV / 5);
  const axisMax = Math.max(tickStep, Math.ceil(maxV / tickStep) * tickStep);
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, i) => i * tickStep);
  const x = (i) => (n === 1 ? padL + plotW / 2 : padL + 6 + (i * (plotW - 12)) / (n - 1));
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const font = `font-family="Geist, system-ui, -apple-system, sans-serif"`;
  const grid = ticks.map((t) => `
    <line x1="${padL}" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="${t === 0 ? "#C9C4B4" : "#E4E1D4"}" stroke-width="1"></line>
    <text x="${padL - 5}" y="${y(t) + 3}" text-anchor="end" font-size="8" ${font} fill="#8A8571">${t}</text>`).join("");
  const xLabels = rows.map((r, i) => `<text x="${x(i)}" y="${padT + plotH + 11}" text-anchor="middle" font-size="8" ${font} fill="${r.future ? "#B5B09F" : "#6B6652"}">${escapeHtml(r.label)}</text>`).join("");
  const totalRow = totals ? `<text x="2" y="${padT + plotH + 24}" font-size="7.5" font-weight="600" ${font} fill="#8A8571">Total</text>` +
    rows.map((r, i) => (r.future ? "" : `<text x="${x(i)}" y="${padT + plotH + 24}" text-anchor="middle" font-size="8" font-weight="700" ${font} fill="#1B2A41">${(r.discipline || 0) + (r.suspension || 0) + (r.timeOut || 0)}</text>`)).join("") : "";
  const paths = lines.map((l) => `
    ${lastPast > 0 ? `<polyline points="${rows.slice(0, lastPast + 1).map((r, i) => `${x(i)},${y(r[l.key] || 0)}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></polyline>` : ""}
    ${rows.map((r, i) => (i <= lastPast && ((r[l.key] || 0) > 0 || lastPast === 0) ? `<circle cx="${x(i)}" cy="${y(r[l.key] || 0)}" r="1.9" fill="${l.color}"></circle>` : "")).join("")}`).join("");
  const legendRow = (ls) => `<div class="dd-cal-legend dd-trend-legend dd-report-lines-legend">${ls.map((l) => `<div class="dd-cal-legend-item"><span class="dd-legend-line" style="background:${l.color}"></span>${l.label}</div>`).join("")}</div>`;
  return `
    <div class="dd-area-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="dd-area-chart" preserveAspectRatio="xMidYMid meet">${grid}${xLabels}${totalRow}${paths}</svg>
      <div class="dd-report-lines-legends">
        ${legendRow(lines.filter((l) => l.cat !== "suspension"))}
        ${legendRow(lines.filter((l) => l.cat === "suspension"))}
      </div>
    </div>`;
}
// One point per term, counted within each term's dates (as in the By term
// table on page 1). Terms that haven't started are left off.
function computeReportTermLines(year) {
  const today = todayISO();
  const terms = computeMoeCalendar(year).terms;
  return computeTrendSeries(terms.map((t, i) => ({ start: t.start, end: t.end, label: `Term ${i + 1}` })))
    .map((r) => ({ ...r, future: r.start > today }));
}
// Week 1–10 of the term, with all four terms added together — to show
// whether the same weeks are busy every term (e.g. around exams).
function computeReportWeekOfTermLines(year) {
  const terms = computeMoeCalendar(year).terms;
  const weeks = Math.max(...terms.map((t) => Math.ceil((daysBetween(t.start, t.end) + 1) / 7)));
  const sum = Array.from({ length: weeks }, (_, w) => ({ label: `W${w + 1}`, discipline: 0, iss: 0, oss: 0, suspension: 0, timeOut: 0, parentMeeting: 0 }));
  // Each term's own total per week (null = that week hasn't started yet),
  // for the grid under the chart.
  const today = todayISO();
  const perTerm = terms.map(() => Array.from({ length: weeks }, () => null));
  terms.forEach((t, ti) => {
    const buckets = [];
    for (let w = 0; w < weeks; w++) {
      const st = addDays(t.start, w * 7);
      if (st > t.end) break;
      const en = addDays(st, 6) > t.end ? t.end : addDays(st, 6);
      buckets.push({ start: st, end: en, w });
    }
    computeTrendSeries(buckets).forEach((r) => {
      ["discipline", "iss", "oss", "suspension", "timeOut", "parentMeeting"].forEach((k) => { sum[r.w][k] += r[k]; });
      if (r.start <= today) perTerm[ti][r.w] = r.discipline + r.suspension + r.timeOut;
    });
  });
  sum.perTerm = perTerm;
  return sum;
}
// Week × term grid under the week chart: how much each term adds to each
// week, so one unusually bad term doesn't pass for a pattern. Darker = more.
// "–" = that week hasn't happened yet.
function renderReportWeekTermGrid(rows) {
  const perTerm = rows.perTerm || [];
  const weeks = rows.length;
  const max = Math.max(1, ...perTerm.flat().filter((v) => v !== null));
  const shade = (v) => {
    if (v === null) return `class="dd-wg-na"`;
    if (!v) return "";
    const a = 0.1 + 0.55 * (v / max);
    return `style="background:rgba(27,42,65,${a.toFixed(2)});${a > 0.42 ? "color:#fff;" : ""}"`;
  };
  const colTotal = (w) => perTerm.reduce((a, row) => a + (row[w] || 0), 0);
  const rowTotal = (row) => row.reduce((a, v) => a + (v || 0), 0);
  return `
    <table class="dd-wg">
      <thead><tr><th></th>${rows.map((r) => `<th>${r.label}</th>`).join("")}<th class="dd-wg-tot">Total</th></tr></thead>
      <tbody>
        ${perTerm.map((row, ti) => `<tr><th>T${ti + 1}</th>${row.map((v) => `<td ${shade(v)}>${v === null ? "–" : v}</td>`).join("")}<td class="dd-wg-tot">${row.every((v) => v === null) ? "–" : rowTotal(row)}</td></tr>`).join("")}
      </tbody>
      <tfoot><tr><th>Total</th>${Array.from({ length: weeks }, (_, w) => `<td>${colTotal(w)}</td>`).join("")}<td class="dd-wg-tot">${perTerm.reduce((a, row) => a + rowTotal(row), 0)}</td></tr></tfoot>
    </table>`;
}
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
          <text x="${padL - 5}" y="${y(t) + 3}" text-anchor="end" font-size="8" font-family="Geist, system-ui, -apple-system, sans-serif" fill="#8A8571">${t}</text>`).join("")}
        <polygon points="${areaFor(grooming, zeros)}" fill="${CHART_COLORS.discipline}" fill-opacity="0.75"></polygon>
        <polygon points="${areaFor(groomPlusSusp, grooming)}" fill="${OSS_DOT_COLOR}" fill-opacity="0.85"></polygon>
        <polygon points="${areaFor(totals, groomPlusSusp)}" fill="${CHART_COLORS.timeOut}" fill-opacity="0.85"></polygon>
        <polyline points="${lineFor(totals)}" fill="none" stroke="${CHART_COLORS.timeOut}" stroke-width="1.5"></polyline>
        <polyline points="${lineFor(groomPlusSusp)}" fill="none" stroke="${OSS_DOT_COLOR}" stroke-width="1.5"></polyline>
        <polyline points="${lineFor(grooming)}" fill="none" stroke="${CHART_COLORS.discipline}" stroke-width="1.5"></polyline>
        ${totals.map((t, i) => `<circle cx="${x(i)}" cy="${y(t)}" r="2.2" fill="#FBFAF6" stroke="${CHART_COLORS.timeOut}" stroke-width="1.3"></circle>`).join("")}
        ${totals.map((t, i) => t > 0
          ? `<text x="${x(i)}" y="${y(t) - 6}" text-anchor="middle" font-size="9" font-weight="700" font-family="Geist, system-ui, -apple-system, sans-serif" fill="#1B2A41">${t}</text>`
          : "").join("")}
        ${rows.map((r, i) => i % labelEvery === 0
          ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="8" font-family="Geist, system-ui, -apple-system, sans-serif" fill="#8A8571">${escapeHtml(String(r.label).slice(0, 3))}</text>`
          : "").join("")}
      </svg>
      <div class="dd-cal-legend dd-trend-legend" style="margin-top:8px;padding-top:8px">
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${CHART_COLORS.discipline}"></span>Grooming</div>
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${OSS_DOT_COLOR}"></span>Suspension</div>
        <div class="dd-cal-legend-item"><span class="dd-legend-swatch" style="background:${CHART_COLORS.timeOut}"></span>Time Out</div>
      </div>
    </div>`;
}
// Exact per-month figures to accompany the trend chart. Parent meetings
// have their own page in the report, so they're not in this table.
function renderMonthlyBreakdownTable(rows) {
  const withData = rows.filter((r) => r.discipline + r.suspension + (r.timeOut || 0) > 0);
  if (!withData.length) return `<div class="dd-dash-empty">Nothing logged this year yet.</div>`;
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return `
    <div class="dd-level-breakdown dd-level-breakdown-monthly" style="margin-top:10px">
      <div class="dd-level-row dd-level-row-header">
        <div class="dd-level-cell-class">Month</div>
        <div class="dd-level-cell-term">Grooming</div>
        <div class="dd-level-cell-term">Suspension</div>
        <div class="dd-level-cell-term">Time Out</div>
      </div>
      ${withData.map((r) => `
      <div class="dd-level-row">
        <div class="dd-level-cell-class">${escapeHtml(r.label)}</div>
        <div class="dd-level-cell-term">${r.discipline}</div>
        <div class="dd-level-cell-term">${r.suspension}</div>
        <div class="dd-level-cell-term">${r.timeOut || 0}</div>
      </div>`).join("")}
      <div class="dd-level-row dd-level-row-total">
        <div class="dd-level-cell-class">Total</div>
        <div class="dd-level-cell-term">${sum("discipline")}</div>
        <div class="dd-level-cell-term">${sum("suspension")}</div>
        <div class="dd-level-cell-term">${sum("timeOut")}</div>
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
// ---------- Annual Summary report ----------
// The report is laid out as six pages. On screen they simply follow one
// another; when printing each starts on a new sheet, and Export PDF puts
// each on its own A4 page:
//   1. Annual summary + By term
//   2. Discipline load by month
//   3. By term (chart) + By position within term + By day of week
//   4. Repeat vs. unique students + Grooming escalation rate + repeat intervals
//   5. Most challenging levels + classes (+ this year's suspension/time out lists)
//   6. Parent meetings (by month, by term, reasons)
//   7. Trend analysis + Recommendations
const ICON_PRINTER = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"></path><rect x="4" y="9" width="16" height="8" rx="1.5"></rect><path d="M6 14h12v7H6z"></path></svg>`;
const ICON_DOCUMENT = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h6"></path></svg>`;
function reportSectionTitle(text) {
  return `<div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:16px 0 8px">${text}</div>`;
}
function renderReportByTermTable(year) {
  const termRows = computeYearTermTrend(year);
  const rowTotal = (t) => t.discipline + t.suspension + t.timeOut + t.parentMeeting;
  const grandDiscipline = termRows.reduce((s, t) => s + t.discipline, 0);
  const grandSuspension = termRows.reduce((s, t) => s + t.suspension, 0);
  const grandToByType = {};
  TO_TYPES.forEach((ty) => { grandToByType[ty.key] = termRows.reduce((s, t) => s + (t.timeOutByType[ty.key] || 0), 0); });
  const grandMeeting = termRows.reduce((s, t) => s + t.parentMeeting, 0);
  const grandTotal = termRows.reduce((s, t) => s + rowTotal(t), 0);
  return `
      <div class="dd-level-breakdown dd-level-breakdown-byterm">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class">Term</div>
          <div class="dd-level-cell-term dd-level-cell-term-groom" style="color:${CHART_COLORS.discipline}">Groom</div>
          <div class="dd-level-cell-term dd-level-cell-term-susp" style="color:${CHART_COLORS.suspension}">Susp</div>
          <div class="dd-level-cell-term dd-level-cell-term-timeout dd-level-cell-term-timeout-first dd-byterm-to-head" style="color:${CHART_COLORS.timeOut}">Time Out</div>
          <div class="dd-level-cell-term dd-level-cell-term-meet" style="color:${CHART_COLORS.parentMeeting}">Meet</div>
          <div class="dd-level-cell-term dd-level-cell-term-total">Total</div>
        </div>
        <div class="dd-level-row dd-level-row-header dd-level-row-subheader">
          <div class="dd-level-cell-class"></div>
          <div class="dd-level-cell-term dd-level-cell-term-groom"></div><div class="dd-level-cell-term dd-level-cell-term-susp"></div>
          ${TO_TYPES.map((t, i) => `<div class="dd-level-cell-term dd-level-cell-term-sub dd-level-cell-term-timeout${i === 0 ? " dd-level-cell-term-timeout-first" : ""}" style="color:${CHART_COLORS.timeOut}">${t.abbrev}</div>`).join("")}
          <div class="dd-level-cell-term dd-level-cell-term-meet"></div>
          <div class="dd-level-cell-term dd-level-cell-term-total"></div>
        </div>
        ${termRows.map((t) => `
          <div class="dd-level-row">
            <div class="dd-level-cell-class">${t.label.replace("Term ", "T")}</div>
            <div class="dd-level-cell-term dd-level-cell-term-groom">${t.discipline}</div><div class="dd-level-cell-term dd-level-cell-term-susp">${t.suspension}</div>
            ${TO_TYPES.map((ty, i) => `<div class="dd-level-cell-term dd-level-cell-term-sub dd-level-cell-term-timeout${i === 0 ? " dd-level-cell-term-timeout-first" : ""}">${t.timeOutByType[ty.key] || 0}</div>`).join("")}
            <div class="dd-level-cell-term dd-level-cell-term-meet">${t.parentMeeting}</div>
            <div class="dd-level-cell-term dd-level-cell-term-total">${rowTotal(t)}</div>
          </div>`).join("")}
        <div class="dd-level-row dd-level-row-total">
          <div class="dd-level-cell-class">Total</div>
          <div class="dd-level-cell-term dd-level-cell-term-groom">${grandDiscipline}</div><div class="dd-level-cell-term dd-level-cell-term-susp">${grandSuspension}</div>
          ${TO_TYPES.map((ty, i) => `<div class="dd-level-cell-term dd-level-cell-term-sub dd-level-cell-term-timeout${i === 0 ? " dd-level-cell-term-timeout-first" : ""}">${grandToByType[ty.key]}</div>`).join("")}
          <div class="dd-level-cell-term dd-level-cell-term-meet">${grandMeeting}</div>
          <div class="dd-level-cell-term dd-level-cell-term-total">${grandTotal}</div>
        </div>
      </div>`;
}
function renderReportIntervalsTable(list) {
  return `
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
}
function renderReportBar(label, count, max, color) {
  return `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div class="dd-mono-muted" style="font-size:11px;width:34px;flex-shrink:0">${label}</div>
            <div style="flex:1;background:#F2EFE6;border-radius:2px;overflow:hidden;height:14px">
              <div style="width:${Math.max(count > 0 ? 4 : 0, (count / max) * 100)}%;height:100%;background:${color}"></div>
            </div>
            <div class="dd-mono-muted" style="font-size:11px;width:18px;text-align:right;flex-shrink:0">${count}</div>
          </div>`;
}
function renderReportRoster(roster, noun, emptyText) {
  if (!roster.length) return `<div class="dd-dash-empty">${emptyText}</div>`;
  return `<div style="display:flex;flex-direction:column;gap:6px">
          ${roster.map((r) => `
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #E4E1D4;padding-bottom:6px">
              <div class="dd-sans" style="font-size:14px">${escapeHtml(truncateName(r.name))}${r.cls ? ` <span class="dd-mono-muted" style="font-size:11px">Class ${escapeHtml(r.cls)}</span>` : ""}</div>
              <span class="dd-mono-muted" style="font-size:12px">${r.count} ${noun}${r.count === 1 ? "" : "s"}</span>
            </div>`).join("")}
        </div>`;
}
// Export PDF: draws each report page exactly as printing lays it out, and
// puts each on its own A4 page. Printing to A4 with 12mm margins gives a
// 703px-wide page, and the tablet-size 1.25x enlargement applies in print
// too, so the report is laid out 562px wide there — the copy used for the
// PDF is drawn at that same width, with the print styling (no header or
// buttons, white background). The two libraries live in /lib (so it works
// offline) and only load the first time Export PDF is used.
const PDF_LAYOUT_WIDTH = 562;
const PDF_LAYOUT_HEIGHT = 826;
const loadedScripts = {};
function loadScriptOnce(src) {
  if (!loadedScripts[src]) {
    loadedScripts[src] = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src; el.onload = resolve;
      el.onerror = () => { delete loadedScripts[src]; reject(new Error("couldn't load the PDF tools — check your connection and try again")); };
      document.head.appendChild(el);
    });
  }
  return loadedScripts[src];
}
// The app's own font, embedded into the chart's SVG while it's drawn for the
// PDF (an SVG turned into a picture can't reach the page's fonts).
let pdfFontCss = null;
async function loadPdfFontCss() {
  if (pdfFontCss !== null) return pdfFontCss;
  const b64 = async (url) => { const buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(bin); };
  try {
    const [w400, w700] = await Promise.all([b64("./fonts/geist-400.woff2"), b64("./fonts/geist-700.woff2")]);
    pdfFontCss = `@font-face{font-family:'Geist';font-weight:400;src:url(data:font/woff2;base64,${w400}) format('woff2')}@font-face{font-family:'Geist';font-weight:700;src:url(data:font/woff2;base64,${w700}) format('woff2')}`;
  } catch { pdfFontCss = ""; }
  return pdfFontCss;
}
// Where a report page can be split across sheets, the way printing does it:
// between blocks (a panel, table or chart stays whole unless it's taller
// than a sheet, in which case it splits between its lines), and never
// straight after a section heading.
function pdfBreakUnits(group, pageH) {
  const top0 = group.getBoundingClientRect().top;
  const unitOf = (el) => { const r = el.getBoundingClientRect(); return { top: r.top - top0, bottom: r.bottom - top0, keepWithNext: el.matches(".dd-dash-title, .dd-ta-head, .dd-report-heading, .dd-rep-group-head") }; };
  const flatten = (el) => {
    const u = unitOf(el);
    const kids = [...el.children].filter((k) => k.getBoundingClientRect().height > 0);
    // Grouped lists always break between rows (a row of 3 shares one top and
    // bottom, so the cut falls under the whole row), so a long list starts
    // right after the section above it instead of jumping to a new sheet.
    if (el.matches(".dd-rep-groups, .dd-rep-group, .dd-rep-grid3") && kids.length) return kids.flatMap(flatten);
    if (u.bottom - u.top <= pageH || !kids.length) return [u];
    return kids.flatMap((k) => (k.matches("ul, ol") ? [...k.children].flatMap(flatten) : flatten(k)));
  };
  return [...group.children].filter((k) => k.getBoundingClientRect().height > 0).flatMap(flatten);
}
function pdfPageSlices(units, total, pageH) {
  const slices = [];
  let start = 0, i = 0;
  while (i < units.length && start < total - 1) {
    const pageEnd = start + pageH;
    let j = i, lastCut = -1;
    while (j < units.length && units[j].bottom <= pageEnd + 0.5) { if (!units[j].keepWithNext) lastCut = j; j++; }
    if (j >= units.length && total <= pageEnd + 0.5) { slices.push([start, total]); return slices; }
    if (lastCut < i) { slices.push([start, pageEnd]); start = pageEnd; while (i < units.length && units[i].bottom <= start) i++; continue; }
    const cut = units[lastCut + 1] ? units[lastCut + 1].top : total;
    slices.push([start, cut]); start = cut; i = lastCut + 1;
  }
  if (start < total - 1) slices.push([start, total]);
  return slices;
}
// On tablet/desktop the whole app is enlarged with CSS zoom, which the
// capture tool doesn't understand (it measured words slightly wrong, e.g.
// "TIMEOUT", "In -School"). So the enlargement is switched off just for
// the capture and put back afterwards — the PDF is laid out at its own
// fixed width either way, so it comes out the same from any device.
async function exportAnnualReportPdf(year) {
  const prevZoom = document.body.style.zoom;
  document.body.style.zoom = "1";
  try { return await exportAnnualReportPdfInner(year); }
  finally { document.body.style.zoom = prevZoom; }
}
async function exportAnnualReportPdfInner(year) {
  await loadScriptOnce("./lib/html2canvas.min.js");
  await loadScriptOnce("./lib/jspdf.umd.min.js");
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const fontCss = await loadPdfFontCss();
  const pages = [...document.querySelectorAll("#report-print-area .dd-report-page")];
  if (!pages.length) throw new Error("nothing to export");
  const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  const M = 12, W = 210 - 2 * M, H = 297 - 2 * M;
  const SCALE = 2.5;
  let first = true;
  for (const group of pages) {
    let measured = null;
    const canvas = await window.html2canvas(group, {
      scale: SCALE, backgroundColor: "#ffffff", logging: false,
      windowWidth: PDF_LAYOUT_WIDTH, windowHeight: PDF_LAYOUT_HEIGHT,
      onclone: (doc, el) => {
        doc.documentElement.classList.add("dd-pdf-render");
        // The copy loses the charts' class-based sizing, so restate it inline
        // before anything is measured.
        el.querySelectorAll("svg.dd-area-chart, .dd-area-chart-wrap > svg").forEach((svg) => { svg.style.width = "100%"; svg.style.height = "auto"; svg.style.display = "block"; });
        const r = el.getBoundingClientRect();
        const pageH = (H / W) * r.width;
        measured = { width: r.width, slices: pdfPageSlices(pdfBreakUnits(el, pageH), r.height, pageH) };
        // Charts (SVG with text): drawn here onto a canvas at their laid-out
        // size, with the app's font embedded — left as SVG they'd come out at
        // their small built-in size in a system font.
        const charts = [...el.querySelectorAll("svg")].filter((svg) => svg.querySelector("text"));
        return Promise.all(charts.map((svg) => new Promise((resolve) => {
          const cr = svg.getBoundingClientRect();
          if (!cr.width) return resolve();
          const copy = svg.cloneNode(true);
          copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          copy.setAttribute("width", cr.width); copy.setAttribute("height", cr.height);
          if (fontCss) { const st = doc.createElementNS("http://www.w3.org/2000/svg", "style"); st.textContent = fontCss; copy.insertBefore(st, copy.firstChild); }
          const img = new Image();
          img.onload = () => setTimeout(() => {
            const cv = doc.createElement("canvas");
            cv.width = Math.round(cr.width * SCALE); cv.height = Math.round(cr.height * SCALE);
            cv.style.width = `${cr.width}px`; cv.style.height = `${cr.height}px`; cv.style.display = "block";
            cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
            svg.replaceWith(cv);
            resolve();
          }, 50);
          img.onerror = () => resolve();
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
        })));
      },
    });
    const pxPerCss = canvas.width / measured.width;
    const mmPerCss = W / measured.width;
    for (const [a, b] of measured.slices) {
      const sy = Math.round(a * pxPerCss), sh = Math.min(canvas.height - sy, Math.round((b - a) * pxPerCss));
      if (sh <= 0) continue;
      const part = document.createElement("canvas");
      part.width = canvas.width; part.height = sh;
      const ctx = part.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(part.toDataURL("image/jpeg", 0.9), "JPEG", M, M, W, (sh / pxPerCss) * mmPerCss);
    }
  }
  pdf.save(`Annual Summary ${year}.pdf`);
}
// ---- Annual Report: Parent meetings page ----
// Meetings held per month, up to today (by the date they happen — a postponed meeting
// counts on its new date; cancelled ones and postponed ones still waiting
// for a date don't count), shown as vertical bars with the number on top.
function computeReportPmMonthly(year) {
  const today = todayISO();
  return Array.from({ length: 12 }, (_, i) => {
    const mk = `${year}-${String(i + 1).padStart(2, "0")}`;
    return {
      label: MONTH_ABBR[i],
      count: state.parentMeetings.filter((m) => isPmCounted(m) && pmDate(m) <= today && monthKey(pmDate(m)) === mk).length,
      future: `${mk}-01` > today,
    };
  });
}
function renderReportPmBars(rows) {
  const W = 320, padL = 22, padR = 6, padT = 14, padB = 16, plotH = 58, H = padT + plotH + padB;
  const plotW = W - padL - padR, n = rows.length, slot = plotW / n, barW = Math.min(16, slot * 0.6);
  const maxV = Math.max(1, ...rows.map((r) => r.count));
  const tickStep = [1, 2, 5, 10, 20, 25, 50, 100].find((st) => Math.ceil(maxV / st) <= 4) || Math.ceil(maxV / 4);
  const axisMax = Math.max(tickStep, Math.ceil(maxV / tickStep) * tickStep);
  const y = (v) => padT + plotH - (v / axisMax) * plotH;
  const font = `font-family="Geist, system-ui, -apple-system, sans-serif"`;
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, i) => i * tickStep);
  const color = CHART_COLORS.parentMeeting;
  return `
    <div class="dd-area-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="dd-area-chart" preserveAspectRatio="xMidYMid meet">
        ${ticks.map((t) => `<line x1="${padL}" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="${t === 0 ? "#C9C4B4" : "#E4E1D4"}" stroke-width="1"></line>
          <text x="${padL - 5}" y="${y(t) + 3}" text-anchor="end" font-size="8" ${font} fill="#8A8571">${t}</text>`).join("")}
        ${rows.map((r, i) => {
          const cx = padL + slot * (i + 0.5);
          const bar = r.count > 0 ? `<rect x="${cx - barW / 2}" y="${y(r.count)}" width="${barW}" height="${y(0) - y(r.count)}" rx="1.5" fill="${color}"></rect>
            <text x="${cx}" y="${y(r.count) - 3}" text-anchor="middle" font-size="8" font-weight="700" ${font} fill="#1B2A41">${r.count}</text>` : "";
          return `${bar}<text x="${cx}" y="${padT + plotH + 11}" text-anchor="middle" font-size="8" ${font} fill="${r.future ? "#B5B09F" : "#6B6652"}">${r.label}</text>`;
        }).join("")}
      </svg>
    </div>`;
}
// Per term (each term runs until the next one starts, so meetings in the
// holidays count with the term before them): held, still-postponed and
// cancelled, by the date originally booked (held ones by the date held).
function computeReportPmByTerm(year) {
  const terms = computeMoeCalendar(year).terms;
  const today = todayISO();
  return terms.map((t, i) => {
    const start = i === 0 ? `${year}-01-01` : t.start;
    const end = i === terms.length - 1 ? `${year}-12-31` : addDays(terms[i + 1].start, -1);
    const inT = (d) => d && d >= start && d <= end;
    const live = state.parentMeetings.filter((m) => !m.deleted);
    return {
      label: `T${i + 1}`,
      future: t.start > today,
      held: live.filter((m) => isPmCounted(m) && pmDate(m) <= today && inT(pmDate(m))).length, // booked for later: not held yet
      postponed: live.filter((m) => m.pmStatus === "Postponed" && !m.postponedTo && inT(m.date)).length,
      cancelled: live.filter((m) => m.pmStatus === "Cancelled" && inT(m.date)).length,
    };
  });
}
function renderReportPmTermTable(rows) {
  const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
  const row = (label, h, p, c, cls = "") => `
        <div class="dd-level-row${cls}">
          <div class="dd-level-cell-class">${label}</div>
          <div class="dd-level-cell-term">${h}</div><div class="dd-level-cell-term">${p}</div><div class="dd-level-cell-term">${c}</div>
        </div>`;
  return `
      <div class="dd-level-breakdown" style="margin-top:10px">
        <div class="dd-level-row dd-level-row-header">
          <div class="dd-level-cell-class">Term</div>
          <div class="dd-level-cell-term" style="color:${CHART_COLORS.parentMeeting}">Held</div>
          <div class="dd-level-cell-term">Postponed*</div>
          <div class="dd-level-cell-term">Cancelled</div>
        </div>
        ${rows.map((r) => (r.future ? row(r.label, "–", "–", "–") : row(r.label, r.held, r.postponed, r.cancelled))).join("")}
        ${row("Total", tot("held"), tot("postponed"), tot("cancelled"), " dd-level-row-total")}
      </div>
      <div class="dd-mono-muted" style="font-size:11px;margin-top:6px">*Postponed and still waiting for a new date. Once a new date is set, the meeting counts as held on that date. Meetings in the holidays count with the term before them.</div>`;
}
// Most common reasons for the year's meetings (held or not), with how
// often the student was the victim, the offender or both.
function computeReportPmReasons(year) {
  const tally = {};
  state.parentMeetings.forEach((m) => {
    if (m.deleted || !String(pmDate(m) || m.date || "").startsWith(`${year}-`)) return;
    const list = Array.isArray(m.reasons) && m.reasons.length
      ? m.reasons.map((r) => ({ cat: r.category === "Others" ? "Others" : r.category, status: r.status }))
      : String(m.reason || "").split("; ").filter(Boolean).map((x) => ({ cat: x.replace(/\s*\((Victim|Offender|Both|NA)\)$/, "").replace(/^Others\b.*/, "Others"), status: (x.match(/\((Victim|Offender|Both)\)$/) || [])[1] }));
    list.forEach(({ cat, status }) => {
      if (!cat) return;
      const t = (tally[cat] = tally[cat] || { cat, count: 0, Victim: 0, Offender: 0, Both: 0 });
      t.count++;
      if (status && t[status] !== undefined) t[status]++;
    });
  });
  return Object.values(tally).sort((a, b) => b.count - a.count);
}
function renderReportPmPage(year) {
  const monthly = computeReportPmMonthly(year);
  const reasons = computeReportPmReasons(year);
  const maxR = Math.max(1, ...reasons.map((r) => r.count));
  const roles = (r) => ["Victim", "Offender", "Both"].filter((k) => r[k]).map((k) => `${pmStatusWords(k)} ${r[k]}`).join(" · ");
  return `
      ${reportSectionTitle("Parent meetings by month")}
      ${renderReportPmBars(monthly)}
      ${reportSectionTitle("Parent meetings by term")}
      ${renderReportPmTermTable(computeReportPmByTerm(year))}
      ${reportSectionTitle("Reasons for parent meetings")}
      ${reasons.length ? `<div class="dd-panel" style="padding:12px;margin-bottom:4px">
        ${reasons.slice(0, 5).map((r) => `
        <div class="dd-pm-reason">
          <div class="dd-pm-reason-head"><span>${escapeHtml(r.cat)}</span><span class="dd-pm-reason-n">${r.count}</span></div>
          <div class="dd-pm-reason-track"><div style="width:${Math.max(4, (r.count / maxR) * 100)}%;background:${CHART_COLORS.parentMeeting}"></div></div>
          ${roles(r) ? `<div class="dd-mono-muted dd-pm-reason-roles">${roles(r)}</div>` : ""}
        </div>`).join("")}
        ${reasons.length > 5 ? `<div class="dd-mono-muted" style="font-size:11px">+ ${reasons.length - 5} other reason${reasons.length - 5 === 1 ? "" : "s"}</div>` : ""}
      </div>` : `<div class="dd-dash-empty">No parent meetings logged this year.</div>`}`;
}
// ================= Annual Report building blocks (8-page layout) =================
// Suspension is one category throughout (in-school and out-of-school
// together). Parent Meet appears in the term graphs and in its own section.
function reportCats() {
  return [
    { key: "discipline", label: "Grooming", color: CHART_COLORS.discipline },
    { key: "suspension", label: "Suspension", color: CHART_COLORS.suspension },
    { key: "timeOut", label: "Time Out", color: CHART_COLORS.timeOut },
    { key: "parentMeeting", label: "Parent Meet", color: CHART_COLORS.parentMeeting },
  ];
}
// Legend sized like the chart labels (see .dd-rep-legend).
function reportLegend(items, kind = "line") {
  return `<div class="dd-rep-legend">${items.map((it) => `<span class="dd-rep-legend-item"><span class="${kind === "line" ? "dd-rep-sw-line" : "dd-rep-sw-box"}" style="background:${it.color}"></span>${escapeHtml(it.label)}</span>`).join("")}</div>`;
}
function reportTicks(maxV, maxTicks = 5) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((st) => Math.ceil(Math.max(1, maxV) / st) <= maxTicks) || Math.ceil(maxV / maxTicks);
  const top = Math.max(step, Math.ceil(Math.max(1, maxV) / step) * step);
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}
const REP_FONT = `font-family="Geist, system-ui, -apple-system, sans-serif"`;
// A small line chart (one per term on page 1). `axisTop` shares the scale
// across the four so the terms can be compared by eye.
function renderReportMiniLines(rows, lines, { title, axisTop, note } = {}) {
  const W = 220, padL = 20, padR = 8, padT = 8, plotH = 78, padB = 16, H = padT + plotH + padB, plotW = W - padL - padR;
  const n = rows.length;
  const lastPast = rows.reduce((acc, r, i) => (r.future ? acc : i), -1);
  const { top, ticks } = reportTicks(axisTop || Math.max(1, ...rows.flatMap((r) => lines.map((l) => r[l.key] || 0))), 4);
  const x = (i) => (n === 1 ? padL + plotW / 2 : padL + 4 + (i * (plotW - 8)) / (n - 1));
  const y = (v) => padT + plotH - (v / top) * plotH;
  const grid = ticks.map((t) => `<line x1="${padL}" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="${t === 0 ? "#C9C4B4" : "#E4E1D4"}" stroke-width="0.8"></line><text x="${padL - 4}" y="${y(t) + 3}" text-anchor="end" font-size="8" ${REP_FONT} fill="#8A8571">${t}</text>`).join("");
  const labels = rows.map((r, i) => `<text x="${x(i)}" y="${padT + plotH + 11}" text-anchor="middle" font-size="7.5" ${REP_FONT} fill="${r.future ? "#C9C4B4" : "#6B6652"}">${escapeHtml(r.label)}</text>`).join("");
  const paths = lines.map((l) => `
    ${lastPast > 0 ? `<polyline points="${rows.slice(0, lastPast + 1).map((r, i) => `${x(i)},${y(r[l.key] || 0)}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"></polyline>` : ""}
    ${rows.map((r, i) => (i <= lastPast && ((r[l.key] || 0) > 0 || lastPast === 0) ? `<circle cx="${x(i)}" cy="${y(r[l.key] || 0)}" r="1.6" fill="${l.color}"></circle>` : "")).join("")}`).join("");
  const empty = lastPast < 0 ? `<text x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle" font-size="9" ${REP_FONT} fill="#8A8571">${escapeHtml(note || "Not started yet")}</text>` : "";
  return `
    <div class="dd-area-chart-wrap dd-rep-mini">
      <div class="dd-rep-mini-title">${escapeHtml(title || "")}</div>
      <svg viewBox="0 0 ${W} ${H}" class="dd-area-chart" preserveAspectRatio="xMidYMid meet">${grid}${labels}${paths}${empty}</svg>
    </div>`;
}
// Vertical stacked bars with the total on top of each bar.
function renderReportStackedBars(rows, segs, { maxTicks = 5 } = {}) {
  const W = 320, padL = 22, padR = 6, padT = 14, plotH = 110, padB = 16, H = padT + plotH + padB, plotW = W - padL - padR;
  const n = rows.length, slot = plotW / n, barW = Math.min(22, slot * 0.62);
  const total = (r) => segs.reduce((a, sg) => a + (r[sg.key] || 0), 0);
  const { top, ticks } = reportTicks(Math.max(1, ...rows.map(total)), maxTicks);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const grid = ticks.map((t) => `<line x1="${padL}" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="${t === 0 ? "#C9C4B4" : "#E4E1D4"}" stroke-width="1"></line><text x="${padL - 5}" y="${y(t) + 3}" text-anchor="end" font-size="8" ${REP_FONT} fill="#8A8571">${t}</text>`).join("");
  const bars = rows.map((r, i) => {
    const cx = padL + slot * (i + 0.5);
    let acc = 0;
    const parts = segs.map((sg) => {
      const v = r[sg.key] || 0;
      if (!v) return "";
      const y1 = y(acc + v), h = y(acc) - y1; acc += v;
      return `<rect x="${cx - barW / 2}" y="${y1}" width="${barW}" height="${h}" fill="${sg.color}"></rect>`;
    }).join("");
    const t = total(r);
    return `${parts}${t > 0 ? `<text x="${cx}" y="${y(t) - 3}" text-anchor="middle" font-size="8" font-weight="700" ${REP_FONT} fill="#1B2A41">${t}</text>` : ""}
      <text x="${cx}" y="${padT + plotH + 11}" text-anchor="middle" font-size="8" ${REP_FONT} fill="${r.future ? "#C9C4B4" : "#6B6652"}">${escapeHtml(r.label)}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="dd-area-chart" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
}
// Grouped list, 3 columns (2 for classes; 6 on tablet/desktop), row by row, with lines between the columns.
function renderReportGroupedGrid(groups, headFn, itemFn, emptyText, phoneCols = 3, extraCls = "") {
  if (!groups.length) return `<div class="dd-dash-empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="dd-rep-groups">${groups.map((g) => `
    <div class="dd-rep-group">
      <div class="dd-rep-group-head">${headFn(g.count, g.items.length)}</div>
      <div class="dd-rep-grid3${extraCls}">${g.items.map((it) => `<div class="dd-rep-cell">${itemFn(it)}</div>`).join("")}${(() => { const n = g.items.length, p4 = (phoneCols - (n % phoneCols)) % phoneCols, pf = (4 - (n % 4)) % 4, p6 = (6 - (n % 6)) % 6; return Array.from({ length: Math.max(p4, pf, p6) }, (_, i) => `<div class="dd-rep-cell dd-rep-cell-pad${i < p4 ? " dd-pad-p" : ""}${i < pf ? " dd-pad-f" : ""}${i < p6 ? " dd-pad-t" : ""}"></div>`).join(""); })()}</div>
    </div>`).join("")}</div>`;
}
function groupByCount(list) {
  const map = new Map();
  list.forEach((it) => { if (!map.has(it.count)) map.set(it.count, []); map.get(it.count).push(it); });
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([count, items]) => ({ count, items }));
}
const studentCell = (r) => `<span class="dd-rep-name">${escapeHtml(truncateName(r.name))}</span>${r.cls ? ` <span class="dd-rep-cls">${escapeHtml(r.cls)}</span>` : ""}`;

// ---- Page 1: weeks of each term ----
function computeReportTermWeeks(year) {
  const today = todayISO();
  return computeMoeCalendar(year).terms.map((t, i) => ({
    title: `Term ${i + 1}`,
    rows: computeTrendSeries(trendBuckets(t.start, t.end, "weeks")).map((r) => ({ ...r, future: r.start > today })),
  }));
}
function renderReportTermQuadrants(year) {
  const terms = computeReportTermWeeks(year);
  const cats = reportCats();
  const top = Math.max(1, ...terms.flatMap((t) => t.rows.filter((r) => !r.future).flatMap((r) => cats.map((c) => r[c.key] || 0))));
  return `
    <div class="dd-rep-quads">
      ${terms.map((t) => renderReportMiniLines(t.rows, cats, { title: t.title, axisTop: top })).join("")}
    </div>
    <div class="dd-rep-legend-wrap">${reportLegend(cats)}</div>`;
}
// ---- Page 2: monthly stacked bars + table with time out types ----
function computeReportMonthly(year) {
  const today = todayISO();
  const lastMonth = String(year) === today.slice(0, 4) ? parseInt(today.slice(5, 7), 10) : 12;
  const base = computeYearMonthlyTrend(year);
  return base.map((m, i) => {
    const mk = `${year}-${String(i + 1).padStart(2, "0")}`;
    const tos = state.timeOuts.filter((t) => !t.deleted && monthKey(t.startDate) === mk);
    return { ...m, label: MONTH_ABBR[i], future: i + 1 > lastMonth, toByType: timeOutTypeBreakdown(tos) };
  });
}
function renderReportMonthlyPage(year) {
  const rows = computeReportMonthly(year);
  const segs = reportCats().filter((c) => c.key !== "parentMeeting");
  const shown = rows.filter((r) => !r.future);
  const tot = (k) => shown.reduce((a, r) => a + (r[k] || 0), 0);
  const totType = (k) => shown.reduce((a, r) => a + (r.toByType[k] || 0), 0);
  const rowTotal = (r) => r.discipline + r.suspension + r.timeOut;
  return `
      <div class="dd-area-chart-wrap">
        ${renderReportStackedBars(rows, segs)}
        <div class="dd-rep-legend-wrap dd-rep-legend-in">${reportLegend(segs, "box")}</div>
      </div>
      <table class="dd-rt">
        <thead>
          <tr><th rowspan="2">Month</th><th rowspan="2" style="color:${CHART_COLORS.discipline}"><span class="dd-rt-long">Grooming</span><span class="dd-rt-short">Groom</span></th><th rowspan="2" style="color:${CHART_COLORS.suspension}"><span class="dd-rt-long">Suspension</span><span class="dd-rt-short">Susp</span></th><th colspan="4" style="color:${CHART_COLORS.timeOut}">Time Out</th><th rowspan="2">Total</th></tr>
          <tr>${TO_TYPES.map((t) => `<th class="dd-rt-sub" style="color:${CHART_COLORS.timeOut}">${t.abbrev}</th>`).join("")}</tr>
        </thead>
        <tbody>${shown.map((r) => `<tr><th>${r.label}</th><td>${r.discipline}</td><td>${r.suspension}</td>${TO_TYPES.map((t) => `<td class="dd-rt-to">${r.toByType[t.key] || 0}</td>`).join("")}<td class="dd-rt-tot">${rowTotal(r)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><th>Total</th><td>${tot("discipline")}</td><td>${tot("suspension")}</td>${TO_TYPES.map((t) => `<td class="dd-rt-to">${totType(t.key)}</td>`).join("")}<td class="dd-rt-tot">${tot("discipline") + tot("suspension") + tot("timeOut")}</td></tr></tfoot>
      </table>
      <div class="dd-mono-muted dd-rep-foot">Time Out types: ${TO_TYPES.map((t) => `${t.abbrev} = ${t.label.replace(/^Time Out \(|\)$/g, "")}`).join(" · ")}.</div>`;
}
// ---- Page 3: day of week by term, parent meetings ----
const TERM_SHADES = ["#B9C4D3", "#8494AB", "#4F6180", "#1B2A41"];
function computeReportDayByTerm(year) {
  const terms = computeMoeCalendar(year).terms;
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const rows = days.map((d) => ({ label: d }));
  const table = terms.map(() => [0, 0, 0, 0, 0]);
  const add = (date) => {
    if (!date) return;
    const ti = terms.findIndex((t) => date >= t.start && date <= t.end);
    const dw = weekdayOf(date);
    if (ti < 0 || dw < 1 || dw > 5) return;
    table[ti][dw - 1]++;
  };
  state.incidents.forEach((it) => { if (!it.deleted && Array.isArray(it.issues)) add(it.date); });
  [...state.suspensions, ...state.timeOuts].forEach((x) => { if (!x.deleted) add(x.startDate); });
  rows.forEach((r, di) => terms.forEach((_, ti) => { r[`t${ti}`] = table[ti][di]; }));
  return { rows, table, terms };
}
function renderReportDayOfWeek(year) {
  const { rows, table } = computeReportDayByTerm(year);
  const segs = [0, 1, 2, 3].map((i) => ({ key: `t${i}`, label: `Term ${i + 1}`, color: TERM_SHADES[i] }));
  const colTot = (di) => table.reduce((a, r) => a + r[di], 0);
  const rowTot = (r) => r.reduce((a, v) => a + v, 0);
  return `
      <div class="dd-area-chart-wrap">
        ${renderReportStackedBars(rows, segs, { maxTicks: 4 })}
        <div class="dd-rep-legend-wrap dd-rep-legend-in">${reportLegend(segs, "box")}</div>
      </div>
      <table class="dd-rt">
        <thead><tr><th>Term</th>${rows.map((r) => `<th>${r.label}</th>`).join("")}<th>Total</th></tr></thead>
        <tbody>${table.map((r, ti) => `<tr><th>T${ti + 1}</th>${r.map((v) => `<td>${v}</td>`).join("")}<td class="dd-rt-tot">${rowTot(r)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><th>Total</th>${rows.map((_, di) => `<td>${colTot(di)}</td>`).join("")}<td class="dd-rt-tot">${table.reduce((a, r) => a + rowTot(r), 0)}</td></tr></tfoot>
      </table>
      <div class="dd-mono-muted dd-rep-foot">Grooming entries, suspensions and time outs on school days in term, by the day they happened (suspensions and time outs by their first day).</div>`;
}
// Students by how many parent meetings they had this year (meetings that
// went ahead, up to today; a postponed one counts on its new date).
function computeReportPmCounts(year) {
  const today = todayISO();
  const rows = {};
  state.parentMeetings.forEach((m) => {
    const d = pmDate(m);
    if (!isPmCounted(m) || !d || !d.startsWith(`${year}-`) || d > today) return;
    const key = `${normalizeName(m.studentName)}|${normCls(sameYearGroup(year, m.studentName, m.studentClass || "")[0])}`;
    rows[key] = rows[key] || { name: m.studentName, cls: m.studentClass, count: 0, last: "" };
    if (d >= rows[key].last) { rows[key].cls = m.studentClass; rows[key].last = d; }
    rows[key].count++;
  });
  return Object.values(rows).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
// ---- Page 5: levels and classes ----
function renderReportLevelBlocks(year) {
  const levels = computeYearLevelRanking(year).slice().sort((a, b) => a.total - b.total || a.label.localeCompare(b.label));
  return `
      <div class="dd-rep-levels">
        ${levels.map((l) => `
        <div class="dd-rep-level">
          <div class="dd-rep-level-name">${l.label}</div>
          <div class="dd-rep-level-total">${l.total}</div>
          <div class="dd-rep-level-line"><span><span class="dd-rt-long">Grooming</span><span class="dd-rt-short">Groom</span></span><b>${l.discipline}</b></div>
          <div class="dd-rep-level-line"><span><span class="dd-rt-long">Suspension</span><span class="dd-rt-short">Susp</span></span><b>${l.suspension}</b></div>
          <div class="dd-rep-level-line"><span><span class="dd-rt-long">Time Out</span><span class="dd-rt-short">T.Out</span></span><b>${l.timeOut}</b></div>
        </div>`).join("")}
      </div>
      <div class="dd-rep-level-scale"><span>Least challenging</span><span>Most challenging</span></div>`;
}
function computeReportClassCounts(year) {
  const inY = (d) => d && d.startsWith(`${year}-`);
  return CLASS_OPTIONS.map((cls) => {
    const discipline = state.incidents.filter((i) => !i.deleted && inY(i.date) && i.studentClass === cls).length;
    const suspension = state.suspensions.filter((x) => !x.deleted && inY(x.startDate) && x.studentClass === cls).length;
    const timeOut = state.timeOuts.filter((x) => !x.deleted && inY(x.startDate) && x.studentClass === cls).length;
    const parentMeeting = state.parentMeetings.filter((m) => isPmCounted(m) && inY(pmDate(m)) && m.studentClass === cls).length;
    return { cls, discipline, suspension, timeOut, parentMeeting, count: discipline + suspension + timeOut + parentMeeting };
  }).filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.cls.localeCompare(b.cls));
}
const classCell = (r) => `
  <div class="dd-rep-class">
    <div class="dd-rep-class-name">${escapeHtml(r.cls)}</div>
    <div class="dd-rep-class-break">
      ${[["Grooming", r.discipline], ["Suspension", r.suspension], ["Time Out", r.timeOut], ["Parent Meet", r.parentMeeting]].filter(([, n]) => n > 0).map(([l, n]) => `<div><span>${l}</span><b>${n}</b></div>`).join("")}
    </div>
  </div>`;
const plainCount = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// ---- Top reasons for suspension / time out, by level ----
// One row per reason that was actually used, ranked by total. A record with
// several reasons counts once towards each. Columns: P1–P6, then the total.
function computeReportReasonsByLevel(records, year) {
  const rows = {};
  records.forEach((r) => {
    if (r.deleted || !r.startDate || !r.startDate.startsWith(`${year}-`)) return;
    const lvl = classLevel(r.studentClass);
    multiReasonsFromSaved(r).selected.forEach((reason) => {
      if (!reason) return;
      const row = (rows[reason] = rows[reason] || { reason, levels: [0, 0, 0, 0, 0, 0], total: 0 });
      if (lvl >= 1 && lvl <= 6) row.levels[lvl - 1]++;
      row.total++;
    });
  });
  return Object.values(rows).sort((a, b) => b.total - a.total || a.reason.localeCompare(b.reason));
}
function renderReportReasonsTable(rows, emptyText) {
  if (!rows.length) return `<div class="dd-dash-empty">${escapeHtml(emptyText)}</div>`;
  return `
      <table class="dd-rt dd-rt-reasons">
        <thead><tr><th class="dd-rt-reason-h">Reason</th>${[1, 2, 3, 4, 5, 6].map((l) => `<th>P${l}</th>`).join("")}<th>Total</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><th class="dd-rt-reason">${escapeHtml(r.reason)}</th>${r.levels.map((v) => `<td${v ? "" : ' class="dd-rt-zero"'}>${v}</td>`).join("")}<td class="dd-rt-tot">${r.total}</td></tr>`).join("")}</tbody>
      </table>`;
}
function renderReportRecommendations(year) {
  const ins = computeYearInsights(year);
  return `
      ${reportSectionTitle("Recommendations")}
      <div class="dd-panel dd-ta-panel">
        <ol class="dd-ta-list">${ins.recs.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>
      </div>
      <div class="dd-rep-disclaimer">Note: These recommendations are generated purely for reference purposes only. Do not use the recommendations without consideration.</div>`;
}
function renderAnnualReportPages(year) {
  const page = (n, html) => `<div class="dd-report-page" data-page="${n}">${html}</div>`;
  // Page 1 — Annual summary tiles, By Term, By Weeks in a Term (4 graphs)
  const p1 = `
      <div class="dd-report-heading" style="margin:10px 0">
        <div class="dd-dash-title" style="color:#1B2A41;margin:0">Annual Summary — ${year}</div>
      </div>
      ${renderTallyGrid(["discipline", "suspension", "timeOut", "parentMeeting"], computeYearlyCategoryTotals(year))}
      ${reportSectionTitle("By Term")}
      ${renderReportByTermTable(year)}
      ${reportSectionTitle("By Weeks in a Term")}
      <div class="dd-keep-together">${renderReportTermQuadrants(year)}</div>`;
  // Page 2 — Discipline Load by Month
  const p2 = `
      ${reportSectionTitle("Discipline Load by Month")}
      ${renderReportMonthlyPage(year)}`;
  // Page 3 — Day of week
  const p3 = `
      ${reportSectionTitle("Discipline Load by Day of Week")}
      ${renderReportDayOfWeek(year)}`;
  // Page 4 — Top reasons (suspension, time out), then Parent meetings at the bottom
  const pmCounts = computeReportPmCounts(year);
  const p4 = `
      ${reportSectionTitle("Top Reasons for Suspension")}
      ${renderReportReasonsTable(computeReportReasonsByLevel(state.suspensions, year), "No suspensions this year.")}
      ${reportSectionTitle("Top Reasons for Time Out")}
      ${renderReportReasonsTable(computeReportReasonsByLevel(state.timeOuts, year), "No time outs this year.")}
      ${reportSectionTitle("Parent Meetings by Month")}
      ${renderReportPmBars(computeReportPmMonthly(year))}
      ${reportSectionTitle("Parent Meet Count")}
      ${renderReportGroupedGrid(groupByCount(pmCounts), (n, k) => `${plainCount(n, "meeting", "meetings")} <span class="dd-rep-group-n">· ${plainCount(k, "student", "students")}</span>`, studentCell, "No parent meetings this year.")}
      ${pmCounts.length ? `<div class="dd-mono-muted dd-rep-foot">Meetings held up to ${formatDate(todayISO() < `${year}-12-31` ? todayISO() : `${year}-12-31`)}. Meetings booked for later dates aren't counted yet.</div>` : ""}`;
  // Page 5 — Repeat vs. unique + Grooming escalation rate + repeat intervals
  const ru = computeRepeatVsUnique(year);
  const esc = computeEscalationRate(year);
  const intervals = computeRepeatSuspensionIntervals(year);
  const toIntervals = computeRepeatTimeOutIntervals(year);
  const p5 = `
      ${reportSectionTitle("Repeated vs. Unique Students")}
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
      ${reportSectionTitle("Grooming Escalation Rate")}
      ${!esc ? `<div class="dd-dash-empty">No grooming issues logged this year.</div>` : `
      <div class="dd-panel" style="background:#F7F5EE;border:1px solid #E4E1D4;padding:12px;margin-bottom:4px">
        <p class="dd-sans" style="font-size:13px;line-height:1.6;margin:0">
          Of ${esc.total} issue${esc.total === 1 ? "" : "s"} logged this year: <b>${esc.pct1st}%</b> never went past 1st Warning, <b>${esc.pct2nd}%</b> reached 2nd Warning, and <b>${esc.pctFinal}%</b> reached Final Warning.
        </p>
      </div>`}
      ${reportSectionTitle("Repeat Suspension Intervals")}
      ${intervals.length === 0 ? `<div class="dd-dash-empty">No student was suspended more than once.</div>` : renderReportIntervalsTable(intervals)}
      ${reportSectionTitle("Repeat Time Out Intervals")}
      ${toIntervals.length === 0 ? `<div class="dd-dash-empty">No student was given more than one time out.</div>` : renderReportIntervalsTable(toIntervals)}`;
  // Page 6 — Most challenging levels (blocks) + classes (grouped by count)
  const p6 = `
      ${reportSectionTitle("Most Challenging Levels")}
      ${renderReportLevelBlocks(year)}
      ${reportSectionTitle("Most Challenging Classes")}
      ${renderReportGroupedGrid(groupByCount(computeReportClassCounts(year)), (n, k) => `${plainCount(n, "count", "counts")} <span class="dd-rep-group-n">· ${plainCount(k, "class", "classes")}</span>`, classCell, "No entries this year.", 2, " dd-rep-grid3-cls")}`;
  // Page 7 — All suspensions / time outs this year (grouped by how many)
  const p7 = `
      ${reportSectionTitle("All Suspensions This Year")}
      ${renderReportGroupedGrid(groupByCount(computeYearSuspensionRoster(year)), (n, k) => `${plainCount(n, "suspension", "suspensions")} <span class="dd-rep-group-n">· ${plainCount(k, "student", "students")}</span>`, studentCell, "No suspensions this year.")}
      ${reportSectionTitle("All Time-Outs This Year")}
      ${renderReportGroupedGrid(groupByCount(computeYearTimeOutRoster(year)), (n, k) => `${plainCount(n, "time out", "time outs")} <span class="dd-rep-group-n">· ${plainCount(k, "student", "students")}</span>`, studentCell, "No time outs this year.")}`;
  // Page 8 — Trend analysis, with the Recommendations right after it
  const p8 = renderTrendAnalysis(year) + renderReportRecommendations(year);
  return [p1, p2, p3, p4, p5, p6, p7, p8].map((h, i) => page(i + 1, h)).join("");
}
const ADMIN_ONLY_NOTE = `<div class="dd-readonly-note">View only. Only admins and the owner can change this.</div>`;
function renderSettingsSection() {
  // Every back button sits in the same kind of row as the report's
  // "← Years" toolbar, so back buttons and titles line up page to page.
  const backBtn = (label, action) => `<button type="button" class="dd-back-link" data-action="${action}">← ${label}</button>`;
  const backRow = (label, action) => `<div class="dd-report-toolbar">${backBtn(label, action)}</div>`;
  let body;
  if (state.settingsView === "yearReport" && state.settingsSelectedYear) {
    const year = state.settingsSelectedYear;
    body = `
      <div class="dd-print-hide dd-report-toolbar">
        ${backBtn("Years", "settings-back-to-years")}
        <div class="dd-report-actions">
          <button type="button" class="dd-print-btn" id="btn-print-report" title="Print">${ICON_PRINTER}<span>Print</span></button>
          <button type="button" class="dd-print-btn" id="btn-export-pdf" title="Export PDF">${ICON_DOCUMENT}<span>Export PDF</span></button>
        </div>
      </div>
      ${state.reportExportError ? `<div class="dd-error dd-print-hide">${escapeHtml(state.reportExportError)}</div>` : ""}
      <div id="report-print-area">${renderAnnualReportPages(year)}</div>`;
  } else if (state.settingsView === "yearList") {
    const years = availableReportYears();
    body = `
      ${backRow("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Annual Summary Reports</div>
      <div class="dd-settings-menu-group">
        ${years.map((y) => `<button type="button" class="dd-settings-menu-row" data-action="settings-open-year" data-year="${y}"><span>${y}</span><span class="dd-settings-chevron">›</span></button>`).join("")}
      </div>`;
  } else if (state.settingsView === "studentLinks") {
    body = `
      ${backRow("Settings", "settings-back-to-menu")}
      ${renderStudentLinksSettings()}`;
  } else if (state.settingsView === "classesForYear") {
    const year = new Date().getFullYear();
    const draft = state._classDraft || classOptionsForCurrentYear();
    const canEdit = !!state.isAdmin;
    body = `
      ${backRow("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Classes For ${year}</div>
      ${canEdit ? "" : ADMIN_ONLY_NOTE}
      <div class="dd-mono-muted" style="font-size:12px;margin-bottom:12px">
        Only ticked classes will show up in the class dropdown when logging an entry this year.${canEdit ? " Untick any that don't exist this year (e.g. after re-streaming); tick any new ones." : ""}
      </div>
      <div class="dd-issue-grid">
        ${CLASS_OPTIONS.map((c) => `
          <label class="dd-checkbox-pill${canEdit ? "" : " dd-readonly"}" style="display:flex">
            <input type="checkbox" class="dd-class-year-cb" value="${c}" ${draft.includes(c) ? "checked" : ""} ${canEdit ? "" : "disabled"} />
            <span>${c}</span>
          </label>`).join("")}
      </div>
      ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
      ${canEdit ? `<button class="dd-btn-primary" type="button" id="btn-save-class-config" style="margin-top:14px" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : `Save for ${year}`}</button>` : ""}`;
  } else if (state.settingsView === "holidays") {
    const year = state.holidaySettingsYear || new Date().getFullYear();
    const moe = computeMoeCalendar(year);
    const phEntries = (state.holidays?.publicHolidayEntries || []).filter((e) => e.startDate.startsWith(String(year))).sort((a, b) => a.startDate.localeCompare(b.startDate));
    const closureEntries = (state.schoolClosureDays?.entries || [])
      .map((e) => ({ ...e, startDate: e.startDate || e.date, endDate: e.endDate || e.date }))
      .filter((e) => e.startDate && e.startDate.startsWith(String(year)))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    // Admins and the owner can add, change and remove; everyone else sees
    // the same list with no edit controls.
    const canEdit = !!state.isAdmin;
    const sectionHead = (label, addAction) => `
      <div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px">
        <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:0">${label}</div>
        ${addAction && canEdit ? `<button type="button" class="dd-settings-add-btn" data-action="${addAction}">+</button>` : ""}
      </div>`;
    const calIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>`;
    const listRow = (title, sub, editAction, editData, deleteAction, deleteId) => `
      <div class="dd-settings-list-row">
        ${canEdit ? `<button type="button" class="dd-date-icon-btn" data-action="${editAction}" ${editData || ""} title="Adjust">${calIcon}</button>` : `<div class="dd-date-icon-btn dd-readonly" aria-hidden="true">${calIcon}</div>`}
        <div style="flex:1;min-width:0">
          <div class="dd-sans" style="font-size:14px">${escapeHtml(title)}</div>
          <div class="dd-mono-muted" style="font-size:12px">${sub}</div>
        </div>
        ${deleteAction && canEdit ? `<button class="dd-followup-icon-btn" data-action="${deleteAction}" data-id="${deleteId}" title="Remove">✕</button>` : ""}
      </div>`;
    const rangeKeys = ["march", "june", "sep", "yearEnd"];
    const singleDayKeys = ["youthDay", "teachersDay", "childrensDay", "nationalDayInLieu"];
    body = `
      ${backRow("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Setting Holidays/School Closure/HBL Days</div>
      ${canEdit ? "" : ADMIN_ONLY_NOTE}
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:6px">
        <button type="button" class="dd-circle-btn" data-action="holidays-prev-year" title="Previous year" aria-label="Previous year">‹</button>
        <div class="dd-sans" style="font-size:16px;font-weight:600;min-width:48px;text-align:center">${year}</div>
        <button type="button" class="dd-circle-btn" data-action="holidays-next-year" title="Next year" aria-label="Next year">›</button>
      </div>
      ${year !== new Date().getFullYear() ? `<div class="dd-mono-muted" style="font-size:12px;text-align:center;margin-bottom:8px">Viewing ${year} — everything below${canEdit ? " (and anything you add)" : ""} applies to that year.</div>` : ""}

      ${sectionHead("Public Holidays", "open-add-public-holiday")}
      ${phEntries.length === 0 ? `<div class="dd-dash-empty">None added yet.</div>` : phEntries.map((e) => listRow(
        e.name, formatDateOrRange(e.startDate, e.endDate),
        "edit-public-holiday", `data-id="${e.id}"`,
        "request-delete-public-holiday", e.id
      )).join("")}
      ${canEdit ? `<button type="button" class="dd-back-link" id="btn-load-known-holidays" style="margin-top:8px">Load known public holidays (2026 &amp; 2027)</button>` : ""}

      ${sectionHead("School Holidays", "open-add-school-holiday")}
      ${moe.ranges.map((r, i) => listRow(r.label, formatDateOrRange(r.start, r.end), "edit-school-holiday", `data-key="${rangeKeys[i]}" data-range="true" data-label="${escapeHtml(r.label)}" data-start="${r.start}" data-end="${r.end}"`, null, null)).join("")}
      ${(state.schoolCalendarOverrides?.[year]?.extraHolidays || []).map((e) => listRow(e.name, formatDateOrRange(e.startDate, e.endDate), "edit-extra-school-holiday", `data-id="${e.id}"`, "request-delete-extra-school-holiday", e.id)).join("")}
      ${moe.singleDays.map((d, i) => ({ d, label: moe.singleDayLabels[i], key: singleDayKeys[i] }))
        .filter(({ label, d }) => label !== "National Day (in lieu)" || !publicHolidayEntryFor(d))
        .map(({ d, label, key }) => listRow(label, formatDate(d), "edit-school-holiday", `data-key="${key}" data-range="false" data-label="${escapeHtml(label)}" data-start="${d}" data-end="${d}"`, null, null)).join("")}

      ${sectionHead("School Closure / HBL Days", "open-add-closure-day")}
      ${closureEntries.length === 0 ? `<div class="dd-dash-empty">None added yet.</div>` : closureEntries.map((e) => listRow(
        closureLabel(e.levels),
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
      ${backRow("Settings", "settings-back-to-menu")}
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
  } else if (state.settingsView === "trash") {
    const items = (state.deletedItems || []).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    const row = (it) => {
      const label = TRASH_TYPE_LABEL[it.collectionName] || it.collectionName;
      const who = it.data?.studentName || "Unknown student";
      const cls = it.data?.studentClass ? `, ${it.data.studentClass}` : "";
      const when = it.deletedAt ? new Date(it.deletedAt).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
      const restoring = state.trashRestoringId === it.id;
      return `
      <div class="dd-contact-row">
        <div class="dd-contact-body">
          <div class="dd-contact-name">${escapeHtml(who)}${cls} — ${escapeHtml(label)}</div>
          <div class="dd-contact-sub">${it.restoredAt ? `Restored ${escapeHtml(new Date(it.restoredAt).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}` : `Deleted ${escapeHtml(when)}${it.deletedBy ? ` by ${escapeHtml(it.deletedBy)}` : ""}`}</div>
        </div>
        ${it.restoredAt ? "" : `<button type="button" class="dd-back-link" data-action="restore-deleted-item" data-id="${it.id}" ${restoring ? "disabled" : ""} style="white-space:nowrap">${restoring ? "Restoring…" : "Restore"}</button>`}
      </div>`;
    };
    body = `
      ${backRow("Settings", "settings-back-to-menu")}
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">Recently Deleted</div>
      ${items.length === 0
        ? `<div class="dd-mono-muted" style="font-size:13px">Nothing's been deleted yet.</div>`
        : `<div class="dd-contact-list">${items.map(row).join("")}</div>`}
      ${state.saveError ? `<div class="dd-error" style="margin-top:14px;padding:10px 12px;border:1px solid #A3372B;border-radius:6px;background:#A3372B11">${escapeHtml(state.saveErrorDetail || "Couldn't restore that entry.")}</div>` : ""}`;
  } else {
    const year = new Date().getFullYear();
    const needsReview = !state.classConfig?.classesByYear?.[String(year)];
    const menuRow = (label, action) => `<button type="button" class="dd-settings-menu-row" data-action="${action}"><span class="dd-settings-menu-label" data-fit="settings-menu">${label}</span><span class="dd-settings-chevron">›</span></button>`;
    body = `
      <div class="dd-dash-title" style="color:#1B2A41;margin-bottom:10px">Settings</div>
      ${needsReview ? `<div class="dd-error" style="margin-bottom:10px">Classes for ${year} haven't been reviewed yet — pick which classes are active this year below.</div>` : ""}
      <div class="dd-settings-menu-group">
        ${menuRow("Annual Summary Reports", "settings-open-years")}
        ${menuRow("Classes For The Year", "settings-open-classes")}
        ${menuRow("Setting Holidays/School Closure/HBL Days", "settings-open-holidays")}
        ${menuRow("Authorised Teachers List", "settings-open-access")}
        ${menuRow("Student Links", "settings-open-links")}
      </div>
      <button type="button" class="dd-back-link" id="btn-app-sign-out" style="margin-top:16px">Sign out</button>`;
  }
  // The Annual Summary's card is marked so printing / Export PDF can drop
  // its frame (otherwise its border and fill run down every printed sheet).
  const isReport = state.settingsView === "yearReport" && !!state.settingsSelectedYear;
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main${isReport ? " dd-report-main" : ""}">
        <div class="dd-panel${isReport ? " dd-report-card" : ""}">${body}</div>
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
  // This year's entries only, matching the term table below (and the
  // students' level, which changes every year).
  const active = items.filter(isActive || ((it) => !it.deleted)).filter((it) => String(it[dateField] || "").startsWith(`${year}-`));
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
          <div class="dd-tally-number${c === "timeOut" && timeOutBreakdown ? "" : bigSizeClass(totals[c])}" style="color:${CHART_COLORS[c]}">${totals[c]}</div>
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
// Each line in the day list says what the entry is, then its detail:
// "Time Out (CCA) | Staff Room with Mr Tan", "In-School Suspension | Library",
// "Out-of-School Suspension", "Parent Meet | 9:00–10:00 AM · Office",
// "Grooming | Long Hair".
function dayDetailLabel(kind, detail) {
  const d = String(detail || "").trim();
  return d ? `${kind} | ${d}` : kind;
}
function renderDayDetail(dateISO, incl) {
  if (!dateISO) return "";
  const items = [];
  if (incl.discipline) {
    state.incidents.forEach((i) => { if (!i.deleted && i.date === dateISO) items.push({ type: "discipline", name: i.studentName, cls: i.studentClass, location: dayDetailLabel("Grooming", incidentSummaryLabel(i)) }); });
  }
  if (incl.suspension) {
    state.suspensions.forEach((s) => {
      if (s.deleted) return;
      suspensionDayEntries(s).forEach((e) => {
        if (e.date === dateISO) items.push({ type: e.type === "OSS" ? "oss" : "iss", name: s.studentName, cls: s.studentClass,
          location: e.type === "OSS" ? "Out-of-School Suspension" : dayDetailLabel("In-School Suspension", e.venue) });
      });
    });
  }
  if (incl.timeOut) {
    state.timeOuts.forEach((t) => {
      if (t.deleted) return;
      suspensionDayEntries(t).forEach((e) => {
        if (e.date === dateISO) items.push({ type: e.type === "OSS" ? "toOss" : "toIss", name: t.studentName, cls: t.studentClass,
          location: `${toTypeDashLabel(t.toType)} | ${timeOutDayLabel(e)}` });
      });
    });
  }
  if (incl.parentMeeting) {
    state.parentMeetings.forEach((m) => {
      if (m.deleted) return;
      if (m.date === dateISO) {
        const note = m.pmStatus === "Cancelled" ? "(Cancelled)" : m.pmStatus === "Postponed" ? (m.postponedTo ? `(Postponed to ${formatDate(m.postponedTo)})` : "(Postponed)") : "";
        items.push({ type: "parentMeeting", name: m.studentName, cls: m.studentClass, note, location: note ? "Parent Meet" : dayDetailLabel("Parent Meet", pmSlotLabel(m.time, m.endTime, m.location)) });
      }
      // The rescheduled meeting itself, on its new date.
      if (isPmRescheduled(m) && m.postponedTo === dateISO && m.date !== dateISO) {
        items.push({ type: "parentMeeting", name: m.studentName, cls: m.studentClass, note: `(Postponed from ${formatDate(m.date)})`, noteKind: "moved", location: dayDetailLabel("Parent Meet", pmSlotLabel(m.postponedTime, m.postponedEndTime, m.postponedLocation)) });
      }
    });
  }
  const typeOrder = { discipline: 0, iss: 1, oss: 2, toIss: 3, toOss: 4, parentMeeting: 5 };
  items.sort((a, b) => (typeOrder[a.type] - typeOrder[b.type]) || (classLevel(a.cls) - classLevel(b.cls)));
  const typeColor = { discipline: CHART_COLORS.discipline, iss: CHART_COLORS.suspension, oss: OSS_DOT_COLOR, toIss: CHART_COLORS.timeOut, toOss: TO_OSS_DOT_COLOR, parentMeeting: CHART_COLORS.parentMeeting };
  return `
    <div class="dd-day-detail">
      <div class="dd-day-detail-title">${formatDate(dateISO)}</div>
      ${items.length === 0 ? `<div class="dd-mono-muted" style="font-size:12px">Nothing logged this day.</div>` : items.map((it) => it.type === "parentMeeting" ? `
        <div class="dd-day-detail-row dd-day-detail-row-pm">
          <div class="dd-day-detail-pm-line">
            <span class="dd-cal-dot" style="background:${typeColor[it.type]}"></span>
            <span class="dd-day-detail-name">${escapeHtml(it.name)}</span>
            <span class="dd-day-detail-class">${escapeHtml(it.cls || "")}</span>
          </div>
          ${it.location ? `<div class="dd-day-detail-pm-slot">${escapeHtml(it.location)}</div>` : ""}
          ${it.note ? `<div class="dd-day-detail-pm-note dd-day-detail-note${it.noteKind === "moved" ? " dd-day-detail-note-moved" : ""}">${escapeHtml(it.note)}</div>` : ""}
        </div>` : `
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
// Week-style tally: suspensions and time outs count each day served, so
// the number answers "how many suspension days are there this week".
function weekStyleTotals(days) {
  const totals = { discipline: 0, suspension: 0, timeOut: 0, parentMeeting: 0 };
  days.forEach((d) => {
    const c = computeCountsForDate(d);
    totals.discipline += c.discipline;
    totals.parentMeeting += c.parentMeeting;
    totals.suspension += c.suspensionISS + c.suspensionOSS;
    totals.timeOut += c.timeOutISS + c.timeOutOSS;
  });
  return totals;
}
// Month/Year-style tally: each suspension and time out counted once, on
// the date it starts.
function rangeStyleTotals(fromISO, toISO) {
  const inRange = (d) => d && d >= fromISO && d <= toISO;
  return {
    discipline: state.incidents.filter((i) => !i.deleted && inRange(i.date)).length,
    suspension: suspensionEntryCountForRange(fromISO, toISO),
    timeOut: timeOutEntryCountForRange(fromISO, toISO),
    parentMeeting: state.parentMeetings.filter((m) => isPmCounted(m) && inRange(pmDate(m))).length,
  };
}
function datesInRange(fromISO, toISO) {
  const out = [];
  for (let d = fromISO; d <= toISO && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}
function renderWeekCells(days, incl) {
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
  return `<div class="dd-week-grid">${cells.join("")}</div>`;
}
function renderWeekCalendar(incl) {
  const monday = state.weekViewMonday || currentWeekBounds().monday;
  const sunday = addDays(monday, 6);
  const days = datesInRange(monday, sunday);
  const totals = weekStyleTotals(days);
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((x) => incl[x]);
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
    ${renderWeekCells(days, incl)}
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
// Calendars start the week on Monday: how many blank cells come before a
// date in its first row (Mon = 0 … Sun = 6).
function mondayFirstOffset(iso) { return (weekdayOf(iso) + 6) % 7; }
function renderMiniMonth(monthKeyStr, incl, range) {
  const [y, m] = monthKeyStr.split("-").map(Number);
  const firstDow = mondayFirstOffset(`${monthKeyStr}-01`);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayISO();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="dd-mini-cell dd-mini-cell-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKeyStr}-${String(d).padStart(2, "0")}`;
    if (range && (iso < range.from || iso > range.to)) {
      cells.push(`<div class="dd-mini-cell dd-mini-out"><span class="dd-mini-daynum">${d}</span><div class="dd-mini-bar dd-mini-bar-empty"></div></div>`);
      continue;
    }
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
      <div class="dd-mini-month-title">${range && range.withYear ? monthLabelFromKey(monthKeyStr) : monthLabelFromKey(monthKeyStr).split(" ")[0]}</div>
      <div class="dd-mini-weekdays"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
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
  const firstDow = mondayFirstOffset(`${monthKeyStr}-01`);
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
    cells.push(renderMonthCell(iso, daily[iso], incl));
  }
  return `
    ${renderTallyGrid(cats, totals)}
    <div class="dd-cal-nav">
      <button type="button" class="dd-cal-nav-btn" data-action="cal-prev-month">‹</button>
      <div class="dd-cal-nav-label">${monthLabelFromKey(monthKeyStr)}</div>
      <button type="button" class="dd-cal-nav-btn" data-action="cal-next-month">›</button>
    </div>
    <div class="dd-cal-weekdays"><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div><div>S</div></div>
    <div class="dd-cal-grid">${cells.join("")}</div>
    ${renderDayDetail(state.selectedCalendarDay, incl)}
    ${renderCalLegend(incl)}
    ${renderDayTypeLegend()}`;
}
// One day in the month-style grid. `monthTag` adds a small month name
// beside the day number (Custom ranges that cross into another month).
function renderMonthCell(iso, c, incl, monthTag) {
    const today = todayISO();
    const d = parseInt(iso.slice(8, 10), 10);
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
    return `<button type="button" class="dd-cal-cell ${dayTypeClass} ${iso === today ? "dd-cal-today" : ""} ${isSelected ? "dd-cal-selected" : ""}" data-action="select-cal-day" data-date="${iso}"><div class="dd-cal-daynum">${d}${monthTag ? `<span class="dd-cal-montag">${monthTag}</span>` : ""}</div><div class="dd-cal-dots">${dots.join("")}</div></button>`;
}
// ---------- Custom and All views ----------
function customRangeBounds() {
  let from = state.chartCustomFrom || todayISO(), to = state.chartCustomTo || todayISO();
  // Older sessions kept month keys (YYYY-MM) here.
  if (from.length === 7) from = `${from}-01`;
  if (to.length === 7) { const [y, m] = to.split("-").map(Number); to = `${to}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; }
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
function addYearsISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y + n, m - 1, d));
  return dt.toISOString().slice(0, 10);
}
// Which layout a Custom range gets, by length: up to 7 days → Week,
// up to 31 days → Month, up to a year → Year, longer → the All trend graph.
function customRangeLayout(from, to) {
  const n = daysBetween(from, to) + 1;
  if (n <= 7) return "week";
  if (n <= 31) return "month";
  if (to < addYearsISO(from, 1)) return "year";
  return "all";
}
function allRangeBounds() {
  const today = todayISO();
  let from = today;
  const consider = (d) => { if (d && d < from) from = d; };
  state.incidents.forEach((i) => { if (!i.deleted) consider(i.date); });
  state.suspensions.forEach((x) => { if (!x.deleted) consider(x.startDate); });
  state.timeOuts.forEach((x) => { if (!x.deleted) consider(x.startDate); });
  state.parentMeetings.forEach((m) => { if (isPmCounted(m)) consider(pmDate(m)); });
  return { from, to: today };
}
// Title in the middle of the nav row, with invisible spacers where the
// ‹ › arrows sit in the other views so it lines up the same way.
function renderRangeNavLabel(title, from, to) {
  return `
    <div class="dd-cal-nav">
      <span class="dd-cal-nav-btn dd-cal-nav-spacer" aria-hidden="true"></span>
      <div class="dd-cal-nav-label">
        <div>${title}</div>
        <div class="dd-cal-nav-sublabel">${from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`}</div>
      </div>
      <span class="dd-cal-nav-btn dd-cal-nav-spacer" aria-hidden="true"></span>
    </div>`;
}
function renderCustomView(incl) {
  const { from, to } = customRangeBounds();
  const layout = customRangeLayout(from, to);
  if (layout === "all") return renderTrendView(incl, from, to, "Custom");
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((c) => incl[c]);
  const nav = renderRangeNavLabel("Custom", from, to);
  const footer = `
    ${renderDayDetail(state.selectedCalendarDay, incl)}
    ${renderCalLegend(incl)}
    ${renderDayTypeLegend()}`;
  if (layout === "week") {
    const days = datesInRange(from, to);
    return `${renderTallyGrid(cats, weekStyleTotals(days))}${nav}${renderWeekCells(days, incl)}${footer}`;
  }
  const totals = rangeStyleTotals(from, to);
  if (layout === "month") {
    const cells = [];
    for (let i = 0; i < mondayFirstOffset(from); i++) cells.push(`<div class="dd-cal-cell dd-cal-cell-empty"></div>`);
    const crossesMonth = monthKey(from) !== monthKey(to);
    datesInRange(from, to).forEach((iso, i) => {
      const tag = crossesMonth && (i === 0 || iso.endsWith("-01")) ? monthLabelFromKey(monthKey(iso)).split(" ")[0].slice(0, 3) : "";
      cells.push(renderMonthCell(iso, computeCountsForDate(iso), incl, tag));
    });
    return `${renderTallyGrid(cats, totals)}${nav}
    <div class="dd-cal-weekdays"><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div><div>S</div></div>
    <div class="dd-cal-grid">${cells.join("")}</div>${footer}`;
  }
  const months = monthKeysInRange(monthKey(from), monthKey(to));
  const range = { from, to, withYear: from.slice(0, 4) !== to.slice(0, 4) };
  return `${renderTallyGrid(cats, totals)}${nav}
    <div class="dd-mini-year-grid">${months.map((mk) => renderMiniMonth(mk, incl, range)).join("")}</div>${footer}`;
}
// Term 1–4: this year's term, week by week. Tally counted like Month/Year
// (each entry once, on its start date, within the term's dates).
function renderTermView(incl, idx) {
  const year = new Date().getFullYear();
  const t = computeMoeCalendar(year).terms[idx];
  return renderTrendView(incl, t.start, t.end, `Term ${idx + 1} ${year}`, "weeks");
}
function renderAllView(incl) {
  const { from, to } = allRangeBounds();
  return renderTrendView(incl, from, to, "All");
}
// The 4 lines of the long-range trend graph (suspension is one line —
// in-school and out-of-school together). The Suspension pill switches
// both suspension lines together.
const TREND_LINES = [
  { key: "discipline", cat: "discipline", label: "Grooming", color: CHART_COLORS.discipline },
  { key: "parentMeeting", cat: "parentMeeting", label: "Parent Meet", color: CHART_COLORS.parentMeeting },
  { key: "timeOut", cat: "timeOut", label: "Time Out", color: CHART_COLORS.timeOut },
  { key: "suspension", cat: "suspension", label: "Suspension", color: CHART_COLORS.suspension },
];
// One point per month, trimmed to the range at both ends.
function trendBuckets(from, to, mode) {
  // Term view: one point per school week (Week 1 starts on the term's first day).
  if (mode === "weeks") {
    const out = [];
    for (let s0 = from, w = 1; s0 <= to && w <= 20; s0 = addDays(s0, 7), w++) {
      const e0 = addDays(s0, 6) > to ? to : addDays(s0, 6);
      out.push({ week: w, start: s0, end: e0, label: `W${w}`, title: `Week ${w} · ${formatDateShort(s0)} – ${formatDateShort(e0)}` });
    }
    return out;
  }
  return monthKeysInRange(monthKey(from), monthKey(to)).map((mk) => {
    const [y, m] = mk.split("-").map(Number);
    const start = `${mk}-01`, end = `${mk}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    return { year: y, month: m, start: start < from ? from : start, end: end > to ? to : end, label: MONTH_ABBR[m - 1], title: `${MONTH_ABBR[m - 1]} ${y}` };
  });
}
// Counted like the Month and Year views: one per entry, on its start date.
// A suspension with both in-school and out-of-school days counts on both
// suspension lines.
function computeTrendSeries(buckets) {
  return buckets.map((b) => {
    const inB = (d) => d && d >= b.start && d <= b.end;
    let iss = 0, oss = 0;
    state.suspensions.forEach((x) => {
      if (x.deleted || !inB(x.startDate)) return;
      const types = new Set(suspensionDayEntries(x).map((e) => (e.type === "OSS" ? "OSS" : "ISS")));
      if (!types.size) types.add(x.type === "OSS" ? "OSS" : "ISS");
      if (types.has("ISS")) iss++;
      if (types.has("OSS")) oss++;
    });
    return {
      ...b, iss, oss,
      suspension: state.suspensions.filter((x) => !x.deleted && inB(x.startDate)).length,
      discipline: state.incidents.filter((i) => !i.deleted && inB(i.date)).length,
      timeOut: state.timeOuts.filter((x) => !x.deleted && inB(x.startDate)).length,
      parentMeeting: state.parentMeetings.filter((m) => isPmCounted(m) && inB(pmDate(m))).length,
    };
  });
}
function renderTrendView(incl, from, to, title, mode = "months") {
  const cats = ["discipline", "suspension", "timeOut", "parentMeeting"].filter((c) => incl[c]);
  const lines = TREND_LINES.filter((l) => incl[l.cat]);
  return `
    ${renderTallyGrid(cats, rangeStyleTotals(from, to))}
    ${renderRangeNavLabel(title, from, to)}
    ${lines.length ? `
    <div class="dd-trend-lines-wrap">
      <div class="dd-trend-lines" data-from="${from}" data-to="${to}" data-mode="${mode}"></div>
    </div>
    <div class="dd-cal-legend dd-trend-lines-legend">
      ${[lines].filter((row) => row.length).map((row) => `
      <div class="dd-trend-lines-legend-row" data-fit="trend-legend">${row.map((l) => `<div class="dd-cal-legend-item"><span class="dd-legend-line" style="background:${l.color}"></span>${l.label}</div>`).join("")}</div>`).join("")}
    </div>
    <div class="dd-mono-muted dd-trend-lines-note">${mode === "weeks" ? "One point per school week. Tap or drag across the graph to see each week's numbers." : "One point per month. Tap or drag across the graph to see each month's numbers."} Each entry is counted once, on the date it starts.</div>` : ""}`;
}
// Drawn after the page is on screen, so the graph can be sized to the
// space it actually has. Styled like a stock chart: thin lines, the value
// axis fixed on the left, and the whole range always fitted to the width
// (no scrolling). When months get too close together for every name to
// fit, only every 2nd / 3rd / 6th month is named, and with very long
// ranges only each January (with its year).
// Numbers aren't printed on the graph (they collide once months are close
// together). Instead, as in a stock app, tapping or dragging across it
// snaps a vertical line to the nearest month and shows a small card, inside
// the graph, with that month's count for each line. Tapping the same month
// again, or anywhere off the graph, hides it.
function drawTrendLineCharts() {
  document.querySelectorAll(".dd-trend-lines").forEach((host) => {
    const mode = host.dataset.mode || "months";
    const rows = computeTrendSeries(trendBuckets(host.dataset.from, host.dataset.to, mode));
    // Lines stop at the current week/month: periods that haven't started
    // keep their label but get no point (a flat 0 would look like a quiet spell).
    const today = todayISO();
    const lastPast = rows.reduce((acc, r, i) => (r.start <= today ? i : acc), -1);
    const lines = TREND_LINES.filter((l) => chartIncl()[l.cat]);
    const axisW = 30;
    host.innerHTML = `<div class="dd-trend-axis"></div><div class="dd-trend-scroll"></div><div class="dd-trend-card" hidden></div>`;
    const plotBox = host.querySelector(".dd-trend-scroll"), axisBox = host.querySelector(".dd-trend-axis"), card = host.querySelector(".dd-trend-card");
    const avail = Math.max(200, host.clientWidth - axisW);
    const H = 250, padT = 18, padB = 34, padL = 12, padR = 12;
    const n = rows.length;
    const plotW = avail - padL - padR;
    const W = plotW + padL + padR, plotH = H - padT - padB;
    const maxV = Math.max(1, ...rows.slice(0, lastPast + 1).flatMap((r) => lines.map((l) => r[l.key])));
    // Scale in even steps (1, 2, 5, 10, 20, 25, 50…), at most 5 of them.
    const tickStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((st) => Math.ceil(maxV / st) <= 5) || Math.ceil(maxV / 5);
    const axisMax = Math.max(tickStep, Math.ceil(maxV / tickStep) * tickStep);
    const x = (i) => (n === 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1));
    const y = (v) => padT + plotH - (v / axisMax) * plotH;
    const font = `font-family="Geist, system-ui, -apple-system, sans-serif"`;
    const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, i) => i * tickStep);
    const grid = ticks.map((t) => `<line x1="0" y1="${y(t)}" x2="${W}" y2="${y(t)}" stroke="${t === 0 ? "#C9C4B4" : "#ECE9DF"}" stroke-width="1"></line>`).join("");
    // A faint divider where each new year starts.
    const yearLines = rows.map((r, i) => (mode === "months" && i > 0 && r.month === 1 ? `<line x1="${x(i) - (x(i) - x(i - 1)) / 2}" y1="${padT - 8}" x2="${x(i) - (x(i) - x(i - 1)) / 2}" y2="${padT + plotH}" stroke="#C9C4B4" stroke-width="1" stroke-dasharray="3 3"></line>` : "")).join("");
    // "Jan" with the year under it, on the first month and on every January.
    // A month name needs about 24px; name fewer months when they're closer.
    const gap = n > 1 ? plotW / (n - 1) : plotW;
    const step = mode === "weeks" ? (gap >= 20 ? 1 : 2) : [1, 2, 3, 6, 12].find((k) => gap * k >= 24) || 12;
    const onStep = (r) => (mode === "weeks" ? (r.week - 1) % step === 0 : (r.month - 1) % step === 0); // months: step 12 → January only
    // The first month is named even off-step, unless it would crowd the next named one.
    const nextNamed = rows.findIndex((r, i) => i > 0 && onStep(r));
    const showAt = (r, i) => (i === 0 ? nextNamed < 0 || nextNamed * gap >= 24 : onStep(r));
    const xLabels = rows.map((r, i) => (showAt(r, i) ? `
      <text x="${x(i)}" y="${padT + plotH + 14}" text-anchor="middle" font-size="9.5" ${font} fill="${r.start > today ? "#B5B09F" : "#6B6652"}">${r.label}</text>
      ${mode === "months" && (i === 0 || r.month === 1) ? `<text x="${x(i)}" y="${padT + plotH + 27}" text-anchor="middle" font-size="9.5" font-weight="600" ${font} fill="#1B2A41">${r.year}</text>` : ""}` : "")).join("");
    const dotR = gap < 8 ? 1.6 : 2.3;
    const paths = lines.map((l) => `
      ${lastPast > 0 ? `<polyline points="${rows.slice(0, lastPast + 1).map((r, i) => `${x(i)},${y(r[l.key])}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"></polyline>` : ""}
      ${rows.map((r, i) => (i <= lastPast && (r[l.key] > 0 || lastPast === 0) ? `<circle cx="${x(i)}" cy="${y(r[l.key])}" r="${dotR}" fill="${l.color}" data-line="${l.key}"></circle>` : "")).join("")}`).join("");
    const notYet = lastPast < 0 ? `<text x="${W / 2}" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" ${font} fill="#8A8571">Nothing yet — starts ${formatDate(rows[0] ? rows[0].start : host.dataset.from)}</text>` : "";
    plotBox.innerHTML = `<svg class="dd-trend-lines-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${yearLines}${xLabels}${paths}${notYet}<g class="dd-trend-cursor"></g></svg>`;
    axisBox.innerHTML = `<svg width="${axisW}" height="${H}" viewBox="0 0 ${axisW} ${H}">${ticks.map((t) => `<text x="${axisW - 6}" y="${y(t) + 3.5}" text-anchor="end" font-size="10" ${font} fill="#8A8571">${t}</text>`).join("")}</svg>`;

    // ---- tap / drag to read a month ----
    const svg = plotBox.querySelector("svg"), cursor = svg.querySelector(".dd-trend-cursor");
    let shown = -1;
    const hide = () => { shown = -1; cursor.innerHTML = ""; card.hidden = true; };
    const show = (i) => {
      shown = i;
      const r = rows[i];
      cursor.innerHTML = `<line x1="${x(i)}" y1="${padT - 8}" x2="${x(i)}" y2="${padT + plotH}" stroke="#1B2A41" stroke-width="1" stroke-opacity="0.55"></line>` +
        lines.map((l) => `<circle cx="${x(i)}" cy="${y(r[l.key])}" r="4" fill="#fff" stroke="${l.color}" stroke-width="2"></circle>`).join("");
      card.innerHTML = `<div class="dd-trend-card-title">${r.title}</div>` +
        lines.map((l) => `<div class="dd-trend-card-row" data-line="${l.key}"><span class="dd-legend-line" style="background:${l.color}"></span><span class="dd-trend-card-label">${l.cardLabel || l.label}</span><span class="dd-trend-card-num">${r[l.key]}</span></div>`).join("");
      card.hidden = false;
      // Beside the line, on the side with more room, kept inside the graph.
      const lineX = axisW + x(i), cw = card.offsetWidth, boxW = host.clientWidth;
      let left = x(i) > W / 2 ? lineX - cw - 10 : lineX + 10;
      left = Math.max(axisW + 2, Math.min(boxW - cw - 2, left));
      card.style.left = `${left}px`;
      card.style.top = `${padT - 6}px`;
    };
    const nearest = (ev) => {
      const b = svg.getBoundingClientRect();
      const px = ((ev.clientX - b.left) / b.width) * W;
      return n === 1 ? 0 : Math.max(0, Math.min(lastPast, Math.round(((px - padL) / plotW) * (n - 1))));
    };
    // Press: show that month (or, pressing the month already showing,
    // hide it on release unless the finger then drags to another month).
    let dragging = false, toggleOff = false;
    svg.addEventListener("pointerdown", (ev) => {
      if (lastPast < 0) return;
      dragging = true;
      const i = nearest(ev);
      toggleOff = i === shown;
      if (!toggleOff) show(i);
    });
    svg.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const i = nearest(ev);
      if (i !== shown) { toggleOff = false; show(i); }
    });
    svg.addEventListener("pointerup", () => { if (dragging && toggleOff) hide(); dragging = false; toggleOff = false; });
    svg.addEventListener("pointercancel", () => { dragging = false; toggleOff = false; });
    host._hideTrendCard = hide;
  });
}
// Tapping anywhere off a trend graph hides its card.
document.addEventListener("pointerdown", (ev) => {
  document.querySelectorAll(".dd-trend-lines").forEach((host) => { if (!host.contains(ev.target) && host._hideTrendCard) host._hideTrendCard(); });
}, true);
let trendResizeBound = false;
function bindTrendResize() {
  if (trendResizeBound) return;
  trendResizeBound = true;
  let t = null;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(drawTrendLineCharts, 150); });
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
        ${renderDateField("chart-custom-from", state.chartCustomFrom)}
        <label class="dd-label">To</label>
        ${renderDateField("chart-custom-to", state.chartCustomTo, `min="${state.chartCustomFrom}"`)}
        <div class="dd-mono-muted dd-custom-hint">Up to 7 days shows as a week, up to 31 days as a month, up to a year as a year, and anything longer as a trend graph.</div>
        <button class="dd-btn-primary" type="button" id="chart-custom-apply">Apply</button>
      </div>
    </div>`;
}
function chartIncl() {
  return {
    discipline: state.chartIncludeDiscipline !== false,
    suspension: state.chartIncludeSuspension !== false,
    timeOut: state.chartIncludeTimeOut !== false,
    parentMeeting: state.chartIncludeParentMeeting !== false,
  };
}
function renderMonthlyChart() {
  const rangeMode = state.chartRangeMode || "thisMonth";
  const incl = chartIncl();
  const rangePillsRow = (opts, cls = "") => `
    <div class="dd-range-pills${cls}">
      ${opts.map((o) => `<button type="button" class="dd-range-pill ${rangeMode === o.key ? "active" : ""}" data-action="set-chart-range" data-range="${o.key}">${o.label}</button>`).join("")}
    </div>`;
  const rangeSelectorHtml = `
    ${rangePillsRow(CHART_RANGE_OPTIONS_PRIMARY)}
    <div style="margin-top:8px">${rangePillsRow(CHART_RANGE_OPTIONS_SECONDARY, " dd-range-pills-fit")}</div>`;

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

  if (/^term[1-4]$/.test(rangeMode)) {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${renderTermView(incl, parseInt(rangeMode.slice(4), 10) - 1)}
    </div>
    ${state.showChartCustomModal ? renderChartCustomModal() : ""}`;
  }

  if (rangeMode === "all" || rangeMode === "custom") {
    return `
    <div class="dd-panel" style="margin-top:16px">
      ${rangeSelectorHtml}
      ${renderCategoryToggles(incl)}
      ${rangeMode === "all" ? renderAllView(incl) : renderCustomView(incl)}
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

// ---------- Students' Watchlist ----------

// Plain-language watchlist criteria for the info box — must match
// riskTierFor() in renderDashboardSection.
const RISK_TIER_CRITERIA = [
  { tier: "High Risk", criteria: ["2 or more suspensions", "3 or more final warnings", "7 or more 2nd warnings", "4 or more time outs"] },
  { tier: "Medium Risk", criteria: ["1 suspension", "2 final warnings", "4–6 2nd warnings", "2–3 time outs"] },
  { tier: "Low Risk", criteria: ["1 final warning", "1–3 2nd warnings", "1 time out"] },
];
// A "semester" is 2 terms: Terms 1–2 or Terms 3–4. Terms 1–2 stay in view
// through the June holidays, until Term 3 starts.
function computeCurrentSemesterBounds() {
  const year = new Date().getFullYear();
  const moe = computeMoeCalendar(year);
  const today = todayISO();
  const [t1, t2, t3, t4] = moe.terms;
  if (today < t3.start) return { start: t1.start, end: t2.end };
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
      <div><span class="dd-sans" style="font-size:14px;font-weight:600">${escapeHtml(truncateName(g.name))}</span>${g.studentClass ? ` <span class="dd-mono-muted" style="font-size:11px">${escapeHtml(g.studentClass)}</span>` : ""}</div>
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
// Postponed parent meetings still waiting for a new date. As soon as a new
// date is set the meeting is fixed, so it leaves this list (it then shows on
// the calendar and in the log on that date). Oldest original date first.
function pendingPostponedMeetings() {
  return state.parentMeetings
    .filter((m) => !m.deleted && m.pmStatus === "Postponed" && !m.postponedTo)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
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
          <div><span class="dd-sans dd-card-student-link" style="font-size:14px;font-weight:600" data-action="view-student" data-name="${escapeHtml(m.studentName)}" data-class="${escapeHtml(m.studentClass || "")}" data-year="${(m.date || "").slice(0, 4)}">${escapeHtml(truncateName(m.studentName))}</span>${m.studentClass ? ` <span class="dd-mono-muted" style="font-size:11px">${escapeHtml(m.studentClass)}</span>` : ""}</div>
          <div class="dd-pending-pm-grid">
            <div class="dd-field-label">Original meeting</div>
            <div class="dd-sans" style="font-size:14px">${formatDate(m.date)}${m.time ? `<div class="dd-mono-muted" style="font-size:11px">${escapeHtml(pmSlotLabel(m.time, m.endTime, m.location))}</div>` : ""}</div>
            <div class="dd-field-label">Postponed to</div>
            <div>${renderPostponeDateField(m)}</div>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
}
// Row of "+ Grooming / + Suspension / + Time Out / + Parent Meet" buttons —
// a common header shown at the top of every log tab (not just the
// dashboard), so a new entry can be started from wherever you're standing.
function renderNewEntryRow() {
  return `
    <div class="dd-new-entry-row">
      <button class="dd-newbtn dd-newbtn-compact" id="btn-new-case" style="flex:1">+ Grooming</button>
      <button class="dd-newbtn dd-newbtn-compact" id="btn-new-susp-only" style="flex:1">+ Suspension</button>
      <button class="dd-newbtn dd-newbtn-compact" id="btn-new-to-only" style="flex:1">+ Time Out</button>
      <button class="dd-newbtn dd-newbtn-compact" id="btn-new-pm-only" style="flex:1">+ Parent Meet</button>
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
  // A student who changed class mid-year (confirmed in their student view)
  // is counted once, shown under their latest class.
  const watchDate = {};
  const watchKey = (name, cls, date) => {
    const y = parseInt(String(date).slice(0, 4), 10);
    const grp = cls ? sameYearGroup(y, name, cls) : [""];
    return `${y}|${normalizeName(name)}|${normCls(grp[0])}`;
  };
  const noteClass = (key, cls, date) => { if (cls && (!watchDate[key] || date >= watchDate[key])) { watchClass[key] = cls; watchDate[key] = date; } };
  activeIncidents.forEach((i) => {
    if (i.date < semester.start || i.date > semester.end) return;
    const isLegacy = !Array.isArray(i.issues);
    const maxStage = isLegacy ? 0 : groomingEntryMaxStage(i);
    const key = watchKey(i.studentName, i.studentClass, i.date);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    if (maxStage >= 3) watchCounts[key].third++;
    else if (maxStage >= 2) watchCounts[key].second++;
    noteClass(key, i.studentClass, i.date);
    watchName[key] = i.studentName || watchName[key];
  });
  activeSusp.forEach((s) => {
    if (s.startDate < semester.start || s.startDate > semester.end) return;
    const key = watchKey(s.studentName, s.studentClass, s.startDate);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    watchCounts[key].suspension++;
    noteClass(key, s.studentClass, s.startDate);
    watchName[key] = s.studentName || watchName[key];
  });
  // Time outs count toward risk tiers too (1 = Low, 2-3 = Medium, 4+ = High),
  // as an extra "or" criterion alongside suspensions and warnings.
  activeTo.forEach((t) => {
    if (t.startDate < semester.start || t.startDate > semester.end) return;
    const key = watchKey(t.studentName, t.studentClass, t.startDate);
    watchCounts[key] = watchCounts[key] || { suspension: 0, timeOut: 0, second: 0, third: 0 };
    watchCounts[key].timeOut++;
    noteClass(key, t.studentClass, t.startDate);
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
        ${state.isAdmin ? `<div class="dd-error" style="margin-bottom:12px" data-action="goto-classes-for-year">Classes for ${new Date().getFullYear()} haven't been reviewed yet — <button type="button" class="dd-back-link" data-action="goto-classes-for-year" style="text-decoration:underline">tap here to set them up</button>.</div>` : `<div class="dd-error" style="margin-bottom:12px">Classes for ${new Date().getFullYear()} haven't been reviewed yet — ask an admin or the owner to set them up.</div>`}` : ""}
        ${renderNewEntryRow()}

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
                <div class="dd-sans" style="font-size:14px"><span class="dd-card-student-link" data-action="view-student" data-name="${escapeHtml(t.name)}" data-class="${escapeHtml(t.studentClass || "")}" data-year="${new Date().getFullYear()}">${escapeHtml(truncateName(t.name))}</span>${t.studentClass ? ` <span class="dd-mono-muted" style="font-size:11px">${escapeHtml(t.studentClass)}</span>` : ""}</div>
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
        ${renderNewEntryRow()}
        ${renderLevelBreakdown("discipline", state.incidents, "date")}
        ${renderExportButton("discipline")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button class="dd-pill ${filter === "all" ? "active" : ""}" data-action="set-discipline-filter" data-filter="all">Show All</button>
          <button class="dd-pill ${filter === "Monitoring" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Monitoring">In Progress (${c.Monitoring})</button>
          <button class="dd-pill ${filter === "Resolved" ? "active" : ""}" data-action="set-discipline-filter" data-filter="Resolved">Resolved (${c.Resolved})</button>
        </div>
        ${state.disciplineExpandedLevel ? renderClassPillsRow("discipline", state.disciplineExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" data-fit-placeholder id="search-input" placeholder="Search by name, class, issue, or teacher…" value="${escapeHtml(state.query)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.incidents.length === 0 ? "No entries yet. Log the first grooming issue to start the record." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderIncidentDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.editingIncidentId ? renderEditIncidentForm() : ""}
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
      ${state.showNewPmForm ? renderPmForm(false) : ""}
    </div>`;
}

// ---------- Same-name students across years ----------
// Classes change every year, so a student's earlier records can't be found
// by name + class. Instead, a teacher confirms once which earlier record (if
// any) is the same student; the answer is saved in studentLinks and shared.
// Nothing is linked automatically: two students can share a name.
function allStudentRecords() {
  return [
    ...state.incidents.filter((i) => !i.deleted).map((r) => ({ kind: "grooming", r, date: r.date })),
    ...state.suspensions.filter((x) => !x.deleted).map((r) => ({ kind: "susp", r, date: r.startDate })),
    ...state.timeOuts.filter((x) => !x.deleted).map((r) => ({ kind: "to", r, date: r.startDate })),
    ...state.parentMeetings.filter((x) => !x.deleted).map((r) => ({ kind: "pm", r, date: pmDate(r) || r.date })),
  ].filter((x) => x.date).map((x) => ({ ...x, year: parseInt(x.date.slice(0, 4), 10) }));
}
function normCls(c) { return (c || "").trim().toUpperCase(); }
function linkId(year, name, cls) {
  return `${year}_${encodeURIComponent(normalizeName(name))}_${encodeURIComponent(normCls(cls))}`;
}
// Mid-year class change: one answer per pair of classes (either order).
function moveId(year, name, clsA, clsB) {
  const [a, b] = [normCls(clsA), normCls(clsB)].sort();
  return `move_${year}_${encodeURIComponent(normalizeName(name))}_${encodeURIComponent(a)}_${encodeURIComponent(b)}`;
}
function moveDecision(year, name, a, b) { return (state.studentLinks || {})[moveId(year, name, a, b)] || null; }
// All classes a student was in during one year: the class itself plus any
// confirmed as the same student after a class change.
function sameYearGroup(year, name, cls) {
  const nm = normalizeName(name);
  const edges = Object.values(state.studentLinks || {}).filter((d) => d.kind === "move" && d.decision === "same" && d.year === year && normalizeName(d.name) === nm);
  const seen = new Set([normCls(cls)]);
  const out = [cls.trim()];
  for (let grew = true; grew;) {
    grew = false;
    edges.forEach((d) => {
      const [a, b] = d.classes;
      [[a, b], [b, a]].forEach(([x, y]) => { if (seen.has(normCls(x)) && !seen.has(normCls(y))) { seen.add(normCls(y)); out.push(y); grew = true; } });
    });
  }
  return out.sort((a, b) => a.localeCompare(b));
}
// The earlier-year answer for a student in a year (any of their classes).
function linkDecision(year, name, cls) {
  for (const c of sameYearGroup(year, name, cls)) { const d = (state.studentLinks || {})[linkId(year, name, c)]; if (d) return d; }
  return null;
}
// Same-name records at a level in a year, grouped into students (classes
// already confirmed as one student are one option).
function nameGroupsAt(all, year, name, level, excludeClasses = []) {
  const nm = normalizeName(name);
  const ex = new Set(excludeClasses.map(normCls));
  const counts = new Map();
  all.forEach((x) => {
    if (x.year !== year || normalizeName(x.r.studentName) !== nm || classLevel(x.r.studentClass) !== level) return;
    const c = normCls(x.r.studentClass);
    if (ex.has(c)) return;
    counts.set(c, { cls: x.r.studentClass.trim(), count: (counts.get(c)?.count || 0) + 1 });
  });
  const groups = [];
  const done = new Set();
  [...counts.values()].sort((a, b) => a.cls.localeCompare(b.cls)).forEach((o) => {
    if (done.has(normCls(o.cls))) return;
    const members = sameYearGroup(year, name, o.cls).filter((c) => counts.has(normCls(c)));
    members.forEach((c) => done.add(normCls(c)));
    groups.push({ cls: members[0], classes: members, count: members.reduce((n, c) => n + counts.get(normCls(c)).count, 0) });
  });
  return groups;
}
// Earlier same-name students this year's student could be: the nearest
// earlier year with records for that name one level lower per year back.
function linkCandidates(year, name, cls, all = allStudentRecords()) {
  const lvl = classLevel(cls);
  if (lvl === 999) return null;
  for (let y = year - 1; y >= year - 6; y--) {
    const expected = lvl - (year - y);
    if (expected < 1) break;
    const options = nameGroupsAt(all, y, name, expected);
    if (options.length) return { year: y, options };
  }
  return null;
}
// The next unanswered question for a student in a year, if any: first a
// same-year class change (same name, same level, another class), then the
// earlier year.
function pendingLinkQuestion(year, name, cls, all = allStudentRecords()) {
  const lvl = classLevel(cls);
  if (lvl === 999) return null;
  const group = sameYearGroup(year, name, cls);
  const moveOpts = nameGroupsAt(all, year, name, lvl, group)
    .filter((o) => !group.some((g) => o.classes.some((c) => moveDecision(year, name, g, c))));
  if (moveOpts.length) return { type: "move", year, name, cls, candYear: year, options: moveOpts };
  if (linkDecision(year, name, cls)) return null;
  const c = linkCandidates(year, name, cls, all);
  return c ? { type: "year", year, name, cls, candYear: c.year, options: c.options } : null;
}
// A student's records grouped by year: the tapped record's year (its class
// plus any confirmed class change), then earlier years only along confirmed
// links. Also returns the next unanswered question and the answers given
// (for undo).
function studentRecordsByYear(name, cls, yearHint) {
  const all = allStudentRecords();
  // The record that was tapped already knows its own year — use that so a
  // common name reused in the same class label in a later, unrelated year
  // doesn't get pulled into this student's identity. Only guess (via the
  // newest exact name+class match) when no year was passed in.
  let startYear = yearHint;
  if (!startYear) {
    const exactYears = all.filter((x) => studentKey(x.r.studentName, x.r.studentClass) === studentKey(name, cls)).map((x) => x.year);
    startYear = exactYears.length ? Math.max(...exactYears) : new Date().getFullYear();
  }
  let id = { year: startYear, name, cls };
  const byYear = new Map();
  const classesByYear = new Map();
  const addGroup = (y, n, c) => {
    const grp = sameYearGroup(y, n, c);
    classesByYear.set(y, grp);
    const keys = new Set(grp.map((g) => studentKey(n, g)));
    all.forEach((x) => {
      if (x.year !== y || !keys.has(studentKey(x.r.studentName, x.r.studentClass))) return;
      if (!byYear.has(y)) byYear.set(y, { grooming: [], susp: [], to: [], pm: [] });
      byYear.get(y)[x.kind].push(x.r);
    });
    return grp;
  };
  const answered = [];
  let question = null;
  for (let hop = 0; hop < 12; hop++) {
    const grp = addGroup(id.year, id.name, id.cls);
    for (let a = 0; a < grp.length; a++) for (let b = a + 1; b < grp.length; b++) {
      const d = moveDecision(id.year, id.name, grp[a], grp[b]);
      if (d && d.decision === "same") answered.push({ kind: "move", year: id.year, name: id.name, classes: [grp[a], grp[b]], dec: d });
    }
    question = pendingLinkQuestion(id.year, id.name, id.cls, all);
    if (question) break;
    const dec = linkDecision(id.year, id.name, id.cls);
    if (!dec) break;
    answered.push({ kind: "year", from: { year: id.year, name: id.name, cls: dec.cls }, dec });
    if (dec.decision !== "linked" || !dec.toYear || !dec.toClass) break;
    id = { year: dec.toYear, name: id.name, cls: dec.toClass };
  }
  byYear.forEach((g) => {
    g.grooming.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    g.susp.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    g.to.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    g.pm.sort((a, b) => (pmDate(b) || b.date || "").localeCompare(pmDate(a) || a.date || ""));
  });
  return { byYear, classesByYear, question, answered };
}
// Saves an answer. For a class change, the picked option is "same" and
// every other option listed is "different" (so it isn't asked again).
async function saveStudentLink(q, toClass) {
  state.linkError = "";
  const base = { name: q.name, by: teacherName(), at: Date.now() };
  try {
    if (q.type === "move") {
      for (const o of q.options) {
        const same = !!toClass && normCls(o.cls) === normCls(toClass);
        await setDoc(doc(db, "studentLinks", moveId(q.year, q.name, q.cls, o.cls)), { ...base, kind: "move", year: q.year, classes: [q.cls, o.cls], decision: same ? "same" : "different" });
      }
    } else {
      await setDoc(doc(db, "studentLinks", linkId(q.year, q.name, q.cls)), { ...base, kind: "year", year: q.year, cls: q.cls,
        decision: toClass ? "linked" : "new", toYear: toClass ? q.candYear : null, toClass: toClass || null });
    }
  } catch (err) { state.linkError = err?.code === "permission-denied" ? "Couldn't save — the updated database rules (firestore.rules) haven't been published yet." : `Couldn't save — ${err?.message || String(err)}`; }
  render();
}
async function undoStudentLink(linkDocId) {
  state.linkError = "";
  try { await deleteDoc(doc(db, "studentLinks", linkDocId)); }
  catch (err) { state.linkError = err?.code === "permission-denied" ? "Only Admins and the Owner can remove student links." : `Couldn't remove — ${err?.message || String(err)}`; }
  render();
}
// Settings → Student Links: every saved answer, newest year first. Anyone
// can look; only Admins and the Owner can change or remove an answer
// (firestore.rules enforces the same).
function studentLinkLine(id, d) {
  if (d.kind === "move") {
    const cls = [...(d.classes || [])].sort((a, b) => a.localeCompare(b)).map(escapeHtml);
    return d.decision === "same"
      ? `${cls.join(" / ")} (${d.year}): same student`
      : `${cls.join(" / ")} (${d.year}): different students`;
  }
  return d.decision === "linked"
    ? `${escapeHtml(d.cls)} (${d.year}) same student as ${escapeHtml(d.toClass)} (${d.toYear})`
    : `${escapeHtml(d.cls)} (${d.year}) different student from earlier years`;
}
const ICON_PENCIL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;
const ICON_BIN = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>`;
// The year a student is in P6 (every student moves up one level a year),
// worked out from any answer about them; null if the class has no level.
function linkP6Year(d) {
  const cls = d.kind === "move" ? (d.classes || [])[0] : d.cls;
  const lvl = classLevel(cls);
  return lvl === 999 ? null : d.year + (6 - lvl);
}
function renderStudentLinksSettings() {
  const canEdit = !!state.isAdmin;
  const q = normalizeName(state.linkSearch || "");
  const thisYear = new Date().getFullYear();
  const all = Object.entries(state.studentLinks || {})
    .filter(([, d]) => d && d.name && (!q || normalizeName(d.name).includes(q)))
    .sort(([, a], [, b]) => (b.year - a.year) || normalizeName(a.name).localeCompare(normalizeName(b.name)) || (b.at || 0) - (a.at || 0));
  // Students past their P6 year have graduated: their answers are parked in
  // the archive at the bottom (still searchable and editable).
  const graduated = ([, d]) => { const p6 = linkP6Year(d); return p6 !== null && p6 < thisYear; };
  const entries = all.filter((e) => !graduated(e));
  const archived = all.filter(graduated);
  const years = [...new Set(entries.map(([, d]) => d.year))];
  const when = (t) => (t ? formatDate(new Date(t + 8 * 3600000).toISOString().slice(0, 10)) : "");
  const row = ([id, d]) => {
    const viewCls = d.kind === "move" ? (d.classes || [])[0] : d.cls;
    return `
        <div class="dd-link-row">
          <div class="dd-link-row-top">
            <span class="dd-card-student-link dd-link-row-name" data-action="view-student" data-name="${escapeHtml(d.name)}" data-class="${escapeHtml(viewCls || "")}" data-year="${d.year || ""}">${escapeHtml(d.name)}</span>
            ${canEdit ? `
            <span class="dd-link-row-icons">
              <button type="button" class="dd-link-icon" data-link-change="${escapeHtml(id)}" title="Change answer" aria-label="Change answer">${ICON_PENCIL}</button>
              <button type="button" class="dd-link-icon dd-link-icon-remove" data-link-remove="${escapeHtml(id)}" title="Remove" aria-label="Remove">${ICON_BIN}</button>
            </span>` : ""}
          </div>
          <div class="dd-link-row-text" data-fit="">${studentLinkLine(id, d)}</div>
          <div class="dd-mono-muted dd-link-row-meta">${escapeHtml(d.by || "")}${d.at ? ` · ${when(d.at)}` : ""}</div>
        </div>`;
  };
  // Collapsible year headers (closed by default; a search opens every
  // year with a match).
  const yearsOpen = state.linkYearsOpen || {};
  const yearBlock = (key, label, count, inner) => {
    const open = !!q || !!yearsOpen[key];
    return `
      <div class="dd-student-year">
        <button type="button" class="dd-settings-menu-row" data-action="toggle-link-year" data-key="${escapeHtml(key)}" aria-expanded="${open}">
          <span>${label}</span>
          <span class="dd-settings-chevron">${open ? "⌄" : "›"}</span>
        </button>
        ${open ? `<div class="dd-link-year-body">${inner}</div>` : ""}
      </div>`;
  };
  const gradYears = [...new Set(archived.map(([, d]) => linkP6Year(d)))].sort((a, b) => b - a);
  const archiveOpen = !!state.linkArchiveOpen || (!!q && archived.length > 0 && entries.length === 0);
  const archiveHtml = archived.length ? `
      <div class="dd-settings-menu-group" style="margin-top:22px">
        <button type="button" class="dd-settings-menu-row" data-action="toggle-link-archive" aria-expanded="${archiveOpen}">
          <span>Archive</span>
          <span class="dd-settings-chevron">${archiveOpen ? "⌄" : "›"}</span>
        </button>
        ${archiveOpen ? `<div class="dd-link-archive">${gradYears.map((gy) => {
          const items = archived.filter(([, d]) => linkP6Year(d) === gy);
          return yearBlock(`grad-${gy}`, `Graduated end of ${gy}`, items.length, items.map(row).join(""));
        }).join("")}</div>` : ""}
      </div>` : "";
  return `
      <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0 4px">Student Links</div>
      <div class="dd-mono-muted" style="font-size:12px;margin-bottom:10px">Answers to "Is this the same student?" — for students with the same name across years or after a class change.${canEdit ? "" : " Only Admins and the Owner can change these."}</div>
      <input class="dd-input dd-search" id="link-search-input" data-fit-placeholder placeholder="Search by student name…" value="${escapeHtml(state.linkSearch || "")}" style="margin-bottom:12px" />
      ${entries.length === 0 ? `<div class="dd-dash-empty">${q ? "No current students match this name." : "No answers yet for current students."}</div>` : `
      <div class="dd-settings-menu-group">${years.map((y) => {
        const items = entries.filter(([, d]) => d.year === y);
        return yearBlock(String(y), String(y), items.length, items.map(row).join(""));
      }).join("")}</div>`}
      ${archiveHtml}
      ${state.linkError ? `<div class="dd-error" style="margin-top:10px">${escapeHtml(state.linkError)}</div>` : ""}`;
}
// "Change answer": the saved answer is removed and the same question is
// asked again straight away (as a pop-up).
async function changeStudentLink(linkDocId) {
  const d = (state.studentLinks || {})[linkDocId];
  if (!d) return;
  const cls = d.kind === "move" ? (d.classes || [])[0] : d.cls;
  state.linkError = "";
  try {
    await deleteDoc(doc(db, "studentLinks", linkDocId));
    state.linkPromptQueue = [{ year: d.year, name: d.name, cls }, ...(state.linkPromptQueue || [])];
  } catch (err) { state.linkError = err?.code === "permission-denied" ? "Only Admins and the Owner can change student links." : `Couldn't change — ${err?.message || String(err)}`; }
  render();
}
// After a new entry is saved, ask straight away (once) if that student's
// name matches an earlier year.
function queueStudentLinkCheck(name, cls, date) {
  if (!name || !cls || !date) return;
  const year = parseInt(String(date).slice(0, 4), 10);
  state.linkPromptQueue = [...(state.linkPromptQueue || []), { year, name, cls }];
}
function currentLinkPrompt() {
  const all = allStudentRecords();
  while ((state.linkPromptQueue || []).length) {
    const p = state.linkPromptQueue[0];
    const q = pendingLinkQuestion(p.year, p.name, p.cls, all);
    if (q) return q;
    state.linkPromptQueue = state.linkPromptQueue.slice(1);
  }
  return null;
}
// The question, in the teacher's own wording: Yes/No when there's one
// earlier student with that name, a multiple choice (plus "None of the
// above") when there are several.
function renderLinkQuestion(q, where) {
  const attrs = `data-q-type="${q.type}" data-year="${q.year}" data-name="${escapeHtml(q.name)}" data-cls="${escapeHtml(q.cls)}" data-cand-year="${q.candYear}" data-where="${where}"`;
  const opt = (o) => `${escapeHtml(q.name)} in ${escapeHtml((o.classes || [o.cls]).join(" / "))} in ${q.candYear}`;
  const count = (o) => `<span class="dd-mono-muted" style="font-size:12px"> · ${o.count} record${o.count === 1 ? "" : "s"}</span>`;
  const head = `<div class="dd-link-q-head">Is this ${escapeHtml(q.name)} (${escapeHtml(q.cls)}) referring to:</div>`;
  if (q.options.length === 1) {
    const o = q.options[0];
    return `
      <div class="dd-link-q" ${attrs}>
        ${head}
        <div class="dd-link-q-single">${opt(o)}?${count(o)}</div>
        <div class="dd-link-q-btns">
          <button type="button" class="dd-add-btn" style="flex:1;background:#8A8571" data-link-answer="no" ${attrs}>No</button>
          <button type="button" class="dd-add-btn" style="flex:1" data-link-answer="yes" data-to-class="${escapeHtml(o.cls)}" ${attrs}>Yes</button>
        </div>
        <div class="dd-link-q-hint">No means a different student with the same name.</div>
      </div>`;
  }
  const name = `link-choice-${where}`;
  return `
    <div class="dd-link-q" ${attrs}>
      ${head}
      <div class="dd-link-q-options">
        ${q.options.map((o, i) => `<label class="dd-link-q-option"><input type="radio" name="${name}" value="${escapeHtml(o.cls)}" /><span>${opt(o)}${count(o)}${i < q.options.length - 1 ? `<span class="dd-link-q-or"> OR</span>` : ""}</span></label>`).join("")}
        <label class="dd-link-q-option"><input type="radio" name="${name}" value="" data-none="1" /><span>None of the above</span></label>
      </div>
      <div class="dd-link-q-btns">
        <button type="button" class="dd-add-btn" style="flex:1" data-link-answer="choice" data-radio="${name}" disabled ${attrs}>Confirm</button>
      </div>
      <div class="dd-link-q-hint">None of the above means a different student with the same name.</div>
    </div>`;
}
function renderLinkPromptModal() {
  const q = currentLinkPrompt();
  if (!q) return "";
  return `
    <div class="dd-modal-backdrop" id="link-prompt-backdrop">
      <div class="dd-modal" style="max-width:420px" role="dialog" aria-label="Same name found in an earlier year">
        <div class="dd-modal-title" style="margin-bottom:6px">${q.type === "move" ? `Same name in another ${escapeHtml(q.cls.replace(/-.*/, ""))} class` : `Same name found in ${q.candYear}`}</div>
        ${renderLinkQuestion(q, "modal")}
        ${state.linkError ? `<div class="dd-error" style="margin-top:8px">${escapeHtml(state.linkError)}</div>` : ""}
      </div>
    </div>`;
}

function renderStudentView() {
  const name = state.studentViewName || "";
  const cls = state.studentViewClass || "";
  const { byYear, classesByYear, question, answered } = studentRecordsByYear(name, cls, state.studentViewYear);
  const thisYear = new Date().getFullYear();
  const empty = { grooming: [], susp: [], to: [], pm: [] };
  const cur = byYear.get(thisYear) || empty;
  const pastYears = [...byYear.keys()].filter((y) => y < thisYear).sort((a, b) => b - a);
  const latest = [cur.grooming[0], cur.susp[0], cur.to[0], cur.pm[0]].find(Boolean);
  const curClasses = classesByYear.get(thisYear) || [];
  const latestClass = curClasses.length > 1 ? curClasses.join(" / ") : (latest?.studentClass || cls);
  const sectionBlock = (title, items, renderFn, hideIfEmpty) => (hideIfEmpty && !items.length) ? "" : `
    <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:20px 0 8px">${title} (${items.length})</div>
    ${items.length === 0 ? `<div class="dd-dash-empty">Nothing on file.</div>` : `<div style="display:flex;flex-direction:column;gap:12px">${items.map(renderFn).join("")}</div>`}`;
  const blocks = (g, hideIfEmpty) => `
        ${sectionBlock("Grooming Log", g.grooming, renderIncidentDetail, hideIfEmpty)}
        ${sectionBlock("Suspension Log", g.susp, renderSuspensionDetail, hideIfEmpty)}
        ${sectionBlock("Time Out Log", g.to, renderTimeOutDetail, hideIfEmpty)}
        ${sectionBlock("Parent Meets", g.pm, renderParentMeetingDetail, hideIfEmpty)}`;
  const open = state.studentViewOpenYears || {};
  const linkNotes = answered.map((a) => {
    const text = a.kind === "move"
      ? `${escapeHtml(a.classes.join(" and "))} in ${a.year} confirmed as the same student (class change)`
      : a.dec.decision === "linked"
        ? `${escapeHtml(a.from.cls)} ${a.from.year} linked to ${escapeHtml(a.from.name)} in ${escapeHtml(a.dec.toClass)} in ${a.dec.toYear}`
        : `${escapeHtml(a.from.cls)} ${a.from.year} marked as a different student from earlier ${escapeHtml(a.from.name)}s`;
    const docId = a.kind === "move" ? moveId(a.year, a.name, a.classes[0], a.classes[1]) : linkId(a.from.year, a.from.name, a.from.cls);
    return `
        <div class="dd-link-note" data-link-id="${escapeHtml(docId)}">${text} <span class="dd-mono-muted">(${escapeHtml(a.dec.by || "")})</span></div>`;
  }).join("");
  const questionHtml = question ? `
        <div class="dd-link-q-card">${renderLinkQuestion(question, "view")}</div>` : "";
  const pastHtml = pastYears.length ? `
        <div class="dd-dash-title" style="color:#1B2A41;font-size:14px;margin:28px 0 8px">Past years</div>
        <div class="dd-settings-menu-group dd-student-years">
          ${pastYears.map((y) => {
            const g = byYear.get(y);
            const n = g.grooming.length + g.susp.length + g.to.length + g.pm.length;
            const cls0 = (classesByYear.get(y) || []).join(" / ");
            return `
          <div class="dd-student-year">
            <button type="button" class="dd-settings-menu-row" data-action="toggle-student-year" data-year="${y}" aria-expanded="${!!open[y]}">
              <span>${y}${cls0 ? ` <span class="dd-mono-muted" style="font-size:12px">${escapeHtml(cls0)}</span>` : ""}</span>
              <span class="dd-student-year-meta"><span class="dd-mono-muted" style="font-size:12px">${n} record${n === 1 ? "" : "s"}</span><span class="dd-settings-chevron">${open[y] ? "⌄" : "›"}</span></span>
            </button>
            ${open[y] ? `<div class="dd-student-year-body">${blocks(g, true)}</div>` : ""}
          </div>`;
          }).join("")}
        </div>` : "";
  return `
    <div class="dd-app">
      ${renderNav()}
      <div class="dd-main">
        <button type="button" class="dd-back-link" data-action="student-view-back">‹ Back</button>
        <div class="dd-dash-title" style="color:#1B2A41;margin:10px 0">${escapeHtml(name)}${latestClass ? ` <span class="dd-mono-muted" style="font-size:14px;font-weight:400">${escapeHtml(latestClass)}</span>` : ""}</div>
        <div class="dd-mono-muted" style="font-size:12px;margin-bottom:6px">${thisYear} records across all four logs.${pastYears.length ? " Earlier years are at the bottom." : ""}</div>
        ${blocks(cur, false)}
        ${questionHtml}
        ${pastHtml}
        ${state.linkError && state.section === "studentView" ? `<div class="dd-error" style="margin-top:8px">${escapeHtml(state.linkError)}</div>` : ""}
        ${linkNotes ? `<div class="dd-link-notes">${linkNotes}</div>` : ""}
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
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(it.studentName)}" data-class="${escapeHtml(it.studentClass || "")}" data-year="${(it.date || "").slice(0, 4)}">${escapeHtml(it.studentName)}</div>
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
      <div class="dd-mono-muted" style="font-size:12px;margin:12px 0">This is an entry from before the Grooming Log rework — no per-issue tracking available for it.</div>
      ` : `
      <div style="margin:12px 0;display:flex;flex-direction:column;gap:10px">
        ${issues.map((issue) => {
          const cfg = GROOMING_ISSUE_CONFIG[issue.type] || GROOMING_ISSUE_CONFIG.Others;
          const overdue = !issue.resolved && issue.deadline < today;
          const isEscalating = state.escalatingIssue && state.escalatingIssue.issueId === issue.id;
          // One card per issue, with its stages nested inside as a timeline.
          // Collapsed (the default) shows only the latest stage — its label,
          // due date and Resolved/Escalate controls, including the note box
          // after Escalate — so a teacher can update it without scrolling
          // past earlier follow-ups. Expanding adds the completed stages
          // above it, oldest first, each with its note and who logged it.
          const hasHistory = issue.stage > 1;
          const issueOpen = hasHistory && !!state.issueExpanded[issue.id];
          const completedRows = [];
          if (issueOpen) for (let s = 1; s < issue.stage; s++) {
            const dueThen = issueStageDueDate(issue, s);
            const noteEntry = issueEscalationNote(issue, s + 1);
            const editKey = `${issue.id}_${s + 1}`;
            const isEditingNote = state.editingEscalationNote && state.editingEscalationNote.issueId === issue.id && state.editingEscalationNote.stage === s + 1;
            // Only the most recent follow-up can be removed (which puts the
            // issue back at that stage), reached through the same pencil
            // used to fix the note rather than a separate control.
            const canUnescalate = (s + 1 === issue.stage) && !issue.resolved;
            completedRows.push(`
            <div class="dd-stage-row">
              <div class="dd-stage-row-head">
                <span class="dd-issue-stage-badge">${WARNING_STAGE_LABEL[s]}</span>
                ${dueThen ? `<span class="dd-mono-muted dd-stage-due">Due ${formatDate(dueThen)}</span>` : ""}
              </div>
              ${noteEntry ? (isEditingNote ? `
              <div class="dd-followup-form dd-issue-note-form" style="margin-top:6px">
                <input class="dd-input" data-action="escalate-note-edit-input" data-key="${editKey}" value="${escapeHtml(state.escalateNoteEditDraft[editKey] ?? noteEntry.note)}" />
                <button class="dd-add-btn" data-action="confirm-escalation-note-edit" title="Save">✓</button>
              </div>
              ${state.escalateNoteEditError === editKey ? `<div class="dd-error" style="margin-top:2px">The note can't be empty.</div>` : ""}
              <button class="dd-back-link" style="margin-top:6px" data-action="cancel-escalation-note-edit">Cancel</button>
              ${canUnescalate ? `<button class="dd-back-link" style="margin-top:6px;margin-left:12px;color:#A3372B" data-action="unescalate-issue" data-id="${it.id}" data-issue="${issue.id}">Remove Follow Up</button>` : ""}
              ` : `
              <div style="display:flex;align-items:flex-start;gap:6px;margin-top:6px">
                <div style="flex:1;min-width:0">
                  <div class="dd-followup-note">${escapeHtml(noteEntry.note)}</div>
                  <div class="dd-followup-meta">Logged by ${escapeHtml(noteEntry.by || "")} · ${formatDate(noteEntry.at)}</div>
                  ${noteEntry.editedAt ? `<div class="dd-followup-meta">Edited by ${escapeHtml(noteEntry.editedBy || "")} · ${formatDateFromMs(noteEntry.editedAt)}</div>` : ""}
                </div>
                <button class="dd-followup-icon-btn" data-action="edit-escalation-note" data-id="${it.id}" data-issue="${issue.id}" data-stage="${s + 1}" data-note="${escapeHtml(noteEntry.note)}" title="Edit this note">✎</button>
              </div>
              `) : ""}
            </div>`);
          }
          return `
          <div class="dd-issue-card">
            <div class="dd-issue-card-top">
              <div class="dd-issue-card-label">${escapeHtml(groomingIssueLabel(issue))}</div>
              ${hasHistory ? `<button class="dd-expand-toggle" data-action="toggle-issue-expanded" data-issue="${issue.id}" title="${issueOpen ? "Hide earlier follow-ups" : "Show earlier follow-ups"}">${issueOpen ? "▲" : "▼"}</button>` : ""}
            </div>
            ${completedRows.join("")}
            <div class="dd-stage-row dd-stage-row-current">
            ${!issue.resolved ? `
            <div class="dd-issue-due-row dd-stage-row-head">
              <span class="dd-issue-stage-badge ${overdue ? "dd-issue-overdue" : ""}">${WARNING_STAGE_LABEL[issue.stage]}</span>
              <span class="dd-stage-due-group">
                <span class="dd-mono-muted dd-stage-due">Due ${formatDate(issue.deadline)}${overdue ? " — overdue" : ""}</span>
                <div class="dd-date-icon-btn" title="Change this issue's deadline">
                  <input type="date" class="dd-input dd-issue-override-input" data-id="${it.id}" data-issue="${issue.id}" value="${issue.deadline}" />
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
                </div>
              </span>
            </div>
            ${(() => {
              // Every non-final stage always shows exactly one FT-facing
              // action: Contact Parents once this issue's rules call for
              // it, otherwise a standing reminder that the student needs
              // to be spoken to. Final Warning always shows the escalated
              // action (facilitated call, or SH/SM contact for the
              // shsm-only issues) instead of either of those.
              if (issue.stage === 3) {
                return `<div class="dd-issue-instruction" data-fit="" data-fit-min="10">${cfg.finalAction === "shsm-only" ? "SH/SM Contact Parents" : "LST or SH/SM Enforced Facilitated Call"}</div>`;
              }
              return `<div class="dd-issue-instruction" data-fit="" data-fit-min="10">${cfg.parentFrom <= issue.stage ? "FT Contact Parents" : "FT Remind Student"}</div>`;
            })()}
            ${cfg.instructions ? (issue.stage === 1
              ? `<div class="dd-issue-instruction" data-fit="" data-fit-min="10">${escapeHtml(cfg.instructions[0] || "")}</div>`
              : `<div class="dd-mono-muted" style="font-size:11px;margin-top:2px">${escapeHtml(cfg.instructions[issue.stage - 1] || "")}</div>`) : ""}
            ${cfg.note ? `<div class="dd-issue-instruction" data-fit="" data-fit-min="10">${escapeHtml(cfg.note)}</div>` : ""}
            <div class="dd-issue-actions">
              <button class="dd-add-btn" data-action="resolve-issue" data-id="${it.id}" data-issue="${issue.id}">Resolved</button>
              ${issue.stage < 3 ? `<button class="dd-add-btn${isEscalating ? " dd-issue-btn-selected" : ""}" style="background:#A3372B" data-action="start-escalate" data-id="${it.id}" data-issue="${issue.id}">Escalate</button>` : ""}
            </div>
            ${isEscalating ? `
            <div class="dd-followup-form dd-issue-note-form" style="margin-top:8px">
              <input class="dd-input" data-action="escalate-note-input" data-issue="${issue.id}" placeholder="Follow-Up Notes" value="${escapeHtml(state.escalateNoteDraft[issue.id] || "")}" />
              <button class="dd-add-btn" data-action="confirm-escalate" title="Confirm and escalate">✓</button>
            </div>
            ${state.escalateNoteError === issue.id ? `<div class="dd-error" style="margin-top:2px">Enter a follow-up note before escalating.</div>` : ""}
            ` : ""}
            ` : `
            <div class="dd-stage-row-head">
              <span class="dd-issue-stage-badge dd-issue-resolved">Resolved</span>
              <span class="dd-mono-muted" style="font-size:12px">${formatDate(issue.resolvedAt)} at ${WARNING_STAGE_LABEL[issue.stage]}</span>
            </div>
            <div class="dd-issue-actions">
              <button class="dd-add-btn dd-issue-btn-selected" data-action="unresolve-issue" data-id="${it.id}" data-issue="${issue.id}">Resolved</button>
            </div>
            `}
            </div>
          </div>`;
        }).join("")}
      </div>`}
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
        ${renderNewEntryRow()}
        ${renderLevelBreakdown("suspension", state.suspensions, "startDate")}
        ${renderExportButton("suspension")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.suspTab === t ? "active" : ""}" data-action="set-susp-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.suspensionExpandedLevel ? renderClassPillsRow("suspension", state.suspensionExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" data-fit-placeholder id="susp-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.suspQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.suspensions.length === 0 ? "No suspensions logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderSuspensionDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.editingSuspensionId ? renderSuspForm(true) : ""}
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
      ${state.showNewPmForm ? renderPmForm(false) : ""}
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
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(s.studentName)}" data-class="${escapeHtml(s.studentClass || "")}" data-year="${(s.startDate || "").slice(0, 4)}">${escapeHtml(s.studentName)}</div>
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
        <ul class="dd-field-value dd-reason-bullets">${entryReasonLines(s).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Day-by-day (${entries.length} day${entries.length === 1 ? "" : "s"})</div>
      <div class="dd-followups" style="margin-bottom:16px">
        ${entries.map((e) => `<div class="dd-followup"><div class="dd-followup-note">${SUSP_TYPE_STYLE[e.type].label}${e.type === "ISS" && e.venue ? ` — ${escapeHtml(e.venue)}` : ""}</div><div class="dd-followup-meta">${formatDate(e.date)}</div></div>`).join("")}
      </div>
      <button class="dd-history-toggle" data-action="toggle-susp-history" data-id="${s.id}">${state.historyOpen[s.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[s.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="dd-add-btn" data-action="edit-suspension" data-id="${s.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-suspension" data-id="${s.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}

// Suspension-only now — Time Out grew its own type selector, free-text
// location and administrator field, so it forked into
// renderTimeOutFieldsBody instead of sharing this one.
function renderSuspFieldsBody(d, idPrefix, excludeSuspensionId) {
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
              <span class="dd-sans" style="font-size:13px;flex:1;${d.issVenues[dt] ? "" : "color:#8A8571"}">${d.issVenues[dt] ? escapeHtml(d.issVenues[dt]) : "Pending Location"}</span>
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
function attachSuspFieldListeners(form, idPrefix, d) {
  const onChange = renderKeepingModalScroll;
  const startDateEl = document.getElementById(`${idPrefix}-start-date`);
  if (startDateEl) startDateEl.addEventListener("change", () => { d.startDate = startDateEl.value; d.autoStart = false; regenerateSuspDates(resetSuspDays(d)); onChange(); });

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
          <div class="dd-mono-muted" style="font-size:11px;margin:12px 0 6px">Meeting date: ${formatDate(d.startDate)}</div>
          ${renderSlotPicker("susp-pm")}
          ${d.pmAttendees.includes("Others") ? `<input class="dd-input" id="susp-pm-others-text" style="margin-top:8px" placeholder="Please specify" value="${escapeHtml(d.pmOthersText)}" />` : ""}
          ${renderPmReasonPicker(d, "pm")}
        </div>` : ""}` : ""}
        ${state.suspFormError ? `<div class="dd-error">${escapeHtml(state.suspFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
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
        ${renderNewEntryRow()}
        ${renderLevelBreakdown("timeOut", state.timeOuts, "startDate")}
        ${renderExportButton("timeOut")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.toTab === t ? "active" : ""}" data-action="set-to-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.timeOutExpandedLevel ? renderClassPillsRow("timeOut", state.timeOutExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" data-fit-placeholder id="to-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.toQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.timeOuts.length === 0 ? "No time outs logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderTimeOutDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
      ${state.editingTimeOutId ? renderTimeOutForm(true) : ""}
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.showNewPmForm ? renderPmForm(false) : ""}
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
          <div class="dd-card-student dd-card-student-link" data-action="view-student" data-name="${escapeHtml(t.studentName)}" data-class="${escapeHtml(t.studentClass || "")}" data-year="${(t.startDate || "").slice(0, 4)}">${escapeHtml(t.studentName)}</div>
          <div class="dd-card-meta dd-card-meta-primary">${t.startDate ? formatDate(t.startDate) : ""}${t.studentClass ? ` · ${escapeHtml(t.studentClass)}` : ""}</div>
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
        <ul class="dd-field-value dd-reason-bullets">${entryReasonLines(t).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>
      </div>
      <div class="dd-mono-muted" style="font-size:11px;text-transform:uppercase;margin-bottom:8px">Day-by-day (${entries.length} day${entries.length === 1 ? "" : "s"})</div>
      <div class="dd-followups" style="margin-bottom:16px">
        ${entries.map((e) => `<div class="dd-followup"><div class="dd-followup-note">${escapeHtml(timeOutDayLabel(e))}</div><div class="dd-followup-meta">${formatDate(e.date)}</div></div>`).join("")}
      </div>
      <button class="dd-history-toggle" data-action="toggle-to-history" data-id="${t.id}">${state.historyOpen[t.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[t.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="dd-add-btn" data-action="edit-timeout" data-id="${t.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-timeout" data-id="${t.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}
// One Time Out day as a short line: "Staff Room with Mdm Tan" for an
// in-school day, "Out of School" otherwise.
function timeOutDayLabel(e) {
  if (e.type === "OSS") return "Out of School";
  const v = (e.venue || "").trim(), a = (e.administrator || "").trim();
  return v && a ? `${v} with ${a}` : v || (a ? `In school with ${a}` : "In school");
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
          applyIssSame(d);
          const bookedCount = d.issDates.filter((dt) => (d.issVenues[dt] || "").trim() && (d.issAdministrators[dt] || "").trim()).length;
          const issRows = d.issDates.map((dt, i) => ({ dt, i })).sort((a, b) => a.dt.localeCompare(b.dt));
          return `
        <label class="dd-label" style="margin-top:12px">In-school days filled in: ${bookedCount} of ${d.issDays}</label>
        ${d.issDates.length > 1 ? `
        <label class="dd-checkbox-pill" style="display:inline-flex;margin-bottom:10px">
          <input type="checkbox" id="${idPrefix}-iss-same" ${d.issSame ? "checked" : ""} />
          <span>Same for all days</span>
        </label>` : ""}
        <div id="${idPrefix}-iss-date-rows" style="display:flex;flex-direction:column;gap:10px">
          ${d.issSame && d.issDates.length > 1 ? (() => {
            const sorted = d.issDates.slice().sort();
            const first = sorted[0];
            return `
            <div class="dd-related-box" style="padding:10px">
              <div class="dd-venue-row" style="margin-bottom:8px">
                <span class="dd-venue-date" style="width:auto">${formatDate(first)} – ${formatDate(sorted[sorted.length - 1])}</span>
              </div>
              <label class="dd-label" style="margin-top:0;font-size:11px">Where is the student going?</label>
              <input class="dd-input ${idPrefix}-iss-venue-all" placeholder="e.g. General Office" value="${escapeHtml(d.issVenues[first] || "")}" />
              <label class="dd-label" style="font-size:11px">Who is administering it?</label>
              <input class="dd-input ${idPrefix}-iss-admin-all" placeholder="Teacher's name" value="${escapeHtml(d.issAdministrators[first] || "")}" />
            </div>`;
          })() : issRows.map(({ dt, i }) => `
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
// "Same for all days": every in-school day takes the first day's location
// and administrator (also re-applied when the day list changes).
function applyIssSame(d) {
  if (!d.issSame || !(d.issDates || []).length) return;
  const first = d.issDates.slice().sort()[0];
  const v = d.issVenues[first] || "", a = d.issAdministrators[first] || "";
  d.issDates.forEach((dt) => { d.issVenues[dt] = v; d.issAdministrators[dt] = a; });
}
function attachTimeOutFieldListeners(form, idPrefix, d) {
  const onChange = renderKeepingModalScroll;
  const typeEl = document.getElementById(`${idPrefix}-to-type`);
  if (typeEl) typeEl.addEventListener("change", () => { d.toType = typeEl.value; regenerateTimeOutDates(d); onChange(); });

  const startDateEl = document.getElementById(`${idPrefix}-start-date`);
  if (startDateEl) startDateEl.addEventListener("change", () => { d.startDate = startDateEl.value; d.autoStart = false; regenerateTimeOutDates(resetSuspDays(d)); onChange(); });

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
  const sameCb = document.getElementById(`${idPrefix}-iss-same`);
  if (sameCb) sameCb.addEventListener("change", () => { d.issSame = sameCb.checked; applyIssSame(d); onChange(); });
  const venueAll = form.querySelector(`.${idPrefix}-iss-venue-all`);
  if (venueAll) venueAll.addEventListener("input", () => { d.issDates.forEach((dt) => { d.issVenues[dt] = venueAll.value; }); state.toFormError = ""; });
  const adminAll = form.querySelector(`.${idPrefix}-iss-admin-all`);
  if (adminAll) adminAll.addEventListener("input", () => { d.issDates.forEach((dt) => { d.issAdministrators[dt] = adminAll.value; }); state.toFormError = ""; });
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
          <div class="dd-mono-muted" style="font-size:11px;margin:12px 0 6px">Meeting date: ${formatDate(d.startDate)}</div>
          ${renderSlotPicker("to-pm")}
          ${d.pmAttendees.includes("Others") ? `<input class="dd-input" id="to-pm-others-text" style="margin-top:8px" placeholder="Please specify" value="${escapeHtml(d.pmOthersText)}" />` : ""}
          ${renderPmReasonPicker(d, "pm")}
        </div>` : ""}` : ""}
        ${state.toFormError ? `<div class="dd-error">${escapeHtml(state.toFormError)}</div>` : ""}
        ${state.saveError ? `<div class="dd-error">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
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
        ${renderNewEntryRow()}
        ${renderLevelBreakdown("pm", state.parentMeetings.map((m) => ({ ...m, countDate: pmDate(m) })), "countDate", isPmCounted)}
        ${renderExportButton("pm")}
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${["All", "This Week", "Upcoming", "Completed"].map((t) => `<button class="dd-pill ${state.pmTab === t ? "active" : ""}" data-action="set-pm-tab" data-tab="${t}">${t}${t !== "All" ? ` (${c[t]})` : ""}</button>`).join("")}
        </div>
        ${state.pmExpandedLevel ? renderClassPillsRow("pm", state.pmExpandedLevel) : ""}
        <div class="dd-panel">
          <div class="dd-search-wrap">
            <input class="dd-input dd-search" data-fit-placeholder id="pm-search-input" placeholder="Search by name, class, reason, or teacher…" value="${escapeHtml(state.pmQuery)}" />
          </div>
          ${list.length === 0 ? `<div class="dd-empty">${state.parentMeetings.length === 0 ? "No parent meetings logged yet." : "No entries match this filter."}</div>` : `
          <div style="display:flex;flex-direction:column;gap:12px">${list.map(renderParentMeetingDetail).join("")}</div>`}
        </div>
        ${state.saveError ? `<div class="dd-toast" style="color:#A3372B">Couldn't save — ${escapeHtml(state.saveErrorDetail || "check your connection and try again")}.</div>` : ""}
        ${state.saving ? `<div class="dd-mono-muted" style="font-size:12px;margin-top:8px">Saving…</div>` : ""}
      </div>
      ${state.showNewPmForm ? renderPmForm(false) : ""}
      ${state.editingPmId ? renderPmForm(true) : ""}
      ${state.showNewForm ? renderNewForm() : ""}
      ${state.showNewSuspForm ? renderSuspForm(false) : ""}
      ${state.showNewToForm ? renderTimeOutForm(false) : ""}
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
          <div class="dd-card-student"><span class="dd-card-student-link" data-action="view-student" data-name="${escapeHtml(m.studentName)}" data-class="${escapeHtml(m.studentClass || "")}" data-year="${(pmDate(m) || m.date || "").slice(0, 4)}">${escapeHtml(m.studentName)}</span>${(m.pmStatus === "Cancelled" || m.pmStatus === "Postponed") ? ` <span class="dd-issue-stage-badge" style="background:${PM_MEETING_STATUS_STYLE[m.pmStatus].ink}22;color:${PM_MEETING_STATUS_STYLE[m.pmStatus].ink}">${PM_MEETING_STATUS_STYLE[m.pmStatus].label}</span>` : ""}</div>
          <div class="dd-card-meta dd-card-meta-primary">${isPmRescheduled(m) ? `<s>${formatDate(m.date)}</s> → ${formatDate(m.postponedTo)}` : formatDate(m.date)}${m.studentClass ? ` · ${escapeHtml(m.studentClass)}` : ""}</div>
          ${(() => { const sl = isPmRescheduled(m) ? pmSlotLabel(m.postponedTime, m.postponedEndTime, m.postponedLocation) : m.pmStatus === "Scheduled" || !m.pmStatus ? pmSlotLabel(m.time, m.endTime, m.location) : ""; return sl ? `<div class="dd-card-meta dd-card-meta-primary">${escapeHtml(sl)}</div>` : ""; })()}
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
      ${state.pmQuickError?.id === m.id && (m.pmStatus || "Scheduled") !== "Scheduled" && roomClash(m.location, m.date, m.time, m.endTime, m.id) ? `<div class="dd-error" role="alert" style="margin-top:6px">${escapeHtml(state.pmQuickError.message)}</div>` : ""}
      ${m.pmStatus === "Postponed" ? `
      <div class="dd-pm-postpone-block">
        <div class="dd-field-label" style="margin-bottom:4px">Postponed to</div>
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
        <div><div class="dd-field-label">Reason(s) for Meeting</div><ul class="dd-field-value dd-reason-bullets">${pmReasonLines(m).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>
      </div>
      <button class="dd-history-toggle" data-action="toggle-pm-history" data-id="${m.id}">${state.historyOpen[m.id] ? "Hide audit trail" : "Show audit trail"}</button>
      ${state.historyOpen[m.id] ? `<div class="dd-history">${history.length === 0 ? `<div class="dd-history-item"><div class="dd-history-detail" style="color:#8A8571">No history recorded yet.</div></div>` : history.map((h) => `<div class="dd-history-item"><div class="dd-history-detail">${escapeHtml(h.detail)}</div><div class="dd-history-meta">${formatDateTime(h.at)} · ${escapeHtml(h.by)}</div></div>`).join("")}</div>` : ""}
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #C9C4B4;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="dd-add-btn" data-action="edit-pm" data-id="${m.id}">Edit entry</button>
        <button class="dd-add-btn" style="background:#A3372B" data-action="delete-pm" data-id="${m.id}">Delete Entry</button>
      </div>` : ""}
    </div>`;
}

// A new meeting is always scheduled, so the Meeting status pills only appear
// when editing an existing meeting (the log card has them too).
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
        ${isEdit ? `
        <label class="dd-label">Meeting status</label>
        <div class="dd-pm-status-row" style="margin-bottom:12px">
          ${PM_MEETING_STATUS_OPTIONS.map((s) => `<button type="button" class="dd-pm-status-pill ${(d.meetingStatus || "Scheduled") === s ? "active" : ""}" style="${(d.meetingStatus || "Scheduled") === s ? `background:${PM_MEETING_STATUS_STYLE[s].ink};border-color:${PM_MEETING_STATUS_STYLE[s].ink}` : ""}" data-action="set-pm-meeting-status" data-status="${s}">${s}</button>`).join("")}
        </div>
        ` : ""}
        ${(d.meetingStatus || "Scheduled") === "Scheduled" ? `
        ${renderSlotPicker("pm")}` : ""}
        ${d.meetingStatus === "Postponed" ? `
        <label class="dd-label" style="margin-top:0">Postponed to</label>
        <div class="dd-pm-postpone-row" style="margin-bottom:12px">
          ${d.postponedTo ? `<div class="dd-sans" style="font-size:15px">${formatDate(d.postponedTo)}${d.postponedTime ? ` · ${pmSlotLabel(d.postponedTime, d.postponedEndTime, d.postponedLocation)}` : ""}</div>` : `<div class="dd-mono-muted" style="font-size:12px">Not set yet</div>`}
          <button type="button" class="dd-date-icon-btn" data-pp-open="draft" id="pm-postponed-to-btn" title="Choose the postponed meeting date">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M8 3v4M16 3v4M3 10h18"></path></svg>
          </button>
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
  attachExportListeners();
  const updBtn = document.getElementById("btn-app-update");
  if (updBtn) updBtn.addEventListener("click", () => { updBtn.textContent = "Updating…"; updBtn.disabled = true; forceRefreshApp(); });

  document.querySelectorAll('[data-action="view-student"]').forEach((el) =>
    el.addEventListener("click", () => {
      state.studentViewFromSection = state.section;
      state.studentViewName = el.dataset.name;
      state.studentViewClass = el.dataset.class || "";
      state.studentViewYear = el.dataset.year ? parseInt(el.dataset.year, 10) : null;
      state.studentViewOpenYears = {};
      state.section = "studentView";
      window.scrollTo(0, 0);
      render();
    }));
  // Same-student question (student view card and after-save pop-up).
  document.querySelectorAll(".dd-link-q input[type=radio]").forEach((el) =>
    el.addEventListener("change", () => {
      const btn = el.closest(".dd-link-q").querySelector('[data-link-answer="choice"]');
      if (btn) btn.disabled = false;
    }));
  document.querySelectorAll("[data-link-answer]").forEach((el) =>
    el.addEventListener("click", () => {
      if (el.disabled) return;
      const q = pendingLinkQuestion(parseInt(el.dataset.year, 10), el.dataset.name, el.dataset.cls) || { type: el.dataset.qType, year: parseInt(el.dataset.year, 10), name: el.dataset.name, cls: el.dataset.cls, candYear: parseInt(el.dataset.candYear, 10), options: [] };
      let toClass = null;
      if (el.dataset.linkAnswer === "yes") toClass = el.dataset.toClass;
      else if (el.dataset.linkAnswer === "choice") {
        const picked = el.closest(".dd-link-q").querySelector(`input[name="${el.dataset.radio}"]:checked`);
        if (!picked) return;
        toClass = picked.value || null;
      }
      // The pop-up then shows the next question for this student, if any
      // (e.g. the earlier year after a class change). If saving failed,
      // it closes and the error shows on the page instead.
      saveStudentLink(q, toClass).then(() => {
        if (el.dataset.where === "modal" && state.linkError) {
          state.linkPromptQueue = (state.linkPromptQueue || []).slice(1);
          state.saveError = true; state.saveErrorDetail = state.linkError; state.linkError = "";
          render();
        }
      });
    }));
  document.querySelectorAll("[data-link-remove]").forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("undoStudentLink", el.dataset.linkRemove, {
      message: "Remove this answer? The question will be asked again in the student's view.", tone: "confirm" })));
  document.querySelectorAll("[data-link-change]").forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("changeStudentLink", el.dataset.linkChange, {
      message: "Change this answer? The question will be asked again now.", tone: "confirm" })));
  const linkSearch = document.getElementById("link-search-input");
  if (linkSearch) linkSearch.addEventListener("input", () => {
    state.linkSearch = linkSearch.value;
    const pos = linkSearch.selectionStart;
    renderKeepingPageScroll();
    const again = document.getElementById("link-search-input");
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* non-fatal */ } }
  });
  document.querySelectorAll('[data-action="toggle-student-year"]').forEach((el) =>
    el.addEventListener("click", () => {
      const y = el.dataset.year;
      state.studentViewOpenYears = { ...(state.studentViewOpenYears || {}), [y]: !(state.studentViewOpenYears || {})[y] };
      renderKeepingPageScroll();
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

  document.querySelectorAll('[data-action="toggle-link-year"]').forEach((el) =>
    el.addEventListener("click", () => { const k = el.dataset.key; state.linkYearsOpen = { ...(state.linkYearsOpen || {}), [k]: !(state.linkYearsOpen || {})[k] }; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="toggle-link-archive"]').forEach((el) =>
    el.addEventListener("click", () => { state.linkArchiveOpen = !state.linkArchiveOpen; renderKeepingPageScroll(); }));
  document.querySelectorAll('[data-action="settings-open-links"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "studentLinks"; state.linkError = ""; render(); }));
  document.querySelectorAll('[data-action="settings-open-classes"]').forEach((el) =>
    el.addEventListener("click", () => { state._classDraft = classOptionsForCurrentYear().slice(); state.settingsView = "classesForYear"; state.saveError = false; render(); }));

  document.querySelectorAll('[data-action="settings-open-holidays"]').forEach((el) =>
    el.addEventListener("click", () => { state.settingsView = "holidays"; state.holidaySettingsYear = new Date().getFullYear(); state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="holidays-prev-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.holidaySettingsYear = (state.holidaySettingsYear || new Date().getFullYear()) - 1; state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="holidays-next-year"]').forEach((el) =>
    el.addEventListener("click", () => { state.holidaySettingsYear = (state.holidaySettingsYear || new Date().getFullYear()) + 1; state.saveError = false; render(); }));

  document.querySelectorAll('[data-action="settings-open-access"]').forEach((el) =>
    el.addEventListener("click", () => { state.accessFormError = ""; state.settingsView = "manageAccess"; render(); }));

  document.querySelectorAll('[data-action="settings-open-trash"]').forEach((el) =>
    el.addEventListener("click", () => { state.saveError = false; state.settingsView = "trash"; render(); }));
  document.querySelectorAll('[data-action="restore-deleted-item"]').forEach((el) =>
    el.addEventListener("click", () => { if (!state.trashRestoringId) restoreDeletedItem(el.dataset.id); }));

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

  // Print: "Opening…" while the phone/browser builds its print preview,
  // then back to "Print" as soon as the print screen has come up (the
  // browser says so with beforeprint/afterprint; the timer is a backstop
  // for browsers that don't).
  const busyLabel = (btn, text) => {
    const label = btn.querySelector("span");
    const original = label ? label.textContent : "";
    if (label) label.textContent = text;
    btn.disabled = true;
    let done = false;
    return () => { if (done) return; done = true; if (label) label.textContent = original; btn.disabled = false; };
  };
  const printReportBtn = document.getElementById("btn-print-report");
  if (printReportBtn) printReportBtn.addEventListener("click", () => {
    const restore = busyLabel(printReportBtn, "Opening…");
    const onBefore = () => setTimeout(restore, 300);
    window.addEventListener("beforeprint", onBefore, { once: true });
    window.addEventListener("afterprint", restore, { once: true });
    // Let the browser paint "Opening…" first so the tap feels acknowledged.
    setTimeout(() => { window.print(); setTimeout(restore, 2000); }, 30);
  });
  // Export PDF: builds the file here (same look as printing to PDF) and
  // downloads it — no print screen involved.
  const exportPdfBtn = document.getElementById("btn-export-pdf");
  if (exportPdfBtn) exportPdfBtn.addEventListener("click", async () => {
    const restore = busyLabel(exportPdfBtn, "Preparing…");
    try { await exportAnnualReportPdf(state.settingsSelectedYear); }
    catch (err) { state.reportExportError = `Couldn't create the PDF — ${err?.message || String(err)}.`; render(); return; }
    finally { restore(); }
    if (state.reportExportError) { state.reportExportError = ""; render(); }
  });

  const loadKnownBtn = document.getElementById("btn-load-known-holidays");
  if (loadKnownBtn) loadKnownBtn.addEventListener("click", async () => {
    if (!state.isAdmin) return;
    const existing = state.holidays?.publicHolidayEntries || [];
    // Skip any holiday whose dates are already listed (under any spelling).
    const covered = coveredHolidayDates(existing);
    const toAdd = KNOWN_PUBLIC_HOLIDAYS.filter((h) => !holidayDates(h).every((d) => covered.has(d))).map((h) => ({ ...h, id: uid() }));
    if (toAdd.length === 0) return;
    try { await setDoc(doc(db, "holidays", "singapore"), { publicHolidayEntries: [...existing, ...toAdd] }, { merge: true }); }
    catch (err) { state.saveError = true; state.saveErrorDetail = err?.message || String(err); render(); }
  });

  // A new entry defaults to today's date when adding for the current year,
  // or Jan 1 of whichever year the Holidays page is viewing otherwise —
  // so adding one while looking at next year doesn't quietly default into
  // this year and need a manual date correction every time.
  const defaultHolidayDate = () => {
    const y = state.holidaySettingsYear || new Date().getFullYear();
    return y === new Date().getFullYear() ? todayISO() : `${y}-01-01`;
  };
  // -- Public Holidays --
  document.querySelectorAll('[data-action="open-add-public-holiday"]').forEach((el) =>
    el.addEventListener("click", () => { state._publicHolidayDraft = { id: null, name: "", startDate: defaultHolidayDate(), endDate: defaultHolidayDate() }; state.saveError = false; render(); }));
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
    el.addEventListener("click", () => { state._extraSchoolHolidayDraft = { id: null, name: "", startDate: defaultHolidayDate(), endDate: defaultHolidayDate() }; state.saveError = false; render(); }));
  document.querySelectorAll('[data-action="edit-extra-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => {
      const year = state.holidaySettingsYear || new Date().getFullYear();
      const entry = (state.schoolCalendarOverrides?.[year]?.extraHolidays || []).find((e) => e.id === el.dataset.id);
      if (entry) { state._extraSchoolHolidayDraft = { ...entry }; state.saveError = false; render(); }
    }));
  document.querySelectorAll('[data-action="request-delete-extra-school-holiday"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("extraSchoolHoliday", el.dataset.id)));

  // -- School Closure / HBL Days --
  document.querySelectorAll('[data-action="open-add-closure-day"]').forEach((el) =>
    el.addEventListener("click", () => { state._closureModalDraft = { id: null, type: "closure", startDate: defaultHolidayDate(), endDate: defaultHolidayDate(), levels: [1, 2, 3, 4, 5, 6] }; state.saveError = false; render(); }));
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
        const entry = { id: d.id || uid(), startDate: d.startDate, endDate: d.endDate, levels: d.type === "closure" ? [1, 2, 3, 4, 5, 6] : d.levels.slice().map(Number).sort((x, y) => x - y) };
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
    if (!state.isAdmin) return;
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

  // The shared "+ Grooming / + Suspension / + Time Out / + Parent Meet" row,
  // and the Suspension/Time Out/Parent Meet modals it can pop up, are
  // rendered on every log tab and on the student cross-log view — but must
  // only be wired up ONCE per render. The branch above can call more than
  // one of the attach*Listeners functions (studentView calls all four), and
  // each of those used to wire these shared bits up itself; with four
  // functions all doing that in studentView, a modal ended up attached four
  // times over, so each of its buttons (e.g. the Cancelled/Postponed status
  // pills, room-booking toggle, and the Save button) fired four times per
  // tap — an even number of toggle-taps net to no visible change, and a
  // Save wrote its history/Sheet-sync four times. Centralizing the call
  // here, after the section dispatch, keeps it to one attachment no matter
  // how many of those functions just ran.
  if (["log", "suspensions", "timeOuts", "parentMeetings", "studentView"].includes(state.section)) {
    attachNewEntryRowListeners();
    attachSuspFormModalListeners();
    attachTimeOutFormModalListeners();
    attachPmFormModalListeners();
  }
}

// Grooming Log page — filter pills, search, audit trail, and the per-issue
// resolve/escalate (with its required follow-up note)/override/undo actions.
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

  document.querySelectorAll('[data-action="toggle-history"]').forEach((el) =>
    el.addEventListener("click", () => { state.historyOpen[el.dataset.id] = !state.historyOpen[el.dataset.id]; render(); }));
  document.querySelectorAll('[data-action="delete-incident"]').forEach((el) =>
    el.addEventListener("click", () => requestDeleteConfirmation("incident", el.dataset.id)));

  document.querySelectorAll('[data-action="resolve-issue"]').forEach((el) =>
    el.addEventListener("click", () => resolveGroomingIssue(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll('[data-action="unresolve-issue"]').forEach((el) =>
    el.addEventListener("click", () => unresolveGroomingIssue(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll('[data-action="start-escalate"]').forEach((el) =>
    el.addEventListener("click", () => startEscalateIssue(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll('[data-action="escalate-note-input"]').forEach((el) =>
    el.addEventListener("input", () => { state.escalateNoteDraft[el.dataset.issue] = el.value; }));
  document.querySelectorAll('[data-action="confirm-escalate"]').forEach((el) =>
    el.addEventListener("click", () => confirmEscalateIssue()));
  document.querySelectorAll(".dd-issue-override-input").forEach((el) =>
    el.addEventListener("change", () => { if (el.value) overrideGroomingIssueDeadline(el.dataset.id, el.dataset.issue, el.value); }));
  document.querySelectorAll('[data-action="edit-escalation-note"]').forEach((el) =>
    el.addEventListener("click", () => startEditEscalationNote(el.dataset.id, el.dataset.issue, parseInt(el.dataset.stage, 10), el.dataset.note)));
  document.querySelectorAll('[data-action="escalate-note-edit-input"]').forEach((el) =>
    el.addEventListener("input", () => { state.escalateNoteEditDraft[el.dataset.key] = el.value; }));
  document.querySelectorAll('[data-action="confirm-escalation-note-edit"]').forEach((el) =>
    el.addEventListener("click", () => confirmEditEscalationNote()));
  document.querySelectorAll('[data-action="cancel-escalation-note-edit"]').forEach((el) =>
    el.addEventListener("click", () => cancelEditEscalationNote()));
  document.querySelectorAll('[data-action="unescalate-issue"]').forEach((el) =>
    el.addEventListener("click", () => unescalateIssueFromEdit(el.dataset.id, el.dataset.issue)));
  document.querySelectorAll('[data-action="toggle-issue-expanded"]').forEach((el) =>
    el.addEventListener("click", () => { state.issueExpanded[el.dataset.issue] = !state.issueExpanded[el.dataset.issue]; render(); }));
  // The shared new-entry row and the Suspension/Time Out/Parent Meet modals
  // it can pop up on this tab are wired once, centrally, in
  // attachMainListeners — see the comment there.
}

// Wires up the "+ Grooming / + Suspension / + Time Out / + Parent Meet"
// row — present at the top of every log tab, not just the dashboard.
function attachNewEntryRowListeners() {
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
}

function attachDashboardListeners() {
  drawTrendLineCharts();
  bindTrendResize();
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
  // To can't be earlier than From: moving From past To pulls To along.
  if (customFromEl) customFromEl.addEventListener("change", () => { if (customFromEl.value) { state.chartCustomFrom = customFromEl.value; if (state.chartCustomTo < state.chartCustomFrom) state.chartCustomTo = state.chartCustomFrom; } renderKeepingModalScroll(); });
  if (customToEl) customToEl.addEventListener("change", () => { if (customToEl.value) state.chartCustomTo = customToEl.value < state.chartCustomFrom ? state.chartCustomFrom : customToEl.value; renderKeepingModalScroll(); });
  const customApplyBtn = document.getElementById("chart-custom-apply");
  if (customApplyBtn) customApplyBtn.addEventListener("click", () => {
    const fromSel = document.getElementById("chart-custom-from");
    const toSel = document.getElementById("chart-custom-to");
    if (fromSel && fromSel.value) state.chartCustomFrom = fromSel.value;
    if (toSel && toSel.value) state.chartCustomTo = toSel.value;
    state.selectedCalendarDay = null;
    state.showChartCustomModal = false;
    render();
  });

  attachNewEntryRowListeners();

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
  // The shared new-entry row and the Suspension/Time Out/Parent Meet modals
  // it can pop up on this tab are wired once, centrally, in
  // attachMainListeners — see the comment there.
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
    if (classEl) classEl.addEventListener("change", () => { onSuspClassChange(state._suspDraft, classEl.value, false); renderKeepingModalScroll(); });
    attachMultiReasonListeners(form, state._suspDraft);

    attachSuspFieldListeners(form, "susp", state._suspDraft);

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
  // The shared new-entry row and the Suspension/Time Out/Parent Meet modals
  // it can pop up on this tab are wired once, centrally, in
  // attachMainListeners — see the comment there.
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
    if (classEl) classEl.addEventListener("change", () => { onSuspClassChange(state._toDraft, classEl.value, true); renderKeepingModalScroll(); });
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
  // The shared new-entry row and the Suspension/Time Out/Parent Meet modals
  // it can pop up on this tab are wired once, centrally, in
  // attachMainListeners — see the comment there.
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
function syncNewIncidentDraftFromDom() {
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
}
function handleDelegatedTap(e) {
  if (handleRoomTap(e)) return;
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
  syncNewIncidentDraftFromDom();
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
