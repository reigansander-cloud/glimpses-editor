// Draws things the way the game does (CardView, AbilityTile, ChoiceCard, EncounterPanel), from the same pictures.
// Sizes and positions are the game's own (a card is 240 x 421); the preview scales the whole thing up.
(function () {
'use strict';

const ART = '../../Glimpses.Godot/Art/';
const AD = window.ART_DATA || { panels: {}, tints: {}, memoryIds: {}, memoryArt: {}, enemies: {}, files: [], sizes: {} };
const FILES = new Set(AD.files);
const artUrl = f => ART + encodeURIComponent(f);
const has = f => FILES.has(f);

function el(tag, cls, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  return e;
}
function img(file, style) {
  const i = el('img', null, style);
  i.src = artUrl(file);
  i.draggable = false;
  i.alt = '';
  return i;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ----- symbols ------------------------------------------------------------------------------------------

/** Art.Glyph: the sheet's symbol names → a picture file. */
function glyphFile(name) {
  let n = String(name || '').trim().toLowerCase();
  n = ({ 'back arrow': 'back', back: 'back', 'down arrow': 'down', down: 'down', compas: 'compass', void: 'vortex' })[n] || n.replace(/ /g, '_');
  if (n === 'leaf') return 'ico_growth.png';
  if (n === 'align' || n === 'allign') return 'align_kw.png';
  return has(`glyph_${n}.png`) ? `glyph_${n}.png` : 'ico_doom.png';
}
/** All symbols there are pictures for (for the symbol pickers). */
function glyphChoices() {
  const out = AD.files.filter(f => /^glyph_.*\.png$/.test(f)).map(f => f.slice(6, -4));
  out.push('leaf');
  return out.sort();
}
// fading became fortitude: ico_fading.png / bar_fading.png are its blue eye and bar
const iconFile = name => (['bone', 'bones', 'ember', 'embers'].includes(name) ? 'ico_doom.png' : name === 'sight' ? 'sight.png' : `ico_${name === 'fortitude' ? 'fading' : name}.png`);

const STAT_WORDS = /\b(aggression|agression|fading|fortitude|vanity|stones?|embers?|threads?|bones?|charm|grit|insight|guile|sights?)\b/gi;
const KEYWORD_WORDS = /\b(Lands|Allign|Fragile|Frantic|Barrier|Anchored|Echo|Growth|Wanderers?)\b/g;
const KEYWORD_ART = {
  Lands: 'glyph_target.png', Allign: 'glyph_compass.png', Fragile: 'glyph_feather.png', Frantic: 'glyph_fastforward.png',
  Barrier: 'glyph_shield.png', Anchored: 'glyph_anvil.png', Echo: 'glyph_cycle.png', Growth: 'ico_growth.png',
  Wanderer: 'glyph_lantern.png', Wanderers: 'glyph_lantern.png',
};

/** Ui.IconText: stat words become their icons, capitalised keyword words their symbols. Returns HTML. */
function iconText(text, size) {
  let t = esc(String(text ?? '').replace(/Agression/g, 'Aggression').replace(/agression/g, 'aggression'));
  t = t.replace(STAT_WORDS, m => {
    let w = m.toLowerCase();
    if (!['fading', 'fortitude', 'aggression', 'vanity', 'guile'].includes(w)) w = w.replace(/s$/, '');
    const f = w === 'sight' ? 'sight.png' : iconFile(w);
    return `<img class="ico" src="${artUrl(f)}" style="width:${size}px;height:${size}px" alt="${m}" title="${m}">`;
  });
  // Ignorance: its red stone (hover for what it does)
  t = t.replace(/\bignorances?\b/gi, m => `<img class="ico" src="${artUrl('ignorance.png')}" style="width:${size}px;height:${size}px" alt="${m}" title="Ignorance: enemy sight. More Ignorance than Sight on a memoriam turns it face down. Can't be claimed or cleared; reconciling it costs 1 fortitude per Ignorance; it scatters with sight (you pick the order); it fades after the encounter.">`);
  t = t.replace(KEYWORD_WORDS, m => `<img class="ico" src="${artUrl(KEYWORD_ART[m])}" style="width:${size}px;height:${size}px" alt="${m}" title="${m}">`);
  return t.replace(/\n/g, '<br>');
}

// ----- sliced tiles (Art.DrawSliced) ---------------------------------------------------------------------

const SLICES = {
  wide: { file: 'tile_wide.png', xs: [0, 45, 250, 300, 505, 550], ys: [0, 38, 189, 227], scale: 0.25 },
  wideGold: { file: 'tile_wide_gold.png', xs: [0, 55, 190, 360, 495, 550], ys: [0, 64, 191, 255], scale: 0.25 },
};
function btnSlice(color) {
  if (color === 'gold') {   // ??? glimpses: the home screen's gold glass
    const [w, h] = AD.sizes['btn_gold_glass.png'] || [860, 200];
    return { file: 'btn_gold_glass.png', xs: [0, 100, w - 100, w], ys: [0, 92, h - 92, h], scale: 0.34 * 1.4 };
  }
  const f = `btn_${color}.png`, [w, h] = AD.sizes[f] || [469, 343];
  return { file: f, xs: [0, 175, w - 175, w], ys: [0, 112, h - 112, h], scale: 0.34 };
}
function bands(cuts, k, total) {
  let fixed = 0, stretch = 0;
  for (let i = 0; i < cuts.length - 1; i++) if (i % 2 === 0) fixed += (cuts[i + 1] - cuts[i]) * k; else stretch++;
  const each = stretch ? Math.max(0, total - fixed) / stretch : 0;
  return cuts.slice(0, -1).map((c, i) => (i % 2 === 0 ? (cuts[i + 1] - c) * k : each));
}
const fixedSize = cuts => { let f = 0; for (let i = 0; i < cuts.length - 1; i += 2) f += cuts[i + 1] - cuts[i]; return f; };
const borders = s => ({ top: s.ys[1] * s.scale, bottom: (s.ys[s.ys.length - 1] - s.ys[s.ys.length - 2]) * s.scale, side: s.xs[1] * s.scale });

/** Fills a box (w x h) with a sliced picture: corners keep their size, the bands between stretch. */
function slicedLayer(s, w, h, extraStyle) {
  let k = s.scale;
  const fw = fixedSize(s.xs) * k, fh = fixedSize(s.ys) * k;
  if (w < fw) k *= w / fw;
  if (h < fh) k = Math.min(k, s.scale * h / fh);
  const dw = bands(s.xs, k, w), dh = bands(s.ys, k, h);
  const [iw, ih] = AD.sizes[s.file] || [s.xs[s.xs.length - 1], s.ys[s.ys.length - 1]];
  const layer = el('div', 'slice', Object.assign({ position: 'absolute', left: 0, top: 0, width: w + 'px', height: h + 'px', pointerEvents: 'none' }, extraStyle));
  let y = 0;
  for (let r = 0; r < dh.length; r++) {
    let x = 0;
    for (let c = 0; c < dw.length; c++) {
      const sw = s.xs[c + 1] - s.xs[c], sh = s.ys[r + 1] - s.ys[r];
      if (dw[c] > 0.01 && dh[r] > 0.01) {
        const sx = dw[c] / sw, sy = dh[r] / sh;
        layer.appendChild(el('div', null, {
          position: 'absolute', left: x + 'px', top: y + 'px', width: dw[c] + 0.4 + 'px', height: dh[r] + 0.4 + 'px',
          backgroundImage: `url("${artUrl(s.file)}")`, backgroundRepeat: 'no-repeat',
          backgroundSize: `${iw * sx}px ${ih * sy}px`, backgroundPosition: `${-s.xs[c] * sx}px ${-s.ys[r] * sy}px`,
        }));
      }
      x += dw[c];
    }
    y += dh[r];
  }
  return layer;
}

// ----- stat bar (EnemyView StatBar) ---------------------------------------------------------------------

function statBar(stat, have, need, w, h) {
  stat = String(stat).toLowerCase().replace('agression', 'aggression');
  if (stat === 'fortitude') stat = 'fading';   // (its blue bar)
  const SrcW = 1085, SrcH = 250, LeftEnd = 120, MidFrom = 525, MidTo = 825, RightFrom = 840, CircleX = 970;
  const full = has(`bar_${stat}.png`) ? `bar_${stat}.png` : 'bar_aggression.png';
  const k = h / SrcH, lw = LeftEnd * k, rw = (SrcW - RightFrom) * k, mw = Math.max(0, w - lw - rw);
  const box = el('div', 'statbar', { position: 'relative', width: w + 'px', height: h + 'px' });
  const piece = (file, dx, dw, sx, sw) => {
    const scaleX = dw / sw;
    box.appendChild(el('div', null, {
      position: 'absolute', left: dx + 'px', top: 0, width: dw + 0.5 + 'px', height: h + 'px',
      backgroundImage: `url("${artUrl(file)}")`, backgroundRepeat: 'no-repeat',
      backgroundSize: `${SrcW * scaleX}px ${h}px`, backgroundPosition: `${-sx * scaleX}px 0`,
    }));
  };
  const fill = need <= 0 ? 0 : Math.min(1, Math.max(0, have / need)), fillW = fill * (lw + mw);
  piece('bar_empty.png', 0, lw, 0, LeftEnd);
  piece('bar_empty.png', lw, mw, MidFrom, MidTo - MidFrom);
  if (fillW > 0) piece(full, 0, Math.min(lw, fillW), 0, LeftEnd * Math.min(1, fillW / lw));
  if (fillW > lw) piece(full, lw, fillW - lw, MidFrom, (MidTo - MidFrom) * (fillW - lw) / mw);
  piece(full, lw + mw, rw, RightFrom, SrcW - RightFrom);
  const cx = lw + mw + (CircleX - RightFrom) * k, ir = h * 0.62;
  box.appendChild(el('div', null, { position: 'absolute', left: cx - ir * 0.75 + 'px', top: h / 2 - ir * 0.75 + 'px', width: ir * 1.5 + 'px', height: ir * 1.5 + 'px',
    background: 'radial-gradient(closest-side, rgba(0,0,0,.55), rgba(0,0,0,.25) 45%, transparent)' }));
  box.appendChild(img(has(iconFile(stat)) ? iconFile(stat) : 'ico_doom.png', { position: 'absolute', left: cx - ir / 2 + 'px', top: h / 2 - ir / 2 + 'px', width: ir + 'px', height: ir + 'px' }));
  const fs = Math.max(11, Math.round(h * 0.31));
  const t = el('div', 'barcount', { position: 'absolute', left: 0, width: (lw + mw) + lw * 0.6 + 'px', top: 0, height: h + 'px', fontSize: fs + 'px' });
  t.textContent = `${Math.min(have, need)} / ${need}`;
  box.appendChild(t);
  return box;
}

// ----- memory card (CardView) ---------------------------------------------------------------------------

const CARD_W = 240, CARD_H = 421;

/** Which picture a memory uses: { file, rect } (rect = a panel cut from an art sheet), or null. */
function memoryPicture(id) {
  if (!id) return null;
  const name = AD.memoryArt[id] || id;
  for (const ext of ['jpg', 'png']) if (has(`art_${name}.${ext}`)) return { file: `art_${name}.${ext}` };
  const p = AD.panels[name];
  return p && has(p.sheet) ? { file: p.sheet, rect: p } : null;
}
function frameFor(id) {
  const t = AD.tints[id];
  return t && has(`card_frame_${t}.png`) ? `card_frame_${t}.png` : 'card_frame.png';
}
/** A picture cropped to cover a box (KeepAspectCovered). */
function coverPicture(pic, w, h, style) {
  const box = el('div', null, Object.assign({ position: 'absolute', width: w + 'px', height: h + 'px', overflow: 'hidden' }, style));
  const [iw, ih] = AD.sizes[pic.file] || [1000, 1000];
  const r = pic.rect || { x: 0, y: 0, w: iw, h: ih };
  const k = Math.max(w / r.w, h / r.h);
  const ox = (w - r.w * k) / 2 - r.x * k, oy = (h - r.h * k) / 2 - r.y * k;
  box.appendChild(el('div', null, {
    position: 'absolute', left: 0, top: 0, width: w + 'px', height: h + 'px',
    backgroundImage: `url("${artUrl(pic.file)}")`, backgroundRepeat: 'no-repeat',
    backgroundSize: `${iw * k}px ${ih * k}px`, backgroundPosition: `${ox}px ${oy}px`,
  }));
  return box;
}

let _measure;
function textWidth(text, px, font) {
  _measure = _measure || document.createElement('canvas').getContext('2d');
  _measure.font = `${px}px ${font || 'Georgia, "Palatino Linotype", serif'}`;
  return _measure.measureText(text).width;
}
function wrapWords(text, px, w) {
  const lines = []; let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const tryLine = cur ? cur + ' ' + word : word;
    if (cur && textWidth(tryLine, px) > w) { lines.push(cur); cur = word; } else cur = tryLine;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * mem = { id, name, attributes:{charm:1,...}, runes:[{icon, title, text}], tiles:[{text, icon, manual, bar:{stat,need}}],
 *         dice: n, pattern: ['this','1','eq','2'] or null }
 * Returns the card element (240 x 421; scale it with CSS). Call layoutCard(card) once it's on the page.
 */
function memoryCard(mem) {
  const card = el('div', 'gcard');
  const pic = memoryPicture(mem.id);
  card.appendChild(el('div', null, { position: 'absolute', left: '9px', top: '10px', width: '222px', height: '72px', background: '#141a2c' }));
  if (pic) card.appendChild(coverPicture(pic, 222, 72, { left: '9px', top: '10px', filter: 'brightness(.58) saturate(.95)' }));
  else {
    const none = el('div', 'noart', { position: 'absolute', left: '9px', top: '10px', width: '222px', height: '72px' });
    none.textContent = 'no picture yet';
    card.appendChild(none);
  }
  card.appendChild(img(frameFor(mem.id), { position: 'absolute', left: 0, top: 0, width: CARD_W + 'px', height: CARD_H + 'px' }));

  // dice lying on the art
  const spots = [[70, 50], [150, 62], [110, 40], [180, 44], [52, 70], [128, 72]];
  for (let i = 0; i < Math.min(mem.dice || 0, 6); i++) {
    const [x, y] = spots[i];
    card.appendChild(img(`die_${6 - (i % 2)}.png`, { position: 'absolute', left: x - 15 + 'px', top: y - 15 + 'px', width: '30px', height: '30px',
      transform: `rotate(${(i * 37 % 50) - 25}deg)`, filter: 'drop-shadow(0 2px 2px rgba(0,0,0,.6))' }));
  }

  const content = el('div', 'gcontent');
  card.appendChild(content);

  const caps = String(mem.name || '').toUpperCase();
  const nameW = 200 - 32 - 8;
  let fs = 17, lines = wrapWords(caps, fs, nameW);
  for (const size of [17, 14, 12, 11, 10]) {
    fs = size;
    lines = wrapWords(caps, fs, nameW);
    const want = lines.length <= 1 ? 17 : lines.length === 2 ? 14 : 12;
    if (lines.length <= 3 && lines.every(l => textWidth(l, fs) <= nameW) && fs <= want) break;
  }
  const title = el('div', 'gtitle', { fontSize: fs + 'px', minHeight: Math.max(24, lines.length * fs * 1.17 + 2) + 'px' });
  title.innerHTML = lines.map(esc).join('<br>');
  content.appendChild(title);

  const chips = el('div', 'gchips');
  for (const a of ['charm', 'grit', 'insight', 'guile']) {
    const v = Number(mem.attributes?.[a] || 0);
    if (!v) continue;
    const b = el('div', 'gattr');
    b.title = `${a[0].toUpperCase() + a.slice(1)} ${v}`;
    b.appendChild(img(`ico_${a}.png`, { position: 'absolute', left: '1.5px', top: '3px', width: '40px', height: '40px', opacity: 0.3, filter: 'brightness(0)' }));
    b.appendChild(img(`ico_${a}.png`, { position: 'absolute', left: 0, top: 0, width: '40px', height: '40px' }));
    const n = el('div', 'gattrnum'); n.textContent = v; b.appendChild(n);
    chips.appendChild(b);
  }
  for (const r of mem.runes || []) {
    const t = el('div', 'grune');
    t.title = r.title + (r.text ? ' — ' + r.text : '');
    t.appendChild(img('tile_square.png', { position: 'absolute', left: '1.5px', top: '3px', width: '46px', height: '46px', opacity: 0.3, filter: 'brightness(0)' }));
    t.appendChild(img('tile_square.png', { position: 'absolute', left: 0, top: 0, width: '46px', height: '46px' }));
    t.appendChild(img(r.icon, { position: 'absolute', left: '7px', top: '7px', width: '32px', height: '32px', objectFit: 'contain' }));
    chips.appendChild(t);
  }
  if (chips.children.length) content.appendChild(chips);

  for (const tile of mem.tiles || []) content.appendChild(abilityTile(tile));

  if (mem.pattern) {
    const ts = 32, gap = 3, x0 = (CARD_W - (ts * 4 + gap * 3)) / 2, y0 = CARD_H - ts / 2 - 9;
    card.appendChild(el('div', null, { position: 'absolute', left: x0 - 22 + 'px', top: y0 - 16 + 'px', width: ts * 4 + gap * 3 + 44 + 'px', height: ts + 32 + 'px',
      background: 'radial-gradient(closest-side, rgba(255,209,89,.45), rgba(255,209,89,.2) 45%, transparent)' }));
    mem.pattern.forEach((v, k) => card.appendChild(img(`align_${v}.png`, { position: 'absolute', left: x0 + k * (ts + gap) + 'px', top: y0 + 'px', width: ts + 'px', height: ts + 'px', objectFit: 'contain' })));
  }
  return card;
}

/** tile = { text, icon (file or null), manual, bar: {stat, need} or null } */
function abilityTile(tile) {
  const t = el('div', 'gtile' + (tile.manual ? ' manual' : ''));
  t._slice = tile.manual ? SLICES.wideGold : SLICES.wide;
  t._bar = tile.bar || null;
  if (tile.icon) {
    const g = img(tile.icon, { width: '30px', height: '30px', objectFit: 'contain', filter: tile.manual ? 'sepia(.25)' : 'sepia(.4) brightness(.95)' });
    g.className = 'gglyph';
    t.appendChild(g);
  }
  const body = el('div', 'gtiletext');
  body.innerHTML = iconText(tile.text, 20) || '&nbsp;';
  t.appendChild(body);
  if (tile.warn) t.classList.add('warn');
  return t;
}

/** Sizes a card's stone section like CardView.Layout: spread out when there's room, shrunk together when not. */
function layoutCard(card) {
  const content = card.querySelector('.gcontent');
  if (!content) return;
  const tiles = [...content.querySelectorAll('.gtile')];
  const availW = 200, availH = 300;
  const groups = content.children.length;
  const fit = (w, spread) => {
    content.style.width = w + 'px';
    content.style.setProperty('--spread', spread + 'px');
    for (const t of tiles) padTile(t);
    return content.scrollHeight;
  };
  let s = 1;
  for (let i = 0; i < 5; i++) {
    const need = fit(availW / s, 0);
    const next = Math.min(1, availH / need);
    if (Math.abs(next - s) < 0.005) { s = next; break; }
    s = next;
  }
  const natural = fit(availW / s, 0);
  const extra = Math.max(0, availH / s - natural);
  if (extra > 0) fit(availW / s, Math.min(16, extra / (groups + 1)));
  content.style.transform = `scale(${s})`;
  for (const t of tiles) drawTile(t);
}

function padTile(t) {
  const s = t._slice, b = borders(s), manual = t.classList.contains('manual');
  let top = manual ? b.top * 0.72 + 3 : b.top + 4, bottom = manual ? b.bottom * 0.72 + 3 : b.bottom + 4, side = manual ? b.side * 0.55 + 7 : b.side * 0.6 + 6;
  if (t._bar) top += 24;
  const glyph = t.querySelector('.gglyph');
  t.style.padding = `${top}px ${side}px ${bottom}px ${glyph ? side + 34 : side}px`;
  t.style.minHeight = glyph ? '42px' : '';
  if (glyph) Object.assign(glyph.style, { position: 'absolute', left: side - 3 + 'px', top: `calc(50% - 15px)` });
  t._pad = { side };
}

function drawTile(t) {
  t.querySelectorAll(':scope > .slice, :scope > .statbar').forEach(x => x.remove());
  const w = t.offsetWidth, h = t.offsetHeight;
  t.insertBefore(slicedLayer(t._slice, w, h, { left: '1.5px', top: '3.5px', opacity: 0.26, filter: 'brightness(0)' }), t.firstChild);
  t.insertBefore(slicedLayer(t._slice, w, h), t.children[1]);
  if (t._bar) {
    const side = t._pad.side;
    const bar = statBar(t._bar.stat, 0, t._bar.need, w - side * 0.9, 26);
    Object.assign(bar.style, { position: 'absolute', left: side * 0.45 + 'px', top: '3px' });
    t.appendChild(bar);
  }
}

// ----- glimpse (ChoiceCard) -----------------------------------------------------------------------------

const GLOW = { red: [255, 71, 56], gold: [255, 189, 71], brown: [217, 158, 115], purple: [184, 92, 255], green: [115, 235, 97],
  sand: [242, 219, 168], orange: [255, 140, 46], blue: [82, 153, 255] };

/** g = { color, kind:'FIGHT'|'NEW MEMORY'|'TAMPER'|'EVENT', title, text, hint } */
function glimpseCard(g) {
  const color = GLOW[g.color] ? g.color : 'sand';
  const [r, gg, b] = GLOW[color];
  const box = el('div', 'gglimpse' + (color === 'gold' ? ' glass' : ''));
  box._slice = btnSlice(color);
  box.appendChild(el('div', 'gglow', { background: `radial-gradient(closest-side, rgba(${r},${gg},${b},.42), rgba(${r},${gg},${b},.16) 50%, transparent)` }));
  const inner = el('div', 'gglimpseinner');
  const kind = el('div', 'gkind', { color: `rgb(${Math.round(r + (255 - r) * 0.55)},${Math.round(gg + (255 - gg) * 0.55)},${Math.round(b + (255 - b) * 0.55)})` });
  kind.textContent = g.kind;
  const title = el('div', 'gltitle'); title.textContent = String(g.title || '').toUpperCase();
  inner.append(kind, title);
  if (g.text) { const tx = el('div', 'gltext'); tx.innerHTML = esc(g.text).replace(/\n/g, '<br>'); inner.appendChild(tx); }
  const hint = el('div', 'glhint'); hint.textContent = g.hint || ''; inner.appendChild(hint);
  box.appendChild(inner);
  return box;
}
function layoutGlimpse(box) {
  box.querySelectorAll(':scope > .slice').forEach(x => x.remove());
  const w = box.offsetWidth, h = box.offsetHeight;
  box.insertBefore(slicedLayer(box._slice, w, h, { left: '3px', top: '7px', opacity: 0.45, filter: 'brightness(0)' }), box.children[1]);
  box.insertBefore(slicedLayer(box._slice, w, h, { filter: 'brightness(.95)' }), box.children[2]);
}

// ----- encounter (EncounterPanel) -----------------------------------------------------------------------

/** e = { name, art, intent (text), traits (text), bars:[{stat, need, reward, ends}], flavor, count } */
function enemyBlock(e) {
  const box = el('div', 'genemy');
  const top = el('div', 'genemytop');
  const col = el('div', 'genemycol');
  const name = el('div', 'genemyname'); name.textContent = (e.count > 1 ? e.count + ' × ' : '') + String(e.name || '').toUpperCase();
  col.appendChild(name);
  if (e.intent) {
    const it = el('div', 'gintent');
    it.innerHTML = iconText(e.intent, 22).replace(/\b[Aa]ttack (\d+)/g, (m, n) => `<img class="ico" src="${artUrl('glyph_swords.png')}" style="width:24px;height:24px"><b>${n}</b>`);
    col.appendChild(it);
  }
  if (e.traits) { const tr = el('div', 'gtraits'); tr.innerHTML = iconText(e.traits, 17); col.appendChild(tr); }
  top.appendChild(col);
  const muralFile = e.art && has(`mural_${e.art}.png`) ? `mural_${e.art}.png` : 'mural_spiral.png';
  const mural = el('div', 'gmural');
  mural.appendChild(img(muralFile, { width: '100%', display: 'block' }));
  mural.title = e.flavor || '';
  top.appendChild(mural);
  box.appendChild(top);
  for (const b of e.bars || []) {
    const row = el('div', 'gbarrow');
    if (b.need > 0) {
      const w = Math.min(440, Math.max(190, 150 + b.need * 9));
      row.appendChild(statBar(b.stat, 0, b.need, w, 62));
    } else {
      const no = el('div', 'gbarnone'); no.textContent = b.label || `can't ${b.verb}`; row.appendChild(no);
    }
    if (b.reward) { const rw = el('div', 'gbarreward'); rw.innerHTML = `<span>${esc(b.verb)}:</span> ` + iconText(b.reward, 18) + (b.ends === false ? ' <i>(the fight goes on)</i>' : ''); row.appendChild(rw); }
    box.appendChild(row);
  }
  return box;
}

window.Render = { ART, AD, artUrl, has, el, img, esc, glyphFile, glyphChoices, iconFile, iconText, memoryCard, layoutCard, abilityTile, padTile, drawTile,
  glimpseCard, layoutGlimpse, enemyBlock, statBar, memoryPicture, frameFor, coverPicture, slicedLayer, SLICES };
})();
