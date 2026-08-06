# Discipline Diary (no-build version)

Plain HTML/CSS/JS — no Node, no npm, no build step, no Terminal. Firebase is
loaded directly from Google's CDN in the browser.

## 1. Enable anonymous sign-in (invisible to your team, keeps the database locked to the app)

1. Go to https://console.firebase.google.com → your `discipline-diary` project
2. **Build → Authentication → Sign-in method**
3. Click **Anonymous** in the list of providers, toggle it **on**, click **Save**

This lets the app quietly authenticate each visitor in the background so your
Firestore security rules can still block anyone who doesn't go through the
app itself — but nobody ever sees a login screen. They just type their name.

## 2. Lock down Firestore

1. Same project → **Build → Firestore Database → Rules** tab
2. Paste in the contents of `firestore.rules` (in this folder)
3. Click **Publish**

## 2. Put it on GitHub (all in the browser)

1. Go to https://github.com and sign in (or create a free account)
2. Click the **+** icon (top right) → **New repository**
3. Name it `discipline-diary`, keep it **Public** (needed for the free GitHub
   Pages hosting below), click **Create repository**
4. On the new repo page, click **"uploading an existing file"**
5. Drag in every file from this folder (`index.html`, `style.css`, `app.js`,
   `manifest.json`, `sw.js`, and the `icons` folder) — GitHub accepts
   drag-and-drop for a whole folder
6. Scroll down, click **Commit changes**

## 3. Turn on GitHub Pages (makes it a live website)

1. In your repo, click **Settings** (top menu)
2. Left sidebar → **Pages**
3. Under **Branch**, choose **main** and **/ (root)**, click **Save**
4. Wait about a minute, then refresh — GitHub will show you a URL like:
   `https://<your-username>.github.io/discipline-diary/`

That URL is the app. Send it to your discipline team.

## 4. First use

1. Open the link
2. Type your name and click **"Enter the log"** — that's it, no email or password
3. Each teacher does the same the first time they open it on their device
   (their name is remembered after that — there's no way to switch names on
   a shared device from within the app; clear the browser's site data for
   this page to reset it, or use separate devices per teacher)
4. On phones: open the link in the browser, then use the browser's
   **"Add to Home Screen"** option (Safari: Share button → Add to Home Screen)
   — it'll behave like an installed app from then on

## How data is structured

**Discipline log** — `incidents` collection:
- `studentName`, `studentClass` (dropdown, e.g. `P3-2`), `date`, `issue`,
  `actionTaken` (required), `status` (Open / Monitoring / Resolved)
- `loggedBy`, `loggedByUid`, `createdAt`
- `followUps`: append-only list of `{ date, note, by }`
- `history`: append-only audit trail

**Suspensions** — `suspensions` collection, rebuilt in v2.0 around a single
unified per-day model:
- `studentName`, `studentClass`, `reason` (required), `startDate`,
  `totalDays`, `issDays`, `ossDays`
- `days`: the authoritative list — `[{ date, type: 'ISS'|'OSS', venue? }, ...]`
  covering every day of the suspension, however the ISS/OSS mix works out.
  A single record can span both in-school and out-of-school days.
- Status (Upcoming / Active / Completed) is calculated from the earliest
  and latest dates in `days`
- `loggedBy`, `loggedByUid`, `createdAt`, `history`

**Parent meetings** — `parentMeetings` collection:
- `studentName`, `studentClass`, `date`, `reason`, `attendees` (array, e.g.
  `["Father", "Others"]`), `othersText` (free text if "Others" is checked)
- `loggedBy`, `loggedByUid`, `createdAt`, `history`

Security rules block **deletes** on all three collections entirely —
nothing can be erased from the client, only added to.

## Version number & in-app help

The header shows the current version (e.g. `v1.7.0`) — useful for confirming
a teacher's device has actually picked up your latest update, especially
after a cache-clearing troubleshooting step.

Bump `APP_VERSION` near the top of `app.js` alongside the `CACHE` version in
`sw.js` every time you ship a change, so the two stay in sync and the number
in the header is a reliable signal of what's actually running.

The **circular "?" icon** (above each list, next to the Deleted pill and New
Entry button) opens a plain-language guide for
teachers — statuses, suspensions, editing, removing, and backups — separate
from this README, which is aimed at whoever maintains the app.

## Dashboard (Home)

The home icon in the nav is the first stop — trends of who's been named
most often across both discipline and suspension records, current open/
active counts, and the In-School / Out-of-School Suspension "who's in
today and over the next 2 days" tracker (moved here from the Suspension Log
page, since it's more of an at-a-glance overview than a log-browsing task).

**Monthly trend chart** — 11 months, shown as horizontal bar rows (one row
per month, stacked vertically) rather than side-by-side vertical bars —
this fits all 11 clearly on a phone screen with no scrolling or cramped
bars. A scale row at the top and faint gridlines behind every bar (at
0/25/50/75/100% of a rounded "nice" maximum, e.g. 5/10/20/50) make bars
comparable at a glance, not just by their number label. Checkboxes toggle
Discipline / Suspension / Parent Meeting in or out of the rows. Discipline
counts by incident date, Suspension by start date, Parent Meeting by
meeting date; deleted entries are excluded.

**Status indicators are now traffic-light dots, not text pills** — a
colored circle instead of a labeled badge, with the actual status as a
tooltip. Discipline Log: red for Open/In Progress, green for Resolved.
Suspension Log: red for Active, green for Completed, yellow-orange for
Upcoming (grey for Removed). The Suspension Log's In-School/Out-of-
School/Mixed type pill was removed from the card header entirely — that
detail is still fully visible in the day-by-day breakdown below it, just
not repeated as a summary badge up top.

**Discipline Log no longer has its own "+ New entry" button** — all
discipline entries (with or without a linked suspension or parent meeting)
now go through the Dashboard's "+ New Entry" guided flow.

**Related records** — when logging a new discipline entry, if the student
already has a suspension or parent meeting on file, a "Related records
found" box appears under the name field with checkboxes to link them.
Linking isn't cosmetic — it writes a reference on *both* records, so the
connection shows up (as a clickable jump-to link) whether you're looking at
the discipline entry, the suspension, or the meeting.

**"+ New Entry" (Dashboard)** — a guided multi-step flow for logging a
whole case at once: Discipline details → "Any Suspension?" (Yes reveals a
Suspension step; No skips it) → "Any Parent Meeting?" (same pattern) →
Submit. Everything gets created and cross-linked in one go — student name
and class only get typed once and carry through every step. This is
separate from the Discipline Log page's own "+ New entry" button, which
stays as a quick single-entry add with no wizard, for when there's nothing
else to link.

## ISS dashboard grouping

The Today / Next 2 Days columns for In-School Suspension group students by
**location first** — each location appears once as a small heading, with
every student assigned there listed underneath (name, then class). Within
Next 2 Days, this grouping happens separately for each date. Out-of-School
Suspension has no location concept, so its columns stay a flat list.

## Weekend-aware scheduling

When a suspension spans more than one day, day 2 onward defaults to the
**next school day** — skipping weekends, the computed MOE school calendar,
and gazetted Singapore public holidays, all automatically.

**School term dates are now calculated, not stored.** MOE's term structure
turns out to follow a fixed, checkable formula: each term is 10 weeks,
March/September breaks are 1 week, the June break is 4 weeks, and the
year-end break runs to 31 December. The only variable is where "Week 1"
starts, which depends on the weekday 2 January falls on. From that, the app
computes term boundaries, Youth Day, Teachers' Day, Children's Day, and the
National Day in-lieu school holiday for any year automatically.

**Verified against MOE's own published calendars for 2019, 2020, 2021,
2024, 2025, and 2026** — six years, checked date-by-date. Term boundaries
and all four holiday blocks matched exactly in every one; so did Youth Day,
Teachers' Day, and the National Day in-lieu rule.

**One known exception found during that check — now fixed:** Term 1's
start date used to be off by a day in years where 1 January falls on a
Saturday or Sunday. MOE consistently pushes the actual start one day later
than the plain weekday rule gives in those years; this is now built in and
verified exactly against 2021 (no shift needed), 2022, and 2023 (both
shifted, matching the real confirmed dates).

One simplification worth knowing: MOE stages the very first day of the
school year — Primary 1 attends starting on the computed date, but other
levels report one school day later. This app doesn't track grade-level-
specific calendars, so it treats P1's (earlier) date as the practical start
for scheduling — some students genuinely are in school that day, and it's
the more inclusive definition.

**Children's Day update:** "first Friday of October" checked out for 2024,
2025, and 2026 — including against a source citing the official MOE press
release directly. 2020-2023 actually used a different rule (Friday of Term
4 Week 4); the policy appears to have changed after 2023, so the current
first-Friday rule is what's implemented.

**Public holidays now sync automatically** — Chinese New Year, Hari Raya,
Vesak Day, and Deepavali follow lunar/religious calendars that can't be
calculated, but they no longer need manual updates either. See "Public
holiday data" below for how the app keeps this current on its own.

For anything the calendar doesn't catch (a one-off closure day, or a year
where the formula's soft spot applies), a small date field sits next to
each day 2+ of a suspension — tap it to override that day's date manually.
Changing one day's date doesn't shift any other day.

## Public holiday data

**Public holidays now update themselves automatically.** MOM publishes an
evergreen "Singapore Public Holidays (consolidated)" dataset on data.gov.sg
that they update in place every year — unlike their per-year datasets,
which get a brand new ID annually and can't be tracked automatically, this
one dataset ID stays the same and just grows. The app quietly checks it
every time it loads, and if it finds new or changed data, updates
`holidays/singapore` in Firestore on its own.

This is genuinely tested against the real dataset — pulled a live response
and confirmed it reproduces the exact 2026 public holiday list byte for
byte, including deriving the "observed" Monday for holidays that land on a
Sunday (the dataset only lists the raw holiday date; Singapore's actual
rule — Sunday holidays get the following Monday off in lieu, Saturday ones
don't — is computed here since it isn't in the source data).

**This is a best-effort convenience, not a dependency.** If a browser
blocks the request, data.gov.sg is briefly down, or they ever change their
API, the sync just silently does nothing and the app keeps using whatever
was already stored — exactly the same as before this existed. Nothing
breaks either way. If you ever want to check it's working: open browser
dev tools → Network tab → look for a request to `data.gov.sg` on page
load.

**Manual updates are now just a safety net, not a requirement** — but the
same process as before still works if you ever want to force a specific
year's list or the dataset stops updating:
1. Firebase Console → Firestore Database → Data → `holidays` → `singapore`
   → edit the `publicHolidays` array
2. Or paste me the new list and I'll help build the updated document

## Suspension workflow (v2.0 — unified, single entry)

Logging a suspension now works as one flow instead of separate ISS/OSS
records:
1. Student name, class (dropdown), and reason (required)
2. Pick the **total days** (1-14)
3. Pick how many are **in-school** vs **out-of-school** — these two
   dropdowns are linked, so setting one recalculates the other to always
   sum to the total (e.g. set in-school to 4 out of 5 total, out-of-school
   becomes 1 automatically)
4. The app then shows a date picker for each out-of-school day and each
   in-school day separately, defaulting to the next available school day
   for each — every date has its own small calendar icon to override it
5. For in-school days, a **location** dropdown (General Office / MPR 1)
   applies to all of them by default; tick **"Different location each
   day"** to set a location per day instead

The whole thing saves as **one log entry**, regardless of how the ISS/OSS
days are split or interleaved — this replaces the earlier "linked
suspension" feature (two records tied together), which is no longer
needed now that a single record can natively hold a mix of both types.

This is also the same feature that gives you weekend/holiday-aware
scheduling and per-day location overrides — see "Weekend-aware scheduling"
below for how the default dates are calculated.

## Class dropdown

`studentClass` is a dropdown everywhere (discipline log, suspensions,
parent meetings), formatted `P<level>-<number>`. P1 and P2 go up to 8
classes each (`P1-1`...`P1-8`), P3 through P6 go up to 6 each (`P3-1`...
`P3-6`). Change the range in `buildClassOptions()` near the top of `app.js`
if your school's numbers differ.

## Parent Meeting

A third log alongside Discipline and Suspensions: student name, class,
who's attending (multiple people allowed — Father, Mother, Grandfather,
Grandmother, Guardian, or Others with a free-text field), date, and reason.
Same editing, audit trail, and remove/restore pattern as the other two logs.

## Dropdown-based entry lists

All three logs went back to always showing every entry as a full stacked
list (like the very original design), rather than a dropdown-select-one
pattern tried in an earlier version — that felt like it hid too much.
Search still narrows what's shown.

**Discipline Log filters** are now three pills: **Show All**, **In
Progress**, **Resolved**. The **Open** status has been removed entirely —
new entries go straight to "In Progress." Any entries logged before this
change that were still "Open" keep displaying correctly (they show under
Show All), just without a dedicated filter pill of their own, since new
entries can no longer be created or set to that status. A separate **Sort
by** dropdown (Date / Name / Class / Level) controls ordering independent
of the filter pills.

**Suspension Log** and **Parent Meeting Log** keep their existing filters
(Active/Upcoming/Completed tabs, and Deleted) — only the display changed,
from dropdown-select to always-full-list.

## Date format

Dates display as **DD MMM YYYY** (e.g. `02 Aug 2026`) throughout the app.

## Editing entries

Individual follow-up notes on a discipline entry can also be edited (✎) or
removed (✕) directly — for typos or notes entered against the wrong entry.
Both are tracked in that entry's audit trail (what changed and, for edits,
the before/after text), same as everything else. Removing a follow-up asks
for a plain confirmation, not the delete password — it's a much lower-
stakes action than removing a whole entry.

Both discipline log entries and suspensions can now be edited (click a card
to expand it → **"Edit entry"**). Every field change is recorded in that
entry's audit trail — e.g. `Entry edited — Issue changed from "..." to
"..."` — with who made the change and when, the same way status changes and
follow-ups already were. Nothing about an edit is silent; the full history
stays visible under "Show audit trail."

## Removing entries

There's no true delete — matching the "nothing can be erased" promise above.
Instead, clicking **"Remove entry"** (inside an expanded discipline entry) or
**"Remove"** (on a suspension) asks for a password before hiding it from the
normal views. The record itself stays in Firestore untouched, just tagged as
removed, and shows up under the **"Deleted"** tab where it can be restored
any time with no password needed.

The password is set in `app.js`:
```
const DELETE_PASSWORD = "shsm";
```
Change it there (and re-commit to GitHub) any time you want a different one.

**Important:** because this is a plain client-side app with no server, this
password only stops accidental clicks in the interface — it's not
cryptographically secure. Anyone who opened their browser's developer tools
could bypass it and call the underlying delete function directly. It's a
"are you sure, and do you know the code" gate, not a real access-control
boundary. Real security here would need Firestore rules keyed to something
the client can't see or fake (e.g. real per-teacher accounts with roles),
which is a bigger step up from this project's current design.

## Data safety / backups

Two layers of protection, on top of the delete-blocking rule above:

1. **Automatic rolling snapshot.** Every time data changes, the full current
   dataset (all incidents + all suspensions) is mirrored into a single
   document: `backups/latest` in Firestore. If a bug ever corrupts or
   overwrites something in the live data, open Firebase Console →
   Firestore Database → Data → `backups` → `latest` to see the most recent
   good copy in full, and manually copy values back into the affected
   record.
2. **Manual download.** The circular backup icon (top right of the header)
   downloads
   a dated `.json` file of everything, right to your device. Worth doing
   this occasionally (e.g. weekly) and keeping a copy somewhere like Google
   Drive — this one is safe even if your Firebase project itself ever has a
   problem, since it isn't stored in Firebase at all.
3. **Google Sheets mirror (optional but recommended).** Every discipline
   entry, suspension, and parent meeting is mirrored into **three separate
   tabs** in a Google Sheet you control — completely independent of
   Firebase. Setup:
   1. Go to https://sheets.new to create a fresh spreadsheet
   2. **Extensions → Apps Script**
   3. Delete the placeholder code, paste in the contents of `apps-script.gs`
      (in this folder)
   4. Click **Deploy → New deployment** → gear icon → **Web app**
      - Execute as: **Me**
      - Who has access: **Anyone**
   5. Click **Deploy**, click **Authorize access**, and approve (it's your
      own script — this prompt is expected)
   6. Copy the **Web app URL** it gives you
   7. In `app.js`, find the line near the top that says
      `const SHEET_WEBHOOK_URL = "...";` and replace it with that URL
   8. Commit the updated `app.js` to GitHub (same edit-in-browser process as
      before)

   From then on, three tabs fill in automatically — **Discipline Log**,
   **Suspension Log**, **Parent Meeting Log** — each with columns matching
   that log's actual fields (e.g. Discipline Log has Student Name, Class,
   Date, Issue, Action Taken, Status, Follow-ups, Logged By).

   **Each record is one row that updates in place**, not a new row per
   action — editing an entry, changing its status, or adding a follow-up
   overwrites that same row (matched by an internal ID in column B) rather
   than piling up duplicate rows. Follow-up notes on a discipline entry all
   accumulate into that row's single "Follow-ups" cell, one per line, each
   stamped with its own date.

   If you had the old single-tab version running, your existing "Log" tab
   is left alone — the new tabs are created alongside it, and you can
   delete the old one once you've confirmed the new tabs are working.

None of these are a substitute for the others — they're deliberately
redundant. Firestore is the live source of truth the app reads from; the
rolling snapshot and the Sheet are both independent copies for the (hopefully
rare) day something goes wrong.

## Making changes later

Edit the files directly on GitHub (click a file → pencil icon → edit → commit),
or download the repo, edit locally, and re-upload. Changes go live within
about a minute of committing — no build or deploy command needed.

## Icons

The current icon crops tightly to the book artwork and places it on a
parchment (#E3E1D6) background matching the app's own color palette, so the
dark navy book stands out clearly rather than blending into a dark backdrop.
Swap `icons/icon-192.png` and `icons/icon-512.png` for your school's own
branding any time — same filenames, same sizes.
