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
  Memories: { title: 'name', sub: null, match: 'name', newValues: { name: 'New Memoriam' }, label: 'Memoriams' },
  Glimpses: { title: 'title', sub: 'id', match: 'id', newValues: { title: 'New Glimpse', kind: 'effects', status: 'Idea' }, label: 'Glimpses' },
  Encounters: { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Encounter' }, label: 'Encounters' },
  Keywords: { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Keyword' }, label: 'Keywords' },
  Runes: { title: 'name', sub: 'id', match: 'name', newValues: { name: 'New Rune' }, label: 'Runes' },
  Masks: { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Mask' }, label: 'Masks' },
  'Action Cards': { title: 'name', sub: 'id', match: 'id', newValues: { name: 'New Card', paper: 'plain', symbol: 'spiral', target: 'has_sight' }, label: 'Action Cards' },
};
/** The Action Cards tab's columns (it's made with these the first time a card is saved). */
const CARD_HEADERS = ['status', 'id', 'name', 'symbol', 'paper', 'target', 'text', 'how it works', 'Mechanical Clarification'];
/** What the Unlock (achievement) button is on; Requirements are on all of these but masks. */
const UNLOCKABLE = ['Memories', 'Glimpses', 'Encounters', 'Masks'];

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

const tabData = tab => (S.data && S.data.tabs && S.data.tabs[tab]) || { headers: tab === 'Action Cards' ? [...CARD_HEADERS] : [], rows: [] };
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
/** The column for a name: the tab's own, or one only this item has so far (a new "Rune 3" the sheet gets on saving). */
const HR = (rec, key) => H(rec.tab, key) || Object.keys(rec.cur).find(k => k.toLowerCase() === key.toLowerCase()) || null;
const val = (rec, key) => { const h = HR(rec, key); return h ? String(rec.cur[h] ?? '') : ''; };
/** "Rune 1", "Rune 2"... (or "Ability Tile 1"...): this item's numbered columns, in order. */
function numbered(rec, stem) {
  const re = new RegExp('^' + stem + ' (\\d+)$', 'i');
  const hs = new Set([...tabData(rec.tab).headers, ...Object.keys(rec.cur)].filter(h => re.test(h.trim())));
  return [...hs].sort((a, b) => Number(a.trim().match(re)[1]) - Number(b.trim().match(re)[1]));
}
/** Writes a list into numbered columns (Rune 1, Rune 2, ...): new columns are made when saved, extra ones emptied. */
function setNumbered(ref, stem, label, list) {
  const rec = record(real(ref));
  const cols = numbered(rec, stem);
  const n = Math.max(cols.length, list.length);
  for (let i = 0; i < n; i++) {
    const h = cols.find(c => Number(c.trim().split(' ').pop()) === i + 1) || `${label} ${i + 1}`;
    if (String(record(real(ref)).cur[h] ?? '') !== String(list[i] ?? '')) setVal(ref, h, list[i] ?? '');
  }
}
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
  const h = HR(rec, key) || key;   // (a column the sheet doesn't have yet: made when it's saved)
  if (!S.drafts[ref]) S.drafts[ref] = { tab: rec.tab, row: rec.row, isNew: false, orig: { ...rec.orig }, cur: { ...rec.orig } };
  const d = S.drafts[ref], sh = H(rec.tab, 'status');
  d.cur[h] = value;
  if (sh && h === sh) d.statusPicked = true;   // picked by hand: kept as it is
  // any other change marks it "Update" straight away (Idea and Delete keep theirs), as saving would
  else if (sh && !d.statusPicked && !/^(idea|delete)$/i.test(String(d.orig[sh] ?? ''))) d.cur[sh] = 'Update';
  if (!d.isNew && changedHeaders(record(ref)).filter(x => x !== sh || d.statusPicked).length === 0) delete S.drafts[ref];
  saveStore();
  afterChange(ref, key);
  if (_statusRedraw && ref === real(S.sel[rec.tab])) _statusRedraw();
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
const squash = s => String(s || '').toLowerCase().replace(/agression/g, 'aggression').replace(/fading/g, 'fortitude').replace(/\s+/g, '');
function findRune(label) {
  const name = plain(label);
  if (!name) return null;
  return runeRows().find(r => squash(r.name) === squash(name)) || runeRows().find(r => squash(r.id) === squash(name)) || null;
}
function stirWord(name) {
  let w = String(name).toLowerCase().replace(/^stir/, '').trim();
  if (w.startsWith('ag')) w = 'aggression';
  if (w === 'fading') w = 'fortitude';   // fading became fortitude
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
  // Land (and an old Action, which is a Land now): the gold tile, no symbol
  if (p.kind === 'action') return { text: p.body, icon: null, manual: true, parsed: p };
  if (p.kind === 'kw' && p.kw.id.toLowerCase() === 'scatter_ends_here') return { text: p.body, icon: null, manual: true, parsed: p };
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
  for (const v of runeList(rec)) {
    const r = findRune(v);
    runes.push({ icon: runeIcon(r), title: r ? r.name : plain(v), text: r ? r.text : "(not on the Runes tab)", missing: !r });
  }
  const tiles = [];
  for (const text of tileList(rec)) { const t = tileView(text); if (t) tiles.push(t); }
  const diceRaw = val(rec, 'dice').trim();
  let dice = 0;
  for (const d of diceRaw.split(/[,; ]+/).filter(Boolean)) dice += /^d/i.test(d) ? 1 : Math.min(6, Number(d) || 0);
  const align = tiles.some(t => t.parsed.kw && /^all?ign$/i.test(t.parsed.kw.id));
  return { id, name, attributes, runes, tiles, dice, pattern: align ? examplePattern(name) : null };
}

/** An Align pattern rolled the way the game rolls one: 4 of 0–4 or =, and a lone = becomes the arrow ("this").
 *  (Seeded by the name, so the example stays put while you edit.) */
function examplePattern(name) {
  let h = 2166136261;
  for (const c of String(name)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const next = () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
  const vals = ['0', '1', '2', '3', '4', 'eq'];
  const p = [0, 1, 2, 3].map(() => vals[Math.floor(next() * vals.length)]);
  if (p.filter(v => v === 'eq').length === 1) p[p.indexOf('eq')] = 'this';
  return p;
}

/** A memory's runes, from however many Rune columns it has (each may hold a comma list). */
const runeList = rec => numbered(rec, 'rune').flatMap(h => String(rec.cur[h] ?? '').split(',')).map(x => x.trim()).filter(Boolean);
const tileList = rec => numbered(rec, 'ability tile').map(h => String(rec.cur[h] ?? '').trim()).filter(Boolean);

function glimpseModel(rec) {
  const kind = val(rec, 'kind').toLowerCase() || 'effects';
  const picks = /^(y|yes|true|1)$/i.test(val(rec, 'player picks a memory').trim());
  const text = val(rec, 'text');
  let color = val(rec, 'colour').trim().toLowerCase();
  if (!GLIMPSE_COLORS.includes(color))
    color = kind === 'encounter' ? 'red' : kind === 'memory' ? 'purple' : picks ? 'orange' : /check/i.test(val(rec, 'effects')) ? 'blue'
      : /heal/i.test(text) ? 'green' : val(rec, 'cost').trim() ? 'gold' : 'sand';
  const label = kind === 'encounter' ? 'FIGHT' : kind === 'memory' ? 'NEW MEMORIAM' : picks ? 'TAMPER' : 'EVENT';
  const hint = kind === 'memory' ? 'Hover to see it, right-click to look closely. Drag it into a gap in the ring, or click then pick a gap.'
    : picks ? 'Drag it onto a memoriam, or click then pick one.' : 'Click to choose.';
  const info = val(rec, 'info line').trim();
  return { color, kind: info ? info.toUpperCase() : label, title: val(rec, 'title'), text: kind === 'memory' ? '' : text, hint };
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
  if (H(rec.tab, 'intents') || !H(rec.tab, 'components')) return encounterModel2(rec);
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

// Memories are called Memoriams on the sheet. Inside the editor tabs and columns keep their old names
// ("Memories", "starting memories"...); these translate on the way in from the sheet and back out to it.
const oldWords = s => String(s).replace(/\b([mM])emoriam(s?)\b/g, (m, a, pl) => a + (pl ? 'emories' : 'emory'));
const REAL = { tabs: {}, heads: {} };   // the sheet's own names, by the editor's: REAL.tabs.Memories = 'Memoriams'
function fromSheet(json) {
  if (json.tabs) {
    const tabs = {};
    for (const [name, t] of Object.entries(json.tabs)) {
      const mine = oldWords(name);
      REAL.tabs[mine] = name;
      REAL.heads[mine] = {};
      for (const h of t.headers || []) REAL.heads[mine][oldWords(h)] = h;
      tabs[mine] = Object.assign({}, t, { headers: (t.headers || []).map(oldWords) });
    }
    json.tabs = tabs;
  }
  for (const r of json.results || []) {
    if (!r.tab) continue;
    r.tab = oldWords(r.tab);
    if (r.headers) { REAL.heads[r.tab] = REAL.heads[r.tab] || {}; for (const h of r.headers) REAL.heads[r.tab][oldWords(h)] = h; r.headers = r.headers.map(oldWords); }
  }
  return json;
}
function toSheet(body) {
  if (!body || !body.edits) return body;
  const head = (tab, h) => (REAL.heads[tab] && REAL.heads[tab][h]) || h;
  return Object.assign({}, body, { edits: body.edits.map(e => Object.assign({}, e, {
    tab: REAL.tabs[e.tab] || e.tab,
    values: Object.fromEntries(Object.entries(e.values || {}).map(([h, v]) => [head(e.tab, h), v])),
    match: e.match ? { column: head(e.tab, e.match.column), value: e.match.value } : e.match,
    headers: e.headers ? e.headers.map(h => head(e.tab, h)) : e.headers,
  })) });
}

async function api(method, body) {
  if (!S.url || !S.key) throw new Error('Not linked to the sheet yet (⚙).');
  body = toSheet(body);
  const res = method === 'GET'
    ? await fetch(S.url + (S.url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(S.key), { redirect: 'follow' })
    : await fetch(S.url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ key: S.key }, body)) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(/<html|<!doctype/i.test(text) ? 'The sheet answered with a web page instead of data. Is the web app deployed with "Who has access: Anyone"?' : 'The sheet sent something unreadable.');
  }
  if (!json.ok) throw new Error(json.error || 'The sheet said no.');
  return fromSheet(json);
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
    if (where && rec) where.innerHTML = `<b>${REAL.tabs[rec.tab] || rec.tab}</b> tab, row ${rec.row}` + (isDirty(rec) ? ' · saving soon…' : ' · saved');
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
    // (a tab the sheet doesn't have yet is made with these columns)
    const headers = !(S.data.tabs && S.data.tabs[rec.tab]) && rec.tab === 'Action Cards' ? CARD_HEADERS : undefined;
    return { ref, tab: rec.tab, row: rec.isNew ? 0 : rec.row, match: rec.isNew || !matchH ? null : { column: matchH, value: rec.orig[matchH] }, values, status, headers, sent: { ...rec.cur } };
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
      if (!(S.data.tabs && S.data.tabs[tab])) moved = true;   // a new tab: reload to see it
      if (r.headers) { tabData(tab).headers = r.headers; moved = true; }   // a column was added: reload so every row lines up
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
  const u = parseUnlock(val(rec, 'unlock'));
  const sub = itemSub2(rec);
  return u.name ? '🔒 ' + sub : sub;
}
function itemSub2(rec) {
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
    case 'Masks': return [val(rec, 'id'), (val(rec, 'starting memories').split(',').filter(x => x.trim()).length) + ' memoriams'].filter(Boolean).join(' · ');
    case 'Action Cards': return [val(rec, 'id'), val(rec, 'symbol')].filter(Boolean).join(' · ');
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
  } else if (rec.tab === 'Masks') {
    const f = `mask_${val(rec, 'mask').trim()}.png`;
    t.style.background = 'none';
    t.appendChild(img(R.has(f) ? f : 'mask_blank.png'));
  } else if (rec.tab === 'Action Cards') {
    t.style.background = 'none';
    t.appendChild(actionCardEl(cardModel(rec), 21));
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
  if (UNLOCKABLE.includes(rec.tab)) {
    const u = parseUnlock(val(rec, 'unlock'));
    const ub = el('button', 'btn small req' + (u.name ? ' has' : ''));
    ub.textContent = u.name ? `🔒 ${u.name}` : 'Unlock condition';
    ub.title = 'An achievement that unlocks this: until it\'s done, this never turns up';
    ub.onclick = () => openUnlock(ref);
    head.appendChild(ub);
  }
  if (['Memories', 'Glimpses', 'Encounters'].includes(rec.tab)) {
    const n = parseRequirements(val(rec, 'requirements')).length;
    const rq = el('button', 'btn small req' + (n ? ' has' : ''));
    rq.textContent = n ? `Requirements (${n})` : 'Requirements';
    rq.title = 'When this can turn up (and when it never will)';
    rq.onclick = () => openRequirements(ref);
    head.appendChild(rq);
  }
  const dup = el('button', 'btn small'); dup.textContent = 'Duplicate'; dup.title = 'Start a new one from a copy of this'; dup.onclick = () => newItem(rec); head.appendChild(dup);
  form.appendChild(head);
  const where = el('div', 'where');
  where.innerHTML = rec.isNew ? 'New — goes to the bottom of the <b>' + rec.tab + '</b> tab' + (S.auto ? ' in a moment.' : ' when saved.')
    : `<b>${REAL.tabs[rec.tab] || rec.tab}</b> tab, row ${rec.row}` + (isDirty(rec) ? (S.auto ? ' · saving soon…' : ` · ${changedHeaders(rec).length} change(s) not saved`) : ' · saved');
  form.appendChild(where);

  const builders = { Memories: memoryForm, Glimpses: glimpseForm, Encounters: encounterForm, Keywords: keywordForm, Runes: runeForm, Masks: maskForm, 'Action Cards': actionCardForm };
  const used = new Set();
  builders[rec.tab](form, rec, used);
  const rqh = HR(rec, 'requirements'); if (rqh) used.add(rqh);   // (the Requirements button)
  const ulh = HR(rec, 'unlock'); if (ulh) used.add(ulh);         // (the Unlock button)
  // any other columns on the tab
  const statusH = H(rec.tab, 'status');
  const rest = tabData(rec.tab).headers.filter(h => h !== '' && !used.has(h) && h !== statusH);
  if (rest.length) {
    const fs = otherInfo(form);
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
  const h = HR(rec, key) || key;
  used && used.add(h);
  const f = el('div', 'f' + (isChanged(rec, h) ? ' changed' : ''));
  if (!opt.create && !tabData(rec.tab).headers.includes(h) && !(h in rec.cur)) { f.style.display = 'none'; return f; }
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
  _statusRedraw = draw;   // (a change elsewhere in the form can turn it to "Update")
  f.appendChild(row);
  return f;
}
let _statusRedraw = null;

/** Glimpses' memories as a datalist (for typing names). */
function ensureDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) { dl = el('datalist'); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = values.map(v => `<option value="${esc(v)}">`).join('');
}

// --- memories ---

function memoryForm(form, rec, used) {
  const top = fieldset(form, 'Memoriam');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  top.appendChild(statusField(rec, used));

  // stats down the left, runes down the right (as many as you like)
  const at = fieldset(form, 'Attributes & runes');
  const cols = el('div', 'two-col');
  const stats = el('div', 'statcol');
  for (const a of ['charm', 'grit', 'insight', 'guile']) {
    const h = H(rec.tab, a);
    if (!h) continue;
    used.add(h);
    const box = el('div', 'attr');
    box.title = a[0].toUpperCase() + a.slice(1);
    const minus = el('button'); minus.textContent = '−';
    const plus = el('button'); plus.textContent = '+';
    const v = el('div', 'v');
    const nm = el('div', 'name'); nm.textContent = box.title;
    const draw = () => { const n = Number((record(rec.ref) || rec).cur[h]) || 0; v.textContent = n || '–'; box.classList.toggle('set', n > 0); };
    const bump = d => { const n = Math.max(0, Math.min(9, (Number((record(rec.ref) || rec).cur[h]) || 0) + d)); setVal(rec.ref, h, n ? String(n) : ''); draw(); };
    minus.onclick = () => bump(-1); plus.onclick = () => bump(1);
    box.append(img(`ico_${a}.png`), nm, minus, v, plus);
    draw();
    stats.appendChild(box);
  }
  const runesCol = el('div', 'runecol');
  runesCol.innerHTML = '<div class="lbl">Runes</div>';
  const runeBox = el('div');
  runesCol.appendChild(runeBox);
  numbered(rec, 'rune').forEach(h => used.add(h));
  const runeLabels = (S.data.lists && S.data.lists.runes && S.data.lists.runes.length ? S.data.lists.runes : runeRows().map(r => r.name));
  const drawRunes = (focusLast) => {
    const cur = record(rec.ref) || rec;
    const list = runeList(cur);
    const shown = list.length ? [...list] : [''];
    runeBox.innerHTML = '';
    shown.forEach((value, i) => {
      const row = el('div', 'pickrow listrow');
      const icon = el('div', 'pickicon');
      const sel = el('select');
      const opts = [['', '— pick a rune —'], ...runeLabels.map(x => [x, x])];
      if (value && !runeLabels.includes(value)) opts.push([value, value + '  (not a listed choice)']);
      for (const [v, t] of opts) { const o = el('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
      sel.value = value;
      const drawIcon = () => { icon.innerHTML = ''; if (sel.value) { const r = findRune(sel.value); icon.appendChild(img(runeIcon(r))); icon.title = r ? r.name + ': ' + r.text : 'not on the Runes tab'; } };
      drawIcon();
      sel.onchange = () => {
        const now = runeList(record(rec.ref) || rec);
        if (i < now.length) now[i] = sel.value; else now.push(sel.value);
        setNumbered(rec.ref, 'rune', 'Rune', now.filter(Boolean));
        drawIcon();
        if (!sel.value) drawRunes();
      };
      const x = el('button', 'xbtn'); x.textContent = '×'; x.title = 'Remove this rune';
      x.onclick = () => { const now = runeList(record(rec.ref) || rec); now.splice(i, 1); setNumbered(rec.ref, 'rune', 'Rune', now); drawRunes(); };
      row.append(icon, sel, x);
      runeBox.appendChild(row);
      if (focusLast && i === shown.length - 1) setTimeout(() => sel.focus(), 0);
    });
  };
  drawRunes();
  const addRune = el('button', 'btn small addbtn'); addRune.textContent = '+ Add rune';
  addRune.onclick = () => {
    const list = runeList(record(rec.ref) || rec);
    if (!list.length) { toast('Pick the first rune, then add another.'); return; }
    // a blank row to pick in (saved once something's picked)
    drawRunes();
    const row = el('div', 'pickrow listrow');
    const icon = el('div', 'pickicon');
    const sel = el('select');
    for (const [v, t] of [['', '— pick a rune —'], ...runeLabels.map(x => [x, x])]) { const o = el('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
    sel.onchange = () => { if (!sel.value) return; setNumbered(rec.ref, 'rune', 'Rune', [...runeList(record(rec.ref) || rec), sel.value]); drawRunes(); };
    const x = el('button', 'xbtn'); x.textContent = '×'; x.onclick = () => row.remove();
    row.append(icon, sel, x);
    runeBox.appendChild(row);
    sel.focus();
  };
  runesCol.appendChild(addRune);
  cols.append(stats, runesCol);
  at.appendChild(cols);

  // ability tiles: one to start, add as many as you like
  const ab = fieldset(form, 'Ability tiles');
  const tileCols = numbered(rec, 'ability tile');
  tileCols.forEach(h => used.add(h));
  const texts = tileCols.map(h => String(rec.cur[h] ?? ''));
  while (texts.length && !texts[texts.length - 1].trim()) texts.pop();
  const showN = Math.max(1, texts.length, S.extraTiles && S.extraTiles.ref === rec.ref ? S.extraTiles.n : 0);
  for (let i = 0; i < showN; i++) {
    const h = tileCols.find(c => Number(c.trim().split(' ').pop()) === i + 1) || `Ability Tile ${i + 1}`;
    ab.appendChild(tileEditor(rec, h, `Ability ${i + 1}`, showN > 1 ? () => {
      const list = numbered(record(rec.ref) || rec, 'ability tile').map(c => String((record(rec.ref) || rec).cur[c] ?? ''));
      list.splice(i, 1);
      while (list.length && !list[list.length - 1].trim()) list.pop();
      if (S.extraTiles && S.extraTiles.ref === rec.ref) S.extraTiles.n = Math.max(0, S.extraTiles.n - 1);
      setNumbered(rec.ref, 'ability tile', 'Ability Tile', list);
      renderForm();
    } : null));
  }
  const addTile = el('button', 'btn small addbtn'); addTile.textContent = '+ Add ability';
  addTile.onclick = () => { S.extraTiles = { ref: rec.ref, n: showN + 1 }; renderForm(); const t = [...document.querySelectorAll('.tile-ed textarea')].pop(); if (t) t.focus(); };
  ab.appendChild(addTile);

  const more = fieldset(form, 'Start, dice & notes');
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'dice', 'Dice', { number: true, hint: '(number of d6)' }, used));
  r2.appendChild(textField(rec, 'starting sight', 'Starting sight', { number: true, hint: '(empty = 0–3 at random)' }, used));
  r2.appendChild(textField(rec, 'offered weight', 'Offered weight', { number: true, hint: '(1 if empty)' }, used));
  more.appendChild(r2);
  more.appendChild(textField(rec, 'mechanical clarification', 'Mechanical clarification', { area: true, hint: '(shown when you right-click it)' }, used));

  // filled in when it's brought into the game
  const other = otherInfo(form);
  other.appendChild(textField(rec, 'id', 'Id', {}, used));
  other.appendChild(tagsField(rec, used));
  other.appendChild(textField(rec, 'artwork', 'Artwork notes', {}, used));
}

/** The collapsed "Other info" section every form ends with (the leftover columns go in it too). */
function otherInfo(form) {
  let fs = form.querySelector('.other-info fieldset');
  if (!fs) {
    fs = fieldset(form, 'Other info', true);
    fs.parentElement.classList.add('other-info');
  }
  return fs;
}

function tileEditor(rec, h, label, onRemove) {
  const box = el('div', 'tile-ed' + (isChanged(rec, h) ? ' changed' : ''));
  const p = parseTile(rec.cur[h]);
  p.prefixFor = p.kw ? p.kw.id : null;
  const top = el('div', 'top');
  top.innerHTML = `<span class="lbl">${esc(label)}</span>`;
  const kwSel = el('select');
  // (memoriams have no Actions any more: the mask's action cards are the actions; an old "Action:" tile works as Land)
  const opts = [['none', 'No keyword — just text'], ['passive', 'Passive']];
  if (p.kind === 'action') opts.push(['action', 'Action (old — works as Land now)']);
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
  for (const s of ['Vanity', 'Fortitude', 'Aggression']) { const o = el('option'); o.value = s; o.textContent = s; stat.appendChild(o); }
  stat.value = /^ag/i.test(p.stat) ? 'Aggression' : /^(fad|fort)/i.test(p.stat) ? 'Fortitude' : 'Vanity';
  const icon = el('div', 'pickicon');
  top.append(icon, kwSel, stat, n);
  if (onRemove) { const x = el('button', 'xbtn'); x.textContent = '×'; x.title = 'Remove this ability'; x.onclick = onRemove; top.appendChild(x); }
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
  const m = glimpseModel(rec);
  const defaultInfo = { encounter: 'Fight', memory: 'New Memoriam' }[val(rec, 'kind').toLowerCase()] || (/^(y|yes)/i.test(val(rec, 'player picks a memory')) ? 'Tamper' : 'Event');
  top.appendChild(textField(rec, 'info line', 'Info line', { create: true, placeholder: defaultInfo, hint: '(the small line above the title, e.g. NEW MEMORY)' }, used));
  top.appendChild(textField(rec, 'title', 'Title', { big: true }, used));
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
  what.appendChild(textField(rec, 'what it does', 'What it does', { create: true, area: true, rows: 5,
    placeholder: 'Explain what happens when you pick it, mechanically.' }, used));
  if (!val(rec, 'what it does').trim() && val(rec, 'text').trim()) {
    const now = el('div', 'reads'); now.innerHTML = `<b>The game says now:</b> ${esc(val(rec, 'text'))}`; what.appendChild(now);
  }

  const other = otherInfo(form);
  other.appendChild(textField(rec, 'id', 'Id', {}, used));
  other.appendChild(selectField(rec, 'kind', 'Kind', [['effects', 'effects (an event)'], ['memory', 'memoriam (a new memoriam)'], ['encounter', 'encounter (a fight)']], used, { onchange: () => renderPreview() }));
  other.appendChild(textField(rec, 'text', 'In-game text', { area: true, rows: 2 }, used));
  other.appendChild(checkField(rec, 'player picks a memory', 'The player picks a memoriam for it (a “tamper”)', used));
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'cost', 'Cost', { placeholder: 'e.g. 1 bone' }, used));
  r2.appendChild(textField(rec, 'offered weight', 'Offered weight', { number: true }, used));
  r2.appendChild(textField(rec, 'from depth', 'From depth', { number: true }, used));
  r2.appendChild(textField(rec, 'to depth', 'To depth', { number: true }, used));
  other.appendChild(r2);
  other.appendChild(textField(rec, 'effects', 'Effects', { area: true, code: true }, used));
  other.appendChild(textField(rec, 'if you have', 'If you have', {}, used));
  other.appendChild(textField(rec, 'then also', 'Then also', { code: true }, used));
  other.appendChild(textField(rec, 'otherwise', 'Otherwise', { code: true }, used));
  other.appendChild(textField(rec, 'artwork', 'Artwork notes', {}, used));
}

// --- encounters ---

// A bar's type → the sheet's columns for it (one bar of each type per enemy)
const BAR_TYPES = [
  { type: 'aggression', label: 'Aggression', verb: 'Slay', need: 'to slay', reward: 'slay reward', word: 'aggression', stat: 'aggression' },
  { type: 'fortitude', label: 'Fortitude', verb: 'Sneak', need: 'to sneak', reward: 'sneak reward', word: 'fortitude', stat: 'fortitude', hint: 'heal this much' },
  { type: 'vanity', label: 'Vanity', verb: 'Soothe', need: 'to soothe', reward: 'soothe reward', word: 'vanity', stat: 'vanity' },
  { type: 'other', label: 'Other', verb: 'Other', need: 'to dismiss', reward: 'dismiss reward', word: '', stat: 'sight' },
];
const RESETS = /\s*\(resets\)|\s*,?\s*(?:then\s+)?resets? (?:this|the) bar\.?/ig;

/** Splits "A: x; B (each): y" (or, with newlines, "A: x\nB: y") into one part per enemy. */
function partsFor(text, enemies, lines) {
  text = String(text || '').trim();
  const out = enemies.map(() => '');
  if (!text) return out;
  if (enemies.length <= 1) { out[0] = text.replace(new RegExp('^\\s*' + (enemies[0] ? enemies[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '\\0') + '\\s*(?:\\(each\\))?\\s*:\\s*', 'i'), ''); return out; }
  const pieces = lines ? text.split(/\n+/) : text.split(/;\s*/);
  let any = false, last = -1;
  for (const piece of pieces) {
    const m = piece.match(/^\s*([^:]+?)(?:\s*\(each\))?\s*:\s*([\s\S]*)$/);
    const i = m ? enemies.findIndex(e => e.name.toLowerCase() === m[1].trim().toLowerCase()) : -1;
    if (i >= 0) { out[i] = m[2].trim(); any = true; last = i; }
    else if (last >= 0 && lines) out[last] += '\n' + piece;
  }
  if (!any) return enemies.map(() => text);   // one value for all of them
  return out;
}
/** The other way round: one part per enemy → a cell ("A: x; B (each): y"), or just "x" when they're all the same. */
function joinParts(values, enemies, lines) {
  if (enemies.length <= 1) return values[0] || '';
  if (values.every(v => v && v === values[0])) return values[0];
  return values.map((v, i) => v ? `${enemies[i].name}${enemies[i].count > 1 ? ' (each)' : ''}: ${v}` : '').filter(Boolean).join(lines ? '\n' : '; ');
}

/** Reads an encounter row into enemies: [{ name, count, intents:[], about, bars:[{type, need, reward, reset}] }]. */
function readEnemies(rec) {
  const enemies = val(rec, 'enemies').split(/,\s*/).map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^(\d+)\s*[×x]\s*(.+)$/i);
    return { name: m ? m[2].trim() : x, count: m ? Number(m[1]) : 1, intents: [], about: '', bars: [] };
  });
  if (!enemies.length) enemies.push({ name: '', count: 1, intents: [], about: '', bars: [] });
  partsFor(val(rec, 'intents'), enemies).forEach((t, i) => { enemies[i].intents = t.split(/\s*(?:→|->)\s*/).map(x => x.trim()).filter(Boolean); });
  partsFor(val(rec, 'what they do'), enemies, true).forEach((t, i) => { enemies[i].about = t; });
  for (const bt of BAR_TYPES) {
    const needs = partsFor(val(rec, bt.need), enemies), rewards = partsFor(val(rec, bt.reward), enemies);
    enemies.forEach((e, i) => {
      const n = (needs[i].match(/(\d+)/) || [])[1];
      if (!n && !rewards[i]) return;
      RESETS.lastIndex = 0;
      const reset = RESETS.test(rewards[i]);
      e.bars.push({ type: bt.type, need: n || '', reward: rewards[i].replace(RESETS, '').trim(), reset });
    });
  }
  return enemies;
}
/** Writes enemies back into the encounter's columns. */
function writeEnemies(ref, enemies) {
  const list = enemies.filter(e => e.name.trim() || e.intents.length || e.about.trim() || e.bars.length);
  const named = list.map(e => ({ ...e, name: e.name.trim() || 'Unnamed enemy', count: Math.max(1, Number(e.count) || 1) }));
  const set = (key, v) => { const rec = record(real(ref)); if (val(rec, key) !== v) setVal(ref, HR(rec, key) || key, v); };
  set('enemies', named.map(e => e.count > 1 ? `${e.count} × ${e.name}` : e.name).join(', '));
  set('intents', joinParts(named.map(e => e.intents.filter(x => x.trim()).join(' → ')), named));
  set('what they do', joinParts(named.map(e => e.about.trim()), named, true));
  for (const bt of BAR_TYPES) {
    const bar = e => e.bars.find(b => b.type === bt.type);
    set(bt.need, joinParts(named.map(e => bar(e) && bar(e).need !== '' ? `${bar(e).need}${bt.word ? ' ' + bt.word : ''}` : ''), named));
    set(bt.reward, joinParts(named.map(e => bar(e) ? `${bar(e).reward.trim()}${bar(e).reset ? ' (resets)' : ''}`.trim() : ''), named));
  }
}

function encounterForm(form, rec, used) {
  ensureDatalist('enemyNames', Object.keys(R.AD.enemies).map(k => k.replace(/\b\w/g, c => c.toUpperCase())));
  const top = fieldset(form, 'Encounter');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  const r = el('div', 'row');
  r.appendChild(textField(rec, 'depth', 'Depth', { placeholder: '1–4' }, used));
  r.appendChild(textField(rec, 'how often', 'Weight', { number: true, hint: '(how often)' }, used));
  r.appendChild(textField(rec, 'rounds', 'Rounds', { hint: '(timed fight)' }, used));
  top.appendChild(r);
  top.appendChild(statusField(rec, used));

  for (const k of ['enemies', 'intents', 'what they do', ...BAR_TYPES.flatMap(b => [b.need, b.reward])]) { const h = HR(rec, k); if (h) used.add(h); }
  const enemies = readEnemies(rec);
  const write = () => writeEnemies(rec.ref, enemies);
  const box = el('div', 'enemies');
  form.appendChild(box);
  const draw = () => {
    box.innerHTML = '';
    enemies.forEach((e, ei) => {
      const fs = el('fieldset', 'enemy');
      fs.innerHTML = `<legend>Enemy ${ei + 1}${e.name ? ' — ' + esc(e.name) : ''}</legend>`;
      // who
      const who = el('div', 'row');
      const nameF = el('div', 'f'); nameF.style.flex = '3';
      nameF.innerHTML = '<label>Enemy</label>';
      const nameI = el('input'); nameI.type = 'text'; nameI.value = e.name; nameI.setAttribute('list', 'enemyNames'); nameI.placeholder = 'Hollow Pilgrim';
      nameI.oninput = () => { e.name = nameI.value; fs.querySelector('legend').textContent = `Enemy ${ei + 1}${e.name ? ' — ' + e.name : ''}`; write(); };
      nameF.appendChild(nameI);
      const countF = el('div', 'f'); countF.style.flex = '0 0 90px';
      countF.innerHTML = '<label>How many</label>';
      const countI = el('input'); countI.type = 'number'; countI.min = 1; countI.value = e.count;
      countI.oninput = () => { e.count = Number(countI.value) || 1; write(); };
      countF.appendChild(countI);
      who.append(nameF, countF);
      if (enemies.length > 1) {
        const x = el('button', 'xbtn big'); x.textContent = '×'; x.title = 'Remove this enemy';
        x.onclick = () => { if (!confirm(`Remove ${e.name || 'this enemy'} from the encounter?`)) return; enemies.splice(ei, 1); write(); draw(); };
        who.appendChild(x);
      }
      fs.appendChild(who);

      // intent tiles
      const it = el('div', 'f');
      it.innerHTML = '<label>Intent tiles <span class="hint">(in order, one each turn: “Lash (Attack 4)”)</span></label>';
      const itBox = el('div', 'intents-ed');
      const shownIntents = e.intents.length ? e.intents : [''];
      shownIntents.forEach((t, ii) => {
        const row = el('div', 'listrow intent-row');
        const n = el('span', 'num'); n.textContent = ii + 1;
        const inp = el('input'); inp.type = 'text'; inp.value = t; inp.placeholder = 'Name (what it does, Attack N)';
        inp.oninput = () => { if (!e.intents.length) e.intents.push(''); e.intents[ii] = inp.value; write(); };
        row.append(n, inp);
        if (shownIntents.length > 1) { const x = el('button', 'xbtn'); x.textContent = '×'; x.onclick = () => { e.intents.splice(ii, 1); write(); draw(); }; row.appendChild(x); }
        itBox.appendChild(row);
      });
      const addI = el('button', 'btn small addbtn'); addI.textContent = '+ Add intent';
      addI.onclick = () => { if (!e.intents.length) e.intents.push(''); e.intents.push(''); draw(); const ins = box.querySelectorAll('fieldset.enemy')[ei].querySelectorAll('.intent-row input'); if (ins.length) ins[ins.length - 1].focus(); };
      it.append(itBox, addI);
      fs.appendChild(it);

      // what it does
      const ab = el('div', 'f');
      ab.innerHTML = '<label>What it does <span class="hint">(its passives and anything special)</span></label>';
      const ta = el('textarea'); ta.rows = 3; ta.value = e.about;
      ta.oninput = () => { e.about = ta.value; write(); };
      ab.appendChild(ta);
      fs.appendChild(ab);

      // bars
      const bars = el('div', 'f');
      bars.innerHTML = '<label>Bars <span class="hint">(type · how much · what you get · reset when filled)</span></label>';
      if (!e.bars.length) e.bars.push({ type: 'aggression', need: '', reward: '', reset: false });   // starts with one (an empty one isn't saved)
      const shownBars = e.bars;
      shownBars.forEach((b, bi) => {
        const row = el('div', 'bar-row');
        const type = el('select');
        for (const bt of BAR_TYPES) { const o = el('option'); o.value = bt.type; o.textContent = bt.label; type.appendChild(o); }
        type.value = b.type;
        const ic = el('div', 'pickicon');
        const drawIc = () => { ic.innerHTML = ''; const bt = BAR_TYPES.find(x => x.type === type.value); ic.appendChild(img(R.iconFile(bt.stat === 'sight' ? 'sight' : bt.stat))); };
        drawIc();
        const need = el('input'); need.type = 'number'; need.min = 0; need.value = b.need; need.placeholder = 'N';
        need.title = type.value === 'fortitude' ? 'Fortitude to gain (heal) this fight' : 'How much';
        const rw = el('input'); rw.type = 'text'; rw.value = b.reward; rw.placeholder = 'What you get (e.g. 2 stone)';
        const rs = el('label', 'check small'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!b.reset; rs.append(cb, document.createTextNode('Reset'));
        rs.title = 'The bar empties and can be filled again (otherwise it pays out once)';
        const x = el('button', 'xbtn'); x.textContent = '×'; x.title = 'Remove this bar';
        type.onchange = () => {
          if (e.bars.some((o, oi) => oi !== bi && o.type === type.value)) { toast(`${e.name || 'This enemy'} already has a ${type.value} bar: one of each type per enemy.`, true); type.value = b.type; return; }
          b.type = type.value; drawIc(); write();
        };
        need.oninput = () => { b.need = need.value; write(); };
        rw.oninput = () => { b.reward = rw.value; write(); };
        cb.onchange = () => { b.reset = cb.checked; write(); };
        x.onclick = () => { e.bars.splice(bi, 1); write(); draw(); };
        row.append(ic, type, need, rw, rs, x);
        bars.appendChild(row);
      });
      const addB = el('button', 'btn small addbtn'); addB.textContent = '+ Add bar';
      addB.onclick = () => {
        const free = BAR_TYPES.find(bt => !e.bars.some(b => b.type === bt.type));
        if (!free) { toast('It already has one bar of each type.'); return; }
        e.bars.push({ type: free.type, need: '', reward: '', reset: false });
        draw();
        const rowsNow = box.querySelectorAll('fieldset.enemy')[ei].querySelectorAll('.bar-row input[type=number]'); if (rowsNow.length) rowsNow[rowsNow.length - 1].focus();
      };
      bars.appendChild(addB);
      fs.appendChild(bars);
      box.appendChild(fs);
    });
    const addE = el('button', 'btn addbtn add-enemy'); addE.textContent = '+ Add enemy';
    addE.onclick = () => { enemies.push({ name: '', count: 1, intents: [], about: '', bars: [{ type: 'aggression', need: '', reward: '', reset: false }] }); draw(); const ins = box.querySelectorAll('fieldset.enemy'); ins[ins.length - 1].querySelector('input').focus(); };
    box.appendChild(addE);
  };
  draw();

  const other = otherInfo(form);
  other.appendChild(textField(rec, 'id', 'Id', {}, used));
  other.appendChild(checkField(rec, 'boss', 'Boss', used));
  const r2 = el('div', 'row');
  r2.appendChild(textField(rec, 'music', 'Music', {}, used));
  r2.appendChild(textField(rec, 'enemy memory', 'Enemy memoriam', {}, used));
  other.appendChild(r2);
  other.appendChild(textField(rec, 'if the clock runs out', 'If the clock runs out', {}, used));
  other.appendChild(textField(rec, 'traits', 'Traits & rules (the game\'s text)', { area: true, rows: 2 }, used));
  other.appendChild(textField(rec, 'notes', 'Notes / flavour', { area: true }, used));
  other.appendChild(textField(rec, 'artwork', 'Artwork notes', {}, used));
}

// --- masks ---

/** Every memory a mask could start with: the Memories tab's, and the ones that aren't on it (Grey Space...). */
function allMemoryNames() {
  const names = new Set(records('Memories').map(r => val(r, 'name').trim()).filter(Boolean));
  for (const n of Object.keys(R.AD.builtinMemories || {})) names.add(n);
  return [...names].sort();
}
/** "Name (banner): what it does" → { name, banner, text } */
function parseAction(t) {
  const m = String(t || '').match(/^\s*([^:(]+?)\s*(?:\(([\w ]+)\))?\s*:\s*([\s\S]*)$/);
  return m ? { name: m[1].trim(), banner: (m[2] || '').trim(), text: m[3].trim() } : { name: '', banner: '', text: String(t || '').trim() };
}
const writeAction = a => !a.name.trim() && !a.text.trim() ? '' : `${a.name.trim() || 'Action'}${a.banner ? ` (${a.banner})` : ''}: ${a.text.trim()}`;
const writePassive = a => !a.name.trim() && !a.text.trim() ? '' : `${a.name.trim() || 'Passive'}: ${a.text.trim()}`;

function attrSteppers(rec, used, box) {
  for (const a of ['charm', 'grit', 'insight', 'guile']) {
    const h = HR(rec, a) || a;
    used.add(h);
    const b = el('div', 'attr');
    b.title = a[0].toUpperCase() + a.slice(1);
    const minus = el('button'); minus.textContent = '−';
    const plus = el('button'); plus.textContent = '+';
    const v = el('div', 'v');
    const nm = el('div', 'name'); nm.textContent = b.title;
    const draw = () => { const n = Number((record(rec.ref) || rec).cur[h]) || 0; v.textContent = n || '–'; b.classList.toggle('set', n > 0); };
    const bump = d => { const n = Math.max(0, Math.min(9, (Number((record(rec.ref) || rec).cur[h]) || 0) + d)); setVal(rec.ref, h, n ? String(n) : ''); draw(); };
    minus.onclick = () => bump(-1); plus.onclick = () => bump(1);
    b.append(img(`ico_${a}.png`), nm, minus, v, plus);
    draw();
    box.appendChild(b);
  }
}

function maskForm(form, rec, used) {
  ensureDatalist('memoryNames', allMemoryNames());
  const top = fieldset(form, 'Mask');
  top.appendChild(textField(rec, 'name', 'Name', { big: true }, used));
  top.appendChild(statusField(rec, used));

  const look = fieldset(form, 'Look');
  const mh = HR(rec, 'mask') || 'mask';
  used.add(mh);
  const pf = el('div', 'f');
  pf.innerHTML = '<label>Mask</label>';
  const grid = el('div', 'glyphs masks');
  const drawPics = () => {
    grid.innerHTML = '';
    const cur = String((record(rec.ref) || rec).cur[mh] ?? '').trim();
    // (not the wooden masks or the mask token: those aren't mask looks)
    const notLooks = new Set(['empty', 'maw', 'rot', 'spite', 'tendril', 'token']);
    for (const f of R.AD.files.filter(x => /^mask_.*\.png$/.test(x) && !notLooks.has(x.slice(5, -4)))) {
      const name = f.slice(5, -4);
      const b = el('button', 'glyph' + (cur === name ? ' on' : ''));
      b.title = name; b.appendChild(img(f));
      b.onclick = () => { setVal(rec.ref, mh, name); drawPics(); };
      grid.appendChild(b);
    }
  };
  drawPics();
  pf.appendChild(grid);
  look.appendChild(pf);
  look.appendChild(textField(rec, 'flavor', 'Flavour line', { placeholder: 'Every scatter is a dare.' }, used));

  const st = fieldset(form, 'Start of a run');
  const sh = HR(rec, 'starting memories') || 'starting memories';
  used.add(sh);
  const cols = el('div', 'two-col');
  const left = el('div', 'statcol');
  attrSteppers(rec, used, left);
  const right = el('div');
  right.innerHTML = '<div class="lbl">Starting memoriams</div>';
  const memBox = el('div');
  right.appendChild(memBox);
  const list = () => String((record(rec.ref) || rec).cur[sh] ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const drawMems = () => {
    memBox.innerHTML = '';
    const shown = list().length ? list() : [''];
    shown.forEach((name, i) => {
      const row = el('div', 'listrow');
      const inp = el('input'); inp.type = 'text'; inp.value = name; inp.setAttribute('list', 'memoryNames'); inp.placeholder = 'a memoriam';
      inp.onchange = () => { const l = list(); if (i < l.length) l[i] = inp.value.trim(); else l.push(inp.value.trim()); setVal(rec.ref, sh, l.filter(Boolean).join(', ')); drawMems(); };
      const x = el('button', 'xbtn'); x.textContent = '×';
      x.onclick = () => { const l = list(); l.splice(i, 1); setVal(rec.ref, sh, l.join(', ')); drawMems(); };
      row.append(inp, x);
      memBox.appendChild(row);
    });
  };
  drawMems();
  const addM = el('button', 'btn small addbtn'); addM.textContent = '+ Add memoriam';
  addM.onclick = () => { const row = el('div', 'listrow'); const inp = el('input'); inp.type = 'text'; inp.setAttribute('list', 'memoryNames'); inp.placeholder = 'a memoriam';
    inp.onchange = () => { if (inp.value.trim()) { setVal(rec.ref, sh, [...list(), inp.value.trim()].join(', ')); drawMems(); } };
    row.appendChild(inp); memBox.appendChild(row); inp.focus(); };
  right.appendChild(addM);
  right.appendChild(textField(rec, 'random memories', 'Random memoriams', { number: true, hint: '(as well, all different)' }, used));
  cols.append(left, right);
  st.appendChild(cols);

  // its action cards (any number, repeats allowed, by name from the Action Cards tab), dealt at the start of a run
  const acts = fieldset(form, 'Action cards');
  numbered(rec, 'action').forEach(h => used.add(h));
  const deck = maskCards(rec);
  const extra = S.extraActs && S.extraActs.ref === rec.ref ? S.extraActs.n : 0;
  const names = cardRecords().map(r => val(r, 'name').trim()).filter(Boolean);
  const row = el('div', 'card-picks');
  const writeDeck = list => { setNumbered(rec.ref, 'action', 'action', list.filter(Boolean)); renderForm(); };
  const slots = [...deck, ...Array(Math.max(deck.length ? 0 : 1, extra)).fill('')];
  slots.forEach((cur, i) => {
    const box = el('div', 'card-pick');
    const pic = el('div', 'pic');
    const c = findCard(cur);
    if (c) pic.appendChild(actionCardEl(c, 92));
    const sel = el('select');
    const opts = ['', ...names];
    if (cur && !opts.some(n => n.toLowerCase() === cur.toLowerCase())) opts.push(cur);
    for (const n of opts) { const o = el('option'); o.value = n; o.textContent = n || '(pick a card)'; sel.appendChild(o); }
    sel.value = opts.find(n => n.toLowerCase() === cur.toLowerCase()) ?? '';
    sel.onchange = () => {
      const list = [...deck];
      if (i < deck.length) list[i] = sel.value; else { list.push(sel.value); if (S.extraActs) S.extraActs.n = Math.max(0, S.extraActs.n - 1); }
      writeDeck(list);
    };
    box.append(pic, sel);
    const x = el('button', 'xbtn'); x.textContent = '×'; x.title = 'Take this card off the mask';
    x.onclick = () => { if (i < deck.length) { const list = [...deck]; list.splice(i, 1); writeDeck(list); } else { if (S.extraActs) S.extraActs.n = Math.max(0, S.extraActs.n - 1); renderForm(); } };
    box.appendChild(x);
    row.appendChild(box);
  });
  acts.appendChild(row);
  const add = el('button', 'btn small addbtn'); add.textContent = '+ Add a card';
  add.onclick = () => { S.extraActs = { ref: rec.ref, n: extra + 1 }; renderForm(); };
  acts.appendChild(add);
  const note = el('div', 'hint'); note.textContent = 'Any number of cards, and the same card more than once if you like. Each costs 1 action and can be used once per round. Make or change cards on the Action Cards tab.'; acts.appendChild(note);

  const pas = fieldset(form, 'Passives');
  const pasCols = [1, 2, 3].map(i => HR(rec, 'passive ' + i) || 'passive ' + i);
  pasCols.forEach(h => used.add(h));
  const filledPas = pasCols.filter(h => String(rec.cur[h] ?? '').trim()).length;
  const showPas = Math.max(filledPas, S.extraPas && S.extraPas.ref === rec.ref ? S.extraPas.n : 0);
  for (let i = 0; i < Math.min(3, showPas); i++) {
    const h = pasCols[i];
    const a = parseAction(rec.cur[h]);
    const box = el('div', 'tile-ed');
    const nm = el('input'); nm.type = 'text'; nm.value = a.name; nm.placeholder = 'Name (e.g. Vanish)';
    const ta = el('textarea'); ta.value = a.text; ta.placeholder = 'What it does, all the time';
    const write = () => { a.name = nm.value; a.text = ta.value; setVal(rec.ref, h, writePassive(a)); };
    nm.oninput = write; ta.oninput = write;
    const top2 = el('div', 'top'); top2.appendChild(nm);
    const x = el('button', 'xbtn'); x.textContent = '×'; x.onclick = () => {
      const vals = pasCols.map(c => String((record(rec.ref) || rec).cur[c] ?? '')); vals.splice(i, 1); vals.push('');
      pasCols.forEach((c, k) => { if (String((record(rec.ref) || rec).cur[c] ?? '') !== vals[k]) setVal(rec.ref, c, vals[k]); });
      if (S.extraPas && S.extraPas.ref === rec.ref) S.extraPas.n--; renderForm(); };
    top2.appendChild(x);
    box.append(top2, ta);
    pas.appendChild(box);
  }
  if (showPas < 3) { const add = el('button', 'btn small addbtn'); add.textContent = '+ Add passive'; add.onclick = () => { S.extraPas = { ref: rec.ref, n: showPas + 1 }; renderForm(); }; pas.appendChild(add); }

  const other = otherInfo(form);
  other.appendChild(textField(rec, 'id', 'Id', {}, used));
  other.appendChild(textField(rec, 'text', 'In-game summary', { area: true, rows: 2 }, used));
  other.appendChild(textField(rec, 'artwork', 'Artwork notes', {}, used));
}

function previewMask(stage, rec) {
  const f = `mask_${val(rec, 'mask').trim()}.png`;
  const wrap = el('div', 'mask-pv');
  const pic = el('div', 'mask-pic');
  pic.appendChild(img(R.has(f) ? f : 'mask_blank.png'));
  wrap.appendChild(pic);
  const name = el('div', 'mask-name'); name.textContent = val(rec, 'name').toUpperCase(); wrap.appendChild(name);
  if (val(rec, 'flavor')) { const fl = el('div', 'mask-flavor'); fl.textContent = val(rec, 'flavor'); wrap.appendChild(fl); }
  const attrs = el('div', 'gchips');
  for (const a of ['charm', 'grit', 'insight', 'guile']) {
    const n = Number(val(rec, a)) || 0; if (!n) continue;
    const b = el('div', 'gattr'); b.appendChild(img(`ico_${a}.png`, { position: 'absolute', left: 0, top: 0, width: '40px', height: '40px' }));
    const num = el('div', 'gattrnum'); num.textContent = '+' + n; b.appendChild(num); attrs.appendChild(b);
  }
  if (attrs.children.length) wrap.appendChild(attrs);
  const acts = el('div', 'mask-acts');
  for (const n of maskCards(rec)) {
    const card = findCard(n);
    const c = el('div', 'mask-act');
    if (card) c.appendChild(actionCardEl(card, 74));
    const t = el('div'); t.innerHTML = `<b>${esc(card ? card.name : n)}</b><span>${card ? R.iconText(card.text, 16) : '(no card by that name on the Action Cards tab)'}</span>`;
    c.appendChild(t);
    acts.appendChild(c);
  }
  wrap.appendChild(acts);
  stage.appendChild(wrap);
  const notes = el('div', 'pv-notes');
  const bits = [];
  for (const i of [1, 2, 3]) { const p = parseAction(val(rec, 'passive ' + i)); if (p.name || p.text) bits.push(`<div class="glos"><b>${esc(p.name)}</b> (passive) — ${R.iconText(p.text, 16)}</div>`); }
  const mems = val(rec, 'starting memories').split(',').map(x => x.trim()).filter(Boolean);
  const rnd = Number(val(rec, 'random memories')) || 0;
  bits.push(`<h4>You start with</h4><p>${mems.map(esc).join(', ') || 'no set memoriams'}${rnd ? `, and ${rnd} random memoriam${rnd === 1 ? '' : 's'}` : ''}.</p>`);
  notes.innerHTML = bits.join('');
  stage.appendChild(notes);
  // the starting memories, as cards
  const row = el('div', 'mask-cards');
  stage.appendChild(row);
  for (const n of mems) {
    const r = records('Memories').find(x => val(x, 'name').trim().toLowerCase() === n.toLowerCase());
    if (r) { const card = R.memoryCard(memoryModel(r)); row.appendChild(scaledCard(card, 0.62)); R.layoutCard(card); }
    else { const builtin = (R.AD.builtinMemories || {})[n]; const card = R.memoryCard({ id: builtin || '', name: n, attributes: {}, runes: [], tiles: [], dice: 0 }); row.appendChild(scaledCard(card, 0.62)); R.layoutCard(card); }
  }
}

// --- action cards ---

/** The ink symbols (Art/ink_*.png) and the parchments (Art/paper_*.png, not the _over layers). */
const inkNames = () => R.AD.files.filter(f => /^ink_.*\.png$/.test(f)).map(f => f.slice(4, -4));
const paperNames = () => R.AD.files.filter(f => /^paper_.*\.png$/.test(f) && !/_over\.png$/.test(f)).map(f => f.slice(6, -4));
function cardRecords() { return S.data && S.data.tabs && S.data.tabs['Action Cards'] ? records('Action Cards') : []; }
function cardModel(rec) { return { id: val(rec, 'id'), name: val(rec, 'name'), symbol: val(rec, 'symbol').trim(), paper: val(rec, 'paper').trim(), text: val(rec, 'text'), target: val(rec, 'target') }; }
/** A mask's "action N" cell: the card's name. (An old one read "Name (art): what it does".) */
function cardName(cell) { const t = String(cell || '').trim(); const a = parseAction(t); return (a.name || t).trim(); }
/** A mask's cards, in order (the "action 1", "action 2"... columns; repeats allowed). */
function maskCards(rec) { return numbered(rec, 'action').map(h => cardName(rec.cur[h])).filter(Boolean); }
function findCard(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const r = cardRecords().find(x => val(x, 'name').trim().toLowerCase() === n || val(x, 'id').trim().toLowerCase() === n);
  return r ? cardModel(r) : null;
}

/** An action card drawn the way the game draws it: the parchment, its name in ink, the ink symbol under it, and
 *  the parchment's wax, tears, chains... over both. w = the card's width in px. */
function actionCardEl(c, w) {
  const k = w / 300, h = 420 * k, m = 40 * k;
  const box = el('div', 'acard', { width: w + 'px', height: h + 'px' });
  const paper = R.has(`paper_${c.paper}.png`) ? c.paper : 'plain';
  const layer = f => img(f, { position: 'absolute', left: -m + 'px', top: -m + 'px', width: w + 2 * m + 'px', height: h + 2 * m + 'px' });
  box.appendChild(layer(`paper_${paper}.png`));
  const sym = String(c.symbol || '').trim().toLowerCase().replace(/ /g, '_');
  const sf = R.has(`ink_${sym}.png`) ? `ink_${sym}.png` : 'ink_spiral.png';
  const s = w * 0.6;
  box.appendChild(img(sf, { position: 'absolute', left: (w - s) / 2 + 'px', top: h * 0.58 - s / 2 + 'px', width: s + 'px', height: s + 'px', objectFit: 'contain', opacity: 0.93 }));
  if (w >= 40) { const nm = el('div', 'acard-name', { top: h * 0.2 - 17 * k / 0.453 + 'px', fontSize: Math.max(7, 17 * w / 136) + 'px' }); nm.textContent = c.name; box.appendChild(nm); }
  if (R.has(`paper_${paper}_over.png`)) box.appendChild(layer(`paper_${paper}_over.png`));
  return box;
}

function actionCardForm(form, rec, used) {
  const top = fieldset(form, 'Action card');
  top.appendChild(textField(rec, 'name', 'Name', { big: true, create: true }, used));
  top.appendChild(statusField(rec, used));
  const look = fieldset(form, 'Look');
  const sh = HR(rec, 'symbol') || 'symbol';
  used.add(sh);
  const f = el('div', 'f');
  f.innerHTML = '<label>Ink symbol <span class="hint">(drawn under the name)</span></label>';
  const wrap = el('div', 'ink-pick');
  const sel = el('select');
  const prev = el('div', 'ink-prev');
  const curSym = () => String((record(rec.ref) || rec).cur[sh] ?? '').trim();
  const names = inkNames();
  if (curSym() && !names.includes(curSym())) names.unshift(curSym());
  for (const n of names) { const o = el('option'); o.value = n; o.textContent = n.replace(/_/g, ' '); sel.appendChild(o); }
  const draw = () => { prev.innerHTML = ''; if (R.has(`ink_${curSym()}.png`)) prev.appendChild(img(`ink_${curSym()}.png`)); };
  sel.value = curSym() || 'spiral';
  sel.onchange = () => { setVal(rec.ref, sh, sel.value); draw(); };
  draw();
  wrap.append(sel, prev);
  f.appendChild(wrap);
  look.appendChild(f);
  look.appendChild(selectField(rec, 'paper', 'Parchment', paperNames(), used, { hint: '(its border: wax, tears, frost...)' }));
  const what = fieldset(form, 'What it does');
  what.appendChild(selectField(rec, 'target', 'Used on', [['has_sight', 'a memoriam with sight'], ['no_sight', 'a memoriam with no sight'], ['any', 'any memoriam'], ['none', 'no memoriam (it just happens)']], used));
  what.appendChild(textField(rec, 'text', 'Card text', { area: true, rows: 3, create: true, placeholder: 'Clear 1 sight from a memoriam...' }, used));
  what.appendChild(textField(rec, 'how it works', 'How it works', { area: true, rows: 2, hint: '(for whoever builds it: scatter, or the code it needs)' }, used));
  const other = otherInfo(form);
  other.appendChild(textField(rec, 'id', 'Id', { create: true }, used));
  other.appendChild(textField(rec, 'mechanical clarification', 'Mechanical clarification', { area: true }, used));
}

function previewActionCard(stage, rec) {
  const c = cardModel(rec);
  const big = el('div', 'acard-pv');
  big.appendChild(actionCardEl(c, 210));
  const g = el('div', 'glossary');
  const tgt = { has_sight: 'Used on a memoriam with sight.', no_sight: 'Used on a memoriam with no sight.', any: 'Used on any memoriam.', none: 'It picks no memoriam.' }[c.target.trim()] || '';
  g.innerHTML = `<div class="h">${esc(c.name)}</div><div class="b">${R.iconText(c.text, 18)}<br><span class="dim">${esc(tgt)} Uses 1 action. Once per round.</span></div>`;
  big.appendChild(g);
  stage.appendChild(big);
  const masks = records('Masks').filter(m => maskCards(m).some(n => n.toLowerCase() === c.name.trim().toLowerCase()));
  const n = el('div', 'pv-notes');
  n.innerHTML = masks.length ? `<h4>Dealt by</h4><p>${masks.map(m => esc(val(m, 'name'))).join(', ')}</p>` : '<h4>Dealt by</h4><p>No mask yet (it can still be gained).</p>';
  stage.appendChild(n);
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

// ----- requirements -------------------------------------------------------------------------------------

/** "Only if: you have Spiteful King Upon His Throne" / "Never if: you've fought the Hollow Pilgrim", one per line. */
function parseRequirements(text) {
  return String(text || '').split(/\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(only if|never if)\s*:\s*([\s\S]*)$/i);
    return m ? { never: /^never/i.test(m[1]), text: m[2].trim() } : { never: false, text: l };
  });
}
const writeRequirements = list => list.filter(r => r.text.trim()).map(r => `${r.never ? 'Never if' : 'Only if'}: ${r.text.trim()}`).join('\n');

// ----- unlock (an achievement) -------------------------------------------------------------------------

/** "Achievement: Name / Description: ... / How: ... / Mystery: yes", one per line (as the game reads it). */
function parseUnlock(text) {
  const u = { name: '', description: '', how: '', mystery: false };
  let key = null;
  for (const raw of String(text || '').split('\n')) {
    const m = raw.match(/^\s*(achievement|name|description|how|mystery)\s*:\s*(.*)$/i);
    if (m) { key = m[1].toLowerCase(); if (key === 'achievement') key = 'name'; }
    if (!key) continue;
    const v = m ? m[2] : '\n' + raw;
    if (key === 'mystery') u.mystery = /^(y|yes|true|1|x)$/i.test(v.trim());
    else u[key] = (u[key] + v);
  }
  for (const k of ['name', 'description', 'how']) u[k] = u[k].trim();
  return u;
}
const writeUnlock = u => !u.name.trim() && !u.description.trim() && !u.how.trim() ? ''
  : [`Achievement: ${u.name.trim()}`, `Description: ${u.description.trim()}`, `How: ${u.how.trim()}`, `Mystery: ${u.mystery ? 'yes' : 'no'}`].join('\n');

function openUnlock(ref) {
  const rec = record(real(ref));
  const u = parseUnlock(val(rec, 'unlock'));
  let d = document.getElementById('reqDialog');
  if (d) d.remove();
  d = el('dialog'); d.id = 'reqDialog';
  d.innerHTML = `<h3>Unlock condition</h3><p class="dim">An achievement unlocks this: until you've done it, <b>${esc(itemTitle(rec))}</b>
    never turns up. It's listed under Achievements on the game's home screen.</p>`;
  const save = () => setVal(real(ref), 'unlock', writeUnlock(u));
  const field = (label, key, area, ph) => {
    const f = el('div', 'f');
    f.innerHTML = `<label>${label}</label>`;
    const inp = area ? el('textarea') : el('input');
    if (!area) inp.type = 'text'; else inp.rows = 2;
    inp.value = u[key]; inp.placeholder = ph;
    inp.oninput = () => { u[key] = inp.value; save(); };
    f.appendChild(inp);
    d.appendChild(f);
    return inp;
  };
  const first = field('Achievement name', 'name', false, 'e.g. The Long Walk');
  field('Description <span class="hint">(what the player reads)</span>', 'description', true, 'e.g. Reach the deepest glimpse.');
  field('How you unlock it <span class="hint">(exactly what has to happen; the game is made to check this)</span>', 'how', true, 'e.g. reach depth 12 in any run');
  const my = el('label', 'check');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = u.mystery;
  cb.onchange = () => { u.mystery = cb.checked; save(); };
  my.append(cb, document.createTextNode(' Mystery: only its name shows until it\'s done (the description reads ???)'));
  d.appendChild(my);
  const actions = el('div', 'actions');
  const rm = el('button', 'btn small danger'); rm.textContent = 'No unlock (always available)';
  rm.onclick = () => { u.name = u.description = u.how = ''; u.mystery = false; save(); d.close(); };
  const done = el('button', 'btn primary'); done.textContent = 'Done';
  done.onclick = () => d.close();
  actions.append(rm, el('span', null, { flex: 1 }), done);
  d.appendChild(actions);
  d.addEventListener('close', () => { d.remove(); renderForm(); refreshListItem(real(ref)); });
  document.body.appendChild(d);
  d.showModal();
  first.focus();
}

function openRequirements(ref) {
  const rec = record(real(ref));
  let list = parseRequirements(val(rec, 'requirements'));
  if (!list.length) list = [{ never: false, text: '' }];
  let d = document.getElementById('reqDialog');
  if (d) d.remove();
  d = el('dialog'); d.id = 'reqDialog';
  d.innerHTML = `<h3>Requirements</h3><p class="dim">When this can turn up. <b>Only if</b>: you'll only see it when this is true.
    <b>Never if</b>: you won't see it once this is true. Write them however you like.</p>`;
  const rows = el('div', 'req-rows');
  const save = () => setVal(real(ref), 'requirements', writeRequirements(list));
  const draw = () => {
    rows.innerHTML = '';
    list.forEach((r, i) => {
      const row = el('div', 'req-row');
      const tg = el('div', 'toggle');
      for (const [never, label] of [[false, 'Only if'], [true, 'Never if']]) {
        const b = el('button', r.never === never ? 'on' + (never ? ' never' : '') : '');
        b.textContent = label;
        b.onclick = () => { r.never = never; save(); draw(); };
        tg.appendChild(b);
      }
      const inp = el('input'); inp.type = 'text'; inp.value = r.text;
      inp.placeholder = r.never ? "e.g. you've fought the Hollow Pilgrim" : 'e.g. you have Spiteful King Upon His Throne';
      inp.oninput = () => { r.text = inp.value; save(); };
      const x = el('button', 'xbtn'); x.textContent = '×'; x.title = 'Remove';
      x.onclick = () => { list.splice(i, 1); if (!list.length) list.push({ never: false, text: '' }); save(); draw(); };
      row.append(tg, inp, x);
      rows.appendChild(row);
    });
  };
  draw();
  d.appendChild(rows);
  const actions = el('div', 'actions');
  const add = el('button', 'btn small'); add.textContent = '+ Add condition';
  add.onclick = () => { list.push({ never: false, text: '' }); draw(); const ins = rows.querySelectorAll('input'); ins[ins.length - 1].focus(); };
  const done = el('button', 'btn primary'); done.textContent = 'Done';
  done.onclick = () => d.close();
  actions.append(add, el('span', null, { flex: 1 }), done);
  d.appendChild(actions);
  d.addEventListener('close', () => { d.remove(); renderForm(); });
  document.body.appendChild(d);
  d.showModal();
  const first = rows.querySelector('input'); if (first) first.focus();
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
  const pv = { Memories: previewMemory, Glimpses: previewGlimpse, Encounters: previewEncounter, Keywords: previewKeyword, Runes: previewRune, Masks: previewMask, 'Action Cards': previewActionCard };
  lab.firstChild.textContent = { Memories: 'As a card in the ring', Glimpses: 'As a glimpse to choose', Encounters: 'As the fight shows it', Keywords: 'On an ability tile', Runes: 'On a card', Masks: 'As you choose it', 'Action Cards': 'In your hand' }[rec.tab];
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
  if (m.pattern) bits.push('<div class="glos"><b>Align</b> — the 4 tiles along the bottom roll at random (each 0–4 or =, and a single = becomes the arrow), and roll again each time the pattern is made. These are an example.</div>');
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

/** What the fight shows, from the same reading as the form. */
function encounterModel2(rec) {
  const traits = partsFor(val(rec, 'traits'), readEnemies(rec), true);
  return readEnemies(rec).filter(e => e.name || e.bars.length || e.intents.length).map((e, i) => {
    const known = R.AD.enemies[e.name.toLowerCase()] || {};
    const bars = e.bars.map(b => {
      const bt = BAR_TYPES.find(x => x.type === b.type);
      return { stat: bt.stat, verb: bt.verb, need: Number(b.need) || 0, label: b.need ? '' : `${bt.label}: no number yet`, reward: b.reward + (b.reset ? ' (resets)' : '') };
    });
    return { name: e.name || 'Unnamed enemy', count: e.count, art: known.art || '', flavor: known.flavor || '', intent: e.intents.join(' → '),
      traits: (e.about || traits[i] || '').replace(/\s*rules:\s*[\w, ]+$/i, ''), bars, unknown: !known.id };
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
  notes.innerHTML = `<h4>Used by ${list.length} memoriam${list.length === 1 ? '' : 's'}</h4>`;
  const p = el('p');
  list.slice(0, 40).forEach((r, i) => {
    const a = el('a'); a.href = '#'; a.textContent = itemTitle(r); a.style.color = 'var(--text)';
    a.onclick = ev => { ev.preventDefault(); S.tab = 'Memories'; S.sel.Memories = r.ref; saveStore(); renderAll(); };
    if (i) p.appendChild(document.createTextNode(' · '));
    p.appendChild(a);
  });
  if (list.length > 40) p.appendChild(document.createTextNode(` … and ${list.length - 40} more`));
  if (!list.length) p.textContent = `No memoriam uses this ${what} yet.`;
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
