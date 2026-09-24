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
| `firestore.rules` | Database security rules; published in the Firebase console, not on GitHub |
| `apps-script.gs` | Google Sheet sync; pasted into Apps Script, not on GitHub |

## Releasing a change

1. Bump `APP_VERSION` near the top of `app.js` **and** `CACHE` at the top of
   `sw.js`, together. The version shows in the header and in the ? help, so
   you can check which version a teacher's device is running.
2. On GitHub, upload the changed files over the old ones and commit. GitHub
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
  immediately, even mid-session.

## The four logs (Firestore collections)

Every record also has `loggedBy`, `loggedByUid`, `createdAt` and a `history`
audit trail (every create, edit and status change, with who and when).

- **Grooming Log** (`incidents`): student, class, date, and `issues` — one or
  more grooming issues (Long Hair, Uniform, …), each with its own
  1st / 2nd / Final Warning stage and deadline. Also follow-ups and links to
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

This semester's records only (Terms 1–2 or Terms 3–4). Grooming entries count
once each, at the highest warning any of their issues reached. A student
needs to meet just **one** criterion in a tier and is shown in the highest
tier they qualify for.

- **High Risk:** 2+ suspensions, 3+ final warnings, 7+ 2nd warnings, or 4+ time outs
- **Medium Risk:** 1 suspension, 2 final warnings, 4–6 2nd warnings, or 2–3 time outs
- **Low Risk:** 1 final warning, 1–3 2nd warnings, or 1 time out

The rules live in `riskTierFor()` in `app.js`. The plain-language list in the
app's ⓘ box is `RISK_TIER_CRITERIA`; change both together.

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
