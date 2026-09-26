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
  HBL/closure day moves to the next school day (`computeGroomingDeadline()`). Also follow-ups and links to
  related suspensions, time outs and meetings. A few very old entries use an
  earlier single-`issue` format; they still display, but don't count toward
  the watchlist.
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

## Students' Watchlist

This semester's records only: Terms 1–2 until Term 3 starts (so through
the June holidays), then Terms 3–4. Grooming entries count
once each, at the highest warning any of their issues reached. A student
needs to meet just **one** criterion in a tier and is shown in the highest
tier they qualify for.

- **High Risk:** 2+ suspensions, 3+ final warnings, 7+ 2nd warnings, or 4+ time outs
- **Medium Risk:** 1 suspension, 2 final warnings, 4–6 2nd warnings, or 2–3 time outs
- **Low Risk:** 1 final warning, 1–3 2nd warnings, or 1 time out

The rules live in `riskTierFor()` in `app.js`. The plain-language list in the
app's ⓘ box is `RISK_TIER_CRITERIA`; change both together.

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

- **Annual Summary Reports:** per-year report with a print / save-as-PDF button.
- **Classes For The Year:** the class list for the current year
  (`settings/classConfig`).
- **Holidays / School Closure / HBL Days:** public and school holidays and
  closure days (`holidays/singapore`, `settings/schoolCalendarOverrides`,
  `settings/schoolClosureDays`). Used to skip non-school days when setting
  deadlines and suspension dates.
- **Authorised Teachers List:** who can sign in (see "Sign-in and access").

## Backups

- **Automatic:** after every change, the app saves a copy of every record to
  Firestore. `backups/index` lists the parts: one per log per year (e.g.
  `backups/incidents-2026`), with a large year split further (`-p2`, `-p3`) to
  stay under Firestore's 1 MB document limit. Only changed parts are
  rewritten. `backups/latest` is the old single-document backup, now just a
  pointer. If a backup can't be saved, a red warning bar appears at the top
  of the app.
- **Manual:** the download icon (top right) saves everything as a `.json`
  file. Do this before any big clean-up.
- The rules never let the app delete backups.

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
