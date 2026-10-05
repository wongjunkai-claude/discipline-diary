# Discipline Diary

A shared log for the discipline team: grooming warnings, suspensions, time
outs and parent meetings, with a dashboard, a students' watchlist and annual
reports.

Plain HTML/CSS/JavaScript with no build step. Firebase (sign-in and the
Firestore database) is loaded straight from Google's CDN, and the site is
hosted free on GitHub Pages. Everything can be maintained from a browser.

## Files

| File | What it is |
|---|---|
| `index.html` | The page shell that loads everything else |
| `app.js` | The whole app |
| `style.css` | All styling |
| `sw.js` | Service worker: lets the app install to a home screen and open offline |
| `manifest.json`, `icons/` | Home-screen app name and icons |
| `fonts/` | The Geist font (regular to extra bold), shipped with the app so it looks the same on every phone and works offline. Free under the SIL Open Font License (`fonts/Geist-OFL.txt`) |
| `firestore.rules` | Database security rules; published in the Firebase console, not on GitHub |
| `apps-script.gs` | Google Sheet sync; pasted into Apps Script, not on GitHub |

## Releasing a change

1. Bump `APP_VERSION` near the top of `app.js` **and** `CACHE` at the top of
   `sw.js`, together. The version shows in the header and in the ? help, so
   you can check which version a teacher's device is running.
2. On GitHub, upload the changed files over the old ones (including any new folder, such as `fonts/`) and commit. GitHub
   Pages updates within a minute or two.
3. Devices pick up the new version the next time the app is opened (sometimes
   one more reload).
4. **Only if `firestore.rules` changed:** Firebase console → Firestore
   Database → Rules → paste the whole file → **Publish**.
5. **Only if `apps-script.gs` changed:** see "Google Sheet sync" below.

## Sign-in and access

- Teachers sign in with Google. Only **verified @moe.edu.sg** accounts are
  accepted, and only if they're on the **Authorised Teachers List**
  (Settings).
- Three tiers:
  - **Owner** can do everything, including adding and removing admins and
    handing over ownership (Settings → Authorised Teachers List). The address
    in `OWNER_EMAIL` (in `app.js`) and the matching address in
    `firestore.rules` is a permanent fallback owner, so access can always be
    recovered.
  - **Admins** can add and remove authorised teachers.
  - **Authorised teachers** can use every log.
- The rules check access on every request, so removing someone cuts them off
  immediately, even mid-session. Removing someone also deletes their
  sign-in record (`users/{uid}`), so they disappear completely and don't
  reappear under "Add Existing Users". If they're added back later, they're
  asked for their name again at sign-in.

## The four logs (Firestore collections)

The "+ Grooming / + Suspension / + Time Out / + Parent Meet" row sits at the
top of the dashboard and every one of the four log tabs (`renderNewEntryRow()`)
— a new entry of any kind can be started from wherever you're standing, not
just from the dashboard.

Every record also has `loggedBy`, `loggedByUid`, `createdAt` and a `history`
audit trail (every create, edit and status change, with who and when).

- **Grooming Log** (`incidents`): student, class, date, and `issues` — one or
  more grooming issues (Long Hair, Uniform, …), each with its own
  1st / 2nd / Final Warning stage and deadline. Deadlines always fall on a
  school day: one that would land on a weekend, holiday or the student's
  HBL/closure day moves to the next school day (`computeGroomingDeadline()`).
  **Repeats** (`issueStartStage()`, every issue; Others = same description):
  1st / 2nd / 3rd+ time in a term → starts at 1st / 2nd / Final Warning; if
  the student had the same issue in the semester's earlier term (T1 for T2,
  T3 for T4), the term starts at 2nd and the 2nd time onwards is Final. A
  school-holiday entry belongs to the term after it; each semester starts
  afresh at 1st Warning. Escalation
  stats count from the warning an issue started at.
  **Permed Hair** (`remindOnly`) has no Resolved/Escalate: 1st and 2nd
  Warning show FT Contact Parents (1st: don't perm again or it must be
  straightened; 2nd: straighten it over the weekend), Final shows the
  facilitated call; the teacher taps **Reminded**.
  Escalating an issue to its next stage requires a follow-up note explaining
  what happened at the stage being left — it's stored on that stage
  transition in the issue's own history. Escalate is a toggle: tapping it
  opens the note input, tapping it again (while selected) backs out without
  escalating. Resolved is a toggle too: tap to resolve, tap the (still
  shown, selected) Resolved button again to un-resolve — so there's no
  separate Undo control for either. Each issue is one card with its stages
  nested inside it (label and due date on one line). Issues open collapsed,
  showing only the latest stage with its Resolved/Escalate controls (the
  follow-up note box works there too); expanding shows the earlier stages
  above it, oldest first, each with its note and who logged it;
  the note itself can be edited later via its pencil icon, which logs
  "Edited by <name>" under the original "Logged by" line. The most recently
  completed stage's pencil also offers "Remove Follow Up", which reverses that
  one step (drops its note and the stage transition, restoring the earlier
  stage as active again) — only while the issue isn't resolved, and only
  for that one most-recent step, not stages further back. Also links to
  related suspensions, time outs and meetings. A few very old entries use
  an earlier single-`issue` format; they still display, but don't count
  toward the watchlist.
- **Suspension Log** (`suspensions`): reasons (`reasons` array plus a
  combined `reason` text), `startDate`, `totalDays`, and `days` — one entry
  per day, each in-school (`ISS`, with a booked room) or out-of-school
  (`OSS`).
- **Time Out Log** (`timeOuts`): same shape as a suspension, plus `toType`
  (Recess, Lesson, CCA or Learning Experience). In-school days carry a
  free-text location and supervising administrator.
- **Parent Meet** (`parentMeetings`): date, attendees, one or more reasons
  (each with a Victim/Offender/Both/NA status), and `pmStatus` (Postponed or
  Cancelled; blank means scheduled) and `postponedTo` (the new date for a
  postponed meeting; optional, blank until known). Once `postponedTo` is set,
  the meeting counts on that new date everywhere (calendar, totals, tabs,
  reports; see `pmDate()` / `isPmCounted()` in `app.js`), and its original
  date shows "Postponed to …". Cancelled meetings, and postponed ones with
  no new date yet, stay in the log but aren't counted. Postponed meetings
  with no new date yet are listed on the Dashboard under "Pending Parent
  Meeting Date"; once the new date is set they leave that list. The new date is chosen with an in-app
  picker (nothing pre-selected; tap a day, then ✓, then confirm), not the
  phone's own date picker. The Dashboard can set it once; later changes are
  made in the Parent Meet log.

**Meeting time and room.** Every parent meeting set-up (the Parent Meet
form, "Meeting Parents" on the Suspension and Time Out forms, and a
postponed meeting's new date) has a "Meeting Time" of two boxes, Start Time
→ End Time, each opening a pop-up wheel (24-hour, 15-minute steps) and a room: Meeting Room or Conference Room. Fields:
`time`, `endTime`, `location`; for the new date of a postponed meeting,
`postponedTime`, `postponedEndTime`, `postponedLocation`. A room holds one
meeting at a time: any overlapping booking on the same day makes it "Not
available", and it can't be chosen. Availability is checked again when
saving. Cancelled meetings, and postponed ones with no new date, free their
room. Required for new meetings and for scheduled meetings dated today or
later; older meetings can stay blank. The Sheet shows time and room in the
Date column (no Apps Script change needed). Rules: `roomClash()` /
`pmBooking()` in `app.js`.

**Choosing dates.** Date fields on the Grooming, Parent Meet, Suspension and
Time Out forms, a grooming issue's follow-up deadline and a postponed
meeting's new date use an in-app calendar instead of the phone's own date
picker, so it can show holidays: weekends (grey), public holidays (pink),
school holidays (yellow) and closure/HBL days (blue) are coloured and named.
- Grooming (date caught, follow-up deadlines): weekends and holidays can't
  be picked, nor closure/HBL days for the student's level.
- Parent Meet: weekends and holidays can't be picked; closure/HBL days are
  just a note.
- Suspension and Time Out: any day can be picked (colours still shown). The
  defaults stay on school days: a new form starts on the next school day,
  that default moves off an HBL day when the class is chosen, and the days
  filled in automatically after day 1 skip non-school days.

On Grooming, Suspension and Time Out the class must be chosen before any
date, since closure days depend on the level. Changing the start date, or
changing the class to a different level, lays a suspension's or time out's
days out again from the new start. Settings and the chart's Custom range
use the phone's own date picker. Overlapping closure/HBL entries are
combined per day, with levels always in order. See `calendarDayInfo()` /
`pickerDayState()` in `app.js`.

**Status dots** on entry cards: green = completed, orange = ongoing
(upcoming, active or in progress), red = cancelled, or postponed with no
new date yet.

**Reasons** for suspensions, time outs and parent meetings come from one
grouped offence list (`OFFENCE_GROUPS` in `app.js`: 12 categories, 34
offences, plus "Others" with free text). Category headings are display-only.
To rename an offence without breaking older records, add the old name to
`LEGACY_REASON_ALIASES`.

**Deleting** an entry is permanent. A 5-second Undo appears straight after.

## Dashboard views

Pills: Day / Week / Month / Year, then Term 1–4 / All / Custom.

- **Day and Week** tallies count suspension and time-out *days served*
  (a 3-day suspension is 3 in its week), so they answer "how many are out
  this week". **Month, Year, Term, All** and the Annual Summary count each
  suspension and time out *once, on its start date*.
- The day list labels each entry: `Grooming | Long Hair`,
  `In-School Suspension | Library`, `Out-of-School Suspension`,
  `Time Out (CCA) | Staff Room with Mr Tan`,
  `Parent Meet | 09:00–10:00 · Office` (`dayDetailLabel()`).
- **Custom** takes any two dates and picks the layout (and its way of
  counting) by length (`customRangeLayout()`): up to 7 days → Week,
  8–31 days → Month, up to a year → Year (months shown, days outside the
  range greyed), longer → the All graph.
- **Term 1–4** show this year's term week by week: the same line graph as
  All, one point per school week (W1–W10, Week 1 = the term's first day),
  with tap-to-read cards titled e.g. "Week 6 · 03 Aug – 09 Aug". The tally
  counts each entry once, on its start date, within the term's dates. Weeks
  (or, in All/Custom, months) that haven't started yet keep their label but
  the lines stop at the current one.
- **All** runs from the earliest entry to today, drawn like a stock chart:
  one line each for Grooming, Parent Meet, Time Out, In-School Suspension
  and Out-of-School Suspension, one point per month
  (`drawTrendLineCharts()`). The value axis is on the left and the whole
  range always fits the width (no scrolling); when months are close
  together only every 2nd / 3rd / 6th month is named, or just each January
  for very long ranges, with the year under the first month and each
  January. No numbers are printed on the graph: tapping or dragging across
  it snaps a line to the nearest month and shows a card inside the graph
  with that month's count per line (tap the same month or off the graph
  to hide it). The Show… pills switch lines off; Suspension switches both
  suspension lines. A suspension with both kinds of days counts on both
  lines. On phones the legend is two rows (suspensions on the second).

## Students' Watchlist

This semester's records only: 1 Jan to the end of Term 2, then from the
June holidays to 31 Dec (an entry in a school holiday belongs to the term
after it). Grooming entries count
once each, at the highest warning any of their issues reached. A student
needs to meet just **one** criterion in a tier and is shown in the highest
tier they qualify for.

- **High Risk:** 2+ suspensions, 3+ final warnings, 7+ 2nd warnings, or 4+ time outs
- **Medium Risk:** 1 suspension, 2 final warnings, 4–6 2nd warnings, or 2–3 time outs
- **Low Risk:** 1 final warning, 1–3 2nd warnings, or 1 time out

The rules live in `riskTierFor()` in `app.js`. The plain-language list in the
app's ⓘ box is `RISK_TIER_CRITERIA`; change both together.

**Recent direction symbols.** Next to a student's name, a yellow ! in a
red circle (worsening) or a white thumbs up in a green circle (improving),
whatever period is chosen (`recentDirection()`). Entries are weighted
grooming 1, time out 2, suspension 3; the last 4 school weeks are compared
with the 4 school weeks before. ! if the score rose by 2+ and by 50%+, or
the student moved up a risk level this semester within the last 4 school
weeks (from Low or above). Thumbs up if the earlier 4 weeks had entries
and the last 4 have none or half as much. A single entry in those 8 school
weeks (e.g. one time out or one suspension) is a one-off: no symbol.
Hovering says why.

## Behavioural Trend (student profile)

At the bottom of each student's profile (`renderStudentTrend()` /
`computeStudentTrend()`), with "Comparing:" By Month / By Term / By
Semester / By Year on the title line (phones under 400px show Month / Term
/ Semester / Year). A table lists Grooming, Suspension, Time Out and Parent
Meet per period from the student's first entry (oldest first, 0s greyed).
A run of empty periods becomes one "No entries recorded" row with a short
one-line label (T2-T3 2026, Mar-Jul 2026, Sem 1-2 2026, 2024-2025; the
run crossing into a new year is split at the year); labels always stay on
one line. Years join only through confirmed
"same student" answers; for students past P6 the table stops at their last
entry. The table only lists the numbers; there's no improving / needs
support analysis (that's left to the Watchlist symbols).

## Start of Year

Settings → **Start of Year** (Admins and the Owner only), with a badge for
what's outstanding (`computeStartOfYear()`):

1. **Classes for the year**: done once the year has its own list. If last
   year's list is being carried on, "Same as YYYY" saves it for this year in
   one tap; "Review classes" opens Classes For The Year.
2. **Same-name questions**: every student with entries this year whose
   "is this the same student?" question (earlier year or class change) is
   still unanswered, answered right there. Returning students are normally
   asked when their first entry of the year is saved; this catches any
   left over.
3. **Left school**: last year's P6 students with entries, for information
   (records stay).

Through Term 1 (or whenever the year's classes aren't set up at all) admins
see a blue bar on the dashboard, "Start of YYYY: N things to sort out",
until everything's done. Teachers keep the old "classes haven't been
reviewed" note.

## Student view and level counters

- Tapping a student's name opens their records for this year across all
  four logs. Earlier years are listed at the bottom as rows (like the
  Annual Summary Reports list); tapping a year shows that year's records,
  grouped by log, with empty logs left out.
- Earlier years are only joined on after a teacher confirms it's the same
  student, because two students can share a name and classes change each
  year. When a student has an entry and there are same-name records one
  level lower in an earlier year, the app asks (right after saving, and in
  the student's view until answered): "Is this Aden Chan (P4-3) referring
  to: Aden Chan in P3-1 in 2026?" (Yes / No), or a multiple choice with
  "None of the above" when there are several. No / None means a different
  student with the same name. Students always move up one level a year
  (no retention), so only records exactly one level lower per year back
  are offered.
- Mid-year class changes: when an entry has the same name and level as
  another class's entry in the same year, the app first asks "Is this Aden
  Chan (P3-2) referring to: Aden Chan in P3-1 in 2026?". Yes treats both
  classes as one student for that year: the student view shows both, the
  Students' Watchlist and the Annual Report's repeat-student figures count
  them once (under the latest class), and later years are asked about as
  one student. Each entry keeps the class it was logged under.
- Answers are shared (`studentLinks` collection). They're listed, by year
  and searchable by name, under Settings → Student Links. Only Admins and
  the Owner can change an answer (the question is asked again) or remove
  it (asked again in the student's view); `firestore.rules` enforces this.
  Any authorised teacher can answer a new question. From January after a
  student's P6 year (worked out from the class and year, since everyone
  moves up one level a year), their answers move to "Archive" at the
  bottom of that page, grouped by graduation year. See `studentRecordsByYear()`, `pendingLinkQuestion()` and
  `sameYearGroup()` in `app.js`.
- The P1–P6 boxes at the top of each log count this year's entries only,
  matching the class-by-term table that opens under them.

## Settings

- **Annual Summary Reports:** per-year report laid out as six pages — (1) annual
  summary + by term, (2) discipline load by month, (3) by term chart + position
  within term + day of week, (4) repeat vs. unique students + grooming
  escalation rate + repeat suspension/time out intervals, (5) most challenging
  levels + classes (+ this year's suspension/time out lists), (6) trend
  analysis + recommendations. **Print** opens the browser's print screen (each
  page starts a new A4 sheet). **Export PDF** builds the same pages as an A4
  PDF in the app and downloads it (`Annual Summary YYYY.pdf`), using
  html2canvas and jsPDF bundled in `lib/` (MIT licence; loaded only when
  Export PDF is first used, cached for offline). The trend analysis and
  recommendations are generated from the report's own figures by fixed
  rules (`computeYearInsights()`), not AI; mid-year it compares completed
  terms only.
  Every PDF sheet carries a footer (year, "Page x of y", date generated);
  Print shows the same footer in browsers that support page margin boxes
  (Chrome, Edge). **Excel** downloads `Annual Summary YYYY.xlsx`, one sheet
  per table behind the report (Summary, By Term, By Week of Term, By Month,
  Day of Week, Top Reasons for Suspension / Time Out, Parent Meets by Month,
  Parent Meet Count, Levels, Classes, Suspensions / Time Outs by Student).
  The Excel button opens a choice: **Report tables** (that workbook) or
  **All logs for YYYY** (`All Logs YYYY.xlsx`: every entry of the year from
  the Grooming, Suspension, Time Out and Parent Meet logs, one sheet each,
  same columns as each log's own Download Excel; for filing or backup).
- **Classes For The Year:** each year's classes (`settings/classConfig`),
  shown in a grid by level (P1–P6). Teachers see the list only. Admins and
  the owner also get **+** (type a name, e.g. "P4-1" or "4 Excellence"; the
  level is picked from the number in the name or chosen; tick to add, saved
  straight away) and a **pencil**: in edit mode each class becomes a text
  field with ✕ to remove it; the ✕ turns into a tick to confirm once its
  name is changed; the pencil turns into a tick that saves all changes (Cancel
  undoes them). This year or next year can be picked at the top. A year with
  nothing saved carries on the latest earlier year's list, so names stay the
  same year after year until changed. Each name's level is kept in
  `classLevels` (all years), and every level count, report, ranking, Data
  Check and student link reads a class's level from there (`classLevel()`),
  falling back to the number in the name. Entries already logged keep the
  class name they were logged with. Class names always show in full on one line.
  The view and edit modes use the same columns: 6, 3, 2 or 1, the most
  that fit a name as long as "6 Excellence" with its edit field and one
  button (`fitClassGrid()`); a longer name, if ever used, widens them. In
  edit mode a class's ✕ turns into a tick once its name is changed. The log
  pages' class table widens its class column, and class pills with longer
  names size to their text and wrap to a second row if needed.
- **Holidays / School Closure / HBL Days:** public and school holidays and
  closure days (`holidays/singapore`, `settings/schoolCalendarOverrides`,
  `settings/schoolClosureDays`). Used to skip non-school days when setting
  deadlines and suspension dates.
- These two pages are **view-only for normal teachers**: only admins and
  the Owner can change them. The app hides the edit controls (with a "View
  only" note), and `firestore.rules` enforces it (`holidays/*` and
  `settings/*` writes need `isAdmin()`). The automatic holiday set-up and
  the yearly public-holiday fetch also only run for admins/the Owner.
- **Authorised Teachers List:** who can sign in (see "Sign-in and access").

## No zooming

The viewport meta in `index.html` has `maximum-scale=1, user-scalable=no`,
so phones don't zoom in when a dropdown or text box is tapped (iOS zooms
into any field with text under 16px otherwise).

## Pop-up buttons

Entry forms (Grooming new/edit, Suspension, Time Out, Parent Meet), the
holiday / school closure / HBL pop-ups in Settings and the dashboard's
Custom range have **Cancel** beside the save button (no ✕). Cancel (or a
tap outside) closes without saving; if anything was changed it first asks
"Discard the changes?" (Yes/No; No goes back with the edits kept). The
Parent Meet link list's Cancel does the same. Changes are spotted by
comparing the pop-up's draft and field values with how it opened
(`captureModalBaselines()` / `modalDirty()`).

## Parent meeting ↔ suspension / time out link prompts

- After a **new parent meeting** is saved, that student's suspensions and
  time outs dated on the meeting day or up to 4 weeks after it, not yet
  linked to a meeting, are offered: Yes/No for one, tick boxes (Confirm /
  None of these) for several.
- After a **new suspension or time out** is saved without a tagged meeting,
  that student's latest parent meeting on or up to 4 weeks before its start
  is offered (Yes/No) — only if the meeting has nothing linked yet and no
  other suspension or time out of that student falls between them.
- Yes links both ways (`linkedSuspensionIds` / `linkedTimeOutIds` on the
  meeting, `linkedPmIds` on the case, with a history line). No is
  remembered (`declinedCaseIds` on the meeting, `declinedPmIds` on the
  case) and never asked again. Cancelled meetings are skipped; a postponed
  one counts on its new date. Edits don't prompt.
- Linked meetings / cases show in a "Linked …" box on the expanded cards.
- **Link icon after the student's name.** Parent Meet cards: a link icon
  (linked) or struck-out link icon (not linked); tapping it lists the
  student's suspensions and time outs on or after the meeting date (linked
  ones ticked; cases linked to another meeting left out). ✓ saves after the
  usual Yes/No confirmation listing what will be linked/unlinked (no
  confirmation if nothing changed); Cancel closes without saving.
  Suspension and Time Out cards show the link icon (display only) when
  linked to a meeting.

## Report summaries and locks

Settings → **Annual Summary Reports** lists the years collapsed. Tapping a
year opens its three summaries: **YYYY Semester 1 Report Summary**,
**YYYY Semester 2 Report Summary** and **YYYY Annual Report Summary**
(`renderReportYearList()`).

- Semester 1 = 1 Jan to the last day of Term 2; Semester 2 = the June
  holidays to 31 Dec. Entries logged in a school holiday belong to the term
  after it, since that's when they're dealt with (the year-end holiday stays
  with Term 4). A semester summary is the same eight sections
  counted over that semester: its two terms, its months, and "compared
  with" the same semester a year earlier (`withReportPeriod()` narrows the
  logs while the report, its PDF, Print and Excel are built; the wording
  reads "semester").
- **Locks:** Semester 1 opens on the first day of Term 1, Semester 2 on the
  first day of Term 3, the Annual summary on the Saturday of Term 4's last
  week (`reportOpenDate()`). Until then the row shows a lock and can't be
  opened. Admins and the Owner can tap the lock to open it early on their
  own screen (the lock shows open); it locks again by itself 5 seconds
  after the lock was last tapped, or when tapped again. An opened summary
  stays open. Teachers see the lock only.
- A summary still running shows "Up to today — the semester/year is still
  in progress."
- Titles, the PDF/Print footer and file names use the summary's name, e.g.
  "2026 Semester 1 Report Summary.pdf". Excel's "All logs" covers the
  same period.

**Findings woven into the sections** (each also in Trend Analysis, and in
the Excel "Report tables"):

- **Concentration** (`computeConcentration()`): above Most Challenging
  Classes (all entries), All Suspensions (suspensions only) and All
  Time-Outs (time outs only), the share that came from the students with
  the most: 10 students, or the top fifth when fewer than 50 students are
  involved. Not shown when no student has more than one.
- **Grooming follow-through** (`computeGroomingFollowThrough()`): in
  Grooming Escalation Rate, 1st → 2nd and 2nd → Final rates, average days
  to fix, the share fixed by the deadline of the warning they were on, and
  the issue type most likely to escalate.
- **Recommendations** appear only when the numbers call for them. Ones
  about particular children name them (class and count): suspended more
  than once, suspended again within a month, more than one time out, and
  the students behind most entries. They draw on established school
  psychology and counselling approaches — PBIS tiers, functional behaviour
  assessment, Check-In/Check-Out, restorative practice, social-emotional
  learning, self-determination theory, family partnership (ecological
  systems), solution-focused talk — and age-appropriate focus by level.
  Up to eight are shown.

**Trend Analysis** is short points under headings, each figure stated once:
At a glance · Compared with · What changed since … · When · Who · Grooming ·
Suspensions, time outs and parent meetings
(`computeYearInsights()`).

- **What changed since** the previous period (last year for Annual,
  Semester 1 for Semester 2, last year's Semester 2 for Semester 1):
  suspension and time out reasons that rose or fell most (by 2+), the
  level and class that changed most (by 3+), and how many students are
  first time in the logs vs already in the logs (an entry earlier this
  year, or confirmed as the same student as someone in an earlier year).
- **When** also has suspensions + time outs as a share of each term's
  cases, and weeks that were among a term's 3 busiest in most of the last
  (up to 8) finished terms (`computeBusyWeekPattern()`, needs 3+ terms
  with 5+ cases).
"Compared with" is the year before (Annual), the same semester last year,
and for Semester 2 also Semester 1 of the same year. While a summary is
still running, the earlier period is counted over the same number of days
from its start ("first N weeks of each"), so it's like for like.

## Annual Summary Report layout

Eight sections, each starting on a new sheet when printed or exported
(`renderAnnualReportPages()`). Suspension is always one category
(in-school and out-of-school together).

1. **Annual Summary** tiles · **By Term** table (Groom, Susp, Time Out by
   type, Meet, Total — the total includes parent meetings; entries logged in a
   school holiday count towards the term after it (year-end: Term 4), so the table adds up
   to the tiles) · **By Weeks in a
   Term**: four small line graphs (Term 1–4, W1–W10, same scale), 4 lines —
   Grooming, Suspension, Time Out, Parent Meet — with one shared legend.
2. **Discipline Load by Month**: stacked vertical bars (Grooming /
   Suspension / Time Out) with the total on top, and a table with Time Out
   split into its four types (no parent meetings here).
3. **Discipline Load by Day of Week**: a stacked bar per weekday split by
   term, with a term × day table.
4. **Top Reasons for Suspension** and **Top Reasons for Time Out**: one row
   per reason actually used, ranked by total, with columns P1–P6 and Total
   (no total row; a record with several reasons counts once towards each) ·
   **Parent Meetings by Month** (bars, number on top) · **Parent Meet
   Count**: students grouped by how many meetings (held up to today).
5. Repeated vs. Unique Students · Grooming Escalation Rate · Repeat
   Suspension / Time Out Intervals.
6. **Most Challenging Levels**: six blocks in one row (also on phones), least → most
   challenging, each with Grooming / Suspension / Time Out / Parent Meet (meetings count towards the level's number) · **Most
   Challenging Classes**: grouped by count (including parent meetings), each
   class with its breakdown beside it (only the non-zero lines).
7. **All Suspensions / All Time-Outs This Year**: students grouped by how
   many.
8. **Trend Analysis** (kept to about a page), with **Recommendations**
   right after it and a reference-only note.

Grouped lists (Most Challenging Classes, All Suspensions, All Time-Outs, Parent Meet Count): phone 2 columns; tablet vertical 4; tablet horizontal and desktop 5; always 3 in the PDF and in Print (which always matches the PDF, on any device), filled row by row with vertical lines between
the columns only (no outer border or row lines; unfilled cells in the last
row keep their lines); in the PDF and print they break between rows, never inside one.
Every report chart's text and legend is the same size as Discipline Load by Month on each screen. The By Weeks in a Term charts keep their own smaller sizing, with their legend matched to them. Export PDF switches off the
tablet/desktop zoom while capturing, so it's identical from any device.

The dashboard graphs (All, Custom over a year, Term 1–4) show one
Suspension line — in-school and out-of-school together.

## Data Check

Settings → **Data Check** reads through a year's entries (pick the year at
the top) and lists anything that could throw the counts and the Annual
Summary off: no student name, no class, a class not in that year's
Classes For The Year list (or not a P1–P6 class if the list isn't set),
possible duplicates (same student, same day, same log; Parent Meets also
same time), a Time Out with no type, a Suspension or Time Out with no
reason, a Grooming entry with no issue, and a Parent Meet postponed over
two weeks ago that still has no new date. It only reports; nothing is
changed. Tapping an item opens that student's record (a past year opens
expanded) to edit the entry. The Settings row shows how many items there
are for the current year (`computeDataCheck()`).

## Download a log as Excel

Each log tab (Grooming, Suspension, Time Out, Parent Meet) has a
**Download Excel** button under the level counters. Pick From/To dates
(default: 1 Jan this year to today) and it saves an `.xlsx` with one row
per entry, oldest first, removed entries left out. Columns follow the
Google Sheet sync (`exportLogTable()`); dates are real Excel dates, the
header row is frozen with filters. The file is written by a small built-in
writer (`buildXlsxSheetXml()` / `buildZip()`), no spreadsheet library.

## New version bar

The app checks for a newer release when it opens, when it's brought back to
the front, and every 30 minutes (`watchForAppUpdates()`). When sw.js has
installed a new version, a bar at the bottom says "A new version of
Discipline Diary is ready" with an **Update** button, which does the same
full refresh as pulling down at the top of the page (`forceRefreshApp()`).

## Backups

- **Automatic:** after every change, the app saves a copy of every record to
  Firestore. `backups/index` lists the parts: one per log per year (e.g.
  `backups/incidents-2026`), with a large year split further (`-p2`, `-p3`) to
  stay under Firestore's 1 MB document limit. Only changed parts are
  rewritten. `backups/latest` is the old single-document backup, now just a
  pointer. If a backup can't be saved, a red warning bar appears at the top
  of the app.
  - This snapshot always reflects the CURRENT live data, so a deleted
    record drops out of it within ~1.5s — it's a way to recover from a bad
    edit or a lost connection, not from a delete. The trash copies (below)
    cover that.
- **Manual:** the download icon (top right) saves everything as a `.json`
  file. Do this before any big clean-up.
- The rules never let the app delete backups.

## Deleting and restoring entries

- Deleting a Grooming/Suspension/Time Out/Parent Meet entry writes a full
  copy to `deletedItems/{collection}_{id}` *before* deleting the live
  record (`trashRecord()` in app.js), then still deletes it immediately —
  deleting itself hasn't changed. That trash copy is independent of both
  the rolling backup above (which drops the record right away) and the
  5-second in-app "Undo" toast (in-memory only, gone on reload).
- There is no Recently Deleted page in Settings any more (removed in
  3.28.0), but every trash copy is still saved. To recover one, find it in
  the Firebase console under `deletedItems` and recreate the record from
  it. (The old Restore code, `restoreDeletedItem()`, is still in app.js.)
  The rules only let Admins/Owner delete a `deletedItems` doc.
- There's no automatic purge — trash accumulates indefinitely. Deliberate
  for now: better an ever-growing list than a real deletion silently
  losing a record.

## Google Sheet sync

Every change is also written to a Google Sheet, one row per record, updated
in place: tabs "Discipline Log", "Suspension Log", "Time Out Log" and
"Parent Meeting Log". Firestore is the source of truth; the Sheet is a
convenience copy.

The Sheet's web-app address is in the public `app.js`, so each post carries
the teacher's sign-in token. The script checks it with Google and accepts
only verified @moe.edu.sg accounts. Rejected posts are noted on a
"Sync Errors" tab (time and reason only). Text starting with `=`, `+`, `-`
or `@` is stored as plain text, never run as a formula.

**First-time setup**
1. Create a Google Sheet → Extensions → Apps Script.
2. Paste in all of `apps-script.gs` and Save.
3. Deploy → New deployment → gear → Web app. Execute as: **Me**. Who has
   access: **Anyone**. Deploy, and authorise when asked.
4. Put the Web app URL into `SHEET_WEBHOOK_URL` near the top of `app.js`.

**Updating the script (keeps the same URL)**
1. Paste the new `apps-script.gs` over the old code and Save.
2. Deploy → **Manage deployments** → pencil (Edit) → Version: **New version**
   → Deploy, and authorise if asked. Don't use "New deployment", which gives
   a new URL.

If rows stop appearing, check the "Sync Errors" tab.

## Offline

The app opens without a connection (the service worker caches it) and shows
an "offline" note. Entries can't load or save until the device reconnects.

## Tests

The app has been checked with automated browser tests that run the real
`app.js` against a stand-in database. They aren't part of this folder;
nothing here needs building or installing.

## Dashboard sizing

Week view boxes keep the date number in the exact centre, with the day
name above and the markers below, so every box lines up. On tablets
(700px and up; desktop a step bigger) the dashboard's text is sized against the log pages' student
names, the ten range pills (Day … Custom) sit in one row, all the same width, their text shrinking if needed so every label fits: bigger pills, labels, tally labels, calendar numbers and legend, and
the week view's boxes are square with larger markers.

When printing the Annual Summary, the Trend Analysis box may run across
pages so its title stays with it.

Report tables: the By Term header merges Term, Grooming, Suspension, Meet
and Total across its two rows (Time Out spans its four types). On tablet and
desktop screens the Time Out types are spelled out (Recess, Lesson, CCA,
Learning Experience) in the By Term and monthly tables; phones, Print and
the PDF use R / L / CCA / LE with a "* Note" key under each table. On tablet and desktop, table headers are
the same size as the monthly table's month labels (11px); reason names in
Top Reasons are that size in every view.
On phones the By Weeks in a Term legend stays on one line.

Report charts on phones: the By Weeks in a Term charts use a phone drawing
laid out like the other report charts (same text size, y-axis in the same
place); tablet, desktop, Print and PDF keep the standard drawing. Every
report legend is sized against the page width, so all legends match (the
Parent Meetings chart has none). Print and PDF drop squeezed letter
spacing, which drew some words with odd gaps.

Students' Watchlist period: a dropdown at the right of the title picks
Semester 1, Semester 2 or Whole Year (this year). It opens on the current
semester. Whole Year halves the year's totals (average per semester) and
places them with the semester limits (any entry at all is at least Low).
The period only breaks the year down; the symbols beside names always
cover the last 8 school weeks.
