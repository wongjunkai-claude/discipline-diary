# Discipline Diary (no-build version)

Plain HTML/CSS/JS — no Node, no npm, no build step, no Terminal. Firebase is
loaded directly from Google's CDN in the browser.

## 1. Lock down Firestore (no CLI needed)

1. Go to https://console.firebase.google.com → your `discipline-diary` project
2. **Build → Firestore Database → Rules** tab
3. Delete what's there and paste in the contents of `firestore.rules` (in this folder)
4. Click **Publish**

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
2. Click **Sign up**, create the first teacher account (name, email, password)
3. Have each teacher do the same the first time they open it
4. On phones: open the link in the browser, then use the browser's
   **"Add to Home Screen"** option (Safari: Share button → Add to Home Screen)
   — it'll behave like an installed app from then on

## How data is structured

Every entry lives in the `incidents` collection in Firestore:

- `studentName`, `date`, `issue`, `actionTaken`, `status` (Open / Monitoring / Resolved)
- `loggedBy`, `loggedByUid`, `createdAt`
- `followUps`: append-only list of `{ date, note, by }`
- `history`: append-only audit trail of every creation, status change, and
  follow-up, each stamped with who and when. The security rules block deletes
  from the client, so this trail can't be erased.

## Making changes later

Edit the files directly on GitHub (click a file → pencil icon → edit → commit),
or download the repo, edit locally, and re-upload. Changes go live within
about a minute of committing — no build or deploy command needed.

## Icons

Swap `icons/icon-192.png` and `icons/icon-512.png` for your school's own
branding any time — same filenames, same sizes.
