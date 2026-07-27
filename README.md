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
   (their name is remembered after that; "Not you?" in the header lets
   someone switch names on a shared device)
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

## Data safety / backups

Two layers of protection, on top of the delete-blocking rule above:

1. **Automatic rolling snapshot.** Every time data changes, the full current
   dataset (all incidents + all suspensions) is mirrored into a single
   document: `backups/latest` in Firestore. If a bug ever corrupts or
   overwrites something in the live data, open Firebase Console →
   Firestore Database → Data → `backups` → `latest` to see the most recent
   good copy in full, and manually copy values back into the affected
   record.
2. **Manual download.** The **"⬇ Backup"** button in the app header downloads
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

Swap `icons/icon-192.png` and `icons/icon-512.png` for your school's own
branding any time — same filenames, same sizes.
