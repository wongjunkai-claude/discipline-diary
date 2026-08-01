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
- `studentName`, `date`, `issue`, `actionTaken`, `status` (Open / Monitoring / Resolved)
- `loggedBy`, `loggedByUid`, `createdAt`
- `followUps`: append-only list of `{ date, note, by }`
- `history`: append-only audit trail of every creation, status change, and
  follow-up, each stamped with who and when.

**Suspensions** — `suspensions` collection:
- `studentName`, `type` (ISS or OSS), `startDate`, `days` (duration), `venue`
  (in-school suspension only), `reason`, `loggedBy`, `createdAt`
- Status (Upcoming / Active / Completed) is calculated automatically from
  today's date — nothing to update manually
- The Suspensions tab shows a live count of who's currently in ISS and OSS,
  plus the full history for reference

Security rules block **deletes** on both collections entirely — nothing can
be erased from the client, only added to.

## Version number & in-app help

The header shows the current version (e.g. `v1.7.0`) — useful for confirming
a teacher's device has actually picked up your latest update, especially
after a cache-clearing troubleshooting step.

Bump `APP_VERSION` near the top of `app.js` alongside the `CACHE` version in
`sw.js` every time you ship a change, so the two stay in sync and the number
in the header is a reliable signal of what's actually running.

The **circular "?" icon** (above the tabs, next to the Deleted pill and New
Entry button) opens a plain-language guide for
teachers — statuses, suspensions, editing, removing, and backups — separate
from this README, which is aimed at whoever maintains the app.

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

**Two known exceptions found during that check:**
1. **Term 1's start date** is off by a day in years where 1 January falls
   on a Saturday or Sunday (seen in 2022 and 2023) — MOE staggers Primary
   1's start in those years as a real, documented policy that began in the
   pandemic and continued afterward.
2. **Children's Day** ("first Friday of October") was wrong for 2020 — the
   actual date was the second Friday, not the first. Every other year
   checked (2021, 2022, 2023, 2025, 2026) matched the first-Friday rule
   exactly, so it's kept as the best default rather than a fully confirmed
   formula.

**Public holidays still need annual updates** — Chinese New Year, Hari
Raya, Vesak Day, and Deepavali follow lunar/religious calendars that
genuinely can't be calculated, only sourced from MOM's actual gazetted
list each year. See "Public holiday data" below for why this can't be
fully automated either, and what the update process looks like.

For anything the calendar doesn't catch (a one-off closure day, or a year
where the formula's soft spot applies), a small date field sits next to
each day 2+ of a suspension — tap it to override that day's date manually.
Changing one day's date doesn't shift any other day.

## Public holiday data

Singapore doesn't offer a stable, evergreen public API for this: MOM
publishes a *new* dataset (with a new ID) on data.gov.sg every year rather
than one URL that updates in place, so there's no single link this app
could point at forever. That means public holidays live in Firestore
(`holidays/singapore` → `publicHolidays`), seeded once with real 2026 data
and meant to be updated by hand each year:
1. Around September/October, MOM publishes next year's list (search
   "Singapore public holidays [year] MOM" or check data.gov.sg)
2. Firebase Console → Firestore Database → Data → `holidays` → `singapore`
   → edit the `publicHolidays` array
3. Or paste me the new list and I'll help build the updated document

## Hybrid (linked) suspensions

For a suspension that's part OSS and part ISS (e.g. 3 days out of school
then 2 in), log it as two separate suspensions and link them: expand the
first one → **"+ Add linked part"**. This carries over the student's name,
class, and reason automatically, suggests the opposite type and a start
date right after the first part ends, and marks both records as one case.

Linked parts show together on both suspension cards — "part 1 of 2" /
"part 2 of 2" — with the full breakdown visible when expanded. Each part is
still its own record with its own dates, type, location(s), and audit
trail; linking only ties them together for display.

## Per-day ISS locations

Location defaults to a single field applying to every day of the
suspension — quick to fill in for the common case. Only check **"Different
location each day"** if a student is actually moving rooms partway through;
that reveals one location field per day of the duration. When logging or
editing an ISS suspension, each day gets its own "Location by day" row. The
Suspensions dashboard's Today / Next 2 Days columns show the correct
location for that specific date automatically. Older suspensions logged
before this feature still show their original single location for every
day, until edited.

(v1.9.0 also fixed a date bug where the location-by-day list and some
suspension date math were off by one day for anyone in a timezone ahead of
UTC — e.g. Singapore/Malaysia.)

## Editing entries

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
3. **Google Sheets mirror (optional but recommended).** Every entry created,
   status change, follow-up, and suspension logged is also sent to a Google
   Sheet you control — completely independent of Firebase. Setup:
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
   7. In `app.js`, find the line near the top that says:
      `const SHEET_WEBHOOK_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";`
      and replace the placeholder text with that URL
   8. Commit the updated `app.js` to GitHub (same edit-in-browser process as
      before)

   From then on, a "Log" tab in that spreadsheet fills in automatically —
   readable by anyone you share the sheet with, with zero dependency on
   Firebase or this app staying online.

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
