'use strict';

// 台本ボード
// データは端末内（localStorage）にだけ保存する。外へは何も送らない。

// 更新のたびに書き換える（本人が、新しい版が届いたかを見分けるため）
const APP_BUILD = '2026-10-20b';
const FORMAT = 'daihon-board';
const VERSION = 1;
const STORE_PREFIX = 'daihon-board/work/';
const META_PREFIX = 'daihon-board/meta/';       // 書き出しの状態（この端末だけ。作品のデータには入れない）
const HISTORY_PREFIX = 'daihon-board/history/';  // 版の履歴（新しい順）
const HISTORY_MAX = 30;
const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
const SLOTS = 10;

// 筋・人物の色（紙の上で見分けやすい、落ち着いた8色）
const PALETTE = ['#4a6f96', '#3f8579', '#7d8b3e', '#b8902f', '#7f5f45', '#7b5f99', '#b06483', '#6a9ab0'];
// 古い版の10色（読み込み時に新しい色へ移し替える）
const OLD_PALETTE = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#7a4fb5', '#56b4e9', '#8c564b', '#666666', '#a89f00'];
// 人物の形（●■▲◆▼✚）。筋には形を付けない
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'down', 'cross'];

const TYPES = {
  shiba: { label: '柴型（3段×10枚）', short: '柴型', blocks: ['第1ブロック', '第2ブロック', '第3ブロック'] },
  snyder: { label: 'スナイダー型（4段×10枚）', short: 'スナイダー型', blocks: ['第1幕', '第2幕・前半', '第2幕・後半', '第3幕'] },
};

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const narrowMq = window.matchMedia('(max-width: 699px)');

let work = null;
const ui = {
  openCardId: null,
  newCardId: null,   // 作ったばかりで、空のまま閉じたら消すカード
  settingsOpen: false,
  tab: 'board',      // 'board'（ボード）、'people'（人物）、'core'（芯）
  memoOpen: false,   // カードの「演出メモ」を開いているか（この画面の中だけ。データには入れない）
  moreOpen: false,   // カードの「その他」を開いているか（同上）
  storageOk: true,
  saveError: false,
  exporting: false,
  newWorkOpen: false, // 作品の一覧で「新しい作品」の欄を開いているか
  legendOpen: false,  // ボードの凡例を開いているか
  entOpen: null, // 色の欄を開いている人物・筋のid（1つだけ）
  entEditOpen: false, // 人物タブの登録（編集）を開いているか
  graphOn: {},       // グラフで表示する人物（人物id → true/false）。この画面の中だけ。データには入れない
  lastSnap: null,    // { id, t }：履歴に最後に控えを取った時刻
  lifted: null,      // 持ち上げ中のもの { kind: 'card' | 'break', id }。この画面の中だけ
  undo: null,        // 動かした直後の［元に戻す］用 { snap, workId, timer, item }
  landed: null,      // 置いた直後に光らせるもの { kind: 'card' | 'break', id, at }。データには入れない
  focus: null,       // 筋・人物で絞り込み { kind: 'thread' | 'char', id }。データには入れない
};

// ---------- 小道具 ----------

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked') el[k] = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- データ ----------

function newCard() {
  return {
    id: uid(),
    title: '',
    event: '',      // 何が起きるか
    change: '',     // 変化（全員の行動や欲求が変わる瞬間）
    conflict: '',   // 対立
    place: '',      // 場所
    big: false,     // 大きなイベント
    characters: [], // 出る人物のid
    threads: [],    // かかわる筋のid
    states: {},     // 変化があった人物だけ（人物id → −3〜＋3）。なければ変化なし
    subEvents: '',  // 細かいイベント（1行に1つ）
    intents: {},    // 人物ごとの意図（人物id → 文字）
    beat: null,     // ビート：null＝置き場所に従う（自動）、ビートのid＝手で指定、'none'＝なし
  };
}

function newWork(title, type) {
  const now = new Date().toISOString();
  return {
    format: FORMAT,
    version: VERSION,
    id: uid(),
    title,
    type,
    createdAt: now,
    updatedAt: now,
    blocks: TYPES[type].blocks.map((name) => ({ id: uid(), name, cards: [] })),
    intermission: null, // { blockId, index }：そのブロックの index 枚目の前に置く
    pool: [],           // 保留のカード（どこに置くか決まっていないもの）
    threads: [],
    characters: [],
    core: newCore(),
    showBeats: true, // 型の札（ビート）を表示するか
  };
}

// 作品の芯：作品全体の 対立 → 出来事 → 変化
const CORE_KEYS = ['protagonist', 'want', 'obstacle', 'event', 'change', 'theme'];
function newCore() {
  return { protagonist: '', want: '', obstacle: '', event: '', change: '', theme: '' };
}

function normalizeWork(w) {
  if (!w || w.format !== FORMAT || !Array.isArray(w.blocks)) return null;
  for (const key of ['threads', 'characters']) {
    w[key] = (Array.isArray(w[key]) ? w[key] : []).filter((e) => e && e.id).map((e, i) => ({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : '',
      // 色は #RRGGBB だけを受け付ける（style に入れるため、ほかの文字列は通さない）
      color: typeof e.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.color)
        ? (OLD_PALETTE.includes(e.color.toLowerCase()) ? PALETTE[i % PALETTE.length] : e.color)
        : PALETTE[i % PALETTE.length],
      // 形は人物だけ。無いか正しくなければ並びの位置で決める
      ...(key === 'characters' ? { shape: SHAPES.includes(e.shape) ? e.shape : SHAPES[i % SHAPES.length] } : {}),
    }));
  }
  const core = newCore();
  if (w.core && typeof w.core === 'object') {
    for (const k of CORE_KEYS) if (typeof w.core[k] === 'string') core[k] = w.core[k];
  }
  w.core = core;
  w.showBeats = w.showBeats !== false;
  const tIds = new Set(w.threads.map((e) => e.id));
  const cIds = new Set(w.characters.map((e) => e.id));
  const seen = new Set();
  const normCard = (raw) => {
    const c = Object.assign(newCard(), raw && typeof raw === 'object' ? raw : {});
    // カードのidは、ブロックと保留をあわせて1回だけ
    if (typeof c.id !== 'string' || !c.id || seen.has(c.id)) c.id = uid();
    seen.add(c.id);
    // 無くなった筋・人物への参照を落とす
    c.threads = (Array.isArray(c.threads) ? c.threads : []).filter((id, i, a) => tIds.has(id) && a.indexOf(id) === i);
    c.characters = (Array.isArray(c.characters) ? c.characters : []).filter((id, i, a) => cIds.has(id) && a.indexOf(id) === i);
    const st = {};
    if (c.states && typeof c.states === 'object') {
      for (const [id, v] of Object.entries(c.states)) {
        if (c.characters.includes(id) && Number.isInteger(v) && v >= -3 && v <= 3) st[id] = v;
      }
    }
    c.states = st;
    if (typeof c.subEvents !== 'string') c.subEvents = '';
    const it = {};
    if (c.intents && typeof c.intents === 'object') {
      for (const [id, v] of Object.entries(c.intents)) {
        if (c.characters.includes(id) && typeof v === 'string') it[id] = v;
      }
    }
    c.intents = it;
    // ビート：知らないidは自動に戻す（seeds.js が無いときは、消さずにそのまま持つ）
    if (typeof c.beat !== 'string' || (c.beat !== 'none' && BEAT_MAP && !BEAT_MAP.has(c.beat))) c.beat = null;
    return c;
  };
  for (const b of w.blocks) b.cards = (Array.isArray(b.cards) ? b.cards : []).map(normCard);
  w.pool = (Array.isArray(w.pool) ? w.pool : []).map(normCard);
  return w;
}

// 筋・人物（kind は 'threads' か 'characters'）
function nextColor(list) {
  const used = new Set(list.map((e) => e.color));
  return PALETTE.find((col) => !used.has(col)) || PALETTE[list.length % PALETTE.length];
}

function nextShape(list) {
  const used = new Set(list.map((e) => e.shape));
  return SHAPES.find((sh) => !used.has(sh)) || SHAPES[list.length % SHAPES.length];
}

function addEntity(kind, name) {
  const item = { id: uid(), name: name.trim(), color: nextColor(work[kind]) };
  if (kind === 'characters') item.shape = nextShape(work[kind]);
  work[kind].push(item);
  return item;
}

function deleteEntity(kind, id) {
  work[kind] = work[kind].filter((e) => e.id !== id);
  for (const card of allCards().map((x) => x.card).concat(work.pool)) {
    card[kind] = card[kind].filter((i) => i !== id);
    if (kind === 'characters') { delete card.states[id]; delete card.intents[id]; }
  }
}

function toggleOnCard(c, kind, id) {
  const i = c[kind].indexOf(id);
  if (i >= 0) {
    c[kind].splice(i, 1);
    if (kind === 'characters') { delete c.states[id]; delete c.intents[id]; } // 人物を外したら状態・意図も消す
  } else {
    c[kind].push(id);
  }
}

function fmtState(v) {
  return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
}

// ボードなどに出すカードの名前。見出しが空なら「何が起きるか」の1行目（データには書かない）
function cardLabel(c) {
  const t = c.title.trim();
  if (t) return t;
  const line = c.event.split('\n').map((l) => l.trim()).find((l) => l);
  return line || '（見出しなし）';
}

// ---------- 型の札（ビート） ----------
// seeds.js が window.BEATS を用意する。無いときは、この機能ぜんぶを隠す。
const BEATS = window.BEATS || null;
const BEAT_MAP = BEATS && Array.isArray(BEATS.list) ? new Map(BEATS.list.map((b) => [b.id, b])) : null;

function beatsOn() {
  return !!(BEAT_MAP && BEATS.layout && work && work.showBeats !== false);
}

// 置き場所（ブロック bi の i 枚目）が持つビート。枠（10枚）を超えた先には無い
function positionBeat(bi, i) {
  if (!BEAT_MAP || i >= SLOTS) return null;
  const rows = BEATS.layout && BEATS.layout[work.type];
  const id = rows && rows[bi] && rows[bi][i];
  return BEAT_MAP.get(id) || null;
}

// カードのビート：手で指定があればそれ、'none' ならなし、自動なら置き場所のもの
function effectiveBeat(c, bi, i) {
  if (!BEAT_MAP) return null;
  if (c.beat === 'none') return null;
  if (c.beat) return BEAT_MAP.get(c.beat) || null;
  return positionBeat(bi, i);
}

// 置き場所のビートと違うか（型を崩している印を出すため）
function beatBroken(c, bi, i) {
  const eff = effectiveBeat(c, bi, i), pos = positionBeat(bi, i);
  return (eff ? eff.id : null) !== (pos ? pos.id : null);
}

// ---------- 骨格のテキスト（クリップボードへ） ----------

// 複数行の欄は、2行目以降を字下げして続ける
function indentLines(label, value, pad) {
  const lines = value.split('\n').map((l) => l.trim()).filter((l) => l);
  if (!lines.length) return [];
  return [`  ${label}：${lines[0]}`, ...lines.slice(1).map((l) => `${pad}${l}`)];
}

function buildOutline() {
  const nums = numbering();
  const out = [`${work.title || '無題'}（${TYPES[work.type].short}）`];
  const co = work.core || newCore();
  const labels = [['protagonist', '主人公'], ['want', '求めるもの'], ['obstacle', '阻むもの'],
    ['event', '決定的な出来事'], ['change', '最後の変化'], ['theme', 'テーマ']];
  const coreParts = labels.filter(([k]) => co[k].trim()).map(([k, l]) => `${l}：${co[k].trim().replace(/\s*\n\s*/g, ' ')}`);
  if (coreParts.length) out.push(`【芯】${coreParts.join(' ／ ')}`);
  const im = work.intermission;
  work.blocks.forEach((b, bi) => {
    out.push('', `■ ${b.name}`);
    const imIndex = im && im.blockId === b.id ? Math.min(im.index, b.cards.length) : -1;
    b.cards.forEach((c, i) => {
      if (i === imIndex) out.push('（休憩）');
      const bt = beatsOn() ? effectiveBeat(c, bi, i) : null;
      out.push(`#${nums.get(c.id)} ${cardLabel(c)}${c.big ? ' ★' : ''}${bt ? ` ［${bt.label}］` : ''}`);
      const pad = '    ';
      out.push(...indentLines('対立', c.conflict, pad), ...indentLines('何が起きるか', c.event, pad),
        ...indentLines('変化', c.change, pad));
      const chars = work.characters.filter((p) => c.characters.includes(p.id));
      if (chars.length) {
        out.push(`  人物：${chars.map((p) => (p.name || '（名前なし）') + (c.states[p.id] !== undefined ? `（${fmtState(c.states[p.id])}）` : '')).join('、')}`);
      }
      const threads = work.threads.filter((t) => c.threads.includes(t.id));
      if (threads.length) out.push(`  筋：${threads.map((t) => t.name || '（名前なし）').join('、')}`);
      if (c.place.trim()) out.push(`  場所：${c.place.trim()}`);
      const intents = chars.filter((p) => (c.intents[p.id] || '').trim())
        .map((p) => `${p.name || '（名前なし）'}＝${c.intents[p.id].trim().replace(/\s*\n\s*/g, ' ')}`);
      if (intents.length) out.push(`  意図：${intents.join('／')}`);
      const subs = c.subEvents.split('\n').map((l) => l.trim()).filter((l) => l);
      if (subs.length) out.push('  細かいイベント：', ...subs.map((l) => `   ・${l}`));
    });
    if (imIndex === b.cards.length) out.push('（休憩）');
  });
  if (work.pool.length) {
    out.push('', '■ 保留');
    work.pool.forEach((c) => out.push(`・${cardLabel(c)}${c.big ? ' ★' : ''}`));
  }
  return out.join('\n');
}

function showToast(msg) {
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

// コピーできなかったとき：全部選んだ状態の欄を出す
function showCopyFallback(text) {
  const ta = h('textarea', { class: 'copy-area', readonly: true, 'aria-label': '骨格のテキスト', value: text });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': '骨格のテキスト' },
    h('div', { class: 'sheet-head' },
      h('h2', { class: 'where' }, '骨格をコピー'),
      h('button', { type: 'button', class: 'primary', onclick: closeModal }, '閉じる')),
    h('p', { class: 'note' }, '自動でコピーできませんでした。全部選んでコピーしてください。'),
    ta);
  modalRoot.replaceChildren(overlay(sheet));
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
}

function copyOutline() {
  const text = buildOutline();
  if (!navigator.clipboard || !navigator.clipboard.writeText) { showCopyFallback(text); return; }
  navigator.clipboard.writeText(text).then(() => showToast('骨格をコピーしました'), () => showCopyFallback(text));
}

function allCards() {
  const out = [];
  work.blocks.forEach((b, bi) => b.cards.forEach((c, i) => out.push({ card: c, block: b, bi, index: i })));
  return out;
}

function numbering() {
  const map = new Map();
  allCards().forEach((x, n) => map.set(x.card.id, n + 1));
  return map;
}

// 保留の列を、ブロックと同じ形で扱うための入れ物（cards は work.pool そのもの）
function poolBlock() {
  return { id: 'pool', name: '保留', cards: work.pool };
}

function blockById(id) {
  return id === 'pool' ? poolBlock() : work.blocks.find((b) => b.id === id) || null;
}

// ボードのカードと保留のカードをさがす（保留は bi が -1）
function findCard(id) {
  const x = allCards().find((y) => y.card.id === id);
  if (x) return x;
  const i = work.pool.findIndex((c) => c.id === id);
  return i < 0 ? null : { card: work.pool[i], block: poolBlock(), bi: -1, index: i };
}

function isBlank(c) {
  return !c.title.trim() && !c.event.trim() && !c.subEvents.trim() && !c.change.trim() && !c.conflict.trim() && !c.place.trim() && !c.big
    && !c.characters.length && !c.threads.length;
}

// 動かすだけ（保存と描き直しは呼ぶ側）
function moveCard(cardId, toBlockId, toIndex) {
  const from = findCard(cardId);
  const to = blockById(toBlockId);
  if (!from || !to) return;
  from.block.cards.splice(from.index, 1);
  if (from.block.id === to.id && from.index < toIndex) toIndex--;
  toIndex = Math.max(0, Math.min(toIndex, to.cards.length));
  to.cards.splice(toIndex, 0, from.card);
}

function addCard(blockId) {
  const b = blockById(blockId);
  const c = newCard();
  b.cards.push(c);
  ui.newCardId = c.id;
  changed();
  openCard(c.id);
}

function deleteCard(cardId) {
  const x = findCard(cardId);
  if (!x) return;
  x.block.cards.splice(x.index, 1);
  const im = work.intermission;
  if (im && im.blockId === x.block.id && im.index > x.index) im.index--;
  changed();
}

function changeType(type) {
  if (type === work.type) return;
  pushHistory(work, '型を変える前');
  const b = work.blocks;
  if (type === 'snyder') {
    // 柴型の第2ブロックをスナイダー型の第2幕・前半とし、後半を空で足す
    work.blocks = [b[0], b[1], { id: uid(), name: '', cards: [] }, b[2]];
  } else {
    // スナイダー型の第2幕の前半と後半をひとつにまとめる
    const im = work.intermission;
    if (im && im.blockId === b[2].id) {
      im.blockId = b[1].id;
      im.index += b[1].cards.length;
    }
    b[1].cards = b[1].cards.concat(b[2].cards);
    work.blocks = [b[0], b[1], b[3]];
  }
  TYPES[type].blocks.forEach((name, i) => (work.blocks[i].name = name));
  work.type = type;
  changed();
}

// ---------- 保存（端末内） ----------

let saveTimer = null;

function storageAvailable() {
  try {
    const k = 'daihon-board/__test';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}

function listWorks() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STORE_PREFIX)) continue;
      try {
        const w = normalizeWork(JSON.parse(localStorage.getItem(k)));
        if (w) out.push(w);
      } catch (e) { /* 壊れた項目は飛ばす */ }
    }
  } catch (e) { /* 使えない環境 */ }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function changed(skipRender) {
  work.updatedAt = new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
  setStatus('保存中…');
  if (!skipRender) renderMain(); // 文字入力中は描き直さない（入力が途切れるため）
  else syncExportBar();
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!work) return;
  if (!writeMainWork(work)) {
    ui.saveError = true;
    setStatus('保存できませんでした', true);
    return;
  }
  ui.saveError = false;
  setStatus('端末に保存済み');
  // 本体の保存が済んでから、履歴を足す（履歴の失敗は本体に響かせない）
  if (!ui.lastSnap || ui.lastSnap.id !== work.id || Date.now() - ui.lastSnap.t > AUTO_SNAPSHOT_MS) {
    pushHistory(work, '自動');
  }
}

// 作品そのものを保存する。容量が足りなければ、履歴を古いほうから減らして保存し直す
// （履歴が端末の容量を埋めて、本体が保存できなくなるのを防ぐ）。
function writeMainWork(w) {
  const data = JSON.stringify(w);
  for (let tries = 0; tries < 8; tries++) {
    try {
      localStorage.setItem(STORE_PREFIX + w.id, data);
      return true;
    } catch (e) {
      if (!trimHistories()) return false;
    }
  }
  return false;
}

// すべての作品の履歴を、古いほうから半分に減らす。減らせたら true。
// 1件しかない履歴（読み込み前の控えなど）は、ほかに減らせるものがないときだけ消す。
function trimHistories() {
  try {
    const lists = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(HISTORY_PREFIX)) {
        const arr = readJson(k, []);
        lists.push({ k, arr: Array.isArray(arr) ? arr : [] });
      }
    }
    const long = lists.filter((x) => x.arr.length > 1);
    if (long.length) {
      for (const x of long) {
        try {
          localStorage.setItem(x.k, JSON.stringify(x.arr.slice(0, Math.ceil(x.arr.length / 2))));
        } catch (e) {
          localStorage.removeItem(x.k);
        }
      }
      return true;
    }
    if (!lists.length) return false;
    lists.forEach((x) => localStorage.removeItem(x.k));
    return true;
  } catch (e) {
    return false;
  }
}

function setStatus(text, error) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!error || ui.saveError);
}

function openWork(w) {
  work = w;
  ui.landed = null;
  ui.focus = null;
  ui.newWorkOpen = false;
  ui.tab = 'board';
  pushHistory(w, '開いたとき');
  renderMain();
}

// 作品のデータ（本体・書き出しの控え・履歴）を端末から消す
function deleteWorkData(id) {
  try {
    localStorage.removeItem(STORE_PREFIX + id);
    localStorage.removeItem(META_PREFIX + id);
    localStorage.removeItem(HISTORY_PREFIX + id);
  } catch (e) { /* 何もしない */ }
}

// 削除の確認文（一覧と設定で共通）
function confirmDeleteWork(w) {
  const title = w.title || '無題';
  const msg = isUnexported(w)
    ? `「${title}」はまだ書き出していません。削除すると、この端末から消え、元に戻せません。削除しますか？`
    : `「${title}」をこの端末から削除しますか？元に戻せません。`;
  return confirm(msg);
}

function closeWork() {
  saveNow();
  if (work && isUnexported(work)) askBeforeClose();
  else doCloseWork();
}

// ---------- 書き出しの状態・版の履歴・書き出し・読み込み ----------

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function readMeta(id) {
  const m = readJson(META_PREFIX + id, {});
  return m && typeof m === 'object' ? m : {};
}

function writeMeta(id, meta) {
  try { localStorage.setItem(META_PREFIX + id, JSON.stringify(meta)); } catch (e) { /* 控えの失敗は無視 */ }
}

// 最後に書き出した版から変わっていれば「未書き出し」
function isUnexported(w) {
  return readMeta(w.id).exportedUpdatedAt !== w.updatedAt;
}

// 保留のカードも数える（読み込みの新旧比べや履歴で、保留だけの違いも見分けるため）
function cardCount(w) {
  return w.blocks.reduce((s, b) => s + b.cards.length, 0) + (Array.isArray(w.pool) ? w.pool.length : 0);
}

function readWork(id) {
  try { return normalizeWork(JSON.parse(localStorage.getItem(STORE_PREFIX + id))); } catch (e) { return null; }
}

function readHistory(id) {
  const arr = readJson(HISTORY_PREFIX + id, []);
  return Array.isArray(arr) ? arr.filter((e) => e && e.work && typeof e.work === 'object') : [];
}

// 容量が足りなければ古いものから捨てて書き直す。だめなら黙ってあきらめる。
function writeHistory(id, arr) {
  const list = arr.slice(0, HISTORY_MAX);
  while (list.length) {
    try {
      localStorage.setItem(HISTORY_PREFIX + id, JSON.stringify(list));
      return true;
    } catch (e) {
      list.pop();
    }
  }
  return false;
}

// 控えを取る。force でなければ、いちばん新しい控えと同じ版のときは取らない。
function pushHistory(w, reason, force) {
  try {
    const hist = readHistory(w.id);
    const newest = hist[0];
    if (!force && newest && newest.updatedAt === w.updatedAt) {
      ui.lastSnap = { id: w.id, t: new Date(newest.at).getTime() || 0 };
      return true;
    }
    ui.lastSnap = { id: w.id, t: Date.now() };
    hist.unshift({ at: new Date().toISOString(), reason, cards: cardCount(w), updatedAt: w.updatedAt, work: w });
    return writeHistory(w.id, hist);
  } catch (e) {
    return false;
  }
}

function restoreVersion(entry) {
  const w = normalizeWork(JSON.parse(JSON.stringify(entry.work)));
  if (!w) { alert('この版は読み込めませんでした。'); return; }
  pushHistory(work, '戻す前の控え', true);
  w.id = work.id;
  work = w;
  changed();   // 新しい更新日時になる＝変更として扱う
  saveNow();
  closeModal();
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

const IOS_HINT = '「共有」の画面で「“ファイル”に保存」を選び、iCloud Drive に保存してください。';

function exportFileName(title, d) {
  const p = (n) => String(n).padStart(2, '0');
  const safe = String(title || '').replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 40).trim() || '無題';
  return `${safe}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 書き出す。毎回、日時入りの新しいファイルにする（上書きしない）。書き出せたら true。
async function exportWork() {
  if (!work || ui.exporting) return false;
  saveNow(); // 更新日時を確定させる
  const w = work;
  const stamp = w.updatedAt;
  const now = new Date();
  const body = JSON.stringify(Object.assign({}, w, { exportedAt: now.toISOString() }), null, 2);
  const file = new File([body], exportFileName(w.title, now), { type: 'application/json' });
  ui.exporting = true;
  let ok = false;
  try {
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        ok = true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // 取りやめ＝書き出していない
        downloadFile(file);
        ok = true;
      }
    } else {
      downloadFile(file);
      ok = true;
    }
  } finally {
    ui.exporting = false;
  }
  if (ok) {
    writeMeta(w.id, { lastExportedAt: now.toISOString(), exportedUpdatedAt: stamp });
    if (work === w) renderMain();
  }
  return ok;
}

function renderExportBar() {
  return h('div', { class: 'export-bar', role: 'status' },
    h('span', { class: 'export-msg' }, '未書き出し'),
    h('button', { type: 'button', class: 'primary export-btn', onclick: exportWork }, '書き出す'));
}

// 文字入力中（描き直さないとき）も、帯の出し入れだけは行う
function syncExportBar() {
  if (!work) return;
  const cur = document.querySelector('.export-bar');
  const need = isUnexported(work);
  if (need && !cur) {
    const m = document.querySelector('.maintabs');
    if (m) m.after(renderExportBar());
  } else if (!need && cur) {
    cur.remove();
  }
}

// ---------- 読み込み ----------

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

async function onImportFile(file) {
  let data;
  try {
    data = JSON.parse(await readFileText(file));
  } catch (e) {
    alert('ファイルを読めませんでした。台本ボードで書き出した .json ファイルを選んでください。');
    return;
  }
  if (!data || data.format !== FORMAT) { alert('台本ボードで書き出したファイルではありません。'); return; }
  if (typeof data.version === 'number' && data.version > VERSION) {
    alert('新しい版のアプリで書き出されたファイルです。アプリを新しくしてから読み込んでください。');
    return;
  }
  if (!Array.isArray(data.blocks) || !data.blocks.length) { alert('このファイルには、ブロック（段）のデータがありません。'); return; }
  const exportedAt = typeof data.exportedAt === 'string' ? data.exportedAt : null;
  delete data.exportedAt;
  const w = normalizeWork(data);
  if (!w || typeof w.id !== 'string' || !w.id || !TYPES[w.type] || w.blocks.length !== TYPES[w.type].blocks.length) {
    alert('このファイルは作品として読み込めません。');
    return;
  }
  if (typeof w.title !== 'string') w.title = '';
  if (!w.updatedAt) w.updatedAt = w.createdAt || new Date().toISOString();
  showImportConfirm(w, exportedAt);
}

function showImportConfirm(w, exportedAt) {
  const local = readWork(w.id);
  const col = (label, x) => h('div', { class: 'cmp-col' },
    h('strong', {}, label),
    h('div', {}, x.title || '無題'),
    h('div', { class: 'cmp-sub' }, `最終更新 ${formatDate(x.updatedAt)}`),
    h('div', { class: 'cmp-sub' }, `カード ${cardCount(x)}枚`));
  let note;
  if (!local) {
    note = h('p', { class: 'import-note' }, 'この端末に新しく加えます');
  } else {
    const tf = new Date(w.updatedAt).getTime();
    const tl = new Date(local.updatedAt).getTime();
    if (tf < tl) note = h('p', { class: 'import-warn' }, '読み込むファイルのほうが古い版です。読み込むと、端末内の新しい内容が置き換わります（控えから戻せます）。');
    else if (tf === tl) note = h('p', { class: 'import-note' }, 'ファイルと端末内は、同じ版です。');
    else note = h('p', { class: 'import-note' }, 'ファイルのほうが新しい版です。');
  }
  const sheet = h('div', { class: 'sheet small-sheet import-sheet', role: 'dialog', 'aria-label': '読み込みの確認' },
    h('h2', {}, 'ファイルから読み込む'),
    h('div', { class: 'cmp' }, col('ファイル', w), local && col('この端末', local)),
    note,
    local && h('p', { class: 'note' }, '置き換える前に、端末内の版を控えに残します。'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary import-go', onclick: () => doImport(w, local, exportedAt) }, '読み込む'),
      h('button', { type: 'button', class: 'text-btn import-cancel', onclick: closeModal }, 'やめる')));
  modalRoot.replaceChildren(overlay(sheet, true));
}

function doImport(w, local, exportedAt) {
  if (local && !pushHistory(local, '読み込み前の控え', true)
    && !confirm('端末内の版の控えを残せませんでした。それでも読み込みますか？')) return;
  if (!writeMainWork(w)) {
    alert('端末に保存できませんでした。読み込みを取りやめました。');
    return;
  }
  // ファイルとして残っている版なので、書き出し済みとして扱う
  writeMeta(w.id, { lastExportedAt: exportedAt || new Date().toISOString(), exportedUpdatedAt: w.updatedAt });
  closeModal();
  openWork(w);
}

// ---------- 閉じる前の確認 ----------

function doCloseWork() {
  saveNow();
  work = null;
  ui.landed = null;
  ui.focus = null;
  closeModal();
  renderMain();
}

function askBeforeClose() {
  const sheet = h('div', { class: 'sheet small-sheet close-sheet', role: 'dialog', 'aria-label': '閉じる前の確認' },
    h('h2', {}, 'まだ書き出していません'),
    h('p', { class: 'note' }, 'この端末には残りますが、ファイルにはまだ残っていません。'),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary close-export', onclick: async () => {
        if (await exportWork()) doCloseWork();
      } }, '書き出してから閉じる'),
      isIOS() && h('small', { class: 'export-hint' }, '次の画面で「“ファイル”に保存」を選ぶ'),
      h('button', { type: 'button', class: 'close-discard', onclick: doCloseWork }, '書き出さずに閉じる'),
      h('button', { type: 'button', class: 'text-btn close-cancel', onclick: closeModal }, 'やめる')));
  modalRoot.replaceChildren(overlay(sheet, true));
}

// ---------- 画面：作品の一覧 ----------

// 見本：sample-*.js が window.SAMPLES に足す。無い・空のときは、見本の欄を出さない。
const SAMPLES = Array.isArray(window.SAMPLES) ? window.SAMPLES.filter((sm) => sm && sm.work) : [];

// 見本を複製して、新しい作品として開く（押すたびに別の作品になる）
function openSample(sm) {
  let w = null;
  try {
    w = JSON.parse(JSON.stringify(sm.work));
    const now = new Date().toISOString();
    w.id = uid();
    w.createdAt = now;
    w.updatedAt = now;
    w.title = (w.title || '無題') + '（見本）';
    w = normalizeWork(w);
  } catch (e) {
    w = null;
  }
  if (!w || !writeMainWork(w)) {
    alert(w ? '端末に保存できませんでした。' : '見本を読み込めませんでした。');
    return;
  }
  openWork(w);
}

function renderWorks() {
  const works = listWorks();
  let type = 'shiba';
  const titleInput = h('input', { type: 'text', placeholder: '作品名', 'aria-label': '作品名' });
  const radios = Object.entries(TYPES).map(([key, t]) =>
    h('label', {},
      h('input', { type: 'radio', name: 'type', value: key, checked: key === type, onchange: () => (type = key) }),
      t.label));
  const create = (e) => {
    e.preventDefault();
    const title = titleInput.value.trim() || '無題';
    const w = newWork(title, type);
    work = w;
    saveNow();
    openWork(w);
  };

  const importInput = h('input', { type: 'file', id: 'import-input', accept: '.json,application/json', hidden: true,
    onchange: (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) onImportFile(f);
    } });

  return h('div', { class: 'page works' },
    !ui.storageOk && h('div', { class: 'banner' }, 'この画面では保存できません。閉じると消えます。'),
    h('h1', {}, '台本ボード'),
    works.length
      ? h('ul', { class: 'work-list' }, works.map((w) => {
          const n = cardCount(w);
          return h('li', { class: 'work-item' },
            h('button', { type: 'button', class: 'work-open', onclick: () => openWork(w) },
              h('span', { class: 'w-title' }, w.title || '無題'),
              h('span', { class: 'w-date' }, formatDate(w.updatedAt)),
              h('span', { class: 'w-meta' }, `${TYPES[w.type] ? TYPES[w.type].short : ''}・${n}枚`,
                isUnexported(w) && h('span', { class: 'w-tag' }, '未書き出し'))),
            h('button', { type: 'button', class: 'work-del', 'aria-label': `「${w.title || '無題'}」を削除`, onclick: () => {
              if (!confirmDeleteWork(w)) return;
              deleteWorkData(w.id);
              if (work && work.id === w.id) { clearTimeout(saveTimer); saveTimer = null; work = null; }
              renderMain();
            } }, '削除'));
        }))
      : h('p', { class: 'note' }, 'まだ作品がありません。'),
    ui.newWorkOpen
      ? h('form', { class: 'new-work', onsubmit: create },
          h('strong', {}, '新しい作品'),
          titleInput,
          h('div', { class: 'radio-row' }, radios),
          h('div', { class: 'actions' },
            h('button', { type: 'submit', class: 'primary' }, '作る'),
            h('button', { type: 'button', class: 'new-work-cancel', onclick: () => { ui.newWorkOpen = false; renderMain(); } }, 'やめる')))
      : h('div', {}, h('button', { type: 'button', class: 'primary new-work-btn', onclick: () => {
          ui.newWorkOpen = true; renderMain();
          const el = document.querySelector('.new-work input[type=text]');
          if (el) el.focus();
        } }, '＋新しい作品')),
    h('div', { class: 'works-more' },
      h('div', { class: 'import-row' },
        h('button', { type: 'button', class: 'import-btn', onclick: () => importInput.click() }, 'ファイルから読み込む'),
        importInput),
      SAMPLES.length > 0 && h('div', { class: 'sample-row' },
        SAMPLES.map((sm) => h('div', { class: 'sample-item' },
          h('button', { type: 'button', class: 'sample-btn', onclick: () => openSample(sm) }, `見本を開く：${sm.label}`),
          sm.note && h('small', { class: 'sample-note' }, sm.note)))),
      h('p', { class: 'note' }, 'データはこの端末だけに保存されます（ホーム画面とSafariは別）')),
    h('p', { class: 'build-label' }, `アプリの版：${APP_BUILD}`));
}

// ---------- 画面：ボード ----------

function renderTopbar() {
  return h('div', { class: 'topbar' },
    h('button', { type: 'button', class: 'link', onclick: closeWork }, '‹ 一覧'),
    h('button', { type: 'button', class: 'title-btn', onclick: openSettings, title: '作品の設定' }, work.title || '無題'),
    h('span', { class: 'type' }, TYPES[work.type].short),
    h('span', { id: 'status', class: 'status' }, '端末に保存済み'));
}

function cardEl(c, over, bi, idx) {
  const noChange = !c.change.trim();
  const threads = work.threads.filter((t) => c.threads.includes(t.id));
  const cls = ['card', c.big && 'big', noChange && 'nochange', over && 'over',
    threads.length && 'has-band'].filter(Boolean);
  const styles = [];
  // 筋・人物で絞り込み中：入っていないカードは薄く、入っているカードはその色の縁
  const f = focusEntity();
  if (f) {
    if (c[f.kind === 'thread' ? 'threads' : 'characters'].includes(f.id)) { cls.push('focus-on'); styles.push(`--fc:${f.e.color}`); }
    else cls.push('dim');
  }
  // 置いた直後なら、光りかけの途中から続ける
  const ld = landedElapsed('card', c.id);
  if (ld != null) { cls.push('landed'); styles.push(`animation-delay:-${ld}ms`); }
  // 型を崩している印：右上の小さな三角（CSSだけ）
  let tip = null;
  if (bi >= 0 && beatsOn() && beatBroken(c, bi, idx)) {
    const bt = effectiveBeat(c, bi, idx);
    cls.push('beat-broken');
    tip = `${bt ? bt.label : 'ビートなし'}（型から外れています）`;
  }
  return h('button', {
    type: 'button', class: cls.join(' '), dataset: { card: c.id }, title: tip, style: styles.length ? styles.join(';') : null,
    onclick: () => {
      if (Date.now() - lastDragEnd < 400) return;
      if (ui.lifted) { if (ui.lifted.kind === 'card' && ui.lifted.id === c.id) cancelLift(); return; } // 持ち上げ中は開かない
      openCard(c.id);
    },
    onpointerdown: (e) => onItemPointerDown(e, 'card', c.id),
  },
    threads.length > 0 && h('span', { class: 'bands' }, threads.map((t) =>
      h('span', { class: 'band-seg', style: `background:${t.color}`, title: t.name }))),
    c.big && h('span', { class: 'star', title: '大きなイベント' }, '★'),
    h('span', { class: 'title' + (cardLabel(c) === '（見出しなし）' ? ' empty' : (c.title.trim() ? '' : ' fallback')) }, cardLabel(c)));
}

// ブロックの中身（カード・休憩・空き枠）を並べる
function blockItems(b) {
  const items = [];
  const im = work.intermission;
  const imIndex = im && im.blockId === b.id ? Math.min(im.index, b.cards.length) : -1;
  const bi = work.blocks.indexOf(b);
  b.cards.forEach((c, i) => {
    if (i === imIndex) items.push(breakEl());
    items.push(cardEl(c, i >= SLOTS, bi, i));
  });
  if (imIndex === b.cards.length) items.push(breakEl());
  for (let i = b.cards.length; i < SLOTS; i++) {
    // 空き枠には、置き場所のビートを薄い札で出す。＋は最初の空き枠だけ
    const pb = beatsOn() ? positionBeat(bi, i) : null;
    items.push(h('button', { type: 'button', class: 'slot', 'aria-label': 'カードを足す', onclick: () => addCard(b.id) },
      i === b.cards.length ? '＋' : '', pb && h('span', { class: 'beat-cap' }, pb.label)));
  }
  if (b.cards.length >= SLOTS) {
    items.push(h('button', { type: 'button', class: 'slot add-over', 'aria-label': '枠を超えてカードを足す', onclick: () => addCard(b.id) }, '＋'));
  }
  return items;
}

function breakEl() {
  const ld = landedElapsed('break', 'break');
  return h('button', { type: 'button', class: ld != null ? 'break landed' : 'break', style: ld != null ? `animation-delay:-${ld}ms` : null, onclick: () => {
    if (Date.now() - lastDragEnd < 400) return;
    if (ui.lifted) { if (ui.lifted.kind === 'break') cancelLift(); return; }
    if (confirm('休憩を取り除きますか？')) { work.intermission = null; changed(); }
  }, onpointerdown: (e) => onItemPointerDown(e, 'break', 'break') }, '休憩');
}

function countEl(b, cls) {
  const n = b.cards.length;
  return h('span', { class: cls + (n > SLOTS ? ' over' : '') }, `${n}/${SLOTS}`);
}

// 保留の列の中身：カードと、足すための＋ひとつだけ
function poolItems() {
  return [
    work.pool.map((c, i) => cardEl(c, false, -1, i)),
    h('button', { type: 'button', class: 'slot', 'aria-label': '保留にカードを足す', onclick: () => addCard('pool') }, '＋'),
  ];
}

// 絞り込み中の筋・人物（消えていたら解除）。{ kind, id, e } か null
function focusEntity() {
  const f = ui.focus;
  if (!f || !work) return null;
  const e = (f.kind === 'thread' ? work.threads : work.characters).find((x) => x.id === f.id);
  if (!e) { ui.focus = null; return null; }
  return { kind: f.kind, id: f.id, e };
}

function toggleFocus(kind, id) {
  ui.focus = ui.focus && ui.focus.kind === kind && ui.focus.id === id ? null : { kind, id };
  renderMain();
}

// 凡例：［色］で開閉する。筋の色・人物の色・印の意味。筋・人物の名前を押すと絞り込む
function renderLegend() {
  const open = ui.legendOpen;
  const btn = h('button', { type: 'button', class: 'legend-btn', 'aria-expanded': open ? 'true' : 'false',
    onclick: () => { ui.legendOpen = !ui.legendOpen; renderMain(); } }, '色');
  const f = focusEntity();
  const chip = f && h('button', { type: 'button', class: 'focus-chip', 'aria-label': `絞り込みを解除（${f.e.name || '名前なし'}）`,
    onclick: () => { ui.focus = null; renderMain(); } },
    f.kind === 'char' ? personMark(f.e, 12) : threadMark(f.e), f.e.name || '（名前なし）', h('span', { class: 'x' }, '×'));
  const row = h('div', { class: 'tools-row' }, btn, chip);
  if (!open) return h('div', { class: 'board-tools' }, row);
  const named = (e) => e.name || '（名前なし）';
  const pick = (kind, e, mark) => {
    const on = !!f && f.kind === kind && f.id === e.id;
    return h('button', { type: 'button', class: 'lg-item lg-btn' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
      onclick: () => toggleFocus(kind, e.id) }, mark, named(e));
  };
  return h('div', { class: 'board-tools' }, row,
    h('div', { class: 'legend board-legend' },
      work.threads.length > 0 && h('div', { class: 'lg-group' }, h('b', {}, '筋'),
        work.threads.map((t) => pick('thread', t, threadMark(t)))),
      work.characters.length > 0 && h('div', { class: 'lg-group' }, h('b', {}, '人物'),
        work.characters.map((p) => pick('char', p, personMark(p, 12)))),
      h('div', { class: 'lg-group' }, h('b', {}, '印'),
        h('span', { class: 'lg-item' }, h('i', { class: 'lg-dash' }), '変化 未記入'),
        h('span', { class: 'lg-item' }, h('i', { class: 'lg-tri' }), '型崩し'),
        h('span', { class: 'lg-item' }, h('i', { class: 'lg-star' }, '★'), '大きなイベント'))));
}

// ボード：ブロックごとの縦の列を、左から右へ並べる
function renderColumns() {
  return h('div', { class: 'cols', id: 'cols' },
    work.blocks.map((b) =>
      h('section', { class: 'row' },
        h('div', { class: 'row-head' }, h('span', { class: 'row-name' }, b.name), countEl(b, 'row-count')),
        h('div', { class: 'track', dataset: { block: b.id } }, blockItems(b)))),
    h('section', { class: 'row pool' },
      h('div', { class: 'row-head' }, h('span', { class: 'row-name' }, '保留'), h('span', { class: 'row-count' }, String(work.pool.length))),
      h('div', { class: 'track', dataset: { block: 'pool' } }, poolItems())));
}

function renderMainTabs() {
  const tab = (key, label) => h('button', { type: 'button', class: 'maintab' + (ui.tab === key ? ' active' : ''),
    dataset: { tab: key }, onclick: () => { if (ui.tab !== key) { ui.tab = key; renderMain(); window.scrollTo(0, 0); } } }, label);
  return h('div', { class: 'maintabs' }, tab('board', 'ボード'), tab('people', '人物'), tab('core', '芯'), tab('graph', 'グラフ'));
}

function renderBoard() {
  let body;
  if (ui.tab === 'people') {
    body = renderPeople();
  } else if (ui.tab === 'core') {
    body = renderCore();
  } else if (ui.tab === 'graph') {
    body = renderGraph();
  } else {
    body = h('div', { class: 'page board' }, renderLegend(), renderColumns());
  }
  return [
    h('div', { class: 'stickyhead' }, renderTopbar(), renderMainTabs()),
    isUnexported(work) && renderExportBar(),
    !ui.storageOk && h('div', { class: 'banner' }, 'この画面では保存できません。閉じると消えます。'),
    body,
  ];
}

function renderMain() {
  if (!work) clearUndo();
  const scrollY = window.scrollY;
  const cols = document.getElementById('cols');
  const colsScroll = cols ? cols.scrollLeft : null;
  const pw = document.querySelector('.ptable-wrap');
  const pwScroll = pw ? [pw.scrollLeft, pw.scrollTop] : null;
  const gw = document.querySelector('.gchart-wrap');
  const gwScroll = gw ? gw.scrollLeft : null;
  app.replaceChildren(...[].concat(work ? renderBoard() : renderWorks()).filter(Boolean));
  if (work) {
    if (saveTimer) setStatus('保存中…');
    else if (ui.saveError) setStatus('保存できませんでした', true);
    const cols2 = document.getElementById('cols');
    if (cols2 && colsScroll) cols2.scrollLeft = colsScroll;
    const pw2 = document.querySelector('.ptable-wrap');
    if (pw2 && pwScroll) { pw2.scrollLeft = pwScroll[0]; pw2.scrollTop = pwScroll[1]; }
    const gw2 = document.querySelector('.gchart-wrap');
    if (gw2 && gwScroll != null) gw2.scrollLeft = gwScroll;
    window.scrollTo(0, scrollY);
  }
  syncLift();
  syncLanded();
}

// ---------- 画面：人物 ----------

// 人物の印：その人物の色と形の小さな図形
function shapeEl(shape, color, size, attrs) {
  const a = Object.assign({ fill: color }, attrs || {});
  switch (shape) {
    case 'square': return s('rect', Object.assign({ x: 2, y: 2, width: 8, height: 8 }, a));
    case 'triangle': return s('path', Object.assign({ d: 'M6 1.5L11 10.5H1Z' }, a));
    case 'diamond': return s('path', Object.assign({ d: 'M6 0.8L11.2 6L6 11.2L0.8 6Z' }, a));
    case 'down': return s('path', Object.assign({ d: 'M1 1.5H11L6 10.5Z' }, a));
    case 'cross': return s('path', Object.assign({ d: 'M4.2 1H7.8V4.2H11V7.8H7.8V11H4.2V7.8H1V4.2H4.2Z' }, a));
    default: return s('circle', Object.assign({ cx: 6, cy: 6, r: 5 }, a));
  }
}
function personMark(p, size) {
  const z = size || 12;
  return s('svg', { class: 'pmark', width: z, height: z, viewBox: '0 0 12 12', 'aria-hidden': 'true' }, shapeEl(p.shape, p.color));
}
// 筋の印：短い縦の棒
function threadMark(t) {
  return h('i', { class: 'tmark', style: `background:${t.color}` });
}
function entMark(kind, e, size) {
  return kind === 'characters' ? personMark(e, size) : threadMark(e);
}

// 名前・色の1行。色ボタンを押すと、その行の下に色と削除の小さな欄が開く
function entityRow(kind, e) {
  const open = ui.entOpen === e.id;
  const row = h('div', { class: 'ent-row' },
    h('button', { type: 'button', class: 'ent-color', title: kind === 'characters' ? '色と形を変える' : '色を変える', 'aria-label': kind === 'characters' ? '色と形を変える' : '色を変える',
      'aria-expanded': open ? 'true' : 'false',
      onclick: () => { ui.entOpen = open ? null : e.id; renderMain(); } }, entMark(kind, e, 20)),
    h('input', { type: 'text', class: 'ent-name', value: e.name, 'aria-label': '名前', placeholder: kind === 'characters' ? '人物の名前' : '筋の名前',
      oninput: (ev) => {
        e.name = ev.target.value;
        changed(true);
        // 表に出ている名前だけ、その場で書き換える
        document.querySelectorAll('[data-pname]').forEach((el) => { if (el.dataset.pname === e.id) el.textContent = e.name || '（名前なし）'; });
      } }));
  if (!open) return row;
  return h('div', { class: 'ent-item' }, row,
    h('div', { class: 'ent-panel' },
      h('div', { class: 'swatches', role: 'group', 'aria-label': '色' }, PALETTE.map((col) =>
        h('button', { type: 'button', class: 'swatch' + (e.color === col ? ' on' : ''), style: `background:${col}`,
          'aria-label': `色 ${col}`, 'aria-pressed': e.color === col ? 'true' : 'false',
          onclick: () => { e.color = col; ui.entOpen = null; changed(); } }))),
      kind === 'characters' && h('div', { class: 'swatches shapes', role: 'group', 'aria-label': '形' }, SHAPES.map((sh) =>
        h('button', { type: 'button', class: 'swatch shape-btn' + (e.shape === sh ? ' on' : ''), 'data-shape': sh,
          'aria-label': `形 ${sh}`, 'aria-pressed': e.shape === sh ? 'true' : 'false',
          onclick: () => { e.shape = sh; changed(); } },
          personMark({ shape: sh, color: e.color }, 16)))),
      h('button', { type: 'button', class: 'ent-del', onclick: () => {
        const label = kind === 'characters' ? '人物' : '筋';
        if (!confirm(`${label}「${e.name || '名前なし'}」を削除しますか？すべてのカードから外れます。元に戻せません。`)) return;
        ui.entOpen = null;
        deleteEntity(kind, e.id);
        changed();
      } }, '削除')));
}

function promptAddEntity(kind, promptText) {
  const name = prompt(promptText);
  if (!name || !name.trim()) return;
  addEntity(kind, name);
  changed();
}

function entitySection(kind, title, addLabel, promptText) {
  return h('section', { class: 'psec' },
    h('h2', {}, title),
    work[kind].map((e) => entityRow(kind, e)),
    h('div', {}, h('button', { type: 'button', class: 'add-ent', onclick: () => promptAddEntity(kind, promptText) }, addLabel)));
}

// 人物の行の表示：行＝人物、列＝カード（ボードの順）
function renderPeopleTable() {
  const nums = numbering();
  const im = work.intermission;
  // 列を作る。休憩は、そのブロックの index 枚目の前
  const groups = work.blocks.map((b) => {
    const cols = [];
    const imIndex = im && im.blockId === b.id ? Math.min(im.index, b.cards.length) : -1;
    b.cards.forEach((c, i) => {
      if (i === imIndex) cols.push({ brk: true });
      cols.push({ card: c });
    });
    if (imIndex === b.cards.length) cols.push({ brk: true });
    return { block: b, cols };
  }).filter((g) => g.cols.length);

  const head1 = h('tr', {}, h('th', { class: 'corner', rowspan: 2 }, '人物'),
    groups.map((g, gi) => h('th', { class: 'bh' + (gi > 0 ? ' bs' : ''), colspan: g.cols.length }, g.block.name)));
  const head2 = h('tr', {}, groups.flatMap((g, gi) => g.cols.map((col, ci) => {
    const cls = (ci === 0 && gi > 0 ? ' bs' : '');
    return col.brk
      ? h('th', { class: 'brk' + cls, title: '休憩' })
      : h('th', { class: 'ch' + cls }, `#${nums.get(col.card.id)}`);
  })));

  const rows = work.characters.map((p) => {
    const count = allCards().filter((x) => x.card.characters.includes(p.id)).length;
    return h('tr', {},
      h('th', { class: 'rname', scope: 'row' },
        personMark(p, 12),
        h('span', { class: 'rn', dataset: { pname: p.id } }, p.name || '（名前なし）'),
        h('span', { class: 'cnt' }, `${count}枚`)),
      groups.flatMap((g, gi) => g.cols.map((col, ci) => {
        const bs = ci === 0 && gi > 0 ? ' bs' : '';
        if (col.brk) return h('td', { class: 'brk' + bs });
        const c = col.card;
        const on = c.characters.includes(p.id);
        const v = on ? c.states[p.id] : undefined;
        return h('td', { class: 'pc' + (on ? ' on' : '') + bs, dataset: { card: c.id, char: p.id },
          onclick: () => openCard(c.id) },
          v !== undefined ? h('span', { class: 'pv' }, fmtState(v)) : on && h('span', { class: 'pdot' }));
      })));
  });

  return h('div', { class: 'ptable-wrap' },
    h('table', { class: 'ptable' }, h('thead', {}, head1, head2), h('tbody', {}, rows)));
}

function renderPeople() {
  const edit = h('details', { class: 'ent-edit', open: ui.entEditOpen, ontoggle: (e) => { if (e.target === edit) ui.entEditOpen = edit.open; } },
    h('summary', {}, '編集'),
    entitySection('characters', '登場人物', '＋人物を足す', '人物の名前'),
    entitySection('threads', '筋', '＋筋を足す', '筋の名前'));
  return h('div', { class: 'page people' },
    work.characters.length
      ? [renderPeopleTable(),
         h('div', { class: 'actions people-links' },
           h('button', { type: 'button', class: 'link to-graph', onclick: () => { ui.tab = 'graph'; renderMain(); window.scrollTo(0, 0); } }, 'グラフで見る'))]
      : h('div', { class: 'empty-people' },
          h('p', { class: 'note' }, 'まだ人物がいません。'),
          h('button', { type: 'button', class: 'primary add-person-direct', onclick: () => promptAddEntity('characters', '人物の名前') }, '＋人物を足す')),
    edit);
}

// ---------- 画面：グラフ（人物の状態の曲線） ----------

function s(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : String(c));
  }
  return el;
}

function charHasStates(p) {
  return allCards().some((x) => x.card.states[p.id] !== undefined);
}

function graphVisible(p) {
  return ui.graphOn[p.id] !== undefined ? ui.graphOn[p.id] : charHasStates(p);
}

function renderGraphChart(chars, cards, nums) {
  const N = cards.length;
  const L = 60, R = 16, T = 30, B = 44, H = 280;
  const avail = Math.max(280, (app.clientWidth || 600) - 34);
  const W = Math.max(avail, N * 22 + L + R);
  const cw = (W - L - R) / N;
  const xc = (i) => L + (i + 0.5) * cw;
  const xe = (i) => L + i * cw; // i 枚目の左の縁
  const ph = H - T - B;
  const yv = (v) => T + (3 - v) / 6 * ph;
  const svg = s('svg', { class: 'gchart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group',
    'aria-label': '人物の状態のグラフ。横は左からカードの順、縦は幸（＋3）から不幸（−3）' });

  // 状態が誰にも入っていないカードの帯
  cards.forEach((x, i) => {
    if (!work.characters.some((p) => x.card.states[p.id] !== undefined)) {
      svg.append(s('rect', { class: 'g-gap', x: xe(i), y: T, width: cw, height: ph }));
    }
  });
  // 横の目盛り線
  for (let v = -3; v <= 3; v++) {
    svg.append(s('line', { class: v === 0 ? 'g-zero' : 'g-grid', x1: L, x2: W - R, y1: yv(v), y2: yv(v) }));
  }
  [[3, '＋3 幸'], [0, '0'], [-3, '−3 不幸']].forEach(([v, t]) =>
    svg.append(s('text', { class: 'g-ylab', x: L - 6, y: yv(v) + 4, 'text-anchor': 'end' }, t)));

  // ブロックの境目と名前、休憩
  const im = work.intermission;
  let off = 0;
  work.blocks.forEach((b, bi) => {
    const n = b.cards.length;
    if (!n) return;
    if (off > 0) svg.append(s('line', { class: 'g-block', x1: xe(off), x2: xe(off), y1: 6, y2: T + ph }));
    const bx = xe(off) + 4;
    svg.append(s('svg', { x: bx, y: 4, width: Math.max(0, n * cw - 8), height: 18, overflow: 'hidden' },
      s('text', { class: 'g-blab', x: 0, y: 13 }, b.name)));
    if (im && im.blockId === b.id) {
      const xi = xe(off + Math.min(im.index, n));
      svg.append(s('line', { class: 'g-brk', x1: xi, x2: xi, y1: 6, y2: T + ph }),
        s('text', { class: 'g-brklab', x: xi + 3, y: T + ph + 28 }, '休憩'));
    }
    off += n;
  });

  // 横軸：#n と大きなイベント
  const every = cw >= 18 ? 1 : 5;
  cards.forEach((x, i) => {
    const n = i + 1;
    if (every === 1 || n === 1 || n % every === 0) {
      svg.append(s('text', { class: 'g-xlab', x: xc(i), y: T + ph + 14, 'text-anchor': 'middle' }, `#${n}`));
    }
    if (x.card.big) svg.append(s('text', { class: 'g-star', x: xc(i), y: T + ph + 30, 'text-anchor': 'middle' }, '★'));
  });

  // 人物ごとの階段状の線と点
  const dots = [];
  work.characters.forEach((p) => {
    if (!graphVisible(p)) return;
    const pts = [];
    cards.forEach((x, i) => { const v = x.card.states[p.id]; if (v !== undefined) pts.push({ i, v, x }); });
    if (!pts.length) return;
    let d = `M${xc(pts[0].i)} ${yv(pts[0].v)}`;
    pts.forEach((pt, k) => {
      if (k > 0) d += `H${xc(pt.i)}V${yv(pt.v)}`;
    });
    d += `H${xc(N - 1)}`;
    svg.append(s('path', { class: 'g-line', d, stroke: p.color, 'data-char': p.id }));
    pts.forEach((pt) => dots.push({ p, pt, cx: xc(pt.i), cy: yv(pt.v) }));
  });
  dots.forEach(({ p, pt, cx, cy }) => {
    const label = `${p.name || '（名前なし）'} #${nums.get(pt.x.card.id)} ${cardLabel(pt.x.card)} ${fmtState(pt.v).replace('+', '＋')}`;
    const open = () => openCard(pt.x.card.id);
    svg.append(s('g', { class: 'g-pt', tabindex: 0, role: 'button', 'aria-label': label, 'data-card': pt.x.card.id, 'data-char': p.id,
      onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
      s('title', {}, label),
      s('circle', { class: 'g-hit', cx, cy, r: 11 }),
      s('g', { class: 'g-dot', transform: `translate(${cx - 5.5} ${cy - 5.5}) scale(${11 / 12})` }, shapeEl(p.shape, p.color, 12, { stroke: 'var(--paper)', 'stroke-width': 1.5, 'paint-order': 'stroke' }))));
  });
  return svg;
}

function renderGraph() {
  if (!work.characters.length) {
    return h('div', { class: 'page graph' },
      h('p', { class: 'note' }, 'まだ人物がいません。'));
  }
  const cards = allCards();
  const anyState = work.characters.some(charHasStates);
  if (!anyState) {
    return h('div', { class: 'page graph' },
      h('p', { class: 'note' }, 'まだ状態の値がありません。'));
  }
  const nums = numbering();
  const chips = h('div', { class: 'gchips', role: 'group', 'aria-label': '表示する人物' }, work.characters.map((p) => {
    const on = graphVisible(p);
    const has = charHasStates(p);
    return h('button', { type: 'button', class: 'gchip' + (on ? ' on' : '') + (has ? '' : ' none'), 'aria-pressed': on ? 'true' : 'false',
      dataset: { char: p.id }, onclick: () => { ui.graphOn[p.id] = !on; renderMain(); } },
      personMark(p, 12), h('span', {}, p.name || '（名前なし）'), !has && h('small', {}, '値なし'));
  }));
  return h('div', { class: 'page graph' },
    chips,
    h('div', { class: 'gchart-wrap' }, renderGraphChart(work.characters, cards, nums)),
    h('p', { class: 'legend' }, '灰色＝変化なし'));
}

// ---------- 画面：芯 ----------

function renderCore() {
  const co = work.core;
  // 高さを中身に合わせる
  const fit = (el) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
  const area = (key, hint, label) => {
    const el = h('textarea', { rows: 1, value: co[key], placeholder: hint || '', 'aria-label': label || hint || key,
      oninput: (e) => { co[key] = e.target.value; fit(e.target); changed(true); } });
    requestAnimationFrame(() => fit(el));
    return el;
  };
  const line = (key, label, hint) => h('div', { class: 'core-line', dataset: { field: key } },
    h('span', { class: 'core-lab' }, label), area(key, hint, label));
  const half = (key, label, hint) => h('div', { class: 'core-half', dataset: { field: key } },
    h('span', { class: 'core-lab' }, label), area(key, hint, label));
  const theme = h('div', { class: 'core-theme', dataset: { field: 'theme' } },
    h('span', { class: 'core-lab' }, 'テーマ'), area('theme', 'テーマを一言', 'テーマ'));
  return h('div', { class: 'page core' },
    h('div', { class: 'core-paper' },
      theme,
      line('protagonist', '主人公', '主人公'),
      h('div', { class: 'core-pair' },
        half('want', '求めるもの', '主人公が求めているもの'),
        half('obstacle', '阻むもの', '求めるものを阻むもの')),
      line('event', '決定的な出来事', '決定的な出来事'),
      h('div', { class: 'core-arrow', 'aria-hidden': 'true' }, '↓'),
      line('change', '最後の変化', '最後の変化')));
}

// ---------- カードの詳細 ----------

function openCard(id) {
  clearUndo();
  cancelLift();
  ui.openCardId = id;
  renderCardSheet();
}

function closeModal() {
  if (ui.openCardId && ui.openCardId === ui.newCardId) {
    const x = findCard(ui.openCardId);
    if (x && isBlank(x.card)) deleteCard(x.card.id);
  }
  ui.openCardId = null;
  ui.newCardId = null;
  ui.settingsOpen = false;
  modalRoot.replaceChildren();
}

// small が true のときは、短い確認の小さな面（スマホでは下から出る）
function overlay(sheet, small) {
  const o = h('div', { class: small ? 'overlay bottom' : 'overlay', onclick: (e) => { if (e.target === o) closeModal(); } }, sheet);
  return o;
}

// 人物・筋をえらぶチップ
function chipPicker(c, kind, label, addLabel, promptText) {
  return h('div', { class: 'field' },
    h('span', {}, label),
    h('div', { class: 'chips' },
      work[kind].map((e) => {
        const on = c[kind].includes(e.id);
        return h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
          dataset: { id: e.id }, style: `--c:${e.color}`,
          onclick: () => { toggleOnCard(c, kind, e.id); changed(); renderCardSheet(); } },
          entMark(kind, e, 14), e.name || '（名前なし）');
      }),
      h('button', { type: 'button', class: 'chip add', onclick: () => {
        const name = prompt(promptText);
        if (!name || !name.trim()) return;
        const e = addEntity(kind, name);
        c[kind].push(e.id);
        changed(); renderCardSheet();
      } }, addLabel)));
}

// 状態：このカードに出る人物ごとに、変化の値をえらぶ
function stateField(c) {
  const chars = work.characters.filter((p) => c.characters.includes(p.id));
  if (!chars.length) return null;
  const values = [null, -3, -2, -1, 0, 1, 2, 3];
  return h('div', { class: 'field' },
    h('span', {}, '状態'),
    chars.map((p) => h('div', { class: 'state-row', dataset: { char: p.id } },
      h('span', { class: 'state-name' }, personMark(p, 14), p.name || '（名前なし）'),
      h('div', { class: 'seg', role: 'group', 'aria-label': `${p.name || '人物'}の状態` }, values.map((v) => {
        const on = v === null ? c.states[p.id] === undefined : c.states[p.id] === v;
        return h('button', { type: 'button', class: 'seg-btn' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
          dataset: { v: v === null ? 'none' : v },
          onclick: () => {
            if (v === null) delete c.states[p.id];
            else c.states[p.id] = v;
            changed(); renderCardSheet();
          } }, v === null ? 'なし' : fmtState(v));
      })))));
}

// 演出メモ：細かいイベントと人物ごとの意図。ふだんは畳んでおく
function memoField(c) {
  const chars = work.characters.filter((p) => c.characters.includes(p.id));
  return h('details', { class: 'memo', open: ui.memoOpen, ontoggle: (e) => { ui.memoOpen = e.target.open; } },
    h('summary', {}, '演出メモ'),
    h('label', { class: 'field', dataset: { field: 'subEvents' } },
      h('span', {}, '細かいイベント（1行に1つ）'),
      h('textarea', { value: c.subEvents, oninput: (e) => { c.subEvents = e.target.value; changed(); } })),
    chars.length
      ? chars.map((p) => h('label', { class: 'field', dataset: { intent: p.id } },
          h('span', {}, personMark(p, 12), `${p.name || '（名前なし）'}の意図`),
          h('input', { type: 'text', value: c.intents[p.id] || '', 'aria-label': `${p.name || '人物'}の意図`,
            oninput: (e) => { c.intents[p.id] = e.target.value; changed(); } })))
      : null);
}

// ---------- アイデアの種 ----------
// seeds.js が window.SEEDS を用意する。無い・空のときは、種のボタンを出さない。
const SEEDS = window.SEEDS || {};
const SEED_KEYS = ['event', 'change', 'conflict'];
const lastSeedPick = {};   // 項目ごとに、前回ランダムで出した種

function seedList(key) {
  const a = SEEDS[key];
  return Array.isArray(a) ? a.filter((t) => typeof t === 'string' && t) : [];
}

// そのカードのビートに合う種（ビートが無い・札を隠しているときは空）
function cardBeat(c) {
  const x = beatsOn() ? findCard(c.id) : null;
  return x && x.bi >= 0 ? effectiveBeat(c, x.bi, x.index) : null;
}

function beatSeedList(c, key) {
  const bt = cardBeat(c);
  const a = bt && bt.seeds && bt.seeds[key];
  return Array.isArray(a) ? a.filter((t) => typeof t === 'string' && t) : [];
}

function anySeeds(c, key) {
  return seedList(key).length > 0 || beatSeedList(c, key).length > 0;
}

// 項目ごとの「元に戻す」用。直前の置き換えの前の文字（1段・メモリのみ。シートを描き直すと消える）
let seedUndo = {};

function allSeedTexts(key) {
  const set = new Set(seedList(key));
  if (BEATS && Array.isArray(BEATS.list)) {
    for (const b of BEATS.list) {
      const a = b && b.seeds && b.seeds[key];
      if (Array.isArray(a)) a.forEach((t) => { if (typeof t === 'string' && t) set.add(t); });
    }
  }
  return set;
}

// 空、または種そのままなら、黙って置き換えてよい
function isSilentSeedField(key, ta) {
  const v = ta.value.trim();
  return v === '' || allSeedTexts(key).has(v);
}

const SEED_CONFIRM = '手で書いた文があります。種に置き換えますか？（あとで「元に戻す」で戻せます）';

function undoButton(key) {
  return modalRoot.querySelector(`.seed-undo[data-key="${key}"]`);
}

// 種に置き換える（確認は済んでいる前提）。入力欄はその場で書き換える（シートは描き直さない）。
function applySeed(c, key, seed, ta) {
  const prev = seedUndo[key];
  // 種から種への入れ替えのあいだは、種を出す前の文（手で書いた文）を「元に戻す」に残し続ける
  const seedToSeed = prev && prev.cardId === c.id && ta.value.trim() !== '' && isSilentSeedField(key, ta);
  if (!seedToSeed) seedUndo[key] = { cardId: c.id, text: ta.value };
  ta.value = seed;
  c[key] = ta.value;
  changed();
  const u = undoButton(key);
  if (u) u.hidden = false;
  ta.classList.remove('flash');
  void ta.offsetWidth;   // アニメーションをやり直す
  ta.classList.add('flash');
}

// 種を入れる。手で書いた文があるときは、確認してから置き換える。
function insertSeed(c, key, seed, ta) {
  if (!isSilentSeedField(key, ta) && !confirm(SEED_CONFIRM)) return false;
  applySeed(c, key, seed, ta);
  return true;
}

function undoSeed(c, key, ta) {
  const u = seedUndo[key];
  if (!u || u.cardId !== c.id) return;
  delete seedUndo[key];
  ta.value = u.text;
  c[key] = ta.value;
  changed();
  const b = undoButton(key);
  if (b) b.hidden = true;
}

// 次に出す種を選ぶ（なければ null）
function pickRandomSeed(c, key) {
  // ビートの種を7割、ふつうの種を3割（片方が空なら、もう片方だけ）
  const bl = beatSeedList(c, key), gl = seedList(key);
  const list = !bl.length ? gl : !gl.length ? bl : (Math.random() < 0.7 ? bl : gl);
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((t) => t !== lastSeedPick[key]) : list;
  const seed = pool[Math.floor(Math.random() * pool.length)];
  lastSeedPick[key] = seed;
  return seed;
}

function randomSeed(c, key, ta) {
  const seed = pickRandomSeed(c, key);
  if (seed != null) insertSeed(c, key, seed, ta);
}

// カードのビートを選ぶ欄（札を隠している・seeds.js が無いときは出さない）
function beatField(c, x) {
  if (!beatsOn() || x.bi < 0) return null;
  const pos = positionBeat(x.bi, x.index);
  const eff = effectiveBeat(c, x.bi, x.index);
  const sel = h('select', { 'aria-label': 'ビート', class: 'beat-select',
    onchange: (e) => { c.beat = e.target.value || null; changed(); renderCardSheet(); } },
    h('option', { value: '' }, `自動（${pos ? pos.label : 'なし'}）`),
    BEATS.list.map((b) => h('option', { value: b.id }, b.label)),
    h('option', { value: 'none' }, 'なし'));
  sel.value = c.beat || '';
  return h('label', { class: 'field', dataset: { field: 'beat' } },
    h('span', {}, 'ビート'),
    sel,
    h('small', { class: 'beat-desc' }, eff ? eff.desc : ''));
}

function renderCardSheet() {
  seedUndo = {};
  const x = findCard(ui.openCardId);
  if (!x) { closeModal(); return; }
  const c = x.card;
  // 前・次のカード（ボードはボードの順、保留は保留の中の順）
  const order = x.bi >= 0 ? allCards().map((y) => y.card.id) : work.pool.map((y) => y.id);
  const oi = order.indexOf(c.id);
  const prevId = oi > 0 ? order[oi - 1] : null;
  const nextId = oi >= 0 && oi < order.length - 1 ? order[oi + 1] : null;
  const goCard = (id) => {
    // 作ったばかりで空のカードは、離れるときに消す
    if (ui.newCardId === c.id && isBlank(c)) deleteCard(c.id);
    ui.newCardId = null;
    openCard(id);
  };

  const text = (key, label, hint, multi) => {
    const ta = h(multi ? 'textarea' : 'input', {
      type: multi ? null : 'text', value: c[key], placeholder: hint,
      oninput: (e) => {
        c[key] = e.target.value; changed();
        if (seedUndo[key]) { delete seedUndo[key]; const u = undoButton(key); if (u) u.hidden = true; }
      },
    });
    ta.dataset.key = key;
    let row = null, list = null;
    if (SEED_KEYS.includes(key) && anySeeds(c, key)) {
      // 種：［ランダム］［一覧から選ぶ］と、開閉する一覧（ビートの種があれば先の組にする）
      const item = (t) => h('button', { type: 'button', class: 'seed-item',
        onclick: () => { if (insertSeed(c, key, t, ta)) list.hidden = true; } }, t);
      const bl = beatSeedList(c, key), gl = seedList(key);
      list = h('div', { class: 'seed-list', hidden: true, dataset: { key } },
        bl.length && gl.length
          ? [h('div', { class: 'seed-head', dataset: { group: 'beat' } }, `${cardBeat(c).label}の種`), bl.map(item),
             h('div', { class: 'seed-head', dataset: { group: 'other' } }, 'ほかの種'), gl.map(item)]
          : (bl.length ? bl : gl).map(item));
      row = h('div', { class: 'seed-row' },
        h('button', { type: 'button', class: 'seed-btn seed-random', dataset: { key },
          onclick: () => randomSeed(c, key, ta) }, 'ランダム'),
        h('button', { type: 'button', class: 'seed-btn seed-pick', dataset: { key },
          onclick: () => {
            const open = list.hidden;
            modalRoot.querySelectorAll('.seed-list').forEach((l) => { l.hidden = true; });
            list.hidden = !open;
          } }, '一覧から選ぶ'),
        h('button', { type: 'button', class: 'seed-btn seed-undo', hidden: true, dataset: { key },
          onclick: () => undoSeed(c, key, ta) }, '元に戻す'));
    }
    // 種のボタンがあるときは label で包まない（見出しを押すと、中の最初のボタンが押されてしまうため）
    if (row) ta.setAttribute('aria-label', label);
    return h(row ? 'div' : 'label', { class: 'field', dataset: { field: key } },
      h('span', {}, label),
      row, ta, list);
  };

  // 3項目まとめてランダム（種が1つも無ければ出さない）
  const seedAll = SEED_KEYS.some((k) => anySeeds(c, k))
    ? h('div', { class: 'seed-all' },
        h('button', { type: 'button', class: 'seed-btn seed-all-btn', onclick: () => {
          const jobs = [];
          for (const k of SEED_KEYS) {
            const ta = modalRoot.querySelector(`textarea[data-key="${k}"]`);
            const seed = ta ? pickRandomSeed(c, k) : null;
            if (seed != null) jobs.push({ k, ta, seed, silent: isSilentSeedField(k, ta) });
          }
          const ask = jobs.filter((j) => !j.silent);
          let all = true;
          if (ask.length) {
            const names = { conflict: '対立', event: '何が起きるか', change: '変化' };
            const label = SEED_KEYS.filter((k) => ask.some((j) => j.k === k)).map((k) => names[k]).join('・');
            all = confirm(`${label}には手で書いた文があります。置き換えますか？（あとで「元に戻す」で戻せます）`);
          }
          for (const j of jobs) if (j.silent || all) applySeed(c, j.k, j.seed, j.ta);
        }, title: '種は出発点です。押すたびに入れ替わります。手で書いた文は、置き換える前に確認します。' }, '3つまとめてランダム'))
    : null;

  const im = work.intermission;
  const breakHere = im && im.blockId === x.block.id && im.index === x.index + 1;

  const more = h('details', { class: 'more', open: ui.moreOpen, ontoggle: (e) => { if (e.target === more) ui.moreOpen = more.open; } },
    h('summary', {}, 'その他'),
    beatField(c, x),
    chipPicker(c, 'threads', '筋', '＋筋を足す', '筋の名前'),
    text('place', '場所'),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: c.big, onchange: (e) => { c.big = e.target.checked; changed(); } }),
      '★ 大きなイベント'),
    stateField(c),
    memoField(c),
    h('div', { class: 'actions' },
      x.bi < 0 ? null : breakHere
        ? h('button', { type: 'button', onclick: () => { work.intermission = null; changed(); renderCardSheet(); } }, '休憩を取り除く')
        : h('button', { type: 'button', onclick: () => {
            work.intermission = { blockId: x.block.id, index: x.index + 1 };
            changed(); renderCardSheet();
          } }, 'このカードの後に休憩を置く'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'danger', onclick: () => {
        if (!confirm('このカードを削除しますか？元に戻せません。')) return;
        pushHistory(work, 'カード削除の前');
        deleteCard(c.id);
        ui.newCardId = null;
        closeModal();
      } }, '削除')));

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'カードの詳細' },
    h('div', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'card-prev', 'aria-label': '前のカード', title: '前のカード', disabled: !prevId, onclick: () => goCard(prevId) }, '‹'),
      h('button', { type: 'button', class: 'card-next', 'aria-label': '次のカード', title: '次のカード', disabled: !nextId, onclick: () => goCard(nextId) }, '›'),
      h('span', { class: 'where' }, x.bi < 0 ? '保留' : `${x.block.name} ${x.index + 1}`),
      h('button', { type: 'button', class: 'primary', onclick: closeModal }, '閉じる')),
    text('title', '見出し', '空なら『何が起きるか』の1行目'),
    chipPicker(c, 'characters', '登場人物', '＋人物を足す', '人物の名前'),
    seedAll,
    text('conflict', '対立', '誰が何を求め、誰が邪魔するか', true),
    text('event', '何が起きるか', 'その瞬間に起きること', true),
    text('change', '変化', '全員の欲求がどう変わるか', true),
    more);

  const wasOpen = modalRoot.firstChild;
  const oldSheet = modalRoot.querySelector('.sheet');
  const scrollTop = oldSheet ? oldSheet.scrollTop : 0;
  modalRoot.replaceChildren(overlay(sheet));
  sheet.scrollTop = scrollTop;
  if (!wasOpen && ui.newCardId === c.id) sheet.querySelector('input').focus();
}

// ---------- 作品の設定 ----------

// 版の履歴：控えの一覧。ここから戻せる。
function historySection() {
  const hist = readHistory(work.id);
  return h('div', { class: 'field' },
    h('span', {}, '版の履歴'),
    hist.length
      ? h('ul', { class: 'history-list' }, hist.map((e) =>
          h('li', { class: 'history-item' },
            h('span', { class: 'hi-text' }, `${formatDate(e.at)}　${e.reason || ''}　${e.cards}枚`),
            h('button', { type: 'button', class: 'restore-btn', onclick: () => {
              if (confirm('この版に戻しますか？今の内容は「戻す前の控え」として履歴に残ります。')) restoreVersion(e);
            } }, 'この版に戻す'))))
      : h('small', {}, 'まだありません'));
}

function openSettings() {
  clearUndo();
  cancelLift();
  ui.settingsOpen = true;
  const titleInput = h('input', { type: 'text', value: work.title,
    oninput: (e) => { work.title = e.target.value; changed(); } });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': '作品の設定' },
    h('div', { class: 'sheet-head' },
      h('h2', { class: 'where' }, '作品の設定'),
      h('button', { type: 'button', class: 'primary', onclick: closeModal }, '閉じる')),
    h('label', { class: 'field' }, h('span', {}, '作品名'), titleInput),
    h('div', { class: 'field' },
      h('span', {}, '型'),
      h('div', { class: 'radio-row' }, Object.entries(TYPES).map(([key, t]) =>
        h('label', {}, h('input', { type: 'radio', name: 'stype', value: key, checked: key === work.type,
          onchange: (e) => {
            const msg = key === 'snyder'
              ? 'スナイダー型に変えます。第2ブロックは「第2幕・前半」になり、空の「第2幕・後半」が加わります。'
              : '柴型に変えます。「第2幕・前半」と「第2幕・後半」のカードを、第2ブロックにまとめます。';
            if (confirm(msg)) changeType(key);
            closeModal(); openSettings();
          } }), t.label))),
      null),
    h('div', { class: 'field' },
      h('span', {}, 'ファイルに書き出す'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary export-btn settings-export', onclick: exportWork }, '書き出す'),
        isUnexported(work) ? h('small', { class: 'unexp-note' }, 'まだ書き出していません') : h('small', {}, '書き出し済み')),
      isIOS() && h('small', { class: 'export-hint' }, IOS_HINT)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'copy-outline settings-copy', onclick: copyOutline }, '骨格をコピー')),
    BEAT_MAP && h('label', { class: 'check' },
      h('input', { type: 'checkbox', class: 'show-beats', checked: work.showBeats !== false,
        onchange: (e) => { work.showBeats = e.target.checked; changed(); } }),
      '型の札を表示する'),
    historySection(),
    h('div', { class: 'actions' },
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'danger', onclick: () => {
        if (!confirmDeleteWork(work)) return;
        deleteWorkData(work.id);
        clearTimeout(saveTimer); saveTimer = null;
        work = null;
        closeModal();
        renderMain();
      } }, 'この作品を削除')),
    h('p', { class: 'build-label' }, `アプリの版：${APP_BUILD}`));
  modalRoot.replaceChildren(overlay(sheet));
}

// ---------- 持ち上げて並べ替え ----------
// 長押し（約0.35秒）で持ち上げる。持ち上げたまま動かせばドラッグ、離せば持ち上げたまま（置く場所をタップ）。
// マウスは、押して少し動かせばすぐドラッグ。置ける場所は .drop-gap（カードのあいだ・列の末尾）。

let drag = null;
let lastDragEnd = 0;
const LONG_PRESS_MS = 350;

function liftedEl() {
  const l = ui.lifted;
  if (!l) return null;
  return l.kind === 'break'
    ? document.querySelector('#app .break')
    : document.querySelector(`#app .card[data-card="${CSS.escape(l.id)}"]`);
}

function clearGaps() {
  document.querySelectorAll('.drop-gap').forEach((el) => el.remove());
}

// カードのあいだ・列の末尾に、置き場所を出す（位置は列の中で決める。カードの並びは動かさない）
function showGaps(kind) {
  clearGaps();
  document.querySelectorAll('#cols .track').forEach((track) => {
    const bid = track.dataset.block;
    if (kind === 'break' && bid === 'pool') return; // 休憩は保留に置けない
    let idx = 0, emitted = false, bottom = null;
    const add = (index, y) => track.append(h('button', {
      type: 'button', class: 'drop-gap', dataset: { block: bid, index: String(index) },
      'aria-label': 'ここに置く', tabindex: '-1', style: `top:${y - 14}px`,
      onclick: () => { if (ui.lifted) placeLifted(bid, index); },
    }));
    for (const ch of Array.from(track.children)) {
      const isCard = ch.classList.contains('card');
      if (!isCard && !ch.classList.contains('break')) continue;
      if (!emitted) { add(idx, ch.offsetTop - 3); emitted = true; }
      if (isCard) { idx++; emitted = false; }
      bottom = ch.offsetTop + ch.offsetHeight;
    }
    if (!emitted) add(idx, bottom == null ? 4 : bottom + 3);
  });
}

function setHot(gap) {
  document.querySelectorAll('.drop-gap.hot').forEach((g) => { if (g !== gap) g.classList.remove('hot'); });
  if (gap) gap.classList.add('hot');
}

// 持ち上げの表示（印・置き場所・下の帯）を、いまの状態に合わせる。描き直しのあとにも呼ぶ。
function syncLift() {
  if (ui.lifted && (!work || ui.tab !== 'board' || !liftedEl())) ui.lifted = null;
  const el = ui.lifted ? liftedEl() : null;
  document.body.classList.toggle('lifting', !!ui.lifted);
  document.querySelectorAll('#app .lifted').forEach((e) => { if (e !== el) e.classList.remove('lifted'); });
  let bar = document.querySelector('.lift-bar');
  if (!el) {
    clearGaps();
    if (bar) bar.remove();
    return;
  }
  el.classList.add('lifted');
  showGaps(ui.lifted.kind);
  if (!bar) {
    document.body.append(h('div', { class: 'lift-bar', role: 'status' },
      h('span', {}, '置く場所をタップ'),
      h('button', { type: 'button', class: 'lift-cancel', onclick: cancelLift }, 'やめる')));
  }
}

function cancelLift() {
  if (drag && (drag.lifted || drag.active)) endDrag(false);
  ui.lifted = null;
  syncLift();
}

// ---------- 動かした直後の［元に戻す］ ----------

function moveSnapshot() {
  return JSON.stringify({ blocks: work.blocks, pool: work.pool, intermission: work.intermission });
}

function clearUndo() {
  if (ui.undo) clearTimeout(ui.undo.timer);
  ui.undo = null;
  document.querySelectorAll('.undo-toast').forEach((el) => el.remove());
}

function setUndo(snap, item) {
  clearUndo();
  document.body.append(h('div', { class: 'undo-toast', role: 'status' },
    h('span', {}, '移動しました'),
    h('button', { type: 'button', class: 'undo-btn', onclick: undoMove }, '元に戻す')));
  ui.undo = { snap, workId: work.id, item, timer: setTimeout(clearUndo, 6000) };
}

function undoMove() {
  const u = ui.undo;
  if (!u || !work || work.id !== u.workId) { clearUndo(); return; }
  const snap = JSON.parse(u.snap);
  const rects = layoutRects();
  work.blocks = snap.blocks;
  work.pool = snap.pool;
  work.intermission = snap.intermission;
  clearUndo();
  if (u.item) ui.landed = { kind: u.item.kind, id: u.item.id, at: Date.now() };
  changed();
  if (u.item) afterMove(u.item, rects);
}

// ---------- 置いた場所が分かる動き ----------

const LANDED_MS = 1600;
let landedTimer = null;

function landedElapsed(kind, id) {
  const l = ui.landed;
  if (!l || l.kind !== kind || l.id !== id) return null;
  const e = Date.now() - l.at;
  if (e >= LANDED_MS) { ui.landed = null; return null; }
  return e;
}

// 描き直しのあと、光る時間が過ぎたら class を外す
function syncLanded() {
  clearTimeout(landedTimer);
  landedTimer = null;
  const l = ui.landed;
  if (!l) return;
  const left = LANDED_MS - (Date.now() - l.at);
  if (left <= 0) { ui.landed = null; return; }
  landedTimer = setTimeout(() => {
    landedTimer = null;
    ui.landed = null;
    document.querySelectorAll('.landed').forEach((el) => { el.classList.remove('landed'); el.style.animationDelay = ''; });
  }, left + 30);
}

function layoutKey(el) {
  return el.classList.contains('break') ? 'b' : `c:${el.dataset.card}`;
}

// ボード上のカード・休憩の位置（動かす直前に測る）
function layoutRects() {
  const m = new Map();
  document.querySelectorAll('#cols [data-card], #cols .break').forEach((el) => m.set(layoutKey(el), el.getBoundingClientRect()));
  return m;
}

// 描き直しのあと：ほかのカードをすべらせて場所を空け、見えない場所なら動かして見せる
function afterMove(item, before, fromRect) {
  const cols = document.getElementById('cols');
  if (!cols) return;
  const cr = cols.getBoundingClientRect();
  const visible = (r) => r.bottom > 0 && r.top < window.innerHeight && r.right > cr.left && r.left < cr.right;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mine = item.kind === 'break' ? 'b' : `c:${item.id}`;
  const movers = [];
  let target = null;
  document.querySelectorAll('#cols [data-card], #cols .break').forEach((el) => {
    const key = layoutKey(el);
    const nr = el.getBoundingClientRect();
    if (key === mine) target = { el, r: nr };
    if (reduce) return;
    const old = key === mine && fromRect ? fromRect : before.get(key);
    if (!old || !visible(old) || !visible(nr)) return;
    const dx = old.left - nr.left, dy = old.top - nr.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    movers.push({ el, dx, dy, mine: key === mine });
  });
  // 置いた先が見える範囲の外なら、見えるところまで動かす
  if (target) {
    const head = document.querySelector('.stickyhead');
    const top = head ? head.getBoundingClientRect().bottom : 0;
    const r = target.r;
    if (r.left < cr.left || r.right > cr.right || r.top < top || r.bottom > window.innerHeight) {
      target.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
  }
  if (!movers.length) return;
  movers.forEach((m) => {
    m.el.style.transition = 'none';
    m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
    if (m.mine) m.el.style.zIndex = '2';
  });
  void document.body.offsetHeight; // 元の位置をいったん確定させる
  requestAnimationFrame(() => {
    movers.forEach((m) => {
      m.el.style.transition = 'transform .28s ease-out';
      m.el.style.transform = '';
    });
    setTimeout(() => {
      movers.forEach((m) => { m.el.style.transition = ''; m.el.style.transform = ''; m.el.style.zIndex = ''; });
    }, 400);
  });
}

// 持ち上げたものを置く（カードはどの列・保留へも、休憩は列の中だけ）。fromRect：ドラッグで離したときのゴーストの位置
function placeItem(item, blockId, index, fromRect) {
  const before = moveSnapshot();
  const rects = layoutRects();
  if (item.kind === 'break') {
    if (blockId === 'pool') return;
    work.intermission = { blockId, index };
  } else {
    moveCard(item.id, blockId, index);
  }
  if (moveSnapshot() === before) return; // 動いていない
  setUndo(before, { kind: item.kind, id: item.id });
  ui.landed = { kind: item.kind, id: item.id, at: Date.now() };
  changed();
  afterMove(item, rects, fromRect);
}

function placeLifted(blockId, index) {
  const item = ui.lifted;
  ui.lifted = null;
  if (item) placeItem(item, blockId, index);
  syncLift();
}

// ---------- 指・マウスの動き ----------

function onItemPointerDown(e, kind, id) {
  if (ui.lifted) return; // 持ち上げ中は、置き場所のタップだけ
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (drag) endDrag(false);
  drag = { kind, id, el: e.currentTarget, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    pointerId: e.pointerId, type: e.pointerType, active: false, lifted: false, target: null, timer: null, raf: 0 };
  if (e.pointerType !== 'mouse') drag.timer = setTimeout(liftNow, LONG_PRESS_MS);
}

function liftNow() {
  if (!drag) return;
  drag.timer = null;
  drag.lifted = true;
  ui.lifted = { kind: drag.kind, id: drag.id };
  syncLift();
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* 何もしない */ }
}

function beginDrag() {
  drag.active = true;
  if (!document.querySelector('.drop-gap')) showGaps(drag.kind);
  document.body.classList.add('dragging-now');
  const r = drag.el.getBoundingClientRect();
  drag.dx = drag.x - r.left;
  drag.dy = drag.y - r.top;
  drag.ghost = drag.el.cloneNode(true);
  drag.ghost.classList.remove('lifted', 'dragging');
  drag.ghost.classList.add('ghost');
  drag.ghost.style.width = `${r.width}px`;
  drag.ghost.style.height = `${r.height}px`;
  document.body.append(drag.ghost);
  drag.el.classList.add('dragging');
  const cols = document.getElementById('cols');
  if (cols) cols.style.scrollSnapType = 'none'; // 端に寄せて自動で動かすあいだ、吸着を切る
  drag.raf = requestAnimationFrame(autoScrollTick);
  moveDrag(drag.x, drag.y);
}

// いちばん近い置き場所（その列の中で、指の高さに近いもの）
function dragTarget(x, y) {
  const cols = document.getElementById('cols');
  if (!cols) return null;
  const cr = cols.getBoundingClientRect();
  if (y < cr.top - 20 || y > cr.bottom + 20) return null;
  for (const row of cols.querySelectorAll('.row')) {
    const r = row.getBoundingClientRect();
    if (x < r.left - 5 || x > r.right + 5) continue;
    let best = null, bestD = Infinity;
    row.querySelectorAll('.drop-gap').forEach((g) => {
      const gr = g.getBoundingClientRect();
      const d = Math.abs(gr.top + gr.height / 2 - y);
      if (d < bestD) { bestD = d; best = g; }
    });
    return best;
  }
  return null;
}

function moveDrag(x, y) {
  drag.x = x; drag.y = y;
  if (!drag.active) return;
  drag.ghost.style.left = `${x - drag.dx}px`;
  drag.ghost.style.top = `${y - drag.dy}px`;
  const gap = dragTarget(x, y);
  setHot(gap);
  drag.target = gap ? { blockId: gap.dataset.block, index: Number(gap.dataset.index) } : null;
}

// 端に寄せたら自動でスクロール：ボードの左右40px＝横、画面の上下60px＝縦
function autoScrollTick() {
  if (!drag || !drag.active) return;
  const speed = (d) => Math.min(18, 3 + d / 4);
  let moved = false;
  const cols = document.getElementById('cols');
  if (cols) {
    const r = cols.getBoundingClientRect();
    if (drag.x < r.left + 40) { cols.scrollLeft -= speed(r.left + 40 - drag.x); moved = true; }
    else if (drag.x > r.right - 40) { cols.scrollLeft += speed(drag.x - (r.right - 40)); moved = true; }
  }
  const vh = window.innerHeight;
  if (drag.y < 60) { window.scrollBy(0, -speed(60 - drag.y)); moved = true; }
  else if (drag.y > vh - 60) { window.scrollBy(0, speed(drag.y - (vh - 60))); moved = true; }
  if (moved) moveDrag(drag.x, drag.y);
  drag.raf = requestAnimationFrame(autoScrollTick);
}

function endDrag(drop) {
  if (!drag) return;
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  cancelAnimationFrame(d.raf);
  document.body.classList.remove('dragging-now');
  if (d.active) {
    const ghostRect = d.ghost.getBoundingClientRect();
    d.ghost.remove();
    d.el.classList.remove('dragging');
    const cols = document.getElementById('cols');
    if (cols) cols.style.scrollSnapType = '';
    setHot(null);
    lastDragEnd = Date.now();
    if (drop && d.target) {
      ui.lifted = null;
      placeItem({ kind: d.kind, id: d.id }, d.target.blockId, d.target.index, ghostRect);
    }
    syncLift();
  } else if (d.lifted) {
    lastDragEnd = Date.now(); // 離したときのクリックは無視（持ち上げたまま残す）
  }
}

function handleDragMove(x, y) {
  drag.x = x; drag.y = y;
  if (drag.active) { moveDrag(x, y); return; }
  const dist = Math.hypot(x - drag.x0, y - drag.y0);
  if (drag.type === 'mouse') { if (dist > 6) beginDrag(); }
  else if (drag.lifted) { if (dist > 8) beginDrag(); }
  else if (dist > 10) endDrag(false); // 長押しの前に動いた＝ふつうのスクロール
}

document.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.pointerId) handleDragMove(e.clientX, e.clientY);
});
document.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
document.addEventListener('pointercancel', (e) => {
  // タッチで持ち上げたあとは、スクロールを止めているので touchend で終える
  if (drag && e.pointerId === drag.pointerId && !drag.active && !drag.lifted) endDrag(false);
});
document.addEventListener('touchmove', (e) => {
  if (drag && (drag.lifted || drag.active) && e.touches[0]) {
    e.preventDefault(); // 持ち上げたあとは、ページをスクロールさせない
    handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }
}, { passive: false });
document.addEventListener('touchend', () => { if (drag && (drag.active || drag.lifted)) endDrag(true); });
document.addEventListener('touchcancel', () => { if (drag && (drag.active || drag.lifted)) endDrag(false); });
document.addEventListener('contextmenu', (e) => { if (drag || ui.lifted) e.preventDefault(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.lifted) cancelLift(); });
window.addEventListener('resize', () => { if (ui.lifted) syncLift(); });

// ---------- 起動 ----------

window.addEventListener('pagehide', () => saveNow());
window.addEventListener('beforeunload', (e) => {
  // 書き出していない作品を開いたまま閉じようとしたときの確認（主にパソコンのブラウザ）
  if (work && isUnexported(work)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
narrowMq.addEventListener('change', () => renderMain());

ui.storageOk = storageAvailable();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
renderMain();
