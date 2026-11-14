/**
 * GLIMPSES — link for the Glimpses Editor (Tools/Editor/index.html on your computer).
 *
 * Lives in its own file (EditorApi.gs) next to Code.gs, so replacing Code.gs never removes it.
 * Set up once: Deploy → New deployment → type "Web app" → Execute as: Me, Who has access: Anyone → Deploy.
 * Then Glimpses menu → "Editor link and key" shows the two things to paste into the editor.
 * Only someone with both the link and the key can read or change the sheet through it.
 *
 * GET  ?key=K                      → every content tab (headers + rows as shown) and the dropdown choices
 * POST {key, edits:[{tab, row, match:{column, value}, values:{header: text}, status}]}
 *      row 0 = a new row at the bottom. match makes sure row still holds the same thing (rows move if someone
 *      sorts or inserts in the sheet); if it doesn't, the row is looked up by match instead.
 *      Saving sets the row's Status to "Update" (Idea and Delete rows keep theirs) unless status is given.
 */

var EDITOR_TABS = ['Memories', 'Glimpses', 'Encounters', 'Keywords', 'Runes', 'Abilities'];

function editorKey_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('EDITOR_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    props.setProperty('EDITOR_KEY', key);
  }
  return key;
}

/** Run this from the script editor to see the key in the Execution log. */
function logEditorKey() { Logger.log('Editor key: ' + editorKey_()); }

/** Glimpses menu → Editor link and key. */
function showEditorLink() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (err) { url = ''; }
  var html = HtmlService.createHtmlOutput(
    '<div style="font:14px Arial;line-height:1.5">' +
    '<b>Link</b> (Deploy → Manage deployments → the web app\'s URL, ending in /exec):<br>' +
    '<input style="width:100%" readonly onclick="this.select()" value="' + url + '"><br><br>' +
    '<b>Key</b>:<br><input style="width:100%;font-size:18px" readonly onclick="this.select()" value="' + editorKey_() + '">' +
    '<p style="color:#666">Paste both into the Glimpses Editor (the ⚙ button). Keep the key to yourself: with it and the ' +
    'link anyone could change this sheet.</p></div>').setWidth(460).setHeight(260);
  SpreadsheetApp.getUi().showModalDialog(html, 'Glimpses Editor link');
}

/** Glimpses menu → Change the editor key (the old one stops working). */
function resetEditorKey() {
  PropertiesService.getScriptProperties().deleteProperty('EDITOR_KEY');
  showEditorLink();
}

function editorOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function editorTab_(sheet) {
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { headers: [], rows: [] };
  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue;          // blank rows between groups
    rows.push({ row: i + 1, cells: values[i] });
  }
  return { headers: values[0], rows: rows };
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (String(p.key || '') !== editorKey_()) return editorOut_({ ok: false, error: 'That key is wrong. Glimpses menu → Editor link and key shows the right one.' });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = {};
  EDITOR_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) tabs[name] = editorTab_(sh);
  });
  // the dropdown choices the sheet itself uses (Lists tab: C = keywords, D = runes)
  var lists = { keywords: [], runes: [] };
  var ls = ss.getSheetByName('Lists');
  if (ls && ls.getLastRow() > 1) {
    ls.getRange(2, 3, ls.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      if (r[0]) lists.keywords.push(r[0]);
      if (r[1]) lists.runes.push(r[1]);
    });
  }
  return editorOut_({ ok: true, tabs: tabs, lists: lists, sheet: ss.getName(), at: new Date().toISOString() });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return editorOut_({ ok: false, error: 'Could not read what the editor sent.' }); }
  if (String(body.key || '') !== editorKey_()) return editorOut_({ ok: false, error: 'That key is wrong.' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var results = [];
    (body.edits || []).forEach(function (edit) {
      try { results.push(editorApply_(ss, edit)); }
      catch (err) { results.push({ ok: false, tab: edit.tab, row: edit.row, ref: edit.ref, error: String(err.message || err) }); }
    });
    SpreadsheetApp.flush();
    return editorOut_({ ok: true, results: results });
  } finally {
    lock.releaseLock();
  }
}

function editorApply_(ss, edit) {
  if (EDITOR_TABS.indexOf(edit.tab) < 0) throw new Error('The editor can only change ' + EDITOR_TABS.join(', ') + '.');
  var sh = ss.getSheetByName(edit.tab);
  if (!sh) throw new Error('There is no ' + edit.tab + ' tab.');
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var col = {};
  headers.forEach(function (h, i) { if (h !== '' && !(h in col)) col[h] = i + 1; });

  var row = Number(edit.row) || 0;
  var m = edit.match;
  if (row > 0 && m && m.column && col[m.column]) {
    var here = String(sh.getRange(row, col[m.column]).getDisplayValue()).trim();
    if (here !== String(m.value).trim()) {
      // the row moved: find it again
      row = 0;
      var colValues = sh.getRange(1, col[m.column], sh.getLastRow(), 1).getDisplayValues();
      for (var i = 1; i < colValues.length; i++)
        if (String(colValues[i][0]).trim() === String(m.value).trim()) { row = i + 1; break; }
      if (!row) throw new Error('Couldn\'t find "' + m.value + '" on ' + edit.tab + ' any more (renamed or deleted in the sheet?). Reload and try again.');
    }
  }
  var isNew = row === 0;
  if (isNew) row = sh.getLastRow() + 1;

  var values = edit.values || {};
  var added = false;
  Object.keys(values).forEach(function (h) {
    if (col[h]) return;
    // a column the editor needs that the tab doesn't have yet ("Rune 3", "Ability Tile 3", "requirements", "info line"...)
    if (String(values[h] == null ? '' : values[h]) === '') return;
    if (!/^[\w &()'-]{1,40}$/.test(h)) throw new Error('The ' + edit.tab + ' tab has no "' + h + '" column.');
    col[h] = editorAddColumn_(sh, h);
    added = true;
    headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    col = {};
    headers.forEach(function (x, i) { if (x !== '' && !(x in col)) col[x] = i + 1; });
  });
  Object.keys(values).forEach(function (h) {
    if (!col[h]) return;   // (blank, for a column that isn't there: nothing to write)
    var v = values[h] == null ? '' : String(values[h]);
    var cell = sh.getRange(row, col[h]);
    // keep text as text (so "1-4" or "007" aren't turned into dates or numbers), numbers as numbers
    if (/^-?\d+(\.\d+)?$/.test(v)) cell.setValue(Number(v));
    else { if (/^\d+\s*[-\/]\s*\d+$/.test(v)) cell.setNumberFormat('@'); cell.setValue(v); }
  });

  if (col['status']) {
    var st = sh.getRange(row, col['status']);
    var current = String(st.getValue());
    if (edit.status) st.setValue(edit.status);
    else if (isNew) st.setValue('Update');
    else if (current !== 'Idea' && current !== 'Delete') st.setValue('Update');
  }
  lastCol = sh.getLastColumn();
  return { ok: true, tab: edit.tab, ref: edit.ref, row: row, cells: sh.getRange(row, 1, 1, lastCol).getDisplayValues()[0],
           headers: added ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : null };
}

/** Adds a column: "Rune 3" goes after the last Rune column (with its dropdown), "Ability Tile 3" after the last
 *  Ability Tile; anything else at the end. Returns its column number. */
function editorAddColumn_(sh, header) {
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var m = header.match(/^(.*?)\s+\d+$/);
  var after = lastCol;
  if (m) {
    var stem = m[1].toLowerCase();
    for (var i = headers.length - 1; i >= 0; i--) {
      var hm = String(headers[i]).match(/^(.*?)\s+\d+$/);
      if (hm && hm[1].toLowerCase() === stem) { after = i + 1; break; }
    }
  }
  sh.insertColumnAfter(after);
  var at = after + 1;
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  // look like its neighbour: header style, width, and (for Rune columns) the rune dropdown
  sh.getRange(1, after).copyTo(sh.getRange(1, at), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sh.setColumnWidth(at, sh.getColumnWidth(after));
  if (m && after !== lastCol) {
    var rules = sh.getRange(2, after, rows, 1).getDataValidations();
    sh.getRange(2, at, rows, 1).setDataValidations(rules);
  }
  sh.getRange(1, at).setValue(header);
  return at;
}
