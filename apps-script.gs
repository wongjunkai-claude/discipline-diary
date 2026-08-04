/**
 * Discipline Diary — Google Sheets logger
 *
 * Writes to three tabs — "Discipline Log", "Suspension Log", "Parent
 * Meeting Log" — each with columns matching that log's actual fields.
 * Each record is one row (an "upsert"): sending an update for an entry
 * that's already on the sheet finds it by ID and overwrites that row,
 * rather than adding a new row every time. Follow-ups on a discipline
 * entry accumulate into a single cell, one per line, each stamped with
 * its own date/time.
 *
 * SETUP:
 * 1. Create a new Google Sheet (sheets.new)
 * 2. In the sheet: Extensions > Apps Script
 * 3. Delete any starter code and paste in this whole file
 * 4. Click "Deploy" > "New deployment"
 *    - Click the gear icon next to "Select type" > Web app
 *    - Description: anything (e.g. "Discipline Diary logger")
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Click Deploy, authorize when prompted (it's your own script, this is expected)
 * 6. Copy the "Web app URL" it gives you — paste it into SHEET_WEBHOOK_URL
 *    near the top of app.js in the Discipline Diary project
 *
 * If you already had the old single-"Log"-tab version running, this
 * creates the three new tabs alongside it — your old "Log" tab is left
 * untouched, and you can delete it manually once you've confirmed the
 * new tabs are working.
 */

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
  ParentMeeting: {
    tabName: "Parent Meeting Log",
    headers: ["Timestamp", "ID", "Student Name", "Class", "Attendees", "Date", "Reason", "Logged By"],
    buildRow: function (data, ts) {
      return [ts, data.id || "", data.studentName || "", data.studentClass || "", data.attendeesText || "",
        data.date || "", data.reason || "", data.loggedBy || ""];
    },
  },
};

function doPost(e) {
  var data = {};
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    data = {};
  }

  var config = SHEET_CONFIG[data.recordType];
  if (!config) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unknown recordType" })).setMimeType(ContentService.MimeType.JSON);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(config.tabName);
  if (!sheet) {
    sheet = ss.insertSheet(config.tabName);
    sheet.appendRow(config.headers);
    sheet.setFrozenRows(1);
  }

  var row = config.buildRow(data, new Date());
  var existingRow = data.id ? findRowById(sheet, data.id) : -1;

  if (existingRow > 0) {
    sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

// ID always lives in column B (index 2) across all three tab layouts above.
function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // +2: 1-indexed, plus header row
  }
  return -1;
}
