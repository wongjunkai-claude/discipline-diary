/**
 * Discipline Diary — Google Sheets logger
 *
 * Writes to four tabs — "Discipline Log", "Suspension Log", "Time Out
 * Log", "Parent Meeting Log" — each with columns matching that log's
 * actual fields. A tab is created automatically the first time a record
 * of that type arrives.
 * Each record is one row (an "upsert"): sending an update for an entry
 * that's already on the sheet finds it by ID and overwrites that row,
 * rather than adding a new row every time. Follow-ups on a discipline
 * entry accumulate into a single cell, one per line, each stamped with
 * its own date/time.
 *
 * SECURITY
 * - The web-app URL is visible in the app's public code, so every post
 *   must carry the signed-in teacher's Firebase ID token. It's checked with
 *   Google (against this project's API key below) and only verified
 *   @moe.edu.sg accounts are accepted. Anything else is rejected and noted
 *   on a "Sync Errors" tab (last 200 attempts, no record data kept).
 * - Text that starts with = + - @ is stored as plain text, never run as a
 *   spreadsheet formula.
 * - A lock stops two saves arriving together from creating duplicate rows.
 *
 * FIRST-TIME SETUP:
 * 1. Create a new Google Sheet (sheets.new)
 * 2. In the sheet: Extensions > Apps Script
 * 3. Delete any starter code and paste in this whole file
 * 4. Click "Deploy" > "New deployment"
 *    - Click the gear icon next to "Select type" > Web app
 *    - Description: anything (e.g. "Discipline Diary logger")
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize when prompted (it's your own script, this is
 *    expected — it now also asks to "connect to an external service",
 *    which is the sign-in check with Google)
 * 6. Copy the "Web app URL" it gives you — paste it into SHEET_WEBHOOK_URL
 *    near the top of app.js in the Discipline Diary project
 *
 * UPDATING AN EXISTING DEPLOYMENT (keeps the same URL):
 * 1. Paste this whole file over the old code and Save
 * 2. Deploy > Manage deployments > pencil (Edit) icon
 * 3. Version: "New version" > Deploy, and authorize if asked
 * (Using "New deployment" instead would give a NEW URL, which app.js
 * would then need.)
 *
 * If syncing ever stops, open the "Sync Errors" tab — each row says why a
 * post was turned away.
 */

// This Firebase project's Web API key (same value as apiKey in app.js).
// Kept here, not taken from the incoming post, so a token from any other
// Firebase project can never pass the check.
var FIREBASE_API_KEY = "AIzaSyDbVoepZjtkLhyLV2yaMwN0G8lTjYkIQQ8";
var ALLOWED_EMAIL_DOMAIN = "@moe.edu.sg";
var ERROR_TAB = "Sync Errors";
var ERROR_TAB_MAX_ROWS = 200;
var MAX_CELL_CHARS = 45000; // Sheets' hard limit is 50,000 per cell

var SHEET_CONFIG = {
  Incident: {
    tabName: "Discipline Log",
    headers: ["Timestamp", "ID", "Student Name", "Class", "Date", "Issue", "Action Taken", "Status", "Follow-ups", "Logged By"],
    buildRow: function (data, ts) {
      return [ts, data.id || "", data.studentName || "", data.studentClass || "", data.date || "",
        data.issue || "", data.actionTaken || "", data.status || "", data.followUpsText || "", data.loggedBy || ""];
    },
  },
  Suspension: {
    tabName: "Suspension Log",
    headers: ["Timestamp", "ID", "Student Name", "Class", "Reason", "Start Date", "Total Days", "In-School Days", "Out-of-School Days", "Day-by-Day Schedule", "Logged By"],
    buildRow: function (data, ts) {
      return [ts, data.id || "", data.studentName || "", data.studentClass || "", data.reason || "",
        data.startDate || "", data.totalDays || "", data.issDays || "", data.ossDays || "", data.scheduleText || "", data.loggedBy || ""];
    },
  },
  TimeOut: {
    tabName: "Time Out Log",
    headers: ["Timestamp", "ID", "Student Name", "Class", "Type", "Reason", "Start Date", "Total Days", "In-School Days", "Out-of-School Days", "Day-by-Day Schedule", "Logged By"],
    buildRow: function (data, ts) {
      return [ts, data.id || "", data.studentName || "", data.studentClass || "", data.toType || "", data.reason || "",
        data.startDate || "", data.totalDays || "", data.issDays || "", data.ossDays || "", data.scheduleText || "", data.loggedBy || ""];
    },
  },
  ParentMeeting: {
    tabName: "Parent Meeting Log",
    headers: ["Timestamp", "ID", "Student Name", "Class", "Attendees", "Date", "Reason", "Logged By"],
    buildRow: function (data, ts) {
      return [ts, data.id || "", data.studentName || "", data.studentClass || "", data.attendeesText || "",
        data.date || "", data.reason || "", data.loggedBy || ""];
    },
  },
};

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var data = {};
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    data = {};
  }

  var config = SHEET_CONFIG[data.recordType];
  if (!config) return reject("unknown record type", data);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(data.id || ""))) return reject("missing or invalid record ID", data);

  var check = verifyIdToken(data.idToken, data.origin);
  if (!check.ok) return reject(check.reason, data);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (err) {
    return reject("sheet busy — lock timeout", data);
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(config.tabName);
    if (!sheet) {
      sheet = ss.insertSheet(config.tabName);
      sheet.appendRow(config.headers);
      sheet.setFrozenRows(1);
    }
    var row = config.buildRow(data, new Date()).map(safeCell);
    var existingRow = findRowById(sheet, data.id);
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  } finally {
    lock.releaseLock();
  }
  return jsonOut({ ok: true });
}

// Stores text exactly as typed: anything that a spreadsheet would treat as a
// formula (leading = + - @, or a tab/carriage return) gets a leading
// apostrophe, which Sheets hides and uses to mean "plain text".
function safeCell(v) {
  if (typeof v !== "string") return v;
  if (v.length > MAX_CELL_CHARS) v = v.slice(0, MAX_CELL_CHARS) + "…";
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}

// Confirms the Firebase ID token with Google and checks it belongs to a
// verified school account. Successful checks are cached for 50 minutes
// (tokens last an hour) so each save doesn't need a fresh lookup.
function verifyIdToken(idToken, origin) {
  if (!idToken || typeof idToken !== "string" || idToken.length > 4096) return { ok: false, reason: "not signed in (no token)" };
  var cache = CacheService.getScriptCache();
  var cacheKey = "tok_" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  if (cache.get(cacheKey)) return { ok: true };

  var url = "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(FIREBASE_API_KEY);
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  };
  // If the API key is restricted to the app's website, Google expects the
  // request to come "from" that site.
  if (typeof origin === "string" && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) {
    options.headers = { Referer: origin + "/" };
  }
  var res;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (err) {
    // Retry once without the custom header in case it's the cause.
    try {
      delete options.headers;
      res = UrlFetchApp.fetch(url, options);
    } catch (err2) {
      return { ok: false, reason: "could not reach Google to check sign-in: " + err2 };
    }
  }
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (err) { body = {}; }
  if (res.getResponseCode() !== 200) {
    var msg = (body.error && body.error.message) || ("HTTP " + res.getResponseCode());
    return { ok: false, reason: "sign-in check failed: " + msg };
  }
  var user = body.users && body.users[0];
  var email = String((user && user.email) || "").toLowerCase();
  if (!user || !email) return { ok: false, reason: "sign-in check returned no account" };
  if (email.slice(-ALLOWED_EMAIL_DOMAIN.length) !== ALLOWED_EMAIL_DOMAIN) return { ok: false, reason: "account is not " + ALLOWED_EMAIL_DOMAIN };
  if (user.emailVerified !== true) return { ok: false, reason: "email not verified" };
  cache.put(cacheKey, "1", 3000);
  return { ok: true };
}

// Notes a rejected post on the "Sync Errors" tab (time, record type, reason
// — never the record's contents), keeping only the latest rows.
function reject(reason, data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ERROR_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(ERROR_TAB);
      sheet.appendRow(["Time", "Record Type", "Reason"]);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), safeCell(String((data && data.recordType) || "").slice(0, 40)), safeCell(String(reason).slice(0, 500))]);
    var extra = sheet.getLastRow() - 1 - ERROR_TAB_MAX_ROWS;
    if (extra > 0) sheet.deleteRows(2, extra);
  } catch (err) {
    // never let error logging break the response
  }
  return jsonOut({ ok: false, error: reason });
}

// ID always lives in column B (index 2) across all four tab layouts above.
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // +2: 1-indexed, plus header row
  }
  return -1;
}
