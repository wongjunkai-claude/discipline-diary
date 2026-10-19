# WordPasture

*"Feed my lambs." (John 21:15)*

A daily Bible-reading game for your fellowship, your family, your friends. Each person keeps one lamb that stays happy as they read. People gather in **flocks** (like classes in Google Classroom). A flock is made of **folds** (small groups). Each person's own fenced home for their lamb is their **pasture**.

Plain HTML/JavaScript with no build step. Firebase (Google sign-in and the Firestore database) is loaded straight from Google's CDN, and the site is hosted free on **GitHub Pages**. Everything can be maintained from a browser.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `firebase-config.js` | Your Firebase project's settings (already filled in for `wordpasture`) |
| `sw.js` | Service worker: lets the app install to a home screen and open offline |
| `manifest.webmanifest`, `icons/` | Home-screen app name and icons |
| `version.json` | The current version number; when it changes, everyone is asked to update |
| `zh/` | The Chinese Union Version (simplified), one file per book |
| `en/` | The Berean Standard Bible (BSB), one file per book |
| `questions/` | The reflection questions for every chapter |
| `zq/` | The same questions in Chinese, used when Reflect is set to CUVS |
| `firestore.rules` | Database security rules; published in the Firebase console (it does nothing on GitHub) |

## Setting up (once)

1. **GitHub:** put all these files at the top level of a repository (upload the folder's contents, not the folder). Then *Settings → Pages → Build and deployment*: Source **Deploy from a branch**, branch **main**, folder **/ (root)**, Save. After a minute your app is at `https://<your-username>.github.io/<repo>/`.
2. **Firebase → Authentication → Sign-in method:** turn on **Google** (pick a support email) and save.
3. **Firebase → Authentication → Settings → Authorized domains:** **Add domain** `<your-username>.github.io` (no `https://`, nothing after it).
4. **Firebase → Firestore Database:** *Create database* in **production mode**, location **asia-southeast1 (Singapore)**. Then the **Rules** tab: delete what's there, paste the whole of `firestore.rules`, **Publish**.
5. Open your app's address in Safari, choose **Start a flock**, give it a name and your name, and continue with Google. You're its **founder**. Then **Share → Add to Home Screen**.
6. **Make yourself the super admin** (once): Firebase → **Authentication → Users**, copy the **User UID** next to your Google email. Then **Firestore Database → Data → Start collection**: collection ID `admins`, document ID = your UID, add one field (e.g. `role` = `owner`), **Save**. Reopen the app: a ★ appears beside your name, and *Settings → Your account* has an **★ Admin** button. Only records made by hand in the console count; the app can never make an admin.

No database indexes are needed: every list the app reads works with Firestore's automatic ones.

## Bible versions: BSB and CUVS

The Read step offers two versions, picked from the menu beside Full screen. Both are public domain and ship with the app, so they work offline and need no setup:

- **BSB**: the Berean Standard Bible, in modern English, in `en/` (from eBible.org via the open-bibles collection).
- **CUVS**: the Chinese Union Version with new punctuation (和合本 新标点), simplified characters, 神 edition, in `zh/`.

The 文A button shows both together, CUVS first and BSB second. The button beside it switches between one above the other (the default) and side by side. Scroll either half and the other follows, verse by verse.

Picking CUVS in Reflect (the menu beside the passage name when choosing what to reflect on) turns the whole Reflect step into Chinese, questions included. In Remember, a verse is learned in the language its reference was typed in; the wording follows the language of the Today card, and the 文A button shows the other language underneath.

The BSB's public-domain notice is in Settings, at the bottom. If an old `esv-relay/` or `bible/` folder is still on GitHub from an earlier version, it can be deleted.

## Releasing a change

1. Bump the version **in three places, together:** `const APP_VERSION` in `index.html` (and the "Version …" line in Settings), `version.json`, and `VERSION` at the top of `sw.js`.
2. On GitHub, upload the changed files over the old ones and commit. GitHub Pages updates within a minute or two.
3. Everyone sees "A new update is ready" with an **Update now** button the next time they open the app (or within 10 minutes if it's open). Their lamb and reading are kept.
4. **Only if `firestore.rules` changed:** Firebase console → Firestore Database → Rules → paste the whole file → **Publish**.

## An app on the home screen

- **iPhone:** open the app's address in **Safari** → **Share** → **Add to Home Screen**.
- **Android:** open it in **Chrome**; the app offers **Add to home screen** (or ⋮ → *Install app*).
- The app shows these steps itself after someone's first reading, and any time in *Settings › On your phone/tablet*; on a phone or tablet the welcome screen also offers it before sign-up.
- Installed, it opens full screen with the lamb icon and **works offline**: the app, the Bible, the questions and the flock's latest data are kept on the phone, and anything done offline is sent when the signal returns.

## Sign-in

People sign in with **Google**, in a small pop-up. There are no passwords. Using the same Google account on any phone brings back the same lamb. If sign-in shows "This web address isn't allowed to sign in yet", add the app's domain in *Authentication → Settings → Authorized domains* (step 3).

## Who can do what

| | Founder | Shepherd | Everyone |
|---|---|---|---|
| Read, reflect, share, send hearts and notes | ✓ | ✓ | ✓ |
| Remove their own posts, notes and replies | ✓ | ✓ | ✓ |
| Remove replies and hearts on their own reflection | ✓ | ✓ | ✓ |
| Take back a heart they sent | ✓ | ✓ | ✓ |
| See the flock code and share an invitation link (on the fold card) | ✓ | ✓ | ✓ |
| Remove posts, notes, questions and replies **in their own fold** | ✓ | ✓ | |
| Remove a lamb **from their own fold** (not a shepherd), from the ⋮ menu | ✓ | ✓ | |
| Remove anyone, anywhere (except the founder) | ✓ | | |
| Appoint or stop a shepherd (⋮ menu, or Founder's tools) | ✓ | | |
| Move lambs between folds; add, rename and remove folds | ✓ | | |
| Rename the flock, make a new code, set the flock plan | ✓ | | |
| Hand the flock to someone else | ✓ | | |

- **Removing someone** asks to confirm, then gives 10 seconds to **Undo** before it happens. It takes them out of the flock; their own lamb and reading stay with them, and they **can join again** with the flock code (unless the super admin has blacklisted them).
- **Invitations:** the Share button beside the flock code sends "Come join our *Flock name* Flock! Click on the link below to join in!" with a link (`…/?join=CODE`) that opens straight onto joining that flock.
- **The founder** can't leave a flock that has other people in it: they hand it on first (*Founder's tools → Hand the flock on*). A founder who is the only one left can close the flock.
- **Everyone stays in at least one flock.** The last flock can't be left; join or start another first.

## The super admin

The ★ Admin button (only for the account in `admins/`) asks Google to confirm it's you **every time**, then shows:

- **Overview:** people, flocks, folds, memberships, who opened the app today and this week, who read today, new people this week, and the blacklist count.
- **People:** everyone's name, email, lamb, reading days, streak, chapters, flocks, last seen and joined date, with search. People appear once they open version 2.8 or later (each person's app keeps a short card about them in `directory/{uid}`).
- **Flocks:** every flock with its founder, code, folds and the lambs in each, with **Remove** for any member and **Hand on** to make someone else the founder.
- **News:** write an announcement; it pops up once for everyone the next time they open the app.
- **Usage:** today's reads, writes and deletes against Firebase's free daily allowance (50,000 / 20,000 / 20,000), and the last 14 days. Each person's app counts what it uses (`usage/{day}`), so it's close but not exact; the Firebase console's *Firestore → Usage* has the exact figures.
- **Log:** every admin action (blacklist, unblock, remove, hand on, close a flock, announcements), recorded for good in `adminlog`; it can't be changed or erased.
- **Close and delete a flock:** for abandoned flocks (marked "Quiet for a month or more"). Deletes the flock, its folds, code and everything shared in it; everyone keeps their own lamb and journal.
- **Blacklist:** blacklisted people are taken out of every flock and can't join or start one; **Unblock** lets them back. A founder must be handed on before they can be blacklisted.

Private journals are never shown, even to the super admin.

## Privacy

- **Visible to the super admin:** your name, email, lamb, reading totals, flocks and everything shared in them (not your private journal).
- **Visible to the flock:** your name, your lamb's name, outfit, fold, streak, total readings and the date you last read.
- **Reflections:** shared with *just me*, *my fold* or the *whole flock*. A fold-only reflection, and its replies and hearts, can only be read in that fold. If it has an *I wonder…* question, the question alone is shown to the whole flock (in the inbox, without an alert).
- **Notes and hearts are open:** everyone in the flock can read them (each fold card shows the notes written to its lambs). Only the person a note or heart is for is alerted.
- **Private to you:** your journal, your answers, your verses and your plan progress.
- **Flocks never see each other.** Joining needs the flock's current code; if a code gets out, the founder makes a new one.
- **Deleting:** *Settings → Your account → Delete my account* removes the person's lamb, journal, and everything they shared or sent, in every flock, then the account itself.
- The app's *Privacy note* (in *Settings › Your account*) explains all this in plain words, and asks under-18s to make sure a parent or guardian knows.

## Never running out of space

Each person's lamb is stored as one small record (`users/{uid}`), and **every journal entry is its own record** (`users/{uid}/journal/{entry}`). Nothing is trimmed or thrown away, and no single record grows past Firestore's 1 MB limit: a daily reader adds a few hundred bytes a day, in a new record each time.

## Two phones, one lamb

When someone signs in on a second phone, or comes back to the app, the two copies are **combined** rather than one replacing the other: every chapter read, every day fed, every journal entry and every memory verse from both is kept; counts take the larger; outfit and settings come from whichever was changed last.

## How it works

- **Flocks are separate.** Folds, members, reflections, questions, hearts, notes, replies and the flock plan all belong to one flock. Someone in two flocks switches between them by tapping the flock name on their fold card.
- **One plan at a time.** You follow one reading plan: a personal one, or one flock's plan. Each flock's founder sets its plan.
- **Read, Reflect, Remember.** The day's passage opens right in the app (BSB from `en/`, or CUVS from `zh/`), with highlighting, a full-screen reading mode, a calendar, and passage-specific questions (in `questions/`).
- **New here?** The first time someone opens the app they're asked whether they'd like a walkthrough; it can be taken again from Settings.
- **Reflect your way:** guided prompts, or "write freely" for those who prefer their own structure. Questions to think about show one at a time.
- **Reward stories:** every book and collection reward has a short line about the passage behind it, marked "In the Bible" (the thing or event is in the passage) or "A picture" (it stands for what the passage teaches). It shows under the reward in the celebration and in its detail sheet.
- **Tablets and computers:** on a tablet held upright the app looks like the phone, scaled up. On a tablet held sideways or a computer, the lamb, its name and the week sit on the left half and everything else on the right half, which scrolls on its own; the wardrobe and pasture open over the right half.
- **Sound and touch:** gentle sounds made live in the app (wooden taps, a shepherd's pipe, sheep bells, chimes; no sound files) and vibrations, both on by default and switchable in *Settings › Sound and touch*. Sounds follow the iPhone silent switch. Android phones vibrate in patterns; iPhones (iOS 18+) get light ticks. A quiet meadow of wind and birds plays while the pasture is open.
- **Wardrobe and pasture** take over the space under the lamb while you dress or decorate.
- **The pasture.** The tree icon opens your own pasture: sky, fence, gate, trees, water and animals, unlocked as you keep reading.
- **Rewards:** 158 in all (155 things to earn, plus a "Nothing" choice in Head, Neck and Body). Every one of the 66 books has its own reward (Exodus gives two: the pillars of cloud and of fire). Others come from reading days, streaks, chapters, verses learned, encouraging others, and reading on Christmas Day, Maundy Thursday, Good Friday or Easter Sunday. Each grid keeps one fixed easiest-to-hardest order. Locked rewards show their real picture, dimmed, with a padlock and a short line such as "Complete Genesis"; tapping one shows the progress so far. Once earned, a reward is recorded (`owned` in the person's record) and kept for good.
- **The sky** has four kinds (sunny, night, cloudy, rainy) and each person picks the sky they like for each. With *Match my weather* on, the app asks first, then uses the phone's location (rounded to about 10 km, never saved or shared) to look up the weather at open-meteo.com. It's night after sunset; rain, drizzle and thunder count as rainy; cloud, fog and snow count as cloudy. The last result is kept on the phone, so it still works offline; without it, the sky follows the clock.
- **The 3D meadow pauses** whenever it's scrolled out of view or the app is in the background, to save battery.

## Looking after it

- **Where things are:** `flocks/{flockId}` holds each flock (with `members`, `groups` (folds, each with its fold-only `reflections`), `reflections` (whole-flock), `questions`, `cheers` (hearts), `notes`, `replies`, `rhearts`, `config/plan` inside), `codes/{CODE}` points a code to its flock, `users/{uid}` (with `journal`) holds each person's lamb, `directory/{uid}` a short card for the super admin, `admins/{uid}` the super admin, `blacklist/{uid}` blacklisted people, `adminlog` the admin's record, `announcements` the admin's news, and `usage/{day}` the daily usage count.
- **Someone has a new phone:** they open the app's address, tap *Already joined? Sign in with Google*, and choose the same Google account.
- **Someone used the wrong Google account:** they sign out (*Settings › Your account*) and sign in with the right one. Each Google account has its own lamb.

## Cost

The free Spark plan allows 50,000 database reads and 20,000 writes a day. A few flocks of up to 70 people opening the app a few times a day stay well inside it.

