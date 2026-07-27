/**
 * Discipline Diary — Google Sheets logger
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
 */

function doPost(e) {
  var sheetName = "Log";
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["Timestamp", "Record Type", "Action", "Student", "Details", "Logged By"]);
    sheet.setFrozenRows(1);
  }

  var data = {};
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    data = {};
  }

  sheet.appendRow([
    new Date(),
    data.recordType || "",
    data.action || "",
    data.studentName || "",
    data.details || "",
    data.loggedBy || "",
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
