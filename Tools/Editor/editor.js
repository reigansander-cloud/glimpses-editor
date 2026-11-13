// Glimpses Editor: browse and edit the Glimpses Database sheet's content tabs, with a live preview drawn the way the game
// draws it. Talks to the sheet through EditorApi.gs (a web app in the sheet's script). Unsaved changes stay in this
// browser until saved, so closing the page loses nothing.
'use strict';
const R = window.Render;
const { el, esc, img } = R;

const STORE = 'glimpsesEditor.v1';
const STATUSES = ['Good', 'Update', 'Idea', 'Delete'];
const STATUS_COLOR = { Good: '#c9ebc4', Update: '#ffe29a', Delete: '#f5b5ae', Idea: '#dcd3f5' };
const GLIMPSE_COLORS = ['red', 'gold', 'brown', 'purple', 'green', 'sand', 'orange', 'blue'];

const TABS = {
  Memories: { title: 'name', sub: null, match: 'name', newValues: { name: 'New Memory' }, label: 'Memories' },
  Glimpses: { title: 'title', sub: 'id', match: 'id', newValues: { title: 'New Glimpse', kind: 'effects', status: 'Idea' }, label: 'Glimpses' },
  Encounters: { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Encounter' }, label: 'Encounters' },
  Keywords: { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Keyword' }, label: 'Keywords' },
  Runes: { title: 'name', sub: 'id', match: 'name', newValues: { name: 'New Rune' }, label: 'Runes' },
};

// ----- state ---------------------------------------------------------------------------------------------

const S = {
  url: '', key: '', data: null, loadedAt: '', fromCache: false,
  tab: 'Memories', sel: {}, drafts: {}, seq: 1, filter: '', status: 'all', busy: false, auto: true,
};

function loadStore() {
  const built = window.SHEET_LINK || {};
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || '{}');
    const mine = /\/exec\/?$/.test(o.url || '') && o.key;   // one you linked yourself with ⚙
    Object.assign(S, { url: mine ? o.url : built.url || '', key: mine ? o.key : built.key || '', drafts: o.drafts || {}, seq: o.seq || 1, tab: TABS[o.tab] ? o.tab : 'Memories', sel: o.sel || {} });
    if (o.cache) { S.data = o.cache; S.loadedAt = o.loadedAt || ''; S.fromCache = true; }
  } catch (e) { Object.assign(S, { url: built.url || '', key: built.key || '' }); /* private window or blocked storage: start fresh */ }
}
let _saveTimer = 0;
function saveStore(now) {
  clearTimeout(_saveTimer);
  const write = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify({ url: S.url, key: S.key, drafts: S.drafts, seq: S.seq, tab: S.tab, sel: S.sel, cache: S.data, loadedAt: S.loadedAt }));
    } catch (e) { /* storage full or blocked: unsaved edits just won't survive a reload */ }
  };
  if (now) write(); else _saveTimer = setTimeout(write, 250);
}

// ----- sheet rows ----------------------------------------------------------------------------------------

const tabData = tab => (S.data && S.data.tabs && S.data.tabs[tab]) || { headers: [], rows: [] };
/** The real header for a column name ("offered weight" finds "offered weight (1 if empty)"). */
function H(tab, key) {
  const hs = tabData(tab).headers, k = key.toLowerCase();
  return hs.find(h => h.trim().toLowerCase() === k) || hs.find(h => h.trim().toLowerCase().startsWith(k)) || null;
}
function rowObj(tab, cells) {
  const o = {};
  tabData(tab).headers.forEach((h, i) => { if (h !== '' && !(h in o)) o[h] = cells[i] ?? ''; });
  return o;
}
/** Everything on a tab: sheet rows (with any unsaved changes) and new ones not saved yet. */
function records(tab) {
  const out = [];
  for (const ref of Object.keys(S.drafts)) if (S.drafts[ref].tab === tab && S.drafts[ref].isNew) out.push(record(ref));
  for (const r of tabData(tab).rows) out.push(record(`${tab}:${r.row}`));
  return out.filter(Boolean);
}
const ALIAS = {};   // a new row's old ref → its row in the sheet once saved
const real = ref => { while (ALIAS[ref]) ref = ALIAS[ref]; return ref; };
function record(ref) {
  ref = real(ref);
  const d = S.drafts[ref];
  if (d) return { ref, tab: d.tab, row: d.row, isNew: !!d.isNew, orig: d.orig, cur: d.cur };
  const [tab, rowS] = ref.split(':');
  const r = tabData(tab).rows.find(x => String(x.row) === rowS);
  if (!r) return null;
  const o = rowObj(tab, r.cells);
  return { ref, tab, row: r.row, isNew: false, orig: o, cur: o };
}
const val = (rec, key) => { const h = H(rec.tab, key); return h ? String(rec.cur[h] ?? '') : ''; };
const origVal = (rec, key) => { const h = H(rec.tab, key); return h ? String(rec.orig[h] ?? '') : ''; };
function changedHeaders(rec) {
  if (!rec) return [];
  return Object.keys(rec.cur).filter(h => String(rec.cur[h] ?? '') !== String(rec.orig[h] ?? ''));
}
const isDirty = rec => rec && (rec.isNew || changedHeaders(rec).length > 0);
function dirtyRefs(tab) { return Object.keys(S.drafts).filter(ref => (!tab || S.drafts[ref].tab === tab) && isDirty(record(ref))); }

function setVal(ref, key, value) {
  ref = real(ref);
  const rec = record(ref);
  if (!rec) return;
  const h = H(rec.tab, key);
  if (!h) return;
  if (!S.drafts[ref]) S.drafts[ref] = { tab: rec.tab, row: rec.row, isNew: false, orig: { ...rec.orig }, cur: { ...rec.orig } };
  S.drafts[ref].cur[h] = value;
  if (!S.drafts[ref].isNew && changedHeaders(record(ref)).length === 0) delete S.drafts[ref];
  saveStore();
  afterChange(ref, key);
  scheduleAutoSave();
}

// ----- the game's words (keywords, runes) --------------------------------------------------------------

function keywordRows() {
  return records('Keywords').filter(r => val(r, 'status') !== 'Delete' && (val(r, 'id') || val(r, 'name'))).map(r => ({
    id: val(r, 'id').trim(), name: val(r, 'name').trim(), symbol: val(r, 'symbol').trim(), text: val(r, 'description'), trigger: val(r, 'trigger').trim(),
  }));
}
function runeRows() {
  return records('Runes').filter(r => val(r, 'status') !== 'Delete' && val(r, 'name')).map(r => ({
    id: val(r, 'id').trim(), name: val(r, 'name').trim(), symbol: val(r, 'symbol').trim(), text: val(r, 'description'),
  }));
}
const plain = s => String(s || '').replace(/^[^A-Za-z0-9]+/, '').split(':')[0].trim();
const squash = s => String(s || '').toLowerCase().replace(/agression/g, 'aggression').replace(/\s+/g, '');
function findRune(label) {
  const name = plain(label);
  if (!name) return null;
  return runeRows().find(r => squash(r.name) === squash(name)) || runeRows().find(r => squash(r.id) === squash(name)) || null;
}
function stirWord(name) {
  let w = String(name).toLowerCase().replace(/^stir/, '').trim();
  if (w.startsWith('ag')) w = 'aggression';
  return w;
}
function runeIcon(rune) {
  if (!rune) return 'ico_doom.png';
  if (rune.symbol.toLowerCase() === 'param') { const f = R.iconFile(stirWord(rune.name)); return R.has(f) ? f : 'ico_doom.png'; }
  return R.glyphFile(rune.symbol || 'doom');
}
const keywordIcon = k => {
  if (!k) return null;
  const id = k.id.toLowerCase();
  if (id === 'at_least' || id === 'bar' || id === 'action' || id === 'active' || id === 'passive') return null;
  if (id === 'allign' || id === 'align') return 'align_kw.png';
  return k.symbol ? R.glyphFile(k.symbol) : null;
};
/** What a keyword is written as at the start of an ability tile. */
function keywordPrefix(k) {
  const id = k.id.toLowerCase();
  if (id === 'scatter_ends_here') return 'Land';
  if (id === 'allign' || id === 'align') return 'Align';
  if (id === 'action' || id === 'active') return 'Action';
  return k.name;
}

/** Reads an ability tile the way the game's importer does. */
function parseTile(text) {
  text = String(text || '').trim();
  const kws = keywordRows();
  const out = { kind: 'none', kw: null, n: '', stat: 'Vanity', body: text, prefix: '', text };
  if (!text) return out;
  let m = text.match(/^\s*(\w+) Bar (\d+)\s*:?\s*([\s\S]*)$/i);
  if (m) return Object.assign(out, { kind: 'bar', kw: kws.find(k => k.id.toLowerCase() === 'bar') || null, stat: m[1], n: m[2], body: m[3].trim() });
  m = text.match(/^\s*(\d+)\+\s*:?\s*([\s\S]*)$/);
  if (m) return Object.assign(out, { kind: 'at_least', kw: kws.find(k => k.id.toLowerCase() === 'at_least') || null, n: m[1], body: m[2].trim() });
  m = text.match(/^\s*([A-Za-z ]+?)\s*:\s*([\s\S]*)$/);
  if (m) {
    const head = m[1].trim().toLowerCase();
    if (head === 'action' || head === 'active') return Object.assign(out, { kind: 'action', body: m[2].trim(), prefix: m[1].trim() });
    if (head === 'passive') return Object.assign(out, { kind: 'passive', body: m[2].trim(), prefix: m[1].trim() });
    const alias = head === 'land' || head === 'lands' ? 'scatter_ends_here' : head === 'align' || head === 'allign' ? 'allign' : null;
    const k = kws.find(k => alias ? k.id.toLowerCase() === alias : k.name.toLowerCase() === head);
    if (k) return Object.assign(out, { kind: 'kw', kw: k, body: m[2].trim(), prefix: m[1].trim() });
  }
  for (const k of [...kws].sort((a, b) => b.name.length - a.name.length)) {
    const id = k.id.toLowerCase();
    if (['active', 'action', 'passive', 'at_least', 'bar'].includes(id) || !k.name) continue;
    if (text.toLowerCase().startsWith(k.name.toLowerCase()) && (text.length === k.name.length || !/[A-Za-z]/.test(text[k.name.length])))
      return Object.assign(out, { kind: 'kw', kw: k, body: text.slice(k.name.length).replace(/^[:\s]+/, '').trim(), prefix: k.name });
  }
  out.unknownHead = m ? m[1].trim() : '';
  return out;
}
function composeTile(p) {
  const body = String(p.body || '').trim();
  switch (p.kind) {
    case 'none': return body;
    case 'action': return `${p.prefix || 'Action'}: ${body}`;
    case 'passive': return `Passive: ${body}`;
    case 'at_least': return `${p.n || 0}+: ${body}`;
    case 'bar': return `${p.stat || 'Vanity'} Bar ${p.n || 0}: ${body}`;
    default: return p.kw ? `${p.prefix && p.prefixFor === p.kw.id ? p.prefix : keywordPrefix(p.kw)}: ${body}` : body;
  }
}
/** An ability tile as the card shows it. */
function tileView(text) {
  const p = parseTile(text);
  if (!p.text) return null;
  if (p.kind === 'bar') return { text: p.body, icon: null, manual: false, bar: { stat: p.stat, need: Number(p.n) || 0 }, parsed: p };
  if (p.kind === 'at_least') return { text: p.text, icon: null, manual: false, parsed: p };
  if (p.kind === 'action') return { text: p.body, icon: null, manual: true, parsed: p };
  if (p.kind === 'passive') return { text: p.body, icon: null, manual: false, parsed: p };
  if (p.kind === 'kw') return { text: p.body, icon: keywordIcon(p.kw), manual: false, parsed: p };
  return { text: p.text, icon: null, manual: false, parsed: p };
}

// ----- turning a row into what the preview draws -----------------------------------------------------

function memoryModel(rec) {
  const name = val(rec, 'name');
  const id = R.AD.memoryIds[name.trim().toLowerCase()] || '';
  const attributes = {};
  for (const a of ['charm', 'grit', 'insight', 'guile']) attributes[a] = Number(val(rec, a)) || 0;
  const runes = [];
  for (const c of ['rune 1', 'rune 2', 'rune 3']) {
    const v = val(rec, c);
    if (!v.trim()) continue;
    const r = findRune(v);
    runes.push({ icon: runeIcon(r), title: r ? r.name : plain(v), text: r ? r.text : "(not on the Runes tab)", missing: !r });
  }
  const tiles = [];
  for (const c of ['ability tile 1', 'ability tile 2', 'ability tile 3']) { const t = tileView(val(rec, c)); if (t) tiles.push(t); }
  const diceRaw = val(rec, 'dice').trim();
  let dice = 0;
  for (const d of diceRaw.split(/[,; ]+/).filter(Boolean)) dice += /^d/i.test(d) ? 1 : Math.min(6, Number(d) || 0);
  const align = tiles.some(t => t.parsed.kw && /^all?ign$/i.test(t.parsed.kw.id));
  return { id, name, attributes, runes, tiles, dice, pattern: align ? ['this', '1', 'eq', '2'] : null };
}

function glimpseModel(rec) {
  const kind = val(rec, 'kind').toLowerCase() || 'effects';
  const picks = /^(y|yes|true|1)$/i.test(val(rec, 'player picks a memory').trim());
  const text = val(rec, 'text');
  let color = val(rec, 'colour').trim().toLowerCase();
  if (!GLIMPSE_COLORS.includes(color))
    color = kind === 'encounter' ? 'red' : kind === 'memory' ? 'purple' : picks ? 'orange' : /check/i.test(val(rec, 'effects')) ? 'blue'
      : /heal/i.test(text) ? 'green' : val(rec, 'cost').trim() ? 'gold' : 'sand';
  const label = kind === 'encounter' ? 'FIGHT' : kind === 'memory' ? 'NEW MEMORY' : picks ? 'TAMPER' : 'EVENT';
  const hint = kind === 'memory' ? 'Hover to see it, right-click to look closely. Drag it into a gap in the ring, or click then pick a gap.'
    : picks ? 'Drag it onto a memory, or click then pick one.' : 'Click to choose.';
  return { color, kind: label, title: val(rec, 'title'), text: kind === 'memory' ? '' : text, hint };
}

/** "Hollow Pilgrim: 12 aggression; Lantern Moth (each): 6 aggression" → the part for one enemy. */
function partFor(text, name, single) {
  text = String(text || '').trim();
  if (!text) return '';
  const parts = text.split(/;\s*/);
  for (const p of parts) {
    const m = p.match(/^\s*([^:]+?)(?:\s*\(each\))?\s*:\s*([\s\S]*)$/);
    if (m && m[1].trim().toLowerCase() === name.toLowerCase()) return m[2].trim();
  }
  return single || parts.length === 1 ? text.replace(/^[^:]+\(each\):\s*/, '') : '';
}
/** The first of these columns the tab has. */
const val2 = (rec, keys) => { for (const k of keys) if (H(rec.tab, k)) return val(rec, k); return ''; };
function encounterModel(rec) {
  if (H(rec.tab, 'intents')) return encounterModel2(rec);
  const comps = (val(rec, 'components') || val(rec, 'name')).split(/,\s*/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(\d+)\s*[×x]\s*(.+)$/i);
    return { count: m ? Number(m[1]) : 1, name: m ? m[2].trim() : s };
  });
  const single = comps.length <= 1;
  const mech = val(rec, 'mechanics');
  const sootheH = tabData('Encounters').headers.find(h => /soothe/i.test(h) && !/reward/i.test(h));
  const sootheRewardH = tabData('Encounters').headers.find(h => /soothe/i.test(h) && /reward/i.test(h));
  return comps.map(c => {
    const known = R.AD.enemies[c.name.toLowerCase()] || {};
    let line = '';
    for (const l of mech.split(/\n/)) { const m = l.match(/^\s*([^:]+?):\s*([\s\S]*)$/); if (m && m[1].toLowerCase() === c.name.toLowerCase()) line = m[2]; }
    if (!line && single) line = mech.replace(new RegExp('^\\s*' + c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*', 'i'), '');
    let intent = line, traits = '';
    const m = line.match(/^(?:At the end of each turn, in order:\s*)([\s\S]*?\))\.\s*([\s\S]*)$/i);
    if (m) { intent = m[1]; traits = m[2]; }
    const bar = (stat, verb, needText, rewardText) => {
      const t = partFor(needText, c.name, single);
      const n = (t.match(/(\d+)/) || [])[1];
      return { stat, verb, need: n ? Number(n) : 0, label: t && !n ? t : `can't be ${verb === 'Slay' ? 'slain' : verb === 'Sneak past' ? 'escaped' : 'soothed'}`, reward: partFor(rewardText, c.name, single) };
    };
    const bars = [bar('aggression', 'Slay', val(rec, 'to slay'), val(rec, 'slay reward')), bar('fading', 'Sneak past', val(rec, 'to escape'), val(rec, 'escape reward'))];
    if (sootheH) bars.push(bar('vanity', 'Soothe', rec.cur[sootheH], sootheRewardH ? rec.cur[sootheRewardH] : ''));
    return { name: c.name, count: c.count, art: known.art || '', flavor: known.flavor || '', intent, traits, bars, unknown: !known.id };
  });
}

// ----- sheet link ---------------------------------------------------------------------------------------

async function api(method, body) {
  if (!S.url || !S.key) throw new Error('Not linked to the sheet yet (⚙).');
  const res = method === 'GET'
    ? await fetch(S.url + (S.url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(S.key), { redirect: 'follow' })
    : await fetch(S.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ key: S.key }, body)) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(/<html|<!doctype/i.test(text) ? 'The sheet answered with a web page instead of data. Is the web app deployed with "Who has access: Anyone"?' : 'The sheet sent something unreadable.');
  }
  if (!json.ok) throw new Error(json.error || 'The sheet said no.');
  return json;
}

/** After a save or a background refresh: redraw everything except a form you're typing in. */
function refreshAfterSync() {
  renderTabs();
  const list = $('#list'), top = list.scrollTop;
  renderList();
  list.scrollTop = top;
  updateHud();
  const ref = currentRef();
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#form');
  if (ref !== _formRef || !typing) {
    const sc = $('#form').scrollTop;
    if (_formSig !== formSig(ref) || ref !== _formRef) { renderForm(); $('#form').scrollTop = sc; }
    renderPreview();
  } else {
    const where = document.querySelector('.where'), rec = record(ref);
    if (where && rec) where.innerHTML = `<b>${rec.tab}</b> tab, row ${rec.row}` + (isDirty(rec) ? ' · saving soon…' : ' · saved');
  }
}
/** What the form shows (to tell whether it needs drawing again). */
const formSig = ref => { const r = ref && record(ref); return r ? JSON.stringify([r.ref, r.cur, isDirty(r)]) : ''; };
let _formSig = '';

let _polling = false;
async function poll() {
  if (_polling || S.busy || document.hidden || !S.url || !S.key) return;
  _polling = true;
  try { await reload(true, true); } finally { _polling = false; }
}

async function reload(quiet, background) {
  if (!S.url || !S.key) { renderAll(); openSetup(); return; }
  if (!background) setConn('busy', 'Loading…');
  try {
    const data = await api('GET');
    S.data = { tabs: data.tabs, lists: data.lists || { keywords: [], runes: [] }, sheet: data.sheet };
    S.loadedAt = data.at || new Date().toISOString();
    S.fromCache = false;
    rebindDrafts();
    saveStore(true);
    if (quiet) refreshAfterSync(); else renderAll();
    if (!quiet) toast('Up to date with the sheet.');
  } catch (e) {
    setConn('bad', S.data ? 'Offline — showing the last copy' : 'Not linked');
    if (!background) toast(e.message, true);
  }
}

/** After reloading, rows may have moved in the sheet: find each unsaved change's row again. */
function rebindDrafts() {
  const moved = {};
  for (const [ref, d] of Object.entries(S.drafts)) {
    if (d.isNew) { moved[ref] = d; continue; }
    const key = TABS[d.tab].match, h = H(d.tab, key);
    const want = h ? String(d.orig[h] ?? '').trim() : '';
    let row = tabData(d.tab).rows.find(r => r.row === d.row);
    if (row && h && String(rowObj(d.tab, row.cells)[h] ?? '').trim() !== want) row = null;
    if (!row && h && want) row = tabData(d.tab).rows.find(r => String(rowObj(d.tab, r.cells)[h] ?? '').trim() === want);
    if (row) moved[`${d.tab}:${row.row}`] = Object.assign(d, { row: row.row });
    else moved[ref] = d;   // gone from the sheet: keep the change, it saves as a new row
  }
  S.drafts = moved;
  for (const t of Object.keys(S.sel)) if (S.sel[t] && !record(S.sel[t])) S.sel[t] = null;
}

let _autoTimer = 0;
function scheduleAutoSave() {
  if (!S.auto) return;
  clearTimeout(_autoTimer);
  _autoTimer = setTimeout(() => { if (S.busy) scheduleAutoSave(); else save(dirtyRefs(), true); }, 2000);
}

async function save(refs, auto) {
  refs = refs.filter(ref => isDirty(record(ref)));
  if (!refs.length) { if (!auto) toast('Nothing to save.'); return; }
  if (S.busy) { scheduleAutoSave(); return; }
  S.busy = true;
  setConn('busy', `Saving ${refs.length}…`);
  const edits = refs.map(ref => {
    const rec = record(ref), cfg = TABS[rec.tab], statusH = H(rec.tab, 'status');
    const values = {};
    for (const h of (rec.isNew ? Object.keys(rec.cur).filter(h => String(rec.cur[h] ?? '') !== '') : changedHeaders(rec)))
      if (h !== statusH) values[h] = rec.cur[h];
    const status = statusH && String(rec.cur[statusH] ?? '') !== String(rec.orig[statusH] ?? '') ? rec.cur[statusH] : (rec.isNew && statusH && rec.cur[statusH]) || '';
    let matchH = H(rec.tab, cfg.match);
    if (matchH && !String(rec.orig[matchH] ?? '').trim()) matchH = H(rec.tab, 'name') || H(rec.tab, 'title');
    return { ref, tab: rec.tab, row: rec.isNew ? 0 : rec.row, match: rec.isNew || !matchH ? null : { column: matchH, value: rec.orig[matchH] }, values, status, sent: { ...rec.cur } };
  });
  const sent = {};
  for (const e of edits) { sent[e.ref] = e.sent; delete e.sent; }
  try {
    const res = await api('POST', { edits });
    let ok = 0, moved = false;
    const failed = [];
    for (const r of res.results) {
      if (!r.ok) { failed.push(r.error); continue; }
      ok++;
      const d = S.drafts[r.ref], tab = r.tab, rows = tabData(tab).rows;
      const i = rows.findIndex(x => x.row === r.row);
      if (i >= 0) rows[i] = { row: r.row, cells: r.cells }; else rows.push({ row: r.row, cells: r.cells });
      rows.sort((a, b) => a.row - b.row);
      if (d && !d.isNew && d.row !== r.row) moved = true;   // it had moved in the sheet: reload to get every row's place right
      const newRef = `${tab}:${r.row}`;
      delete S.drafts[r.ref];
      if (newRef !== r.ref) ALIAS[r.ref] = newRef;
      if (S.sel[tab] === r.ref) S.sel[tab] = newRef;
      // typed more while it was saving: keep that as a change still to save
      if (d && sent[r.ref] && Object.keys(d.cur).some(h => String(d.cur[h] ?? '') !== String(sent[r.ref][h] ?? ''))) {
        const orig = rowObj(tab, r.cells);
        S.drafts[newRef] = { tab, row: r.row, isNew: false, orig, cur: { ...orig, ...Object.fromEntries(Object.keys(d.cur).filter(h => String(d.cur[h] ?? '') !== String(sent[r.ref][h] ?? '')).map(h => [h, d.cur[h]])) } };
        scheduleAutoSave();
      }
    }
    saveStore(true);
    refreshAfterSync();
    if (failed.length) toast(`Saved ${ok}. ${failed.length} didn't: ${failed[0]}`, true);
    else if (!auto) toast(`Saved ${ok} to the sheet (marked “Update”).`);
    if (moved) setTimeout(() => reload(true), 50);
  } catch (e) {
    setConn('bad', 'Save failed — will try again');
    toast(e.message + ' Your changes are kept and will be tried again.', true);
    clearTimeout(_autoTimer);
    if (S.auto) _autoTimer = setTimeout(() => save(dirtyRefs(), true), 15000);
  } finally {
    S.busy = false;
    if (!document.querySelector('#conn.bad')) setConn('ok', connText());
  }
}

// ----- page ---------------------------------------------------------------------------------------------

const $ = s => document.querySelector(s);
function setConn(kind, text) { const c = $('#conn'); c.className = kind; c.textContent = text; }
function connText() {
  if (!S.data) return 'Not linked';
  const t = S.loadedAt ? new Date(S.loadedAt) : null;
  const when = t ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return S.fromCache ? `Last copy (${when})` : `Live · checked ${when}`;
}
let _toastTimer = 0;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => (t.className = bad ? 'bad' : ''), bad ? 7000 : 2600);
}

function renderAll() {
  renderTabs();
  renderFilters();
  renderList();
  renderForm();
  renderPreview();
  updateHud();
}

function updateHud() {
  const n = dirtyRefs().length;
  const b = $('#saveAll');
  b.textContent = n ? (S.auto ? `Saving soon (${n})` : `Save all (${n})`) : 'All saved ✓';
  b.disabled = !n || !S.data;
  if (!S.busy) setConn(S.data ? (S.fromCache ? 'busy' : 'ok') : 'bad', connText());
  renderTabs();
}

function renderTabs() {
  const nav = $('#tabs');
  nav.innerHTML = '';
  for (const [tab, cfg] of Object.entries(TABS)) {
    const b = el('button', tab === S.tab ? 'on' : '');
    b.innerHTML = `${cfg.label} <span class="count">${S.data ? records(tab).length : ''}</span>` + (dirtyRefs(tab).length ? '<span class="dirty" title="unsaved changes"></span>' : '');
    b.onclick = () => { S.tab = tab; saveStore(); renderAll(); };
    nav.appendChild(b);
  }
}

function renderFilters() {
  const f = $('#filters');
  f.innerHTML = '';
  const opts = [['all', 'All'], ...STATUSES.map(s => [s, s]), ['unsaved', 'Unsaved']];
  for (const [k, label] of opts) {
    const c = el('button', 'chip' + (S.status === k ? ' on' : ''));
    c.innerHTML = (STATUS_COLOR[k] ? `<span class="dot" style="background:${STATUS_COLOR[k]}"></span>` : '') + label;
    c.onclick = () => { S.status = k; renderFilters(); renderList(); };
    f.appendChild(c);
  }
}

function itemTitle(rec) { const cfg = TABS[rec.tab]; return val(rec, cfg.title) || val(rec, 'name') || val(rec, 'id') || '(no name)'; }
function itemSub(rec) {
  switch (rec.tab) {
    case 'Memories': {
      const bits = [];
      for (const a of ['charm', 'grit', 'insight', 'guile']) if (Number(val(rec, a))) bits.push(`${a} ${val(rec, a)}`);
      const t1 = parseTile(val(rec, 'ability tile 1'));
      if (t1.text) bits.push(t1.kind === 'kw' ? keywordPrefix(t1.kw) : t1.kind === 'none' ? 'text' : t1.kind === 'at_least' ? t1.n + '+' : t1.kind === 'bar' ? `${t1.stat} bar` : t1.kind);
      return bits.join(' · ');
    }
    case 'Glimpses': return [val(rec, 'id'), val(rec, 'kind')].filter(Boolean).join(' · ');
    case 'Encounters': return [val(rec, 'id'), val(rec, 'depth') && 'depth ' + val(rec, 'depth')].filter(Boolean).join(' · ');
    default: return [val(rec, 'id'), val(rec, 'symbol')].filter(Boolean).join(' · ');
  }
}
function thumb(rec) {
  const t = el('div', 'thumb');
  if (rec.tab === 'Memories') {
    const id = R.AD.memoryIds[val(rec, 'name').trim().toLowerCase()];
    const pic = R.memoryPicture(id);
    if (pic) t.appendChild(R.coverPicture(pic, 46, 30, { left: 0, top: 0 }));
    else t.classList.add('noart');
  } else if (rec.tab === 'Glimpses') {
    const m = glimpseModel(rec);
    t.classList.add('sw');
    t.style.background = `url("${R.artUrl('btn_' + m.color + '.png')}") center/cover`;
  } else if (rec.tab === 'Encounters') {
    const m = encounterModel(rec)[0];
    t.appendChild(img(m && m.art && R.has(`mural_${m.art}.png`) ? `mural_${m.art}.png` : 'mural_spiral.png', { objectFit: 'cover', objectPosition: '50% 30%' }));
  } else {
    const sym = val(rec, 'symbol');
    const file = rec.tab === 'Runes' ? runeIcon({ name: val(rec, 'name'), symbol: sym }) : sym ? R.glyphFile(sym) : null;
    t.style.background = 'none';
    if (file) t.appendChild(img(file));
  }
  return t;
}

function renderList() {
  const list = $('#list');
  list.innerHTML = '';
  if (!S.data) { list.innerHTML = '<div class="empty-list">Link the sheet with ⚙ to see everything here.</div>'; return; }
  const q = S.filter.trim().toLowerCase();
  const recs = records(S.tab).filter(rec => {
    const st = val(rec, 'status');
    if (S.status === 'unsaved' ? !isDirty(rec) : S.status !== 'all' && st !== S.status) return false;
    if (!q) return true;
    return Object.values(rec.cur).some(v => String(v).toLowerCase().includes(q));
  });
  if (!recs.length) { list.innerHTML = '<div class="empty-list">Nothing matches.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const rec of recs) {
    const it = el('div', 'item' + (S.sel[S.tab] === rec.ref ? ' on' : ''));
    it.dataset.ref = rec.ref;
    it.appendChild(thumb(rec));
    const tx = el('div', 'txt');
    tx.innerHTML = `<div class="nm">${esc(itemTitle(rec))}</div><div class="sub">${esc(itemSub(rec)) || '&nbsp;'}</div>`;
    it.appendChild(tx);
    if (rec.isNew) it.insertAdjacentHTML('beforeend', '<span class="unsaved new" title="new, not in the sheet yet">NEW</span>');
    else if (isDirty(rec)) it.insertAdjacentHTML('beforeend', '<span class="unsaved" title="changed, not saved yet">EDITED</span>');
    const st = val(rec, 'status');
    it.insertAdjacentHTML('beforeend', `<span class="st" title="${esc(st || 'no status')}" style="background:${STATUS_COLOR[st] || '#4a3a28'}"></span>`);
    it.onclick = () => select(rec.ref);
    frag.appendChild(it);
  }
  list.appendChild(frag);
}
function refreshListItem(ref) {
  const it = document.querySelector(`.item[data-ref="${CSS.escape(ref)}"]`);
  const rec = record(ref);
  if (!it || !rec) return;
  it.querySelector('.nm').textContent = itemTitle(rec);
  it.querySelector('.sub').innerHTML = esc(itemSub(rec)) || '&nbsp;';
  it.querySelector('.thumb').replaceWith(thumb(rec));
  it.querySelectorAll('.unsaved').forEach(x => x.remove());
  const st = it.querySelector('.st');
  if (rec.isNew) st.insertAdjacentHTML('beforebegin', '<span class="unsaved new">NEW</span>');
  else if (isDirty(rec)) st.insertAdjacentHTML('beforebegin', '<span class="unsaved">EDITED</span>');
  st.style.background = STATUS_COLOR[val(rec, 'status')] || '#4a3a28';
}

function select(ref) {
  S.sel[S.tab] = ref;
  saveStore();
  document.querySelectorAll('.item.on').forEach(x => x.classList.remove('on'));
  const it = document.querySelector(`.item[data-ref="${CSS.escape(ref)}"]`);
  if (it) { it.classList.add('on'); it.scrollIntoView({ block: 'nearest' }); }
  renderForm();
  renderPreview();
}
function currentRef() {
  const r = S.sel[S.tab];
  if (r && record(r)) return r;
  const first = S.data && records(S.tab)[0];
  return first ? first.ref : null;
}

function newItem(copyFrom) {
  if (!S.data) { openSetup(); return; }
  const tab = S.tab, ref = `${tab}:new${S.seq++}`;
  const blank = {};
  for (const h of tabData(tab).headers) if (h !== '') blank[h] = '';
  const cur = { ...blank };
  if (copyFrom) {
    Object.assign(cur, copyFrom.cur);
    const t = H(tab, TABS[tab].title); if (t) cur[t] = cur[t] + ' (copy)';
    const idH = H(tab, 'id'); if (idH && cur[idH]) cur[idH] = cur[idH] + '_copy';
    const st = H(tab, 'status'); if (st) cur[st] = '';
  } else for (const [k, v] of Object.entries(TABS[tab].newValues)) { const h = H(tab, k); if (h) cur[h] = v; }
  S.drafts[ref] = { tab, row: 0, isNew: true, orig: blank, cur };
  S.sel[tab] = ref;
  S.status = 'all';
  saveStore();
  renderAll();
  setTimeout(() => { const f = document.querySelector('#form input.big'); if (f) { f.focus(); f.select(); } }, 30);
}

function revert(ref) {
  const d = S.drafts[ref];
  if (!d) return;
  if (d.isNew && !confirm('Throw away this new one? It was never saved to the sheet.')) return;
  delete S.drafts[ref];
  if (d.isNew) S.sel[d.tab] = null;
  saveStore();
  renderAll();
}

// ----- form ---------------------------------------------------------------------------------------------

let _formRef = null;
function renderForm() {
  const form = $('#form');
  form.innerHTML = '';
  _formRef = null;
  if (!S.data) { form.appendChild(welcome()); return; }
  const ref = currentRef();
  if (!ref) { form.innerHTML = `<div class="welcome"><h2>Nothing here yet</h2><p>Press <b>+ New</b> to make the first one.</p></div>`; return; }
  S.sel[S.tab] = ref;
  _formRef = ref;
  _formSig = formSig(ref);
  const rec = record(ref);

  const head = el('div', 'form-head');
  const h2 = el('h2');
  h2.textContent = itemTitle(rec);
  head.appendChild(h2);
  if (isDirty(rec) && !S.auto) {
    const sv = el('button', 'btn primary small'); sv.textContent = rec.isNew ? 'Save to sheet' : 'Save this'; sv.onclick = () => save([ref]); head.appendChild(sv);
    const rv = el('button', 'btn small'); rv.textContent = rec.isNew ? 'Discard' : 'Undo changes'; rv.onclick = () => revert(ref); head.appendChild(rv);
  }
  const dup = el('button', 'btn small'); dup.textContent = 'Duplicate'; dup.title = 'Start a new one from a copy of this'; dup.onclick = () => newItem(rec); head.appendChild(dup);
  form.appendChild(head);
  const where = el('div', 'where');
  where.innerHTML = rec.isNew ? 'New — goes to the bottom of the <b>' + rec.tab + '</b> tab' + (S.auto ? ' in a moment.' : ' when saved.')
    : `<b>${rec.tab}</b> tab, row ${rec.row}` + (isDirty(rec) ? (S.auto ? ' · saving soon…' : ` · ${changedHeaders(rec).length} change(s) not saved`) : ' · saved');
  form.appendChild(where);

  const builders = { Memories: memoryForm, Glimpses: glimpseForm, Encounters: encounterForm, Keywords: keywordForm, Runes: runeForm };
  const used = new Set();
  builders[rec.tab](form, rec, used);
  // any other columns on the tab
  const statusH = H(rec.tab, 'status');
  const rest = tabData(rec.tab).headers.filter(h => h !== '' && !used.has(h) && h !== statusH);
  if (rest.length) {
    const fs = fieldset(form, 'Other columns', true);
    for (const h of rest) fs.appendChild(textField(rec, h, h, { area: String(rec.cur[h] || '').length > 50 }, used));
  }
}

function welcome() {
  const w = el('div', 'welcome');
  w.innerHTML = `<h2>Link the sheet</h2>
    <p>The editor reads and saves the <b>Glimpses Database</b> sheet through a small web app in the sheet's script.</p>
    <ol><li>In the sheet: <b>Glimpses</b> menu → <b>Editor link and key</b>.</li>
    <li>Press <b>⚙</b> up top and paste the link and the key.</li></ol>
    <p>Until then nothing can be loaded or saved.</p>`;
  const b = el('button', 'btn primary'); b.textContent = 'Link the sheet…'; b.onclick = openSetup;
  w.appendChild(b);
  return w;
}

function fieldset(parent, legend, collapsed) {
  if (collapsed) {
    const d = el('details', 'more');
    d.innerHTML = `<summary>${esc(legend)}</summary>`;
    const fs = el('fieldset');
    d.appendChild(fs);
    parent.appendChild(d);
    return fs;
  }
  const fs = el('fieldset');
  fs.innerHTML = `<legend>${esc(legend)}</legend>`;
  parent.appendChild(fs);
  return fs;
}
const isChanged = (rec, h) => h && String(rec.cur[h] ?? '') !== String(rec.orig[h] ?? '') && !rec.isNew;

/** A labelled text box (or textarea) bound to a column. key = the column's name (or its real header). */
function textField(rec, key, label, opt, used) {
  opt = opt || {};
  const h = H(rec.tab, key) || key;
  used && used.add(h);
  const f = el('div', 'f' + (isChanged(rec, h) ? ' changed' : ''));
  if (!tabData(rec.tab).headers.includes(h)) { f.style.display = 'none'; return f; }
  f.innerHTML = `<label>${esc(label)}${opt.hint ? ` <span class="hint">${esc(opt.hint)}</span>` : ''}</label>`;
  const inp = opt.area ? el('textarea', opt.code ? 'code' : '') : el('input', opt.big ? 'big' : '');
  if (!opt.area) inp.type = opt.number ? 'number' : 'text';
  if (opt.number) { inp.min = opt.min ?? 0; inp.step = 1; }
  if (opt.list) inp.setAttribute('list', opt.list);
  inp.value = rec.cur[h] ?? '';
  if (opt.placeholder) inp.placeholder = opt.placeholder;
  if (opt.rows) inp.rows = opt.rows;
  inp.spellcheck = !opt.code;
  inp.oninput = () => { setVal(rec.ref, h, inp.value); f.classList.toggle('changed', isChanged(record(rec.ref) || rec, h)); };
  f.appendChild(inp);
  return f;
}
function selectField(rec, key, label, options, used, opt) {
  opt = opt || {};
  const h = H(rec.tab, key);
  const f = el('div', 'f' + (isChanged(rec, h) ? ' changed' : ''));
  if (!h) { f.style.display = 'none'; return f; }
  used.add(h);
  f.innerHTML = `<label>${esc(label)}${opt.hint ? ` <span class="hint">${esc(opt.hint)}</span>` : ''}</label>`;
  const s = el('select');
  const cur = String(rec.cur[h] ?? '');
  const opts = [...options];
  if (cur && !opts.some(o => (Array.isArray(o) ? o[0] : o) === cur)) opts.push([cur, cur + '  (not a listed choice)']);
  for (const o of opts) { const [v, t] = Array.isArray(o) ? o : [o, o]; const op = el('option'); op.value = v; op.textContent = t; s.appendChild(op); }
  s.value = cur;
  s.onchange = () => { setVal(rec.ref, h, s.value); f.classList.toggle('changed', isChanged(record(rec.ref) || rec, h)); if (opt.onchange) opt.onchange(s.value); };
  f.appendChild(s);
  return f;
}
function checkField(rec, key, label, used) {
  const h = H(rec.tab, key);
  const f = el('div', 'f' + (isChanged(rec, h) ? ' changed' : ''));
  if (!h) { f.style.display = 'none'; return f; }
  used.add(h);
  const l = el('label', 'check');
  const c = el('input'); c.type = 'checkbox';
  c.checked = /^(y|yes|true|1)$/i.test(String(rec.cur[h] ?? '').trim());
  c.onchange = () => { setVal(rec.ref, h, c.checked ? 'yes' : ''); f.classList.toggle('changed', isChanged(record(rec.ref) || rec, h)); };
  l.append(c, document.createTextNode(label));
  f.appendChild(l);
  return f;
}
function statusField(rec, used) {
  const h = H(rec.tab, 'status');
  const f = el('div', 'f');
  if (!h) return f;
  used.add(h);
  f.innerHTML = '<label>Status <span class="hint">— saving marks it “Update” unless you pick one here</span></label>';
  const row = el('div', 'status-pick');
  const draw = () => {
    row.innerHTML = '';
    const cur = String((record(rec.ref) || rec).cur[h] ?? '');
    for (const s of STATUSES) {
      const b = el('button', s === cur ? 'on' : '');
      b.textContent = s;
      if (s === cur) b.style.background = STATUS_COLOR[s];
      b.onclick = () => { setVal(rec.ref, h, s); draw(); };
      row.appendChild(b);
    }
  };
  draw();
  f.appendChild(row);
  return f;
}

/** Glimpses' memories as a datalist (for typing names). */
function ensureDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) { dl = el('datalist'); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = values.map(v => `<option value="${esc(v)}">`).join('');
}

// --- memories ---

function memoryForm(form, rec, used) {
  const top = fieldset(form, 'Memory');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  top.appendChild(statusField(rec, used));

  const at = fieldset(form, 'Attributes & runes');
  const grid = el('div', 'attrs');
  for (const a of ['charm', 'grit', 'insight', 'guile']) {
    const h = H(rec.tab, a);
    if (!h) continue;
    used.add(h);
    const box = el('div', 'attr');
    box.title = a[0].toUpperCase() + a.slice(1);
    const minus = el('button'); minus.textContent = '−';
    const plus = el('button'); plus.textContent = '+';
    const v = el('div', 'v');
    const draw = () => { const n = Number((record(rec.ref) || rec).cur[h]) || 0; v.textContent = n || '–'; box.classList.toggle('set', n > 0); };
    const bump = d => { const n = Math.max(0, Math.min(9, (Number((record(rec.ref) || rec).cur[h]) || 0) + d)); setVal(rec.ref, h, n ? String(n) : ''); draw(); };
    minus.onclick = () => bump(-1); plus.onclick = () => bump(1);
    box.append(img(`ico_${a}.png`), minus, v, plus);
    draw();
    grid.appendChild(box);
  }
  at.appendChild(grid);
  const runeLabels = (S.data.lists && S.data.lists.runes && S.data.lists.runes.length ? S.data.lists.runes : runeRows().map(r => r.name));
  const rr = el('div', 'row');
  rr.style.marginTop = '10px';
  for (const c of ['rune 1', 'rune 2', 'rune 3']) {
    const h = H(rec.tab, c);
    if (!h) continue;
    const f = selectField(rec, c, c[0].toUpperCase() + c.slice(1), [['', '— none —'], ...runeLabels], used);
    const sel = f.querySelector('select');
    const icon = el('div', 'pickicon');
    const draw = () => { icon.innerHTML = ''; if (sel.value) { const r = findRune(sel.value); icon.appendChild(img(runeIcon(r))); icon.title = r ? r.name + ': ' + r.text : 'not on the Runes tab'; } };
    sel.addEventListener('change', draw);
    const wrap = el('div', 'pickrow');
    sel.replaceWith(wrap);
    wrap.append(icon, sel);
    draw();
    rr.appendChild(f);
  }
  at.appendChild(rr);

  const ab = fieldset(form, 'Ability tiles');
  for (const c of ['ability tile 1', 'ability tile 2', 'ability tile 3']) {
    const h = H(rec.tab, c);
    if (!h) continue;
    used.add(h);
    ab.appendChild(tileEditor(rec, h, c[0].toUpperCase() + c.slice(1)));
  }

  const more = fieldset(form, 'Start, dice & notes');
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'dice', 'Dice', { number: true, hint: '(number of d6)' }, used));
  r2.appendChild(textField(rec, 'starting sight', 'Starting sight', { number: true, hint: '(empty = 0–3 at random)' }, used));
  r2.appendChild(textField(rec, 'offered weight', 'Offered weight', { number: true, hint: '(1 if empty)' }, used));
  more.appendChild(r2);
  more.appendChild(textField(rec, 'mechanical clarification', 'Mechanical clarification', { area: true, hint: '(shown when you right-click it)' }, used));
  more.appendChild(tagsField(rec, used));
  const art = textField(rec, 'artwork', 'Artwork notes', {}, used);
  more.appendChild(art);
}

function tileEditor(rec, h, label) {
  const box = el('div', 'tile-ed' + (isChanged(rec, h) ? ' changed' : ''));
  const p = parseTile(rec.cur[h]);
  p.prefixFor = p.kw ? p.kw.id : null;
  const top = el('div', 'top');
  top.innerHTML = `<span class="lbl">${esc(label)}</span>`;
  const kwSel = el('select');
  const opts = [['none', 'No keyword — just text'], ['action', 'Action — click to use (1 action)'], ['passive', 'Passive']];
  for (const k of keywordRows()) {
    const id = k.id.toLowerCase();
    if (['active', 'action', 'passive', 'at_least', 'bar'].includes(id)) continue;
    opts.push(['kw:' + k.id, keywordPrefix(k)]);
  }
  opts.push(['at_least', 'At least X (X+)'], ['bar', 'Bar (fills as you gain…)']);
  for (const [v, t] of opts) { const o = el('option'); o.value = v; o.textContent = t; kwSel.appendChild(o); }
  kwSel.value = p.kind === 'kw' ? 'kw:' + p.kw.id : p.kind;
  const n = el('input'); n.type = 'number'; n.min = 0; n.value = p.n || ''; n.title = 'how many';
  const stat = el('select');
  for (const s of ['Vanity', 'Fading', 'Aggression']) { const o = el('option'); o.value = s; o.textContent = s; stat.appendChild(o); }
  stat.value = /^ag/i.test(p.stat) ? 'Aggression' : /^fad/i.test(p.stat) ? 'Fading' : 'Vanity';
  const icon = el('div', 'pickicon');
  top.append(icon, kwSel, stat, n);
  const ta = el('textarea');
  ta.value = p.kind === 'none' ? p.text : p.body;
  ta.placeholder = 'What it does…';
  const reads = el('div', 'reads');
  box.append(top, ta, reads);

  const sync = write => {
    const v = kwSel.value;
    p.kind = v.startsWith('kw:') ? 'kw' : v;
    p.kw = v.startsWith('kw:') ? keywordRows().find(k => k.id === v.slice(3)) : p.kind === 'bar' || p.kind === 'at_least' ? keywordRows().find(k => k.id.toLowerCase() === p.kind) : null;
    p.n = n.value; p.stat = stat.value; p.body = ta.value;
    stat.style.display = p.kind === 'bar' ? '' : 'none';
    n.style.display = p.kind === 'bar' || p.kind === 'at_least' ? '' : 'none';
    icon.innerHTML = '';
    const ic = p.kind === 'kw' ? keywordIcon(p.kw) : null;
    if (ic) icon.appendChild(img(ic));
    const k = p.kind === 'kw' ? p.kw : p.kind === 'action' ? keywordRows().find(k => /^acti/i.test(k.id)) : p.kind === 'passive' ? keywordRows().find(k => k.id.toLowerCase() === 'passive') : p.kw;
    const name = p.kind === 'none' ? '' : p.kind === 'kw' ? keywordPrefix(p.kw) : kwSel.options[kwSel.selectedIndex].textContent;
    reads.innerHTML = p.kind === 'none'
      ? (p.unknownHead && write === false ? `<span class="warnline">“${esc(p.unknownHead)}:” isn't a keyword, so the game shows it as plain text with no symbol.</span>` : 'No keyword: it shows exactly what you write.')
      : `<b>${esc(name)}</b>${k && k.text ? ' — ' + esc(k.text) : ''}`;
    if (write !== false) {
      const text = ta.value.trim() || p.kind !== 'none' ? composeTile(p) : '';
      setVal(rec.ref, h, ta.value.trim() ? text : '');
      box.classList.toggle('changed', isChanged(record(rec.ref) || rec, h));
    }
  };
  kwSel.onchange = () => sync(); n.oninput = () => sync(); stat.onchange = () => sync(); ta.oninput = () => sync();
  sync(false);
  return box;
}

function allTags() {
  const set = new Set();
  for (const r of records('Memories')) for (const t of val(r, 'tags').split(/\s+/)) if (t.startsWith('#') && t.length > 1) set.add(t);
  return [...set].sort();
}
function tagsField(rec, used) {
  const h = H(rec.tab, 'tags');
  const f = textField(rec, 'tags', 'Tags', { placeholder: '#Vanity #Dice' }, used);
  if (!h) return f;
  const inp = f.querySelector('input');
  const box = el('div', 'tags');
  const draw = () => {
    box.innerHTML = '';
    const mine = new Set(inp.value.split(/\s+/).filter(Boolean));
    for (const t of allTags()) {
      const b = el('button', 'tag' + (mine.has(t) ? ' on' : ''));
      b.textContent = t;
      b.onclick = () => {
        const cur = inp.value.split(/\s+/).filter(Boolean);
        const next = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
        inp.value = next.join(' ');
        inp.dispatchEvent(new Event('input'));
        draw();
      };
      box.appendChild(b);
    }
  };
  inp.addEventListener('change', draw);
  draw();
  f.appendChild(box);
  return f;
}

// --- glimpses ---

function glimpseForm(form, rec, used) {
  const top = fieldset(form, 'Glimpse');
  top.appendChild(textField(rec, 'title', 'Title', { big: true }, used));
  const r = el('div', 'row');
  r.appendChild(textField(rec, 'id', 'Id', { hint: '(unique, no spaces)' }, used));
  r.appendChild(selectField(rec, 'kind', 'Kind', [['effects', 'effects (an event)'], ['memory', 'memory (a new memory)'], ['encounter', 'encounter (a fight)']], used, { onchange: () => renderPreview() }));
  top.appendChild(r);
  top.appendChild(statusField(rec, used));

  const look = fieldset(form, 'Colour');
  const h = H(rec.tab, 'colour');
  if (h) {
    used.add(h);
    const sw = el('div', 'swatches');
    const draw = () => {
      sw.innerHTML = '';
      const cur = String((record(rec.ref) || rec).cur[h] ?? '').toLowerCase();
      const auto = el('button', 'swatch auto' + (!GLIMPSE_COLORS.includes(cur) ? ' on' : ''));
      auto.textContent = 'auto';
      auto.title = 'Picked by the game from what it does';
      auto.onclick = () => { setVal(rec.ref, h, ''); draw(); };
      sw.appendChild(auto);
      for (const c of GLIMPSE_COLORS) {
        const b = el('button', 'swatch' + (cur === c ? ' on' : ''));
        b.style.backgroundImage = `url("${R.artUrl('btn_' + c + '.png')}")`;
        b.textContent = c;
        b.onclick = () => { setVal(rec.ref, h, c); draw(); };
        sw.appendChild(b);
      }
    };
    draw();
    look.appendChild(sw);
  }

  const what = fieldset(form, 'What it does');
  what.appendChild(textField(rec, 'text', 'Text', { area: true, rows: 3 }, used));
  what.appendChild(checkField(rec, 'player picks a memory', 'The player picks a memory for it (a “tamper” — dragged onto a memory)', used));
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'cost', 'Cost', { placeholder: 'e.g. 1 bone' }, used));
  r2.appendChild(textField(rec, 'offered weight', 'Offered weight', { number: true }, used));
  r2.appendChild(textField(rec, 'from depth', 'From depth', { number: true }, used));
  r2.appendChild(textField(rec, 'to depth', 'To depth', { number: true }, used));
  what.appendChild(r2);

  const adv = fieldset(form, 'Effects (advanced)', true);
  adv.appendChild(textField(rec, 'effects', 'Effects', { area: true, code: true, hint: '(JSON the game runs; leave empty while it\'s an idea)' }, used));
  adv.appendChild(textField(rec, 'if you have', 'If you have', {}, used));
  adv.appendChild(textField(rec, 'then also', 'Then also', { code: true }, used));
  adv.appendChild(textField(rec, 'otherwise', 'Otherwise', { code: true }, used));
  textField(rec, 'artwork', '', {}, used);
}

// --- encounters ---

function encounterForm(form, rec, used) {
  if (H(rec.tab, 'intents')) return encounterForm2(form, rec, used);
  ensureDatalist('enemyNames', Object.keys(R.AD.enemies).map(k => k.replace(/\b\w/g, c => c.toUpperCase())));
  const top = fieldset(form, 'Encounter');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  const r = el('div', 'row');
  r.appendChild(textField(rec, 'id', 'Id', {}, used));
  r.appendChild(textField(rec, 'depth', 'Depth', { placeholder: '1–4' }, used));
  r.appendChild(textField(rec, 'how often', 'How often', { number: true }, used));
  r.appendChild(checkField(rec, 'boss', 'Boss', used));
  top.appendChild(r);
  top.appendChild(statusField(rec, used));

  const who = fieldset(form, 'Who you face');
  who.appendChild(textField(rec, 'components', 'Enemies', { list: 'enemyNames', hint: '(comma between them; “2 × Lantern Moth” for more than one)' }, used));
  who.appendChild(textField(rec, 'mechanics', 'What they do', { area: true, rows: 4, hint: '(one line per enemy: “Name: …”)' }, used));
  who.appendChild(textField(rec, 'duration', 'Duration', {}, used));

  const win = fieldset(form, 'Ways out');
  const hs = tabData(rec.tab).headers;
  const pair = (needKey, rewardKey, needLabel, rewardLabel) => {
    const row = el('div', 'row');
    row.appendChild(textField(rec, needKey, needLabel, {}, used));
    row.appendChild(textField(rec, rewardKey, rewardLabel, {}, used));
    win.appendChild(row);
  };
  pair('to slay', 'slay reward', 'To slay', 'Slay reward');
  pair('to escape', 'escape reward', 'To sneak past', 'Sneak reward');
  const sootheH = hs.find(h => /soothe/i.test(h) && !/reward/i.test(h)), sootheR = hs.find(h => /soothe/i.test(h) && /reward/i.test(h));
  if (sootheH) pair(sootheH, sootheR || sootheH, 'To soothe', 'Soothe reward');
  win.appendChild(textField(rec, 'other way to win', 'Other way to win', {}, used));
  win.appendChild(textField(rec, 'if the clock runs out', 'If the clock runs out', {}, used));
  form.appendChild(el('div'));
  const notes = fieldset(form, 'Notes');
  notes.appendChild(textField(rec, 'notes', 'Notes / flavour', { area: true }, used));
  textField(rec, 'artwork', '', {}, used);
}

function encounterForm2(form, rec, used) {
  ensureDatalist('enemyNames', Object.keys(R.AD.enemies).map(k => k.replace(/\b\w/g, c => c.toUpperCase())));
  ensureDatalist('musicNames', [...new Set(records('Encounters').map(r => val(r, 'music')).filter(Boolean))].sort());
  const top = fieldset(form, 'Encounter');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  const r = el('div', 'row');
  r.appendChild(textField(rec, 'id', 'Id', {}, used));
  r.appendChild(textField(rec, 'depth', 'Depth', { placeholder: '1–4' }, used));
  r.appendChild(textField(rec, 'how often', 'How often', { number: true }, used));
  r.appendChild(checkField(rec, 'boss', 'Boss', used));
  top.appendChild(r);
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'music', 'Music', { list: 'musicNames' }, used));
  r2.appendChild(textField(rec, 'rounds', 'Rounds', { hint: '(timed fight)' }, used));
  r2.appendChild(textField(rec, 'enemy memory', 'Enemy memory', { hint: '(put in your ring)' }, used));
  top.appendChild(r2);
  top.appendChild(statusField(rec, used));

  const who = fieldset(form, 'Who you face');
  who.appendChild(textField(rec, 'enemies', 'Enemies', { list: 'enemyNames', hint: '(comma between them; “2 × Lantern Moth” for more than one)' }, used));
  who.appendChild(textField(rec, 'intents', 'Intents', { area: true, rows: 3, hint: '(in order, at the end of each turn: “Lash (Attack 4) → Toll (Attack 6)”; with several enemies “Name: …; Other (each): …”)' }, used));
  who.appendChild(textField(rec, 'traits', 'Traits & rules', { area: true, rows: 2 }, used));

  const win = fieldset(form, 'Ways out');
  const pair = (needKey, rewardKey, needLabel, rewardLabel, ph) => {
    const row = el('div', 'row');
    row.appendChild(textField(rec, needKey, needLabel, { placeholder: ph }, used));
    row.appendChild(textField(rec, rewardKey, rewardLabel, {}, used));
    win.appendChild(row);
  };
  pair('to slay', 'slay reward', 'To slay', 'Slay reward', '12 aggression');
  pair('to sneak', 'sneak reward', 'To sneak', 'Sneak reward', '7 fading');
  pair('to soothe', 'soothe reward', 'To soothe', 'Soothe reward', '4 vanity');
  pair('to dismiss', 'dismiss reward', 'To dismiss', 'Dismiss reward', '');
  win.appendChild(textField(rec, 'if the clock runs out', 'If the clock runs out', {}, used));
  const notes = fieldset(form, 'Notes');
  notes.appendChild(textField(rec, 'notes', 'Notes / flavour', { area: true }, used));
  textField(rec, 'artwork', '', {}, used);
}

// --- keywords & runes ---

function symbolPicker(rec, used, extra) {
  const h = H(rec.tab, 'symbol');
  const f = el('div', 'f' + (isChanged(rec, h) ? ' changed' : ''));
  if (!h) return f;
  used.add(h);
  f.innerHTML = '<label>Symbol</label>';
  const grid = el('div', 'glyphs');
  const draw = () => {
    grid.innerHTML = '';
    const cur = String((record(rec.ref) || rec).cur[h] ?? '').trim().toLowerCase();
    const curNorm = ({ 'back arrow': 'back', 'down arrow': 'down', compas: 'compass', void: 'vortex' })[cur] || cur;
    const none = el('button', 'glyph none' + (!cur ? ' on' : ''));
    none.textContent = 'none';
    none.onclick = () => { setVal(rec.ref, h, ''); draw(); };
    grid.appendChild(none);
    for (const [name, file, title] of [...(extra || []), ...R.glyphChoices().map(g => [g, R.glyphFile(g), g])]) {
      const b = el('button', 'glyph' + (curNorm === name ? ' on' : ''));
      b.title = title;
      b.appendChild(img(file));
      b.onclick = () => { setVal(rec.ref, h, name); draw(); f.classList.toggle('changed', isChanged(record(rec.ref) || rec, h)); };
      grid.appendChild(b);
    }
    if (cur && !grid.querySelector('.on')) {
      const w = el('div', 'warnline'); w.textContent = `“${cur}” has no picture yet — the game shows a skull for it.`; grid.appendChild(w);
    }
  };
  draw();
  f.appendChild(grid);
  return f;
}

function keywordForm(form, rec, used) {
  const top = fieldset(form, 'Keyword');
  top.appendChild(textField(rec, 'name', 'Name', { big: true, hint: '(what you write at the start of an ability tile)' }, used));
  const r = el('div', 'row');
  r.appendChild(textField(rec, 'id', 'Id', {}, used));
  const triggers = [...new Set(records('Keywords').map(x => val(x, 'trigger').trim()).filter(Boolean))].sort();
  ensureDatalist('triggers', triggers);
  r.appendChild(textField(rec, 'trigger', 'Trigger', { list: 'triggers', hint: '(when the game runs it)' }, used));
  top.appendChild(r);
  top.appendChild(statusField(rec, used));
  const look = fieldset(form, 'Look & words');
  look.appendChild(symbolPicker(rec, used, [['align', 'align_kw.png', 'align (the Align tile)']]));
  look.appendChild(textField(rec, 'description', 'Description', { area: true, hint: '(shown when you hover its symbol)' }, used));
  look.appendChild(textField(rec, 'mechanical clarification', 'Mechanical clarification', { area: true }, used));
  textField(rec, 'artwork', '', {}, used);
}

function runeForm(form, rec, used) {
  const top = fieldset(form, 'Rune');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  top.appendChild(textField(rec, 'id', 'Id', {}, used));
  top.appendChild(statusField(rec, used));
  const look = fieldset(form, 'Look & words');
  look.appendChild(symbolPicker(rec, used, [['param', 'ico_aggression.png', 'param (Stir runes: the icon of what it gives)']]));
  look.appendChild(textField(rec, 'description', 'Description', { area: true }, used));
  look.appendChild(textField(rec, 'mechanical clarification', 'Mechanical clarification', { area: true }, used));
  textField(rec, 'artwork', '', {}, used);
}

// ----- preview ------------------------------------------------------------------------------------------

let _pvTimer = 0;
function afterChange(ref, key) {
  clearTimeout(_pvTimer);
  _pvTimer = setTimeout(() => {
    renderPreview();
    refreshListItem(ref);
    updateHud();
    const rec = record(ref);
    if (real(ref) === real(_formRef || '')) _formSig = formSig(ref);
    const h2 = document.querySelector('#form h2');
    if (h2 && rec) h2.textContent = itemTitle(rec);
    // the Save/Undo buttons come and go with changes
    const head = document.querySelector('.form-head');
    if (!S.auto && head && rec && !!head.querySelector('.btn.primary') !== isDirty(rec)) {
      const active = document.activeElement, pos = active && active.selectionStart;
      const path = active && active.closest('#form') ? [...document.querySelectorAll('#form input, #form textarea, #form select')].indexOf(active) : -1;
      renderForm();
      if (path >= 0) {
        const again = document.querySelectorAll('#form input, #form textarea, #form select')[path];
        if (again) { again.focus(); try { if (pos != null) again.setSelectionRange(pos, pos); } catch (e) { /* selects */ } }
      }
    }
  }, 60);
}

let _zoom = 1.45;
function renderPreview() {
  const stage = $('#stage');
  stage.innerHTML = '';
  const lab = $('#pvLabel');
  if (!S.data) { lab.firstChild.textContent = 'Preview'; return; }
  const ref = currentRef();
  const rec = ref && record(ref);
  if (!rec) return;
  const pv = { Memories: previewMemory, Glimpses: previewGlimpse, Encounters: previewEncounter, Keywords: previewKeyword, Runes: previewRune };
  lab.firstChild.textContent = { Memories: 'As a card in the ring', Glimpses: 'As a glimpse to choose', Encounters: 'As the fight shows it', Keywords: 'On an ability tile', Runes: 'On a card' }[rec.tab];
  pv[rec.tab](stage, rec);
}

function scaledCard(card, zoom) {
  const wrap = el('div', 'pv-scaled', { width: 240 * zoom + 'px', height: 421 * zoom + 'px' });
  card.style.transform = `scale(${zoom})`;
  wrap.appendChild(card);
  return wrap;
}

function previewMemory(stage, rec) {
  const m = memoryModel(rec);
  const card = R.memoryCard(m);
  stage.appendChild(scaledCard(card, _zoom));
  R.layoutCard(card);
  const notes = el('div', 'pv-notes');
  const bits = [];
  if (!m.id) bits.push('<p>Not in the game yet (no picture until it\'s brought in and given art).</p>');
  for (const r of m.runes) bits.push(`<div class="glos"><img class="ico" src="${R.artUrl(r.icon)}" style="width:20px;height:20px"> <b>${esc(r.title)}</b> — ${esc(r.text)}${r.missing ? ' <span class="warnline">(no rune with this name)</span>' : ''}</div>`);
  if (m.dice) bits.push(`<div class="glos"><img class="ico" src="${R.artUrl('die_6.png')}" style="width:20px;height:20px"> <b>Dice</b> — comes with ${m.dice} die${m.dice > 1 ? 'ce' : ''}.</div>`);
  if (m.pattern) bits.push('<div class="glos"><b>Align</b> — the 4 tiles along the bottom are rolled each run; these are an example.</div>');
  const cl = val(rec, 'mechanical clarification');
  if (cl) bits.push(`<h4>Clarification</h4><p>${esc(cl).replace(/\n/g, '<br>')}</p>`);
  const tags = val(rec, 'tags');
  if (tags) bits.push(`<h4>Tags</h4><p>${esc(tags)}</p>`);
  if (bits.length) { notes.innerHTML = bits.join(''); stage.appendChild(notes); }
}

function previewGlimpse(stage, rec) {
  const g = glimpseModel(rec);
  const wrap = el('div', 'glimpse-stack');
  const card = R.glimpseCard(g);
  wrap.appendChild(card);
  stage.appendChild(wrap);
  R.layoutGlimpse(card);
  const notes = el('div', 'pv-notes');
  const bits = [`<p><b>${esc(g.kind)}</b> · ${esc(g.color)}${GLIMPSE_COLORS.includes(val(rec, 'colour').toLowerCase()) ? '' : ' (picked automatically)'}</p>`];
  const w = val(rec, 'offered weight'), from = val(rec, 'from depth'), to = val(rec, 'to depth');
  bits.push(`<p>Offered weight ${esc(w || '1')}${from || to ? ` · depths ${esc(from || 'any')}–${esc(to || 'any')}` : ''}${val(rec, 'cost') ? ' · costs ' + esc(val(rec, 'cost')) : ''}</p>`);
  if (!val(rec, 'effects').trim() && val(rec, 'kind').toLowerCase() === 'effects') bits.push('<p class="warnline">No effects written yet, so the game can\'t run it (fine for an Idea).</p>');
  notes.innerHTML = bits.join('');
  stage.appendChild(notes);
}

function previewEncounter(stage, rec) {
  const wrap = el('div', 'enc-wrap');
  const enemies = encounterModel(rec);
  for (const e of enemies) wrap.appendChild(R.enemyBlock(e));
  stage.appendChild(wrap);
  const notes = el('div', 'pv-notes');
  const bits = [];
  const unknown = enemies.filter(e => e.unknown).map(e => e.name);
  if (unknown.length) bits.push(`<p class="warnline">Not in the game yet: ${unknown.map(esc).join(', ')} (shown with a stand-in picture).</p>`);
  for (const k of ['other way to win', 'if the clock runs out', 'music', 'notes']) if (H(rec.tab, k) && val(rec, k)) bits.push(`<h4>${esc(k)}</h4><p>${esc(val(rec, k))}</p>`);
  if (bits.length) { notes.innerHTML = bits.join(''); stage.appendChild(notes); }
}

/** The Encounters tab as it is now: enemies, intents, traits & rules, sneak / soothe / dismiss. */
function encounterModel2(rec) {
  const comps = (val(rec, 'enemies') || val(rec, 'name')).split(/,\s*/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(\d+)\s*[×x]\s*(.+)$/i);
    return { count: m ? Number(m[1]) : 1, name: m ? m[2].trim() : s };
  });
  const single = comps.length <= 1;
  const tidyRules = t => String(t || '').replace(/\s*rules:\s*[\w, ]+$/i, '').trim();
  return comps.map(c => {
    const known = R.AD.enemies[c.name.toLowerCase()] || {};
    const bar = (stat, verb, needKey, rewardKey) => {
      const t = partFor(val(rec, needKey), c.name, single);
      const n = (t.match(/(\d+)/) || [])[1];
      const reward = partFor(val(rec, rewardKey), c.name, single);
      return { stat, verb, need: n ? Number(n) : 0, label: t && !n ? t : '', reward, skip: !t && !reward };
    };
    const bars = [bar('aggression', 'Slay', 'to slay', 'slay reward'), bar('fading', 'Sneak', 'to sneak', 'sneak reward'),
      bar('vanity', 'Soothe', 'to soothe', 'soothe reward')].filter(b => !b.skip);
    const dismiss = val(rec, 'to dismiss');
    if (dismiss || val(rec, 'dismiss reward')) bars.push({ stat: 'aggression', verb: 'Dismiss', need: 0, label: 'Dismiss: ' + dismiss, reward: val(rec, 'dismiss reward') });
    for (const b of bars) if (!b.need && !b.label) b.label = `can't ${b.verb.toLowerCase()}`;
    return { name: c.name, count: c.count, art: known.art || '', flavor: known.flavor || '', intent: partFor(val(rec, 'intents'), c.name, single),
      traits: tidyRules(single ? val(rec, 'traits') : partFor(val(rec, 'traits'), c.name, false)), bars, unknown: !known.id };
  });
}

function usedBy(test) {
  const out = [];
  for (const r of records('Memories')) {
    if (val(r, 'status') === 'Delete') continue;
    for (const c of ['ability tile 1', 'ability tile 2', 'ability tile 3', 'rune 1', 'rune 2', 'rune 3'])
      if (test(c, val(r, c))) { out.push(r); break; }
  }
  return out;
}
function exampleList(stage, list, what, pick) {
  const notes = el('div', 'pv-notes');
  notes.innerHTML = `<h4>Used by ${list.length} memor${list.length === 1 ? 'y' : 'ies'}</h4>`;
  const p = el('p');
  list.slice(0, 40).forEach((r, i) => {
    const a = el('a'); a.href = '#'; a.textContent = itemTitle(r); a.style.color = 'var(--text)';
    a.onclick = ev => { ev.preventDefault(); S.tab = 'Memories'; S.sel.Memories = r.ref; saveStore(); renderAll(); };
    if (i) p.appendChild(document.createTextNode(' · '));
    p.appendChild(a);
  });
  if (list.length > 40) p.appendChild(document.createTextNode(` … and ${list.length - 40} more`));
  if (!list.length) p.textContent = `No memory uses this ${what} yet.`;
  notes.appendChild(p);
  stage.appendChild(notes);
  if (list[0] && pick) {
    const card = R.memoryCard(memoryModel(list[0]));
    const cap = el('div', 'pv-notes'); cap.innerHTML = `<p>For example, <b>${esc(itemTitle(list[0]))}</b>:</p>`;
    stage.appendChild(cap);
    stage.appendChild(scaledCard(card, 1.1));
    R.layoutCard(card);
  }
}

function previewKeyword(stage, rec) {
  const k = { id: val(rec, 'id').trim() || val(rec, 'name').trim(), name: val(rec, 'name').trim(), symbol: val(rec, 'symbol').trim(), text: val(rec, 'description') };
  const icon = keywordIcon(k) || (k.symbol ? R.glyphFile(k.symbol) : null);
  const g = el('div', 'glossary');
  g.innerHTML = `<div class="h">${icon ? `<img src="${R.artUrl(icon)}">` : ''}${esc(k.name)}</div><div class="b">${R.iconText(k.text, 18)}</div>`;
  stage.appendChild(el('div', null, { height: '24px' }));
  stage.appendChild(g);
  // a sample tile, at the size of a card's content, scaled up
  const holder = el('div', 'pv-scaled', { width: 200 * 1.45 + 'px' });
  const inner = el('div', null, { width: '200px', transform: 'scale(1.45)', transformOrigin: '0 0' });
  const id = k.id.toLowerCase();
  const sample = id === 'action' || id === 'active' ? { text: 'Spend 1 sight here: gain 2 aggression.', manual: true }
    : id === 'bar' ? { text: 'Gain 3 Fading.', bar: { stat: 'vanity', need: 5 } }
    : id === 'at_least' ? { text: '6+: Gain 2 aggression at the end of each turn.' }
    : { text: 'Gain 2 aggression.', icon };
  const tile = R.abilityTile(sample);
  inner.appendChild(tile);
  holder.appendChild(inner);
  stage.appendChild(holder);
  R.padTile(tile);
  holder.style.height = tile.offsetHeight * 1.45 + 'px';
  R.drawTile(tile);
  const list = usedBy((c, v) => c.startsWith('ability') && (() => { const p = parseTile(v); return p.kw && p.kw.id === k.id || (p.kind === 'action' && /^acti/i.test(id)) || (p.kind === 'passive' && id === 'passive'); })());
  exampleList(stage, list, 'keyword', true);
}

function previewRune(stage, rec) {
  const r = { name: val(rec, 'name').trim(), symbol: val(rec, 'symbol').trim(), text: val(rec, 'description') };
  const icon = runeIcon(r);
  const big = el('div', 'rune-big');
  const t = el('div', 'grune');
  t.appendChild(img('tile_square.png', { position: 'absolute', left: 0, top: 0, width: '46px', height: '46px' }));
  t.appendChild(img(icon, { position: 'absolute', left: '7px', top: '7px', width: '32px', height: '32px', objectFit: 'contain' }));
  big.appendChild(t);
  const g = el('div', 'glossary');
  g.innerHTML = `<div class="h"><img src="${R.artUrl(icon)}">${esc(r.name)}</div><div class="b">${R.iconText(r.text, 18)}</div>`;
  big.appendChild(g);
  stage.appendChild(big);
  const list = usedBy((c, v) => c.startsWith('rune') && v.trim() && squash(plain(v)) === squash(r.name));
  exampleList(stage, list, 'rune', true);
}

// ----- setup dialog -------------------------------------------------------------------------------------

function openSetup() {
  const d = $('#setup');
  $('#setUrl').value = S.url;
  $('#setKey').value = S.key;
  $('#setMsg').textContent = '';
  $('#setMsg').className = 'msg';
  if (!d.open) d.showModal();
}
async function testSetup() {
  const url = $('#setUrl').value.trim(), key = $('#setKey').value.trim();
  const msg = $('#setMsg');
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { msg.textContent = 'The link should start with https://script.google.com/macros/s/… and end in /exec.'; msg.className = 'msg bad'; return; }
  if (!key) { msg.textContent = 'Paste the key too.'; msg.className = 'msg bad'; return; }
  if (!/\/exec\/?$/.test(url)) { msg.textContent = 'Use the web app link that ends in /exec (Deploy → Manage deployments → Web app URL). A link ending in /dev or /edit needs you signed in, so it can\'t be used here.'; msg.className = 'msg bad'; return; }
  const old = [S.url, S.key];
  S.url = url; S.key = key;
  msg.textContent = 'Trying…'; msg.className = 'msg';
  try {
    const data = await api('GET');
    S.data = { tabs: data.tabs, lists: data.lists || {}, sheet: data.sheet };
    S.loadedAt = data.at; S.fromCache = false;
    rebindDrafts();
    saveStore(true);
    msg.textContent = `Linked to “${data.sheet}”.`; msg.className = 'msg ok';
    renderAll();
    setTimeout(() => $('#setup').close(), 700);
  } catch (e) {
    [S.url, S.key] = old;
    msg.textContent = /failed to fetch/i.test(e.message) ? 'Couldn\'t reach the sheet (Failed to fetch). Check the link is the /exec one from Deploy → Manage deployments, and that a browser extension isn\'t blocking it.' : e.message;
    msg.className = 'msg bad';
  }
}

// ----- start --------------------------------------------------------------------------------------------

function start() {
  loadStore();
  $('#search').oninput = e => { S.filter = e.target.value; renderList(); };
  $('#newItem').onclick = () => newItem();
  $('#saveAll').onclick = () => save(dirtyRefs());
  $('#reload').onclick = () => {
    if (dirtyRefs().length) toast('Your unsaved changes are kept; the rest comes fresh from the sheet.');
    reload();
  };
  $('#settings').onclick = openSetup;
  $('#setTest').onclick = testSetup;
  $('#setClose').onclick = () => $('#setup').close();
  $('#zoomIn').onclick = () => { _zoom = Math.min(2.4, _zoom + 0.15); renderPreview(); };
  $('#zoomOut').onclick = () => { _zoom = Math.max(0.8, _zoom - 0.15); renderPreview(); };
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(dirtyRefs()); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('#setup').open) { e.preventDefault(); $('#search').focus(); $('#search').select(); }
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = [...document.querySelectorAll('#list .item')];
      const i = items.findIndex(x => x.classList.contains('on'));
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.dataset.ref);
    }
  });
  document.fonts && document.fonts.ready.then(() => renderPreview());
  renderAll();
  if (S.url && S.key) reload(true, true).then(() => { if (dirtyRefs().length) scheduleAutoSave(); }); else openSetup();
  // stay in step with the sheet: check every 30 seconds, and whenever you come back to the page
  setInterval(poll, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', () => poll());
  window.addEventListener('beforeunload', e => { if (dirtyRefs().length && S.url) { save(dirtyRefs(), true); } });
}
document.addEventListener('DOMContentLoaded', start);
