'use strict';

// 台本ボード
// データは端末内（localStorage）に保存する。claude.ai の本人専用ページとして開かれたときだけ、
// 同じデータを claude.ai のデータベース（claude.use('db')）にも保存する。ほかへは何も送らない。

// 更新のたびに書き換える（本人が、新しい版が届いたかを見分けるため）
const APP_BUILD = '2026-11-01f';
const FORMAT = 'daihon-board';
const VERSION = 1;
const LAST_KEY = 'daihon-board/last'; // 前回開いた作品のid（作品のデータには入れない）
const STORE_PREFIX = 'daihon-board/work/';
const META_PREFIX = 'daihon-board/meta/';       // 書き出しの状態（この端末だけ。作品のデータには入れない）
const HISTORY_PREFIX = 'daihon-board/history/';  // 版の履歴（新しい順）
const HISTORY_MAX = 30;
const AUTO_SNAPSHOT_MS = 10 * 60 * 1000;
const SLOTS = 10;

// 筋・人物の色（強いトーンにそろえ、色相を均等に離した8色。2026-10-20 くすんだトーンから変更）
const PALETTE = ['#2a6fd6', '#0f9aa8', '#2f9e44', '#c9a10a', '#e07b1a', '#d6408a', '#8b4fd0', '#5aa9e6'];
// 前の版の色（読み込み時に、並び順で新しい色へ移し替える）
const OLD_PALETTE = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#7a4fb5', '#56b4e9', '#8c564b', '#666666', '#a89f00',
  '#4a6f96', '#3f8579', '#7d8b3e', '#b8902f', '#7f5f45', '#7b5f99', '#b06483', '#6a9ab0']; // 前の2つの版の色
// 人物の形（●■▲◆▼✚）。筋には形を付けない
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'down', 'cross'];

const TYPES = {
  shiba: { label: '一幕構成（3段×10枚）', short: '一幕構成', blocks: ['序', '破', '急'] },
  snyder: { label: '二幕構成（4段×10枚）', short: '二幕構成', blocks: ['一幕前半・序', '一幕後半・破', '二幕前半・破', '二幕後半・急'] },
};
// 古い版で使っていた段の名前（読み込み時に新しい名前へ移し替える）
const OLD_BLOCK_NAMES = {
  shiba: ['第1ブロック', '第2ブロック', '第3ブロック'],
  snyder: ['第1幕', '第2幕・前半', '第2幕・後半', '第3幕'],
};

// 休憩は型で決まる：二幕構成は「一幕後半・破」（2段目）の最後、一幕構成は休憩なし。
// { blockId, index } か null。index はそのブロックの index 枚目の前（＝最後なら枚数）
function intermissionOf(w) {
  if (!w || w.type !== 'snyder' || !Array.isArray(w.blocks) || !w.blocks[1]) return null;
  return { blockId: w.blocks[1].id, index: w.blocks[1].cards.length };
}

// 保存用の work.intermission を、型から求めた値に合わせる（古いアプリで開いても崩れないように）
function syncIntermission(w) {
  const im = intermissionOf(w);
  w.intermission = im ? { blockId: im.blockId, index: im.index } : null;
}

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
  graphThread: null, // グラフで選んでいる筋のid（null＝すべて）。この画面の中だけ。データには入れない
  lastSnap: null,    // { id, t }：履歴に最後に控えを取った時刻
  lifted: null,      // 持ち上げ中のもの { kind: 'card', id }。この画面の中だけ
  undo: null,        // 動かした直後の［元に戻す］用 { snap, workId, timer, item }
  landed: null,      // 置いた直後に光らせるもの { kind: 'card', id, at }。データには入れない
  focus: null,       // 筋・人物で絞り込み { kind: 'thread' | 'char', id }。データには入れない
  nextSkip: new Set(), // 「次の一手」で［あとで］に送った候補のキー。データには入れない
  quickDraft: '',    // 「思いつきを1行で」の書きかけ。データには入れない
  ideaOpen: null,    // 発想（広い画面）：書く画面で開いているマンダラートのid。データには入れない
  ideaPick: null,    // 発想（スマホ）：選んでいるマンダラートのid
  ideaBlock: null,   // 発想（スマホ）：入っている3×3の番号 0..8
  ideaEdit: null,    // 発想：入力中のマス { m: マンダラートid, i: 添字 }
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
    intermission: null, // 型から求めた値を保存のときに書く（読むときは intermissionOf を使う）
    pool: [],           // 保留のカード（どこに置くか決まっていないもの）
    threads: [],
    characters: [],
    core: newCore(),
    showBeats: true, // 型の札（ビート）を表示するか
    mandalas: [],    // マンダラート { id, cells: 81個の文字 }
    materials: [],   // 素材 { id, text, src, cards, core }
    memos: [],       // 単語のメモ { id, text }（拾った言葉とは別）
  };
}

// 作品の芯：作品全体の 対立 → 出来事 → 変化
const CORE_KEYS = ['protagonist', 'want', 'obstacle', 'event', 'change', 'theme', 'direction'];
function newCore() {
  return { protagonist: '', want: '', obstacle: '', event: '', change: '', theme: '', direction: '' };
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
  // 段の名前：古い決まりの名前か空なら、同じ位置の新しい名前にする（自分で付けた名前は残す）
  const oldNames = OLD_BLOCK_NAMES[w.type];
  const newNames = TYPES[w.type] && TYPES[w.type].blocks;
  if (oldNames && newNames) {
    w.blocks.forEach((b, i) => {
      if (b && newNames[i] && (typeof b.name !== 'string' || !b.name.trim() || b.name === oldNames[i])) b.name = newNames[i];
    });
  }
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
  // マンダラート：81マスの文字。外側ブロックの中央は、中心ブロックの同じ言葉（正規の添字 36+b）に寄せる
  const mIds = new Set();
  w.mandalas = (Array.isArray(w.mandalas) ? w.mandalas : []).filter((m) => m && typeof m === 'object').map((m) => {
    const raw = Array.isArray(m.cells) ? m.cells : [];
    const cells = [];
    for (let i = 0; i < 81; i++) cells.push(typeof raw[i] === 'string' ? raw[i] : '');
    for (let b = 0; b < 9; b++) {
      if (b === 4) continue;
      const o = b * 9 + 4;
      if (cells[o]) { if (!cells[36 + b]) cells[36 + b] = cells[o]; cells[o] = ''; }
    }
    let id = m.id;
    if (typeof id !== 'string' || !id || mIds.has(id)) id = uid();
    mIds.add(id);
    return { id, cells };
  });
  // 素材：言葉・出どころ（印）・結んだカード・芯
  const mMap = new Map(w.mandalas.map((m) => [m.id, m]));
  const claimed = new Set();
  const matIds = new Set();
  w.materials = (Array.isArray(w.materials) ? w.materials : []).filter((t) => t && typeof t === 'object' && typeof t.text === 'string').map((t) => {
    let src = null;
    if (t.src && typeof t.src === 'object') {
      const m = mMap.get(t.src.m);
      if (m && Number.isInteger(t.src.i) && t.src.i >= 0 && t.src.i <= 80) {
        const i = canonIdx(t.src.i);
        const key = m.id + ':' + i;
        if (m.cells[i] && !claimed.has(key)) { claimed.add(key); src = { m: m.id, i }; }
      }
    }
    let id = t.id;
    if (typeof id !== 'string' || !id || matIds.has(id)) id = uid();
    matIds.add(id);
    const cards = (Array.isArray(t.cards) ? t.cards : []).filter((cid, i, a) => seen.has(cid) && a.indexOf(cid) === i);
    return { id, text: t.text, src, cards, core: t.core === true };
  }).filter((t) => t.src || t.cards.length || t.core || t.text);
  // 単語のメモ（無い古いデータは空として扱う）
  const memoIds = new Set();
  w.memos = (Array.isArray(w.memos) ? w.memos : []).filter((t) => t && typeof t === 'object' && typeof t.text === 'string').map((t) => {
    let id = t.id;
    if (typeof id !== 'string' || !id || memoIds.has(id)) id = uid();
    memoIds.add(id);
    return { id, text: t.text };
  });
  syncIntermission(w);
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
    ['event', '決定的な出来事'], ['change', '最後の変化'], ['theme', 'テーマ'], ['direction', '演出の考え']];
  const coreParts = labels.filter(([k]) => co[k].trim()).map(([k, l]) => `${l}：${co[k].trim().replace(/\s*\n\s*/g, ' ')}`);
  if (coreParts.length) out.push(`【芯】${coreParts.join(' ／ ')}`);
  const im = intermissionOf(work);
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
  if (Array.isArray(work.materials)) work.materials.forEach((t) => { t.cards = t.cards.filter((id) => id !== cardId); }); // 素材の結びから外す
  changed();
}

function changeType(type) {
  if (type === work.type) return;
  pushHistory(work, '型を変える前');
  const b = work.blocks;
  if (type === 'snyder') {
    // 一幕構成の「破」を二幕構成の「一幕後半・破」とし、「二幕前半・破」を空で足す
    work.blocks = [b[0], b[1], { id: uid(), name: '', cards: [] }, b[2]];
  } else {
    // 二幕構成の真ん中の2段（一幕後半・破と二幕前半・破）をひとつにまとめる
    b[1].cards = b[1].cards.concat(b[2].cards);
    work.blocks = [b[0], b[1], b[3]];
  }
  TYPES[type].blocks.forEach((name, i) => (work.blocks[i].name = name));
  work.type = type;
  changed();
}

// ---------- 保存（端末の控え＋claude.ai） ----------
// 手元の写し＝メモリ＋localStorage。画面はこの写しを同期の関数で読み書きする。
// claude.ai のデータベースが使えるときだけ、その裏で書き込み・読み込みをする。

let saveTimer = null;

const SYNCED_PREFIX = 'daihon-board/synced/';       // 最後にデータベースと同じになった版の更新日時
const PENDING_DEL_KEY = 'daihon-board/pending-delete'; // つながっていない間に消した作品のid

// localStorage に書けなかった分はメモリに持つ（書けたらメモリの分は捨てる）
const memStore = new Map();

function lsGet(key) {
  if (memStore.has(key)) return memStore.get(key);
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
    memStore.delete(key);
    return true;
  } catch (e) {
    memStore.set(key, val);
    return false;
  }
}

function lsDel(key) {
  memStore.delete(key);
  try { localStorage.removeItem(key); } catch (e) { /* 何もしない */ }
}

function lsKeys() {
  const out = new Set(memStore.keys());
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.add(k);
    }
  } catch (e) { /* 使えない環境 */ }
  return [...out];
}

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
  for (const k of lsKeys()) {
    if (!k.startsWith(STORE_PREFIX)) continue;
    try {
      const w = normalizeWork(JSON.parse(lsGet(k)));
      if (w) out.push(w);
    } catch (e) { /* 壊れた項目は飛ばす */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---------- claude.ai のデータベース ----------
// 置き場所（本人だけが読める data/users/<uid>/board の下）：
//   works/<作品id> … 作品のデータ　meta/<作品id> … 書き出しの状態
//   history/<作品id>/v/<控えの時刻> … 版の履歴（1版＝1文書。新しい順に30件）
// claude.ai の外・ログインなしでは cloud.state が 'on' にならず、端末だけで今までどおり動く。

const cloud = {
  expected: false,   // claude.ai の中で開かれていそう（window.claude がある）。つながるまでは端末だけ
  state: 'off',      // 'on'＝データベースにつながっている
  failed: false,     // 直近の書き込みが失敗した
  base: null,        // data/users/<uid>/board の文書
  dl: null,          // downloads（使えないときは null）
  dirty: new Set(),  // まだデータベースに書いていない作品のid
  timers: new Map(), // 作品ごとの、約0.4秒まとめて書くタイマー
  pending: new Map(), // 他の端末で直された作品（入力が終わってから取り込む）
  watchId: null,
  unwatch: null,
};
const cq = { ops: new Map(), running: false }; // 書き込みの待ち行列（1つずつ順に実行）

function tsOf(s) {
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function cloneJson(o) {
  return JSON.parse(JSON.stringify(o));
}

const wRef = (id) => cloud.base.collection('works').doc(id);
const mRef = (id) => cloud.base.collection('meta').doc(id);
const hCol = (id) => cloud.base.collection('history').doc(id).collection('v');

function syncedAt(id) {
  return lsGet(SYNCED_PREFIX + id);
}

function setSynced(id, at) {
  if (at && tsOf(at) >= tsOf(syncedAt(id))) lsSet(SYNCED_PREFIX + id, at);
}

// データベースに書いていない変更がある（データベースと同じ版になったことがない）
function hasUnsynced(w) {
  return syncedAt(w.id) !== w.updatedAt;
}

// 上の表示（保存の状態）の文字と、赤にするか
function statusLabel() {
  if (ui.saveError) return ['保存できませんでした', true];
  if (saveTimer) return ['保存中…', false];
  if (cloud.state === 'on') {
    if (cloud.failed) return ['同期できません', true];
    if (cloud.dirty.size || cq.ops.size || cq.running) return ['保存中…', false];
    return ['保存済み', false];
  }
  if (cloud.expected) return ['端末にだけ保存', false];
  return ['端末に保存済み', false];
}

function refreshStatus() {
  const [text, err] = statusLabel();
  setStatus(text, err);
  if (typeof syncExportBar === "function") syncExportBar();
}

// ----- 書き込みの待ち行列 -----

function cloudQueue(key, run) {
  if (cloud.state !== 'on') return;
  cq.ops.set(key, run);
  cloudRun();
  refreshStatus();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(run) {
  try {
    return await run();
  } catch (e) {
    if (e && e.code === 'unavailable') { await sleep(600 + Math.random() * 600); return run(); }
    throw e;
  }
}

async function cloudRun() {
  if (cq.running) return;
  cq.running = true;
  try {
    while (cq.ops.size) {
      const [key, run] = cq.ops.entries().next().value;
      cq.ops.delete(key);
      try {
        await withRetry(run);
        cloud.failed = false;
      } catch (e) {
        if (key.startsWith('w:') || key.startsWith('m:')) {
          cloud.failed = true;
          // 一時的な失敗だけ、あとでやり直す（容量超過などは次の変更まで待つ）
          const retriable = e && (e.code === 'unavailable' || e.code === 'resource_exhausted');
          if (retriable && key.startsWith('w:')) setTimeout(() => cloudMarkDirty(key.slice(2)), 15000);
        }
      }
      refreshStatus();
    }
  } finally {
    cq.running = false;
    refreshStatus();
  }
}

// ----- 作品を書く（約0.4秒まとめて、変わったときだけ） -----

function cloudMarkDirty(id) {
  if (cloud.state !== 'on') return;
  const l = readWork(id);
  if (!l || syncedAt(id) === l.updatedAt) return;
  cloud.dirty.add(id);
  if (!cloud.timers.has(id)) {
    cloud.timers.set(id, setTimeout(() => { cloud.timers.delete(id); cloudFlush(id); }, 400));
  }
  refreshStatus();
}

function clearCloudDirty(id) {
  cloud.dirty.delete(id);
  clearTimeout(cloud.timers.get(id));
  cloud.timers.delete(id);
  cq.ops.delete('w:' + id);
}

function cloudFlush(id) {
  if (cloud.state !== 'on' || !cloud.dirty.has(id)) return;
  if (cloud.pending.has(id)) return; // 他の端末の新しい版を取り込むまで、上書きしない
  cloudQueue('w:' + id, async () => {
    const l = readWork(id);
    if (!l) { cloud.dirty.delete(id); return; }
    if (syncedAt(id) !== l.updatedAt) {
      await wRef(id).set(cloneJson(l));
      setSynced(id, l.updatedAt);
    }
    const cur = readWork(id);
    if (!cur || cur.updatedAt === l.updatedAt) cloud.dirty.delete(id);
  });
}

function cloudFlushAll() {
  for (const id of [...cloud.dirty]) {
    clearTimeout(cloud.timers.get(id));
    cloud.timers.delete(id);
    cloudFlush(id);
  }
}

// ----- 他の端末の変更を受け取る -----

// 文字入力・ドラッグの最中か。この間は、他の端末の変更で画面を描き直さない
function syncBusy() {
  const a = document.activeElement;
  if (a && (a.tagName === 'TEXTAREA'
    || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/.test(a.type)))) return true;
  return !!drag;
}

function syncKick(ms) {
  clearTimeout(ui.syncPoll);
  ui.syncPoll = setTimeout(syncTick, ms == null ? 500 : ms);
}

function syncTick() {
  ui.syncPoll = null;
  if (!cloud.pending.size && !ui.renderPending) return;
  if (syncBusy()) { syncKick(); return; }
  applyPending();
  if (ui.renderPending) {
    ui.renderPending = false;
    if (!work) renderMain();
  }
}

// 一覧の描き直し（入力が終わってから）
function softRender() {
  if (work) return;
  ui.renderPending = true;
  syncKick(60);
}

function takeRemoteWork(raw) {
  try {
    const w = normalizeWork(cloneJson(raw));
    return w && typeof w.id === 'string' && w.id ? w : null;
  } catch (e) {
    return null;
  }
}

// 作品を端末の控えに書く（データベースへは書かない）
function writeLocalWork(w) {
  syncIntermission(w);
  const data = JSON.stringify(w);
  for (let tries = 0; tries < 8; tries++) {
    if (lsSet(STORE_PREFIX + w.id, data)) return true;
    if (!trimHistories()) return false;
  }
  return false;
}

// データベースにある作品を受け取る。端末より新しければ、端末に取り込む
function receiveRemote(remote) {
  const id = remote.id;
  const isOpen = !!work && work.id === id;
  const local = isOpen ? work : readWork(id);
  if (!local) {
    writeLocalWork(remote);
    setSynced(id, remote.updatedAt);
    softRender();
    return;
  }
  const rt = tsOf(remote.updatedAt);
  const lt = tsOf(local.updatedAt);
  if (rt < lt) return; // こちらのほうが新しい（書き込みの待ちに任せる）
  if (rt === lt) { setSynced(id, local.updatedAt); return; }
  if (isOpen) {
    cloud.pending.set(id, remote);
    if (syncBusy()) syncKick(); else applyPending();
    return;
  }
  if (hasUnsynced(local)) pushHistory(local, '同期の前の控え', true);
  writeLocalWork(remote);
  setSynced(id, remote.updatedAt);
  softRender();
}

// 開いている作品を、他の端末の新しい版に合わせる
function applyPending() {
  const remote = work ? cloud.pending.get(work.id) : null;
  cloud.pending.clear();
  if (!remote) return;
  if (tsOf(remote.updatedAt) <= tsOf(work.updatedAt)) { cloudMarkDirty(work.id); return; } // 入力中にこちらが新しくなった
  // こちらに書き残しがあれば（データベースに上がっていない・この画面で直したあと）、履歴に残してから合わせる
  if (hasUnsynced(work) || ui.editedSinceSync) pushHistory(work, '同期の前の控え', true);
  ui.editedSinceSync = false;
  clearTimeout(saveTimer);
  saveTimer = null;
  clearCloudDirty(remote.id);
  writeLocalWork(remote);
  setSynced(remote.id, remote.updatedAt);
  work = remote;
  ui.newCardId = null;
  renderMain();
  if (ui.openCardId) {
    if (findCard(ui.openCardId)) renderCardSheet();
    else { ui.openCardId = null; modalRoot.replaceChildren(); }
  } else if (ui.settingsOpen) {
    openSettings();
  }
}

function receiveMeta(id, raw) {
  let r;
  try { r = cloneJson(raw); } catch (e) { return; }
  if (!r || typeof r !== 'object' || !r.lastExportedAt) return;
  const l = readMeta(id);
  if (tsOf(r.lastExportedAt) <= tsOf(l.lastExportedAt)) return;
  lsSet(META_PREFIX + id, JSON.stringify({ lastExportedAt: r.lastExportedAt, exportedUpdatedAt: r.exportedUpdatedAt }));
  if (work && work.id === id) syncExportBar(); else softRender();
}

// 開いている作品の文書と書き出しの状態を見張る
function cloudWatch(id) {
  if (cloud.state !== 'on') return;
  if (cloud.watchId === id && cloud.unwatch) return;
  cloudUnwatch();
  if (!id) return;
  try {
    const a = wRef(id).onSnapshot((snap) => {
      if (!snap.exists) return;
      const r = takeRemoteWork(snap.data());
      if (r && r.id === id) receiveRemote(r);
    }, () => {});
    const b = mRef(id).onSnapshot((snap) => { if (snap.exists) receiveMeta(id, snap.data()); }, () => {});
    cloud.watchId = id;
    cloud.unwatch = () => { a(); b(); };
  } catch (e) {
    cloud.watchId = null;
    cloud.unwatch = null;
  }
}

function cloudUnwatch() {
  if (cloud.unwatch) { try { cloud.unwatch(); } catch (e) { /* 何もしない */ } }
  cloud.unwatch = null;
  cloud.watchId = null;
}

// ----- 戻ったとき・開いている間の読み直し（見張りが届かないときの備え） -----

const POLL_FAST_MS = 5000;
const POLL_SLOW_MS = 30000;
const poll = { timer: null, slow: false, busy: false, resumeTimer: null, syncing: false };

// 開いている作品の文書と書き出しの状態を読み、見張りの受け取りと同じ処理に渡す
async function cloudRefreshOpen() {
  if (cloud.state !== 'on' || !work || poll.busy) return;
  const id = work.id;
  poll.busy = true;
  try {
    const [a, b] = await Promise.all([wRef(id).get(), mRef(id).get()]);
    if (!work || work.id !== id) return;
    if (a && a.exists) {
      const r = takeRemoteWork(a.data());
      if (r && r.id === id) receiveRemote(r);
    }
    if (b && b.exists) receiveMeta(id, b.data());
  } catch (e) {
    if (e && e.code === 'resource_exhausted' && !poll.slow) { poll.slow = true; cloudPollSchedule(); }
  } finally {
    poll.busy = false;
  }
}

function cloudPollStop() {
  clearTimeout(poll.timer);
  poll.timer = null;
}

// 作品を開いていて画面が見えているあいだだけ、5秒ごと（断られたら30秒ごと）に読み直す
function cloudPollSchedule() {
  cloudPollStop();
  if (cloud.state !== 'on' || !work || document.visibilityState === 'hidden') return;
  poll.timer = setTimeout(async () => {
    poll.timer = null;
    await cloudRefreshOpen();
    cloudPollSchedule();
  }, poll.slow ? POLL_SLOW_MS : POLL_FAST_MS);
}

// アプリに戻ったとき、すぐ読み直す（短時間に重なったら1回）
function cloudResume() {
  clearTimeout(poll.resumeTimer);
  poll.resumeTimer = setTimeout(async () => {
    poll.resumeTimer = null;
    if (cloud.state !== 'on' || document.visibilityState === 'hidden') return;
    cloudFlushAll();
    if (work) {
      await cloudRefreshOpen();
    } else if (!poll.syncing) {
      poll.syncing = true;
      try { await cloudSync(); } catch (e) { /* 黙って次の機会に */ }
      poll.syncing = false;
    }
    cloudPollSchedule();
  }, 150);
}

// ----- 版の履歴 -----

let lastHistAt = 0;
function nextHistoryAt() {
  let t = Date.now();
  if (t <= lastHistAt) t = lastHistAt + 1;
  lastHistAt = t;
  return new Date(t).toISOString();
}

function cloudQueueHistory(id, entry, dropped) {
  if (cloud.state !== 'on') return;
  const snap = cloneJson(entry);
  cloudQueue('h:' + id + ':' + entry.at, () => hCol(id).doc(entry.at).set(snap));
  dropped.forEach((e) => cloudQueue('h:' + id + ':' + e.at, () => hCol(id).doc(e.at).delete()));
}

// データベースの履歴を、端末の履歴と合わせる（新しい順に30件まで。足りない側へ補う）
async function syncHistory(id) {
  if (cloud.state !== 'on') return;
  try {
    const snap = await hCol(id).orderBy('at', 'desc').limit(HISTORY_MAX + 10).get();
    const remote = snap.docs.map((d) => cloneJson(d.data()))
      .filter((e) => e && typeof e.at === 'string' && e.work && typeof e.work === 'object');
    const local = readHistory(id);
    const haveAt = new Set(local.map((e) => e.at));
    const merged = local.slice();
    let added = false;
    remote.forEach((e) => { if (!haveAt.has(e.at)) { merged.push(e); added = true; } });
    merged.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const keep = merged.slice(0, HISTORY_MAX);
    const drop = merged.slice(HISTORY_MAX);
    if (added || drop.length) writeHistory(id, keep);
    const remoteAt = new Set(remote.map((e) => e.at));
    keep.forEach((e) => {
      if (!remoteAt.has(e.at)) {
        const c = cloneJson(e);
        cloudQueue('h:' + id + ':' + e.at, () => hCol(id).doc(c.at).set(c));
      }
    });
    drop.forEach((e) => {
      if (remoteAt.has(e.at)) cloudQueue('h:' + id + ':' + e.at, () => hCol(id).doc(e.at).delete());
    });
    if (added && ui.settingsOpen && work && work.id === id && !syncBusy()) openSettings();
  } catch (e) { /* 履歴の同期は、失敗しても本体に響かせない */ }
}

// ----- 作品の削除 -----

function cloudDeleteWork(id, ats) {
  if (cloud.state !== 'on') return;
  for (const k of [...cq.ops.keys()]) {
    if (k === 'w:' + id || k === 'm:' + id || k.startsWith('h:' + id + ':')) cq.ops.delete(k);
  }
  cloudQueue('dw:' + id, () => wRef(id).delete());
  cloudQueue('dm:' + id, () => mRef(id).delete());
  cloudQueue('dh:' + id, async () => {
    const snap = await hCol(id).get();
    const all = new Set(snap.docs.map((d) => d.id).concat(ats || []));
    for (const at of all) await hCol(id).doc(at).delete();
  });
}

// ----- つなぐ -----

async function cloudInit() {
  const c = window.claude;
  if (!c || typeof c.use !== 'function') return; // claude.ai の外：端末だけ
  cloud.expected = true;
  refreshStatus();
  // 応答がなければ最大10秒で null（起動は待たせない）
  const cap = (name) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 10000);
    let p;
    try { p = Promise.resolve(c.use(name)); } catch (e) { p = Promise.resolve(null); }
    p.then((v) => { clearTimeout(t); resolve(v || null); }, () => { clearTimeout(t); resolve(null); });
  });
  cap('downloads').then((v) => { cloud.dl = v; });
  const [db, user] = await Promise.all([cap('db'), cap('user')]);
  let uid = null;
  if (db && user) {
    try { uid = await Promise.race([user.id(), sleep(10000).then(() => null)]); } catch (e) { uid = null; }
  }
  if (!db || typeof uid !== 'string' || !uid) { // つながらない（ログインなしなど）：端末だけ
    cloud.expected = false;
    refreshStatus();
    return;
  }
  cloud.base = db.doc('data/users/' + uid + '/board');
  cloudConnect(0);
}

async function cloudConnect(attempt) {
  try {
    await cloudSync();
  } catch (e) {
    cloud.state = 'off';
    refreshStatus();
    if (attempt < 3) setTimeout(() => cloudConnect(attempt + 1), 20000);
  }
}

// データベースの作品・書き出しの状態を読み、端末と新しい方に合わせる
async function cloudSync() {
  const [ws, ms] = await Promise.all([
    cloud.base.collection('works').get(),
    cloud.base.collection('meta').get(),
  ]);
  cloud.state = 'on';
  cloud.failed = false;
  // つながっていない間に消した作品は、データベースからも消す
  const gone = new Set(readJson(PENDING_DEL_KEY, []));
  gone.forEach((id) => cloudDeleteWork(id));
  lsDel(PENDING_DEL_KEY);

  const remoteTs = new Map();
  ws.docs.forEach((d) => {
    if (gone.has(d.id)) return;
    const r = takeRemoteWork(d.data());
    if (!r || r.id !== d.id) return;
    remoteTs.set(r.id, tsOf(r.updatedAt));
    receiveRemote(r);
  });
  const remoteMeta = new Map();
  ms.docs.forEach((d) => {
    if (gone.has(d.id)) return;
    remoteMeta.set(d.id, d.data());
    receiveMeta(d.id, d.data());
  });
  // 端末のほうが新しいもの・データベースに無いものを書く
  const localWorks = work ? listWorks().filter((w) => w.id !== work.id).concat([work]) : listWorks();
  localWorks.forEach((l) => {
    if (remoteTs.has(l.id)) {
      if (tsOf(l.updatedAt) > remoteTs.get(l.id)) cloudMarkDirty(l.id);
    } else if (!syncedAt(l.id)) {
      cloudMarkDirty(l.id); // 初めて上げる（一度つながって消えたものは上げ直さない）
    }
  });
  lsKeys().filter((k) => k.startsWith(META_PREFIX)).forEach((k) => {
    const id = k.slice(META_PREFIX.length);
    const l = readMeta(id);
    if (!l.lastExportedAt || gone.has(id)) return;
    const r = remoteMeta.get(id);
    if (!r || tsOf(l.lastExportedAt) > tsOf(r.lastExportedAt)) {
      const m = cloneJson(l);
      cloudQueue('m:' + id, () => mRef(id).set(m));
    }
  });
  if (work) { cloudWatch(work.id); syncHistory(work.id); }
  cloudPollSchedule();
  softRender();
  refreshStatus();
}

// ---------- 保存（作品） ----------

function changed(skipRender) {
  work.updatedAt = new Date().toISOString();
  ui.editedSinceSync = true;
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
  refreshStatus();
  // 本体の保存が済んでから、履歴を足す（履歴の失敗は本体に響かせない）
  if (!ui.lastSnap || ui.lastSnap.id !== work.id || Date.now() - ui.lastSnap.t > AUTO_SNAPSHOT_MS) {
    pushHistory(work, '自動');
  }
}

// 作品そのものを保存する。容量が足りなければ、履歴を古いほうから減らして保存し直す
// （履歴が端末の容量を埋めて、本体が保存できなくなるのを防ぐ）。
function writeMainWork(w) {
  const ok = writeLocalWork(w);
  cloudMarkDirty(w.id); // claude.ai につながっていれば、約1秒まとめてデータベースへ
  return ok || cloud.state === 'on';
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
  ui.nextSkip = new Set();
  ui.quickDraft = '';
  ui.ideaOpen = null;
  ui.ideaPick = null;
  ui.ideaBlock = null;
  ui.ideaEdit = null;
  ui.editedSinceSync = false;
  try { localStorage.setItem(LAST_KEY, w.id); } catch (e) { /* 書けなくても無視 */ }
  pushHistory(w, '開いたとき');
  renderMain();
  cloudWatch(w.id);   // 別の端末での変更を見張る
  poll.slow = false;
  cloudPollSchedule();
  syncHistory(w.id);
}

// 作品のデータ（本体・書き出しの控え・履歴）を端末から消す
function deleteWorkData(id) {
  try {
    if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
  } catch (e) { /* 何もしない */ }
  const ats = readHistory(id).map((e) => e.at);
  lsDel(STORE_PREFIX + id);
  lsDel(META_PREFIX + id);
  lsDel(HISTORY_PREFIX + id);
  lsDel(SYNCED_PREFIX + id);
  cloud.pending.delete(id);
  clearCloudDirty(id);
  if (cloud.watchId === id) cloudUnwatch();
  if (cloud.state === 'on') {
    cloudDeleteWork(id, ats);
  } else if (cloud.expected) { // つながっていない間に消した分は、つながったときにデータベースからも消す
    const list = readJson(PENDING_DEL_KEY, []);
    if (Array.isArray(list) && !list.includes(id)) { list.push(id); lsSet(PENDING_DEL_KEY, JSON.stringify(list)); }
  }
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
  if (work && exportUrgent(work)) askBeforeClose();
  else doCloseWork();
}

// ---------- 書き出しの状態・版の履歴・書き出し・読み込み ----------

function readJson(key, fallback) {
  try {
    const v = JSON.parse(lsGet(key));
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
  lsSet(META_PREFIX + id, JSON.stringify(meta)); // 控えの失敗は無視
  const m = cloneJson(meta);
  cloudQueue('m:' + id, () => mRef(id).set(m)); // 書き出しの状態は端末どうしで共通
}

// 最後に書き出した版から変わっていれば「未書き出し」
function isUnexported(w) {
  return readMeta(w.id).exportedUpdatedAt !== w.updatedAt;
}

// 書き出しの基準の日時（最後に書き出した日時。無ければ作品を作った日時）
function exportBaseTime(w) {
  const m = readMeta(w.id);
  const t = tsOf(m.lastExportedAt) || tsOf(w.createdAt);
  return t || null;
}

// 基準から今までの日数（切り捨て）。基準が分からなければ null
function daysSinceExport(w) {
  const t = exportBaseTime(w);
  if (t == null) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// 急いで書き出す必要があるか：未書き出しで、claude.ai に保存できていない、または7日以上たっている
function exportUrgent(w) {
  if (!isUnexported(w)) return false;
  if (cloud.state !== 'on' || cloud.failed) return true;
  const d = daysSinceExport(w);
  return d != null && d >= 7;
}

// 保留のカードも数える（読み込みの新旧比べや履歴で、保留だけの違いも見分けるため）
function cardCount(w) {
  return w.blocks.reduce((s, b) => s + b.cards.length, 0) + (Array.isArray(w.pool) ? w.pool.length : 0);
}

function readWork(id) {
  try { return normalizeWork(JSON.parse(lsGet(STORE_PREFIX + id))); } catch (e) { return null; }
}

function readHistory(id) {
  const arr = readJson(HISTORY_PREFIX + id, []);
  return Array.isArray(arr) ? arr.filter((e) => e && e.work && typeof e.work === 'object') : [];
}

// 容量が足りなければ古いものから捨てて書き直す。だめなら黙ってあきらめる。
function writeHistory(id, arr) {
  const list = arr.slice(0, HISTORY_MAX);
  while (list.length) {
    if (lsSet(HISTORY_PREFIX + id, JSON.stringify(list))) return true;
    list.pop();
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
    syncIntermission(w);
    const entry = { at: nextHistoryAt(), reason, cards: cardCount(w), updatedAt: w.updatedAt, work: w };
    hist.unshift(entry);
    cloudQueueHistory(w.id, entry, hist.slice(HISTORY_MAX)); // 31件目以降はデータベースからも消す
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
  syncIntermission(w);
  const body = JSON.stringify(Object.assign({}, w, { exportedAt: now.toISOString() }), null, 2);
  const file = new File([body], exportFileName(w.title, now), { type: 'application/json' });
  ui.exporting = true;
  let ok = false;
  try {
    if (cloud.dl && typeof cloud.dl.save === 'function') {
      // claude.ai の中：保存を頼む（断られたら書き出していない扱い）
      try {
        await cloud.dl.save({ filename: file.name, data: body });
        ok = true;
      } catch (e) {
        if (e && (e.code === 'declined' || e.code === 'rate_limited')) return false;
      }
    }
    if (!ok && isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        ok = true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // 取りやめ＝書き出していない
        downloadFile(file);
        ok = true;
      }
    } else if (!ok) {
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

// 帯の種類と文：急ぎは朱（保存できていなければ「未書き出し」、7日以上なら「N日 書き出していません」）。急ぎでなければ控えめ
function exportBarInfo(w) {
  const urgent = exportUrgent(w);
  const d = daysSinceExport(w);
  const meta = readMeta(w.id);
  let text;
  if (urgent) {
    text = cloud.state !== 'on' || cloud.failed ? '未書き出し' : `${d}日 書き出していません`;
  } else if (!meta.lastExportedAt) {
    text = '書き出し：まだ';
  } else {
    text = d === 0 ? '書き出し：今日' : `書き出し：${d}日前`;
  }
  return { urgent, text };
}

function renderExportBar() {
  const info = exportBarInfo(work);
  return h('div', { class: 'export-bar' + (info.urgent ? '' : ' calm'), role: 'status' },
    h('span', { class: 'export-msg' }, info.text),
    h('button', { type: 'button', class: info.urgent ? 'primary export-btn' : 'export-btn', onclick: exportWork }, '書き出す'));
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
  } else if (need && cur) {
    const info = exportBarInfo(work);
    if (cur.classList.contains('calm') === info.urgent || cur.querySelector('.export-msg').textContent !== info.text) cur.replaceWith(renderExportBar());
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
  const col = (label, x, newer) => h('div', { class: 'cmp-col' + (newer ? ' newer' : '') },
    h('strong', {}, label, newer && h('span', { class: 'cmp-new' }, '新しい')),
    h('div', {}, x.title || '無題'),
    h('div', { class: 'cmp-sub' }, '最終更新 ', h('span', { class: 'cmp-date' }, formatDate(x.updatedAt))),
    h('div', { class: 'cmp-sub' }, `カード ${cardCount(x)}枚`));
  const tfile = new Date(w.updatedAt).getTime();
  const tloc = local ? new Date(local.updatedAt).getTime() : NaN;
  const fileNewer = !!local && tfile > tloc;
  const localNewer = !!local && tloc > tfile;
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
    h('div', { class: 'cmp' + (local ? '' : ' one') }, col('ファイル', w, fileNewer), local && col('この端末', local, localNewer)),
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
  // claude.ai につながっているとき、ファイルがデータベースの版より古いと、読み込んだ内容が
  // すぐ新しい版に戻されてしまう。読み込みは本人の操作なので、更新日時を今にして新しい版として扱う
  if (cloud.state === 'on' && tsOf(w.updatedAt) < Math.max(tsOf(local && local.updatedAt), tsOf(syncedAt(w.id)))) {
    w.updatedAt = new Date().toISOString();
  }
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
  cloudUnwatch();
  cloudPollStop();
  cloud.pending.clear();
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
    h('div', { class: 'works-head' },
      h('h1', {}, '台本ボード'),
      h('button', { type: 'button', class: 'primary new-work-btn', onclick: () => {
        ui.newWorkOpen = true; renderMain();
        const el = document.querySelector('.new-work input[type=text]');
        if (el) el.focus();
      } }, '＋新しい作品')),
    works.length
      ? h('ul', { class: 'work-list' }, works.map((w) => {
          const n = cardCount(w);
          return h('li', { class: 'work-item' },
            h('button', { type: 'button', class: 'work-open', onclick: () => openWork(w) },
              h('span', { class: 'w-title' }, w.title || '無題'),
              h('span', { class: 'w-date' }, formatDate(w.updatedAt)),
              h('span', { class: 'w-meta' }, `${TYPES[w.type] ? TYPES[w.type].short : ''}・${n}枚`,
                exportUrgent(w) && h('span', { class: 'w-tag' }, '未書き出し'))),
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
      : null,
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
    h('button', { type: 'button', class: 'settings-btn', onclick: openSettings }, '設定'),
    h('span', { id: 'status', class: 'status' }, statusLabel()[0]));
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
  const im = intermissionOf(work);
  const imIndex = im && im.blockId === b.id ? Math.min(im.index, b.cards.length) : -1;
  const bi = work.blocks.indexOf(b);
  b.cards.forEach((c, i) => {
    if (i === imIndex) items.push(breakEl());
    items.push(cardEl(c, i >= SLOTS, bi, i));
  });
  for (let i = b.cards.length; i < SLOTS; i++) {
    // 空き枠には、置き場所のビートを薄い札で出す。＋は最初の空き枠だけ
    // 次の空き枠だけ点線の箱、それより後ろは枠線のない「道しるべ」
    const pb = beatsOn() ? positionBeat(bi, i) : null;
    const next = i === b.cards.length;
    items.push(h('button', { type: 'button', class: next ? 'slot' : 'slot guide', 'aria-label': 'カードを足す', onclick: () => addCard(b.id) },
      next ? '＋' : h('i', { class: 'guide-line' }), pb && h('span', { class: 'beat-cap' }, pb.label)));
  }
  if (b.cards.length >= SLOTS) {
    items.push(h('button', { type: 'button', class: 'slot add-over', 'aria-label': '枠を超えてカードを足す', onclick: () => addCard(b.id) }, '＋'));
  }
  // 休憩がカードの末尾にあるときは、空き枠・＋のあとの、列のいちばん終わりに出す
  if (imIndex === b.cards.length) items.push(breakEl());
  return items;
}

// 休憩の帯（型で決まる位置に出るだけ。押しても動かしても何も起きない）
function breakEl() {
  return h('div', { class: 'break' }, '休憩');
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
      onclick: () => {
        if (window.matchMedia('(max-width: 699px)').matches) ui.legendOpen = false; // スマホでは選んだら閉じる
        toggleFocus(kind, e.id);
      } }, mark, named(e));
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
  return h('div', { class: 'maintabs' }, tab('board', 'ボード'), tab('people', '人物'), tab('graph', 'グラフ'), tab('core', '芯'), tab('idea', '発想'));
}

// ---------- 次の一手・思いつきを1行で ----------

// 次にやることを1つ。描画のたびに作品から計算する（持たない）。{ key, kind, text, btn, run } か null
function nextAction() {
  if (!work || ui.lifted) return null;
  const skip = (k) => ui.nextSkip.has(k);
  const focusKey = (key) => {
    const el = modalRoot.querySelector(`input[data-key="${key}"], textarea[data-key="${key}"]`);
    if (el) el.focus();
  };
  for (const c of work.pool) {
    const key = `保留:${c.id}`;
    if (skip(key)) continue;
    return { key, kind: '保留', text: `『${cardLabel(c)}』の置き場所を決める`, btn: '置く',
      run: () => { ui.lifted = { kind: 'card', id: c.id }; syncLift(); } };
  }
  const cards = allCards();
  for (const x of cards) {
    const key = `変化:${x.card.id}`;
    if (x.card.change.trim() || skip(key)) continue;
    return { key, kind: '変化', text: `『${cardLabel(x.card)}』の変化を書く`, btn: '開く',
      run: () => { openCard(x.card.id); focusKey('change'); } };
  }
  const nums = numbering();
  for (const x of cards) {
    const key = `見出し:${x.card.id}`;
    if (x.card.title.trim() || skip(key)) continue;
    return { key, kind: '見出し', text: `#${nums.get(x.card.id)} の見出しを付ける`, btn: '開く',
      run: () => { openCard(x.card.id); focusKey('title'); } };
  }
  for (let bi = 0; bi < work.blocks.length; bi++) {
    const b = work.blocks[bi];
    if (b.cards.length >= SLOTS) continue;
    const key = `slot:${b.id}`;
    if (skip(key)) continue;
    const pb = beatsOn() ? positionBeat(bi, b.cards.length) : null;
    return { key, kind: '空き枠', text: pb ? `${b.name}「${pb.label}」のカードを足す` : `${b.name}にカードを足す`, btn: '足す',
      run: () => addCard(b.id) };
  }
  return null;
}

function renderNextBar() {
  const n = nextAction();
  if (!n) return null;
  return h('div', { class: 'nextbar' },
    h('span', { class: 'next-kind' }, `次：${n.kind}`),
    h('span', { class: 'next-text' }, n.text),
    h('button', { type: 'button', class: 'primary next-go', onclick: n.run }, n.btn),
    h('button', { type: 'button', class: 'link next-later', onclick: () => { ui.nextSkip.add(n.key); renderMain(); } }, 'あとで'));
}

// 画面の下に貼り付く、思いつきの入力欄。置くと保留の末尾にカードができる
function renderQuickBar() {
  const input = h('input', { type: 'text', class: 'quick-input', placeholder: '思いつきを1行で', 'aria-label': '思いつきを1行で',
    value: ui.quickDraft, enterkeyhint: 'done',
    oninput: (e) => { ui.quickDraft = e.target.value; } });
  return h('form', { class: 'quickbar', onsubmit: (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    const c = newCard();
    c.title = t;
    work.pool.push(c);
    ui.landed = { kind: 'card', id: c.id, at: Date.now() };
    ui.quickDraft = '';
    changed();
    showToast('保留に置きました');
    const again = document.querySelector('.quick-input');
    if (again) again.focus();
  } }, input, h('button', { type: 'submit', class: 'primary quick-go' }, '保留へ'));
}

function renderBoard() {
  gpopClose();
  let body;
  if (ui.tab === 'people') {
    body = renderPeople();
  } else if (ui.tab === 'core') {
    body = renderCore();
  } else if (ui.tab === 'graph') {
    body = renderGraph();
  } else if (ui.tab === 'idea') {
    body = renderIdea();
  } else {
    body = h('div', { class: 'page board' }, renderLegend(), renderColumns());
  }
  const board = ui.tab !== 'people' && ui.tab !== 'core' && ui.tab !== 'graph' && ui.tab !== 'idea';
  return [
    h('div', { class: 'stickyhead' }, renderTopbar(), renderMainTabs()),
    isUnexported(work) && renderExportBar(),
    !ui.storageOk && h('div', { class: 'banner' }, 'この画面では保存できません。閉じると消えます。'),
    board && renderNextBar(),
    body,
    board && renderQuickBar(),
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
  const ir = document.querySelector('.idea-rail');
  const irScroll = ir ? ir.scrollLeft : null;
  app.replaceChildren(...[].concat(work ? renderBoard() : renderWorks()).filter(Boolean));
  if (work) {
    refreshStatus();
    const cols2 = document.getElementById('cols');
    if (cols2 && colsScroll) cols2.scrollLeft = colsScroll;
    const pw2 = document.querySelector('.ptable-wrap');
    if (pw2 && pwScroll) { pw2.scrollLeft = pwScroll[0]; pw2.scrollTop = pwScroll[1]; }
    const gw2 = document.querySelector('.gchart-wrap');
    if (gw2 && gwScroll != null) gw2.scrollLeft = gwScroll;
    const ir2 = document.querySelector('.idea-rail');
    if (ir2 && irScroll) ir2.scrollLeft = irScroll;
    window.scrollTo(0, scrollY);
    ideaPagerPlace();
  }
  syncIdeaBar();
  document.body.classList.toggle('has-quick', !!work && ui.tab === 'board');
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
// 香盤表の列（画面の表と PDF で共通）。休憩は、そのブロックの index 枚目の前に入る、ブロックの外の独立した列。
// flat は列の並び（bs＝前の列と別のブロックのカードの始まり。休憩の直後は除く）。
// segments は見出しの1段目の区切り（ブロックの続き、または休憩の列）。
function peopleColumns() {
  const im = intermissionOf(work);
  const flat = [];
  work.blocks.forEach((b) => {
    const imIndex = im && im.blockId === b.id ? Math.min(im.index, b.cards.length) : -1;
    b.cards.forEach((c, i) => {
      if (i === imIndex) flat.push({ col: { brk: true } });
      flat.push({ col: { card: c }, block: b });
    });
    if (imIndex === b.cards.length) flat.push({ col: { brk: true } });
  });
  flat.forEach((f, i) => {
    const prev = flat[i - 1];
    f.bs = !f.col.brk && !!prev && !prev.col.brk && prev.block !== f.block;
  });
  const segments = [];
  flat.forEach((f, i) => {
    const last = segments[segments.length - 1];
    if (f.col.brk) segments.push({ brk: true, start: i, end: i + 1 });
    else if (last && !last.brk && last.block === f.block) last.end = i + 1;
    else segments.push({ block: f.block, start: i, end: i + 1 });
  });
  return { flat, segments };
}

function renderPeopleTable() {
  const nums = numbering();
  const { flat, segments } = peopleColumns();

  // 休憩の列は見出しの2段と本文をそれぞれ1つのセルにし、同じ帯の色で上から下までつなげる
  const head1 = h('tr', {}, h('th', { class: 'corner', rowspan: 2 }, '人物'),
    segments.map((sg) => sg.brk
      ? h('th', { class: 'brk', rowspan: 2, 'aria-hidden': 'true' })
      : h('th', { class: 'bh' + (flat[sg.start].bs ? ' bs' : ''), colspan: sg.end - sg.start }, sg.block.name)));
  const head2 = h('tr', {}, flat.filter((f) => !f.col.brk).map((f) =>
    h('th', { class: 'ch' + (f.bs ? ' bs' : '') }, `#${nums.get(f.col.card.id)}`)));

  // 香盤表：列の並び（休憩で区切る）。続けて出ている間を1本の帯にする
  const colgroup = h('colgroup', {}, h('col', { class: 'c-name' }), flat.map((f) => h('col', { class: f.col.brk ? 'c-brk' : 'c-card' })));
  const nRows = work.characters.length;
  const rows = work.characters.map((p, r) => {
    const count = allCards().filter((x) => x.card.characters.includes(p.id)).length;
    const onAt = (k) => !!(flat[k] && !flat[k].col.brk && flat[k].col.card.characters.includes(p.id));
    return h('tr', {},
      h('th', { class: 'rname', scope: 'row' },
        personMark(p, 12),
        h('span', { class: 'rn', dataset: { pname: p.id } }, p.name || '（名前なし）'),
        h('span', { class: 'cnt' }, `${count}枚`)),
      flat.map((f, k) => {
        const bs = f.bs ? ' bs' : '';
        if (f.col.brk) return r === 0 ? h('td', { class: 'brk', rowspan: nRows }, h('span', { class: 'brk-label', 'aria-label': '休憩' }, '休', h('br'), '憩')) : null;
        const c = f.col.card;
        const on = onAt(k);
        const v = on ? c.states[p.id] : undefined;
        // 帯の始まり（登場）と終わり（退場）。休憩の列で帯は切れる
        const band = on ? (onAt(k - 1) ? '' : ' run-start') + (onAt(k + 1) ? '' : ' run-end') : '';
        return h('td', { class: 'pc' + (on ? ' on' : '') + band + bs, dataset: { card: c.id, char: p.id },
          style: on ? `--pc:${p.color}` : null, onclick: () => openCard(c.id) },
          v !== undefined && h('span', { class: 'pv' }, fmtState(v)));
      }));
  });

  // 見出しの2段目が貼り付く位置＝1段目の実際の高さ。文字の高さはブラウザで違う（Safari は低い）ので、
  // 数字で決めると2段目だけが下へずれて本文の線にかぶる。描いたあとに測って合わせる
  const table = h('table', { class: 'ptable' }, colgroup, h('thead', {}, head1, head2), h('tbody', {}, rows));
  requestAnimationFrame(() => {
    const hgt = head1.getBoundingClientRect().height;
    if (hgt > 0) table.style.setProperty('--ph1', `${hgt}px`);
  });
  return h('div', { class: 'ptable-wrap' }, table);
}

// ---------- 香盤表の PDF（コンビニ印刷用。A4 横） ----------
// 外の部品は使わず、端末の中で表を絵（JPEG）に描き、その絵を貼った PDF を組む。
// できたファイルは端末に保存するだけで、ほかへは送らない。書き出しと同じく、毎回日時入りの新しい名前にする。

const PDF_PAGE = { w: 297, h: 210, m: 10 }; // mm
const PDF_DPI = 200;

function kobanPages() {
  const { flat, segments } = peopleColumns();
  const chars = work.characters;
  const top = PDF_PAGE.m + 11, h1 = 7, h2 = 6, foot = 6;
  const avail = PDF_PAGE.h - PDF_PAGE.m - foot - top - h1 - h2;
  let rh = Math.min(10, avail / Math.max(1, chars.length));
  let per = chars.length || 1;
  if (rh < 7) { rh = 7; per = Math.floor(avail / rh); }
  const pages = [];
  for (let i = 0; i < Math.max(1, chars.length); i += per) pages.push(chars.slice(i, i + per));
  return { flat, segments, pages, rh, top, h1, h2 };
}

function drawKobanPage(ctx, k, L, rowsChars, pageNo, pageCount) {
  const { flat, segments, rh, top, h1, h2 } = L;
  const nums = numbering();
  const INK = '#2d2822', MUTED = '#6e6455', LINE = '#d9d1c1', HEAD = '#f2eee5', SUNK = '#e9e3d6', RULE = '#b7ac97';
  const FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
  const pt = (n) => n * 0.3528 * k; // ポイント → 絵の点
  const X = (mm) => mm * k;
  const font = (size, bold) => { ctx.font = `${bold ? '700 ' : ''}${pt(size)}px ${FONT}`; };
  const fit = (text, maxW) => {
    let t = String(text);
    if (ctx.measureText(t).width <= maxW) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  };

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, X(PDF_PAGE.w), X(PDF_PAGE.h));
  ctx.textBaseline = 'middle';

  // 見出し：作品名・香盤表
  const m = PDF_PAGE.m;
  ctx.fillStyle = INK; font(14, true); ctx.textAlign = 'left';
  const title = fit(work.title || '無題', X(PDF_PAGE.w - m * 2 - 40));
  ctx.fillText(title, X(m), X(m + 4));
  const tw = ctx.measureText(title).width;
  font(11, false); ctx.fillText('　香盤表', X(m) + tw, X(m + 4));

  // 列の幅
  const NAME = 34, BRK = 7;
  const nBrk = flat.filter((f) => f.col.brk).length;
  const nCard = flat.length - nBrk;
  const cw = (PDF_PAGE.w - m * 2 - NAME - nBrk * BRK) / Math.max(1, nCard);
  const xs = []; let x = m + NAME;
  flat.forEach((f) => { xs.push(x); x += f.col.brk ? BRK : cw; });
  const right = x;
  const rowsTop = top + h1 + h2;
  const bottom = rowsTop + rh * rowsChars.length;

  // 見出しの段（ブロック名・カードの番号）
  ctx.fillStyle = HEAD; ctx.fillRect(X(m), X(top), X(right - m), X(h1 + h2));
  ctx.fillStyle = INK; font(9, true); ctx.textAlign = 'left';
  ctx.fillText('人物', X(m + 2), X(top + (h1 + h2) / 2));
  segments.forEach((sg) => {
    if (sg.brk) return;
    const x0 = xs[sg.start], x1 = sg.end === flat.length ? right : xs[sg.end];
    ctx.save(); ctx.beginPath(); ctx.rect(X(x0), X(top), X(x1 - x0), X(h1)); ctx.clip();
    ctx.fillStyle = INK; font(9, true); ctx.fillText(sg.block.name || '', X(x0 + 1.5), X(top + h1 / 2));
    ctx.restore();
  });
  const numSize = Math.min(8, cw / 0.3528 / 2.2);
  flat.forEach((f, i) => {
    if (f.col.brk) return;
    const n = nums.get(f.col.card.id);
    font(numSize, false); ctx.fillStyle = MUTED; ctx.textAlign = 'center';
    ctx.fillText(cw >= 5.5 ? `#${n}` : String(n), X(xs[i] + cw / 2), X(top + h1 + h2 / 2));
  });

  // 罫線
  ctx.strokeStyle = LINE; ctx.lineWidth = X(0.25);
  ctx.beginPath();
  for (let r = 0; r <= rowsChars.length; r++) { const y = rowsTop + r * rh; ctx.moveTo(X(m), X(y)); ctx.lineTo(X(right), X(y)); }
  ctx.moveTo(X(m), X(top)); ctx.lineTo(X(right), X(top));
  ctx.moveTo(X(m + NAME), X(top + h1)); ctx.lineTo(X(right), X(top + h1));
  [m, m + NAME, right].forEach((xx) => { ctx.moveTo(X(xx), X(top)); ctx.lineTo(X(xx), X(bottom)); });
  flat.forEach((f, i) => { if (!f.bs) { ctx.moveTo(X(xs[i]), X(top + h1)); ctx.lineTo(X(xs[i]), X(bottom)); } });
  ctx.stroke();
  // 休憩の列：罫線を消し、上から下まで細い帯を1本通して、真ん中に縦書きの「休憩」
  flat.forEach((f, i) => {
    if (!f.col.brk) return;
    ctx.fillStyle = '#fff'; ctx.fillRect(X(xs[i] + 0.15), X(top + 0.2), X(BRK - 0.3), X(bottom - top - 0.4)); // 表の上下の線は残す
    ctx.fillStyle = HEAD; ctx.fillRect(X(xs[i] + 0.15), X(top + 0.2), X(BRK - 0.3), X(h1 + h2 - 0.2)); // 見出しの段は画面と同じ地の色
    ctx.fillStyle = SUNK; ctx.beginPath(); ctx.roundRect(X(xs[i] + 1.3), X(top + 0.6), X(BRK - 2.6), X(bottom - top - 1.2), X(1.2)); ctx.fill();
    font(9, true); ctx.fillStyle = MUTED; ctx.textAlign = 'center';
    const cyb = top + (bottom - top) / 2;
    ctx.fillText('休', X(xs[i] + BRK / 2), X(cyb - 2.2));
    ctx.fillText('憩', X(xs[i] + BRK / 2), X(cyb + 2.2));
  });
  // 人物の行
  rowsChars.forEach((p, r) => {
    const y = rowsTop + r * rh;
    const cy = y + rh / 2;
    // 印・名前・枚数
    ctx.save();
    ctx.translate(X(m + 1.5), X(cy - 1.5)); ctx.scale(X(3) / 12, X(3) / 12);
    ctx.fillStyle = p.color;
    const shapes = { square: 'M2 2H10V10H2Z', triangle: 'M6 1.5L11 10.5H1Z', diamond: 'M6 0.8L11.2 6L6 11.2L0.8 6Z',
      down: 'M1 1.5H11L6 10.5Z', cross: 'M4.2 1H7.8V4.2H11V7.8H7.8V11H4.2V7.8H1V4.2H4.2Z' };
    if (shapes[p.shape]) ctx.fill(new Path2D(shapes[p.shape]));
    else { ctx.beginPath(); ctx.arc(6, 6, 5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    const count = allCards().filter((xx) => xx.card.characters.includes(p.id)).length;
    font(7.5, false); ctx.fillStyle = MUTED; ctx.textAlign = 'right';
    const cnt = `${count}枚`;
    ctx.fillText(cnt, X(m + NAME - 1.5), X(cy));
    const cntW = ctx.measureText(cnt).width;
    font(9, true); ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.fillText(fit(p.name || '（名前なし）', X(NAME - 5.5 - 2.5) - cntW), X(m + 5.5), X(cy));

    // 出ている間の帯（休憩とブロックの区切りで切る）
    const onAt = (i) => !!(flat[i] && !flat[i].col.brk && flat[i].col.card.characters.includes(p.id));
    for (let i = 0; i < flat.length; i++) {
      if (!onAt(i) || onAt(i - 1)) continue;
      let j = i; while (onAt(j + 1)) j++;
      const x0 = xs[i] + 0.6, x1 = xs[j] + cw - 0.6;
      ctx.beginPath(); ctx.roundRect(X(x0), X(y + 1.2), X(x1 - x0), X(rh - 2.4), X(1.4));
      ctx.fillStyle = '#fff'; ctx.fill(); // 下の罫線を消してから色を重ねる
      ctx.globalAlpha = 0.24; ctx.fillStyle = p.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = X(0.45); ctx.strokeStyle = p.color; ctx.stroke();
      i = j;
    }
    // 状態の値
    const vSize = Math.min(9, cw / 0.3528 / 2);
    flat.forEach((f, i) => {
      if (!onAt(i)) return;
      const v = f.col.card.states[p.id];
      if (v === undefined) return;
      font(vSize, true); ctx.fillStyle = INK; ctx.textAlign = 'center';
      ctx.fillText(fmtState(v), X(xs[i] + cw / 2), X(cy));
    });
  });

  // ブロックの区切り：罫線より一段濃いだけの細い線
  ctx.fillStyle = RULE;
  flat.forEach((f, i) => { if (f.bs) ctx.fillRect(X(xs[i] - 0.25), X(top), X(0.5), X(bottom - top)); });

  // 下の端：日付と頁
  const d = new Date();
  font(7.5, false); ctx.fillStyle = MUTED; ctx.textAlign = 'right';
  ctx.fillText(`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` + (pageCount > 1 ? `　${pageNo}/${pageCount}` : ''),
    X(PDF_PAGE.w - m), X(PDF_PAGE.h - m));
}

// JPEG の絵を1頁に1枚ずつ貼った PDF を組む
function buildImagePdf(images, wPt, hPt) {
  const enc = new TextEncoder();
  const parts = []; const offs = []; let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, ...body) => { offs[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n%âãÏÓ\n');
  const n = images.length;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`);
  images.forEach((im, i) => {
    const pg = 3 + i * 3, ct = pg + 1, ig = pg + 2;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${ig} 0 R >> >> /Contents ${ct} 0 R >>`);
    const c = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
    obj(ct, `<< /Length ${c.length} >>\nstream\n`, c, '\nendstream');
    obj(ig, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`, im.bytes, '\nendstream');
  });
  const size = 3 + n * 3;
  const xref = len;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let i = 1; i < size; i++) push(`${String(offs[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

async function kobanPdf() {
  const k = PDF_DPI / 25.4;
  const L = kobanPages();
  const images = [];
  for (let i = 0; i < L.pages.length; i++) {
    const cv = document.createElement('canvas');
    cv.width = Math.round(PDF_PAGE.w * k); cv.height = Math.round(PDF_PAGE.h * k);
    drawKobanPage(cv.getContext('2d'), k, L, L.pages[i], i + 1, L.pages.length);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error('jpeg');
    images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height });
  }
  return buildImagePdf(images, 841.89, 595.28);
}

async function saveKobanPdf() {
  if (!work || ui.pdfBusy) return;
  ui.pdfBusy = true;
  try {
    let blob;
    try { blob = await kobanPdf(); } catch (e) { showToast('PDFを作れませんでした'); return; }
    const filename = exportFileName(`${work.title || '無題'}_香盤表`, new Date()).replace(/\.json$/, '.pdf');
    if (window.claude && typeof window.claude.use === 'function') {
      // claude.ai の枠の中：保存を頼む（ファイルを直接落とすことは止められている）
      if (!cloud.dl || typeof cloud.dl.save !== 'function') { showToast('この画面ではPDFを保存できません'); return; }
      try {
        await cloud.dl.save({ filename, data: blob });
        showToast('PDFを保存しました');
      } catch (e) {
        const code = e && e.code;
        if (code === 'declined') return;
        showToast(code === 'rate_limited' ? '少し待ってから、もう一度押してください' : 'この画面ではPDFを保存できません');
      }
      return;
    }
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { if (!e || e.name !== 'AbortError') downloadFile(file); }
    } else {
      downloadFile(file);
    }
  } finally {
    ui.pdfBusy = false;
  }
}

function renderPeople() {
  const edit = h('details', { class: 'ent-edit', open: ui.entEditOpen, ontoggle: (e) => { if (e.target === edit) ui.entEditOpen = edit.open; } },
    h('summary', {}, '編集'),
    entitySection('characters', '登場人物', '＋人物を足す', '人物の名前'),
    entitySection('threads', '筋', '＋筋を足す', '筋の名前'));
  return h('div', { class: 'page people' },
    work.characters.length
      ? [h('div', { class: 'people-tools' },
           h('button', { type: 'button', class: 'pdf-btn', onclick: saveKobanPdf }, 'PDFを保存')),
         h('div', { class: 'print-title' }, h('b', {}, work.title || '無題'), h('span', {}, '　香盤表')),
         renderPeopleTable(),
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

// 選んでいる筋（なければ null）
function graphThreadSel() {
  return ui.graphThread ? work.threads.find((t) => t.id === ui.graphThread) || null : null;
}

// カードごとの「盛り上がり」：各人物の、前に値を入れたカードからの差の絶対値の合計（値のない人物は0）
function cardMoves(cards) {
  const moves = new Map();
  const prev = {};
  cards.forEach((x) => {
    let sum = 0;
    work.characters.forEach((p) => {
      const v = x.card.states[p.id];
      if (v === undefined) return;
      if (prev[p.id] !== undefined) sum += Math.abs(v - prev[p.id]);
      prev[p.id] = v;
    });
    moves.set(x.card.id, sum);
  });
  return moves;
}

// 点と点のあいだで値をはみ出さないなめらかな線（Fritsch–Carlson の単調3次補間）の SVG パス
function monotonePath(pts) {
  const n = pts.length;
  if (!n) return '';
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  if (n === 1) return d;
  const dx = [], sl = [];
  for (let k = 0; k < n - 1; k++) {
    dx[k] = pts[k + 1][0] - pts[k][0];
    sl[k] = (pts[k + 1][1] - pts[k][1]) / dx[k];
  }
  const mt = [sl[0]];
  for (let k = 1; k < n - 1; k++) mt[k] = sl[k - 1] * sl[k] <= 0 ? 0 : (sl[k - 1] + sl[k]) / 2;
  mt[n - 1] = sl[n - 2];
  for (let k = 0; k < n - 1; k++) {
    if (sl[k] === 0) { mt[k] = 0; mt[k + 1] = 0; continue; }
    const a = mt[k] / sl[k], b = mt[k + 1] / sl[k], r = a * a + b * b;
    if (r > 9) { const tau = 3 / Math.sqrt(r); mt[k] = tau * a * sl[k]; mt[k + 1] = tau * b * sl[k]; }
  }
  for (let k = 0; k < n - 1; k++) {
    const h3 = dx[k] / 3;
    d += `C${pts[k][0] + h3} ${pts[k][1] + mt[k] * h3} ${pts[k + 1][0] - h3} ${pts[k + 1][1] - mt[k + 1] * h3} ${pts[k + 1][0]} ${pts[k + 1][1]}`;
  }
  return d;
}

function renderGraphChart(chars, cards, nums) {
  const N = cards.length;
  const th = graphThreadSel();
  const inTh = (x) => !!th && x.card.threads.includes(th.id);
  const thChars = new Set();
  if (th) cards.forEach((x) => { if (inTh(x)) x.card.characters.forEach((id) => thChars.add(id)); });
  const BAR_H = 56, BAR_EXTRA = th ? 4 + 18 + BAR_H + 8 : 0;
  const L = 60, R = 16, T = 30, B = 52;
  const H0 = Math.max(280, Math.min(420, (window.innerHeight || 700) - 260));
  const H = H0 + BAR_EXTRA;
  const avail = Math.max(280, Math.min(app.clientWidth || 600, 1200) - 34);
  const W = Math.max(avail, N * 22 + L + R);
  const cw = (W - L - R) / N;
  const xc = (i) => L + (i + 0.5) * cw;
  const xe = (i) => L + i * cw; // i 枚目の左の縁
  const ph = H0 - T - B;
  const yv = (v) => T + (3 - v) / 6 * ph;
  const svg = s('svg', { class: 'gchart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group',
    'aria-label': '人物の状態のグラフ。横は左からカードの順、縦は幸（＋3）から不幸（−3）' });

  // 選んだ筋のカードの列を少し濃く
  if (th) {
    cards.forEach((x, i) => {
      if (inTh(x)) svg.append(s('rect', { class: 'g-tcol', x: xe(i), y: T, width: cw, height: ph, 'data-card': x.card.id }));
    });
  }
  // 状態が誰にも入っていないカードの帯
  if (!th) cards.forEach((x, i) => {
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
  const im = intermissionOf(work);
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
        s('text', { class: 'g-brklab', x: xi + 3, y: T + ph + 46 }, '休憩'));
    }
    off += n;
  });

  // 横軸：#n と大きなイベント
  const every = Math.max(1, Math.ceil((String(N).length * 8 + 14) / cw));
  cards.forEach((x, i) => {
    const n = i + 1;
    if ((n - 1) % every === 0) {
      svg.append(s('text', { class: 'g-xlab', x: xc(i), y: T + ph + 14, 'text-anchor': 'middle' }, `#${n}`));
    }
    if (x.card.big) {
      svg.append(s('line', { class: 'g-starline', x1: xc(i), x2: xc(i), y1: T, y2: T + ph }));
      const label = `大きなイベント #${n} ${cardLabel(x.card)}`;
      const open = (e) => gpopShow(e.currentTarget, x.card.id, e.type === 'click' || e.type === 'keydown');
      svg.append(s('g', { class: 'g-bigstar', tabindex: 0, role: 'button', 'aria-label': label, 'data-card': x.card.id,
        onclick: open, onpointerenter: gpopHover, onpointerleave: gpopLeave,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } } },
        s('title', {}, label),
        s('rect', { class: 'g-hit', x: xc(i) - 14, y: T + ph + 16, width: 28, height: 28 }),
        s('text', { class: 'g-star', x: xc(i), y: T + ph + 36, 'text-anchor': 'middle' }, '★')));
    }
  });

  // 人物ごとのなめらかな線（点と点のあいだで値をはみ出さない）と点。最後の点から右端までは平らに伸ばす
  const dots = [];
  // 登録順で早い人物ほど上に重ねる（後から描く）
  work.characters.slice().reverse().forEach((p) => {
    if (!graphVisible(p)) return;
    const pts = [];
    cards.forEach((x, i) => { const v = x.card.states[p.id]; if (v !== undefined) pts.push({ i, v, x }); });
    if (!pts.length) return;
    let d = monotonePath(pts.map((pt) => [xc(pt.i), yv(pt.v)]));
    d += `H${xc(N - 1)}`;
    svg.append(s('path', { class: 'g-line' + (th && !thChars.has(p.id) ? ' dim' : ''), d, stroke: p.color, 'data-char': p.id }));
    pts.forEach((pt) => dots.push({ p, pt, cx: xc(pt.i), cy: yv(pt.v) }));
  });
  // 筋を選んでいるとき、ほかのカードの列を薄く（線の上にかぶせる）
  if (th) {
    cards.forEach((x, i) => {
      if (!inTh(x)) svg.append(s('rect', { class: 'g-veil', x: xe(i), y: T, width: cw, height: ph }));
    });
  }
  dots.forEach(({ p, pt, cx, cy }) => {
    const label = `${p.name || '（名前なし）'} #${nums.get(pt.x.card.id)} ${cardLabel(pt.x.card)} ${fmtState(pt.v).replace('+', '＋')}`;
    const open = (e) => gpopShow(e.currentTarget, pt.x.card.id, true);
    svg.append(s('g', { class: 'g-pt' + (th && (!thChars.has(p.id) || !inTh(pt.x)) ? ' dim' : ''), tabindex: 0, role: 'button', 'aria-label': label, 'data-card': pt.x.card.id, 'data-char': p.id,
      onclick: open, onpointerenter: gpopHover, onpointerleave: gpopLeave, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } } },
      s('title', {}, label),
      s('circle', { class: 'g-hit', cx, cy, r: 12 }),
      s('g', { class: 'g-dot', transform: `translate(${cx - 5.5} ${cy - 5.5}) scale(${11 / 12})` }, shapeEl(p.shape, p.color, 12, { stroke: 'var(--paper)', 'stroke-width': 1.5, 'paint-order': 'stroke' }))));
  });

  // 曲線の下：選んだ筋の盛り上がり（カードごとの状態の動きの合計）
  if (th) {
    const moves = cardMoves(cards);
    const yTop = T + ph + B + 4;
    const base = yTop + 18 + BAR_H;
    const mx = Math.max(0, ...cards.filter(inTh).map((x) => moves.get(x.card.id)));
    svg.append(s('text', { class: 'g-barlab', x: L, y: yTop + 13 }, `盛り上がり（${th.name || '（名前なし）'}）`),
      s('line', { class: 'g-barbase', x1: L, x2: W - R, y1: base, y2: base }));
    const mp = [];
    cards.forEach((x, i) => { if (inTh(x)) mp.push({ x, i, m: moves.get(x.card.id), px: xc(i), py: base - (mx > 0 ? moves.get(x.card.id) / mx * BAR_H : 0) }); });
    const curve = monotonePath(mp.map((q) => [q.px, q.py]));
    if (mp.length > 1) {
      svg.append(s('path', { class: 'g-areafill', d: `${curve}L${mp[mp.length - 1].px} ${base}L${mp[0].px} ${base}Z`, fill: th.color }),
        s('path', { class: 'g-moveline', d: curve, stroke: th.color }));
    }
    mp.forEach((q) => {
      const label = `盛り上がり #${nums.get(q.x.card.id)} ${cardLabel(q.x.card)} 動き ${q.m}`;
      const open = (e) => gpopShow(e.currentTarget, q.x.card.id, true);
      svg.append(s('g', { class: 'g-bar', tabindex: 0, role: 'button', 'aria-label': label, 'data-card': q.x.card.id, 'data-move': q.m,
        onclick: open, onpointerenter: gpopHover, onpointerleave: gpopLeave,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } } },
        s('title', {}, label),
        s('circle', { class: 'g-hit', cx: q.px, cy: q.py, r: 12 }),
        s('circle', { class: 'g-mdot', cx: q.px, cy: q.py, r: 3.5, fill: th.color }),
        q.x.card.big && s('text', { class: 'g-barstar', x: q.px, y: q.py - 8, 'text-anchor': 'middle' }, '★')));
    });
  }
  return svg;
}

// 印・★を押した所の近くの小さな吹き出し（見出しと［詳細を見る］）
let gpop = null;       // { el, cardId, pinned, timer }
function gpopClose() {
  if (!gpop) return;
  clearTimeout(gpop.timer);
  gpop.el.remove();
  gpop = null;
}
function gpopShow(anchor, cardId, pinned) {
  if (gpop && gpop.cardId === cardId && gpop.anchor === anchor) {
    clearTimeout(gpop.timer);
    if (pinned) gpop.pinned = true;
    return;
  }
  gpopClose();
  const x = findCard(cardId);
  if (!x) return;
  const nums = numbering();
  const el = h('div', { class: 'gpop', role: 'dialog', 'aria-label': 'カードの見出し' },
    h('div', { class: 'gpop-title' }, `#${nums.get(cardId)} ${cardLabel(x.card)}`),
    h('button', { type: 'button', class: 'gpop-go primary', onclick: () => { gpopClose(); openCard(cardId); } }, '詳細を見る'));
  document.body.append(el);
  gpop = { el, cardId, anchor, pinned: !!pinned, timer: null };
  el.addEventListener('pointerenter', () => { if (gpop) clearTimeout(gpop.timer); });
  el.addEventListener('pointerleave', gpopLeave);
  // 印の近く（下、入らなければ上）。画面の端で切れないよう寄せる
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const pw = el.offsetWidth, ph2 = el.offsetHeight;
  let left = Math.round(r.left + r.width / 2 - pw / 2);
  left = Math.max(8, Math.min(vw - pw - 8, left));
  let top = Math.round(r.bottom + 2);
  if (top + ph2 > vh - 8) top = Math.max(8, Math.round(r.top - ph2 - 2));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
function gpopCanHover(e) { return e.pointerType === 'mouse' && window.matchMedia('(hover: hover)').matches; }
function gpopHover(e) {
  if (!gpopCanHover(e)) return;
  gpopShow(e.currentTarget, e.currentTarget.dataset.card || e.currentTarget.getAttribute('data-card'), false);
  if (gpop) clearTimeout(gpop.timer);
}
function gpopLeave(e) {
  if (!gpop || gpop.pinned || (e.pointerType && e.pointerType !== 'mouse')) return;
  clearTimeout(gpop.timer);
  gpop.timer = setTimeout(gpopClose, 250);
}
document.addEventListener('pointerdown', (e) => {
  if (gpop && !gpop.el.contains(e.target)) gpopClose();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') gpopClose(); });
window.addEventListener('scroll', () => gpopClose(), true);
window.addEventListener('resize', () => gpopClose());

function renderGraph() {
  if (!work.characters.length) {
    return h('div', { class: 'page graph' },
      h('div', { class: 'empty-people' },
        h('p', { class: 'note' }, 'まだ人物がいません。'),
        h('button', { type: 'button', class: 'primary add-person-direct', onclick: () => promptAddEntity('characters', '人物の名前') }, '＋人物を足す')));
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
  const th = graphThreadSel();
  const threadChips = work.threads.length > 0 && h('div', { class: 'gchips gthreads', role: 'group', 'aria-label': '筋' },
    h('button', { type: 'button', class: 'gchip gthread' + (th ? '' : ' on'), 'aria-pressed': th ? 'false' : 'true', dataset: { thread: '' },
      onclick: () => { ui.graphThread = null; renderMain(); } }, h('span', {}, 'すべて')),
    work.threads.map((t) => {
      const on = !!th && th.id === t.id;
      return h('button', { type: 'button', class: 'gchip gthread' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', dataset: { thread: t.id },
        onclick: () => { ui.graphThread = t.id; renderMain(); } }, threadMark(t), h('span', {}, t.name || '（名前なし）'));
    }));
  return h('div', { class: 'page graph' },
    threadChips,
    chips,
    h('div', { class: 'gchart-wrap' }, renderGraphChart(work.characters, cards, nums)),
    !th && h('p', { class: 'legend' }, '灰色＝だれの状態も入っていないカード'));
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
      line('change', '最後の変化', '最後の変化'),
      line('direction', '演出の考え', 'コンセプトなど')),
    h('div', { class: 'core-extra' }, matTags(), memoBox()));
}

// ---------- 画面：発想（マンダラートと拾った言葉） ----------
// マンダラートは9×9。添字 = 段(ブロック)*9 + マス（左上から右へ 0..8、4 が中央）。
// 外側ブロックの中央は、中心ブロックの同じ言葉と同じもの。保存も印も正規の添字（36+b）だけを使う。

function canonIdx(i) {
  const b = Math.floor(i / 9);
  return b !== 4 && i % 9 === 4 ? 36 + b : i;
}

function cellText(m, i) { return m.cells[canonIdx(i)] || ''; }
function mandalaName(m) { return m.cells[40].trim() || '（名前なし）'; }
function mandalaById(id) { return work.mandalas.find((m) => m.id === id) || null; }
function materialById(id) { return work.materials.find((t) => t.id === id) || null; }
function materialAt(m, i) {
  const c = canonIdx(i);
  return work.materials.find((t) => t.src && t.src.m === m.id && t.src.i === c) || null;
}
function hasTies(t) { return t.core || t.cards.length > 0; }

function ideaClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function newMandalaObj() { return { id: uid(), cells: Array(81).fill('') }; }

// 新しいマンダラートを末尾に作り、中心のマスを入力中にして開く
function addMandalaAndOpen() {
  const m = newMandalaObj();
  work.mandalas.push(m);
  ui.ideaEdit = { m: m.id, i: 40 };
  ui.ideaBlock = 4;
  if (narrowMq.matches) ui.ideaPick = m.id; else ui.ideaOpen = m.id;
  changed();
  ideaFocus();
}

function dropMaterial(t) {
  work.materials = work.materials.filter((x) => x !== t);
  changed();
}

function deleteMandala(m) {
  work.materials = work.materials.filter((t) => {
    if (!t.src || t.src.m !== m.id) return true;
    if (hasTies(t)) { t.src = null; return true; }
    return false;
  });
  work.mandalas = work.mandalas.filter((x) => x !== m);
  ui.ideaOpen = null;
  ui.ideaBlock = null;
  ui.ideaEdit = null;
  if (ui.ideaPick === m.id) ui.ideaPick = null;
  changed();
}

function confirmDeleteMandala(m) {
  ideaConfirm('このマンダラートを消しますか？',
    `「${mandalaName(m)}」を消します。結びのある拾った言葉は、出どころなしで残ります。`, '消す', () => { deleteMandala(m); ideaShut(); }, ideaShut);
}

// マスの言葉を確定する。印のある拾った言葉の言葉も合わせる。変わったら true
function commitCell(m, raw, value) {
  const i = canonIdx(raw);
  const v = value.trim();
  if (m.cells[i] === v) return false;
  m.cells[i] = v;
  const t = materialAt(m, i);
  if (t) {
    if (v) t.text = v;
    else if (hasTies(t)) t.src = null;            // 結びがあれば、出どころなしで残す
    else work.materials = work.materials.filter((x) => x !== t);
  }
  return true;
}

// 印を付ける・外す
function toggleMark(m, raw) {
  const i = canonIdx(raw);
  if (i === 40 || !m.cells[i]) return;
  const t = materialAt(m, i);
  if (!t) {
    work.materials.push({ id: uid(), text: m.cells[i], src: { m: m.id, i }, cards: [], core: false });
    changed();
    return;
  }
  dropMaterial(t);
}

// 同じブロックの、次の空いたマス（なければ null）
function nextEmptyCell(m, raw) {
  const b = Math.floor(raw / 9), k = raw % 9;
  for (let step = 1; step < 9; step++) {
    const kk = (k + step) % 9;
    if (!cellText(m, b * 9 + kk)) return b * 9 + kk;
  }
  return null;
}

// ----- 下の入力欄（キーボードの真上）-----
// 入力欄は #app の外に1つだけ。描き直しで作り直さない（作り直すと iOS でキーボードが閉じる）。
// ideaCur = いま入力欄が持っているマス { work, m, raw, key }。データは確定まで変えない。

let ideaBar = null;
let ideaCur = null;

function ensureIdeaBar() {
  if (ideaBar) return ideaBar;
  const input = h('input', { type: 'text', class: 'ibar-input', 'aria-label': 'マスの言葉', enterkeyhint: 'next',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    oninput: ideaLiveText,
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      ideaNext();
    },
    onblur: () => {
      // 押された相手のクリックを先に通してから閉じる
      setTimeout(() => {
        if (!ideaCur || document.activeElement === input) return;
        const ch = ideaEndEdit();
        if (ch) changed(); else renderMain();
      }, 200);
    } });
  const keep = (e) => e.preventDefault();   // ボタンを押しても入力欄から focus を奪わない
  const next = h('button', { type: 'button', class: 'primary ibar-next', onmousedown: keep, onclick: ideaNext }, '次へ');
  const done = h('button', { type: 'button', class: 'ibar-done', onmousedown: keep, onclick: () => {
    const ch = ideaEndEdit();
    if (ch) changed(); else renderMain();
  } }, '完了');
  const el = h('div', { id: 'idea-bar', role: 'group', 'aria-label': 'マスの言葉を書く' }, input, next, done);
  el.inert = true;
  document.body.append(el);
  ideaBar = { el, input };
  return ideaBar;
}

// 見えている画面の下端にぴったり付ける
function placeIdeaBar() {
  if (!ideaBar) return;
  if (!narrowMq.matches) {
    // 広い画面：3×3 の真上の置き場（.idea-slot）に、ページの座標で重ねる。画面の動きには追わせない
    const el = ideaBar.el;
    el.classList.add('wide');
    el.classList.remove('kb');
    const slot = document.querySelector('.idea-slot');
    if (slot) {
      const r = slot.getBoundingClientRect();
      el.style.top = (r.top + window.scrollY) + 'px';
      el.style.left = (r.left + window.scrollX) + 'px';
      el.style.width = r.width + 'px';
    }
    el.style.bottom = 'auto';
    document.documentElement.style.setProperty('--ibar-pad', el.classList.contains('on') ? '40vh' : '0px');
    return;
  }
  ideaBar.el.classList.remove('wide');
  ideaBar.el.style.top = '';
  ideaBar.el.style.left = '';
  ideaBar.el.style.width = '';
  const vv = window.visualViewport;
  const off = vv ? Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))) : 0;
  ideaBar.el.style.bottom = off + 'px';
  ideaBar.el.classList.toggle('kb', off > 40);
  document.documentElement.style.setProperty('--ibar-pad', (ideaBar.el.offsetHeight + off) + 'px');
}

// 入力欄の中身を、いまのマスに確定する。keep なら入力を続ける。変わったら true
function ideaCommit(keep) {
  if (!ideaCur || !ideaBar) return false;
  const c = ideaCur;
  if (!keep) ideaCur = null;
  if (c.work !== work || !work.mandalas.includes(c.m)) return false;
  return commitCell(c.m, c.raw, ideaBar.input.value);
}

// 確定して入力を終える（キーボードも閉じる）。変わったら true
function ideaEndEdit() {
  const ch = ideaCommit(false);
  ui.ideaEdit = null;
  if (ideaBar && ideaBar.input === document.activeElement) ideaBar.input.blur();
  return ch;
}

function ideaStopEdit() {
  if (!ideaCur && !ui.ideaEdit) return;
  const ch = ideaEndEdit();
  if (ch) changed(true);
  syncIdeaBar();
}

// 押した操作の前に確定して入力欄を閉じ、操作をして描き直す
function ideaGo(fn) {
  const ch = ideaEndEdit();
  fn();
  if (ch) changed(); else renderMain();
}

function ideaFocus() {
  if (!ideaBar || !ideaCur) return;
  ideaBar.input.focus({ preventScroll: true });
  try { ideaBar.input.setSelectionRange(ideaBar.input.value.length, ideaBar.input.value.length); } catch (e) { /* 何もしない */ }
  placeIdeaBar();
  ideaEnsureVisible();
}

// 書いているマスが、帯とキーボードの上に見えるように画面を動かす
function ideaEnsureVisible() {
  if (!ideaBar || !ideaCur) return;
  if (!narrowMq.matches) {
    // 広い画面：入力欄が画面の上の方（上から 0〜40%）に見えるようにする。キーボードは下から出る
    const rb = ideaBar.el.getBoundingClientRect();
    const vw = window.visualViewport;
    const vTop = vw ? vw.offsetTop : 0;
    const vH = vw ? vw.height : window.innerHeight;
    const shd = document.querySelector('.stickyhead');
    const topLim = vTop + (shd ? shd.offsetHeight : 0) + 8;
    const maxTop = vTop + vH * 0.4;
    if (rb.top > maxTop || rb.top < topLim) window.scrollBy(0, rb.top - Math.max(topLim, Math.min(maxTop, topLim + 8)));
    return;
  }
  const cell = document.querySelector(`.nb-cell .mcell[data-i="${ideaCur.raw}"]`);
  if (!cell) return;
  const r = cell.getBoundingClientRect();
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const limit = bottom - ideaBar.el.offsetHeight - 8;
  const sh = document.querySelector('.stickyhead');
  const topLimit = top + (sh ? sh.offsetHeight : 0) + 8;
  if (r.bottom > limit) window.scrollBy(0, r.bottom - limit);
  else if (r.top < topLimit) window.scrollBy(0, r.top - topLimit);
}

// 打った文字を、マスの表示にも映す（データは確定まで変えない）
function ideaLiveText() {
  if (!ideaCur || !ideaBar) return;
  const cell = document.querySelector(`.nb-cell .mcell[data-i="${ideaCur.raw}"]`);
  if (!cell) return;
  const v = ideaBar.input.value.trim();
  const tx = cell.querySelector('.mtxt');
  if (tx) tx.textContent = v;
  cell.classList.toggle('has', !!v);
  cell.classList.toggle('empty', !v);
}

// 描き直しのたびに、入力欄の表示・値・ラベルだけを更新する
function syncIdeaBar() {
  let want = null;
  if (work && ui.tab === 'idea' && ui.ideaEdit && !modalRoot.firstChild && ui.ideaBlock != null) {
    const m = mandalaById(ui.ideaEdit.m);
    const owner = narrowMq.matches ? ui.ideaPick : ui.ideaOpen;
    if (m && owner === m.id && Math.floor(ui.ideaEdit.i / 9) === ui.ideaBlock) want = { m, raw: ui.ideaEdit.i };
  }
  if (!want) {
    if (ideaCur) { if (ideaCommit(false)) changed(true); }
    ui.ideaEdit = null;
    if (ideaBar) {
      ideaBar.el.classList.remove('on');
      ideaBar.el.inert = true;
      ideaBar.el.style.bottom = narrowMq.matches ? '0px' : 'auto';
      ideaBar.el.classList.toggle('wide', !narrowMq.matches);
    }
    document.body.classList.remove('idea-editing');
    return;
  }
  const bar = ensureIdeaBar();
  const key = `${want.m.id}:${want.raw}`;
  if (!ideaCur || ideaCur.key !== key) {
    if (ideaCur && ideaCommit(false)) changed(true);
    bar.input.value = cellText(want.m, want.raw);
    ideaCur = { work, m: want.m, raw: want.raw, key };
  }
  bar.el.inert = false;
  bar.el.classList.add('on');
  document.body.classList.add('idea-editing');
  placeIdeaBar();
}

// マスを押す：いまのマスを確定し、押したマスを書く状態にする（押した処理の中で focus する）
function startEdit(m, raw) {
  if (ideaCur && ideaCur.m === m && ideaCur.raw === raw) { ideaFocus(); return; }
  const ch = ideaCommit(true);
  ui.ideaEdit = { m: m.id, i: raw };
  if (ch) changed(); else renderMain();
  ideaFocus();
}

// ［次へ］・Enter：確定して、同じブロックの次の空いたマスへ。なければ次のマス
function ideaNext() {
  if (!ideaCur) return;
  const c = ideaCur;
  const ch = ideaCommit(true);
  let nx = nextEmptyCell(c.m, c.raw);
  if (nx == null) { const b = Math.floor(c.raw / 9), k = c.raw % 9; nx = b * 9 + (k + 1) % 9; }
  ui.ideaEdit = { m: c.m.id, i: nx };
  if (ch) changed(); else renderMain();
  ideaFocus();
}

// ○：いまのマスを確定してから、印を付け外す
function ideaToggleMark(m, raw) {
  const ch = ideaCommit(true);
  const t = materialAt(m, raw);
  if (ch) changed(true);
  toggleMark(m, raw);
}

// マス1つ。o = { tag, big, editable, onclick }
function ideaCell(m, raw, o) {
  const i = canonIdx(raw);
  const b = Math.floor(raw / 9), k = raw % 9;
  const editing = !!(o.editable && ui.ideaEdit && ui.ideaEdit.m === m.id && ui.ideaEdit.i === raw);
  const draft = editing && ideaCur && ideaCur.m === m && ideaCur.raw === raw && ideaBar ? ideaBar.input.value.trim() : null;
  const txt = draft != null ? draft : m.cells[i];
  const isKey = (b === 4 && k !== 4) || (b !== 4 && k === 4);
  const marked = i !== 40 && !!materialAt(m, i);
  const cls = ['mcell', txt ? 'has' : 'empty', raw === 40 && 'name', txt && isKey && 'key', marked && 'mark', o.big && 'big', editing && 'editing'];
  const tag = o.tag || 'button';
  return h(tag, { class: cls.filter(Boolean).join(' '), type: tag === 'button' ? 'button' : null, dataset: { i: raw },
    'aria-label': txt ? `${txt}${marked ? '（印あり）' : ''}` : '空いたマス', onclick: o.onclick,
    onmousedown: o.editable ? (e) => { if (ideaCur) e.preventDefault(); } : null },
    h('span', { class: 'mtxt' }, txt));
}

// 9×9 を1枚。o = { c: マスの大きさ(px), tag, onCell(raw), onBlock(b) }
function mandalaEl(m, o) {
  const c = o.c;
  const fs = ideaClamp(Math.round(c * 0.27), 10, 18);
  const wrap = h('div', { class: 'mandala' + (o.pad ? ' pad' : ''), dataset: { id: m.id }, style: `--mc:${c}px;--mfs:${fs}px` });
  for (let b = 0; b < 9; b++) {
    const blk = h(o.onBlock ? 'button' : 'div', { class: 'mblock' + (o.onBlock ? ' mblock-btn' : '') + (o.sel === b ? ' sel' : ''), type: o.onBlock ? 'button' : null,
      dataset: { b }, 'aria-label': o.onBlock ? `ブロック ${b + 1}` : null, onclick: o.onBlock ? () => o.onBlock(b) : null });
    for (let k = 0; k < 9; k++) {
      const raw = b * 9 + k;
      blk.append(ideaCell(m, raw, { tag: o.tag, onclick: o.onCell ? () => o.onCell(raw) : null }));
    }
    wrap.append(blk);
  }
  return wrap;
}

// ----- 拾った言葉の一覧・札 -----

function matPanel() {
  const list = work.materials;
  return h('aside', { class: 'mat-panel', 'aria-label': '拾った言葉の一覧' },
    h('div', { class: 'mat-head' }, h('strong', {}, '拾った言葉'), h('span', { class: 'mat-count' }, `${list.length}件`)),
    h('p', { class: 'mat-sub' }, '印を付けた言葉。カードにできる'),
    list.map((t) => {
      const m = t.src ? mandalaById(t.src.m) : null;
      const sub = m ? mandalaName(m) : '';
      return h('button', { type: 'button', class: 'mat-item', dataset: { id: t.id }, onclick: () => openMaterial(t.id) },
        h('strong', {}, t.text || '（空）'), sub && h('small', {}, sub));
    }),
    memoBox());
}

function matTags() {
  return h('div', { class: 'mat-tags idea-mats' },
    h('div', { class: 'mat-head' }, h('strong', {}, '拾った言葉'), h('span', { class: 'mat-count' }, `${work.materials.length}件`)),
    work.materials.map((t) => h('button', { type: 'button', class: 'mat-tag', dataset: { id: t.id }, onclick: () => openMaterial(t.id) }, t.text || '（空）')));
}

// ----- 画面本体 -----

function renderIdea() {
  // 画面の広さが変わっても、どのマンダラートのどの3×3かが引き継がれるようにそろえる
  if (narrowMq.matches) {
    if (ui.ideaOpen) { ui.ideaPick = ui.ideaOpen; ui.ideaOpen = null; if (ui.ideaBlock == null) ui.ideaBlock = 4; }
  } else {
    if (!ui.ideaOpen && ui.ideaBlock != null && ui.ideaPick) ui.ideaOpen = ui.ideaPick;
    if (ui.ideaOpen && ui.ideaBlock == null) ui.ideaBlock = 4;
    if (!ui.ideaOpen) ui.ideaBlock = null;
  }
  return h('div', { class: 'page idea' }, narrowMq.matches ? renderIdeaNarrow() : renderIdeaWide());
}

// 3×3 の画面（広い画面もスマホも同じ形）
function ideaBlockView(m, wide, S) {
  const b = ui.ideaBlock;
  const full = document.documentElement.clientWidth;
  const availW = full - 32 - (wide && full >= 1000 ? 276 : 0);
  const G = 6;
  const side = S || ideaClamp(Math.floor(Math.min(availW, window.innerHeight * 0.62) / 3) - G, 96, 180);
  const fs = ideaClamp(Math.round(side * 0.16), 16, 24);
  const word = cellText(m, b * 9 + 4);
  const nav = h('div', { class: 'nb-nav', 'aria-label': '3×3 の移動' },
    Array.from({ length: 9 }, (_, j) => h('button', { type: 'button', class: 'nb-dot' + (j === b ? ' cur' : j === 4 ? ' mid' : ''),
      dataset: { b: j }, 'aria-label': `ブロック ${j + 1} へ`, onclick: () => ideaGo(() => { ui.ideaBlock = j; }) })));
  const cells = Array.from({ length: 9 }, (_, k) => {
    const raw = b * 9 + k;
    const i = canonIdx(raw);
    const marked = !!materialAt(m, i);
    return h('div', { class: 'nb-cell' },
      ideaCell(m, raw, { big: true, editable: true, onclick: () => startEdit(m, raw) }),
      k !== 4 && m.cells[i] && h('button', { type: 'button', class: 'nb-mark', 'aria-label': marked ? '印を外す' : '印を付ける',
        'aria-pressed': marked ? 'true' : 'false', onmousedown: (e) => { if (ideaCur) e.preventDefault(); },
        onclick: () => ideaToggleMark(m, raw) }, h('span', {}, marked ? '●' : '○')));
  });
  if (S) {   // 広い画面の書く画面：右の列（中央の言葉と大きな3×3）。戻る・移動は左の9×9と［‹ 並べる］が受け持つ
    return h('div', { class: 'idea-block wide-right', style: `--ns:${side}px;--nfs:${fs}px;width:${3 * side + 2 * G}px` },
      h('div', { class: 'idea-slot' }, !ui.ideaEdit && h('span', { class: 'idea-slot-hint' }, 'マスを押して書く')),
      h('div', { class: 'nb-grid' }, cells));
  }
  const back = wide
    ? h('button', { type: 'button', class: 'ibtn nb-back idea-back', onclick: () => ideaGo(() => { ui.ideaOpen = null; ui.ideaBlock = null; }) }, '‹ 並べる')
    : h('button', { type: 'button', class: 'ibtn nb-back', onclick: () => ideaGo(() => { ui.ideaBlock = null; }) }, `‹ ${mandalaName(m)}`);
  return h('div', { class: 'idea-block', style: `--ns:${side}px;--nfs:${fs}px;width:${3 * side + 2 * G}px;max-width:100%` },
    h('div', { class: 'nb-head' }, back, h('span', { class: 'nb-word' }, word || '（未記入）'), nav),
    h('div', { class: 'nb-grid' }, cells));
}

// 一覧に戻ったあと、そのマンダラートが見える所へ動かす
function ideaScrollToItem(id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.idea-item[data-id="${id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sh = document.querySelector('.stickyhead');
    const topLimit = (sh ? sh.offsetHeight : 0) + 8;
    if (r.top < topLimit || r.height > window.innerHeight - topLimit) window.scrollBy(0, r.top - topLimit);
    else if (r.bottom > window.innerHeight) window.scrollBy(0, r.bottom - window.innerHeight + 8);
  });
}

function renderIdeaWide() {
  const full = document.documentElement.clientWidth;
  const W = Math.max(300, full - 32);
  const side = full >= 1000;
  const avail = side ? W - 276 : W;
  const open = ui.ideaOpen ? mandalaById(ui.ideaOpen) : null;
  if (ui.ideaOpen && !open) { ui.ideaOpen = null; ui.ideaBlock = null; }
  if (open) {
    // 書く画面：左に9×9（ブロックを選ぶだけ）、右に選んだ3×3。縦向きでも横に並べる
    const Wp = full - 32 - 24;
    const c = ideaClamp(Math.floor((Wp * 0.45 - 36) / 9), 30, 52);
    const s = Math.min(ideaClamp(Math.floor((Wp - (9 * c + 36) - 16) / 3), 96, 170), Math.max(96, Math.floor((window.innerHeight - 230) / 3)));
    const b = ui.ideaBlock;
    const head = h('div', { class: 'wl-head' },
      h('button', { type: 'button', class: 'ibtn idea-back', onclick: () => { ideaGo(() => { ui.ideaOpen = null; ui.ideaBlock = null; }); ideaScrollToItem(open.id); } }, '‹ 並べる'),
      h('span', { class: 'idea-name' }, mandalaName(open)),
      h('button', { type: 'button', class: 'idea-del-wide', onclick: () => confirmDeleteMandala(open) }, 'このマンダラートを消す'));
    const detail = h('div', { class: 'wl-detail' }, ideaBlockView(open, true, s), work.materials.length ? matTags() : null, memoBox());
    const nine = h('div', { class: 'wl-nine' },
      mandalaEl(open, { c, tag: 'div', pad: true, sel: b, onBlock: (j) => { if (j !== ui.ideaBlock) ideaGo(() => { ui.ideaBlock = j; }); } }));
    requestAnimationFrame(ideaFitWrite);
    return h('div', { class: 'idea-wide-write' }, head, h('div', { class: 'wl-row' }, detail, nine));
  }
  let left;
  if (!work.mandalas.length) {
    left = h('div', { class: 'idea-empty' },
      h('p', { class: 'note' }, 'マンダラートで言葉を広げて、気になる言葉に印を付けます。'),
      h('button', { type: 'button', class: 'idea-add primary', onclick: addMandalaAndOpen }, '＋ マンダラート'));
  } else {
    const c = ideaClamp(Math.floor(((avail - 24) / 2 - 36) / 9), 30, 56);
    left = h('div', { class: 'idea-tiles' },
      h('div', { class: 'idea-top' },
        h('span', { class: 'idea-hint' }, '書きたい所を押すと、その 3×3 が開く'),
        h('button', { type: 'button', class: 'idea-add', onclick: addMandalaAndOpen }, '＋ マンダラート')),
      h('div', { class: 'idea-grid' }, work.mandalas.map((m) => h('div', { class: 'idea-item', dataset: { id: m.id } },
        h('div', { class: 'idea-head' },
          h('span', { class: 'idea-name' }, mandalaName(m))),
        mandalaEl(m, { c, tag: 'div', pad: true,
          onBlock: (b) => { ui.ideaOpen = m.id; ui.ideaBlock = b; ui.ideaEdit = null; renderMain(); window.scrollTo(0, 0); } })))));
  }
  const showList = true;
  if (work.mandalas.length === 1) requestAnimationFrame(ideaFitOne);
  return h('div', { class: 'idea-main' + (side ? '' : ' stack') },
    h('div', { class: 'idea-left' }, left),
    showList && matPanel());
}

// 書く画面：ページ全体が画面の高さに収まる範囲で、9×9 を先に、3×3 を残りいっぱいに大きくし、2つまとめて中央に置く
function ideaFitWrite() {
  const wrap = document.querySelector('.idea-wide-write');
  if (!wrap || narrowMq.matches || !ui.ideaOpen) return;
  const nine = wrap.querySelector('.mandala'), blk = wrap.querySelector('.idea-block'), detail = wrap.querySelector('.wl-detail');
  if (!nine || !blk || !detail) return;
  const root = document.documentElement;
  const oldPad = root.style.getPropertyValue('--ibar-pad');
  root.style.setProperty('--ibar-pad', '0px');         // 書いている間の下の余白は、収まりの計算に入れない
  const W = root.clientWidth - 32, GAP = 16, G = 6, NS_MIN = 100;
  const setNine = (mc) => { nine.style.setProperty('--mc', mc + 'px'); nine.style.setProperty('--mfs', ideaClamp(Math.round(mc * 0.27), 10, 18) + 'px'); };
  const setBlk = (ns) => {
    blk.style.setProperty('--ns', ns + 'px'); blk.style.setProperty('--nfs', ideaClamp(Math.round(ns * 0.16), 16, 24) + 'px');
    blk.style.width = (3 * ns + 2 * G) + 'px';
    detail.style.width = blk.style.width;        // 拾った言葉の札も、3×3 の幅の中で折り返す
  };
  const fits = () => root.scrollHeight <= window.innerHeight;
  // 1. 9×9：3×3 を隠して、高さに収まる最大（幅は3×3の最小を残す）
  detail.style.display = 'none';
  let mc = ideaClamp(Math.floor((W - GAP - (3 * NS_MIN + 2 * G) - 36) / 9), 30, 80);
  setNine(mc);
  while (mc > 30 && !fits()) { mc--; setNine(mc); }
  // 2. 3×3：幅の残りと高さに収まる最大
  detail.style.display = '';
  let ns = ideaClamp(Math.floor((W - GAP - nine.offsetWidth - 2 * G) / 3), 60, 200);
  setBlk(ns);
  while (ns > 60 && !fits()) { ns -= 2; setBlk(ns); }
  wrap.style.width = (nine.offsetWidth + GAP + blk.offsetWidth) + 'px';
  if (oldPad) root.style.setProperty('--ibar-pad', oldPad); else root.style.removeProperty('--ibar-pad');
  placeIdeaBar();
}

// 1枚だけのとき：9×9 が幅と画面の高さの両方に収まる大きさに合わせる
function ideaFitOne() {
  const el = document.querySelector('.idea-grid .mandala');
  if (!el || narrowMq.matches || ui.ideaOpen) return;
  const c0 = parseFloat(el.style.getPropertyValue('--mc')) || 30;
  const r = el.getBoundingClientRect();
  const extra = r.height - 9 * c0;
  const extraW = r.width - 9 * c0;
  const full = document.documentElement.clientWidth;
  const availW = full - 32 - (full >= 1000 ? 276 + 16 : 0);
  const top = r.top + window.scrollY;
  const c = ideaClamp(Math.floor(Math.min((availW - extraW) / 9, (window.innerHeight - top - 48 - extra) / 9)), 30, 72);
  if (c === c0) return;
  el.style.setProperty('--mc', c + 'px');
  el.style.setProperty('--mfs', ideaClamp(Math.round(c * 0.27), 10, 18) + 'px');
}

function ideaSyncTabs() {
  document.querySelectorAll('.idea-tab[data-id]').forEach((b) => b.classList.toggle('on', b.dataset.id === ui.ideaPick));
}

// スマホの全体：マンダラートを横に並べ、左右のスワイプで隣へ。選んでいる持ち主は ui.ideaPick だけ
function ideaPager(c) {
  const panes = work.mandalas.map((x) => h('div', { class: 'idea-pane', dataset: { id: x.id } },
    mandalaEl(x, { c, tag: 'div', onBlock: (b) => { ui.ideaPick = x.id; ui.ideaBlock = b; ui.ideaEdit = null; renderMain(); window.scrollTo(0, 0); } }),
    h('p', { class: 'idea-hint' }, '押した所の 3×3 に入る')));
  const pager = h('div', { class: 'idea-pager' }, panes);
  let timer = null;
  const settle = () => {
    clearTimeout(timer);
    const w = pager.clientWidth;
    if (!w || !work) return;
    const idx = ideaClamp(Math.round(pager.scrollLeft / w), 0, work.mandalas.length - 1);
    const x = work.mandalas[idx];
    if (x && x.id !== ui.ideaPick) { ui.ideaPick = x.id; ideaSyncTabs(); }
  };
  pager.addEventListener('scroll', () => { clearTimeout(timer); timer = setTimeout(settle, 120); });
  pager.addEventListener('scrollend', settle);
  return pager;
}

// 描いたあと、選んでいる面の位置へ動きなしで合わせる
function ideaPagerPlace() {
  const p = document.querySelector('.idea-pager');
  if (!p || !work) return;
  const idx = Math.max(0, work.mandalas.findIndex((x) => x.id === ui.ideaPick));
  p.scrollLeft = idx * p.clientWidth;
}

function renderIdeaNarrow() {
  if (!work.mandalas.length) {
    return h('div', { class: 'idea-empty' },
      h('p', { class: 'note' }, 'マンダラートで言葉を広げて、気になる言葉に印を付けます。'),
      h('button', { type: 'button', class: 'idea-add primary', onclick: addMandalaAndOpen }, '＋ マンダラート'),
      work.materials.length ? matTags() : null,
      memoBox());
  }
  let m = ui.ideaPick ? mandalaById(ui.ideaPick) : null;
  if (!m) { m = work.mandalas[0]; ui.ideaPick = m.id; ui.ideaBlock = null; }
  if (ui.ideaBlock == null) {
    const full = document.documentElement.clientWidth;
    const c = Math.floor((full - 32 - 24) / 9);
    const pager = ideaPager(c);
    return h('div', { class: 'idea-narrow' },
      h('div', { class: 'idea-tabs' },
        work.mandalas.map((x) => h('button', { type: 'button', class: 'idea-tab' + (x === m ? ' on' : ''), dataset: { id: x.id },
          onclick: () => {
            ui.ideaPick = x.id;
            ideaSyncTabs();
            const idx = work.mandalas.indexOf(x);
            pager.scrollTo({ left: idx * pager.clientWidth, behavior: 'smooth' });
          } }, mandalaName(x))),
        h('button', { type: 'button', class: 'idea-tab add', 'aria-label': 'マンダラートを足す', onclick: addMandalaAndOpen }, '＋')),
      pager,
      matTags(),
      memoBox(),
      h('button', { type: 'button', class: 'idea-del', onclick: () => {
        const cur = ui.ideaPick ? mandalaById(ui.ideaPick) : null;
        if (cur) confirmDeleteMandala(cur);
      } }, 'このマンダラートを消す'));
  }
  return h('div', { class: 'idea-narrow' },
    ideaBlockView(m, false),
    h('p', { class: 'idea-hint' }, '右上の ○ で印'),
    matTags(),
    memoBox());
}

// ----- 小さな面（確認・拾った言葉） -----

function ideaOverlay(sheet, onClose) {
  const o = h('div', { class: 'overlay bottom', onclick: (e) => { if (e.target === o) onClose(); } }, sheet);
  return o;
}

// 拾った言葉などの面を閉じる。カードの詳細から開いていたら、詳細に戻る
function ideaShut() {
  if (ui.openCardId) renderCardSheet();
  else modalRoot.replaceChildren();
}

function ideaConfirm(title, note, goLabel, onGo, onCancel) {
  ideaStopEdit();
  const sheet = h('div', { class: 'sheet small-sheet idea-confirm', role: 'dialog', 'aria-label': title },
    h('h2', {}, title),
    note && h('p', { class: 'note' }, note),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary idea-go' + (goLabel === '消す' || goLabel === '外す' ? ' danger' : ''), onclick: onGo }, goLabel),
      h('button', { type: 'button', class: 'ibtn idea-cancel', onclick: onCancel }, 'やめる')));
  modalRoot.replaceChildren(ideaOverlay(sheet, onCancel));
}

// ----- 単語のメモ（拾った言葉とは別の一覧）-----

function memoBox() {
  const input = h('input', { type: 'text', class: 'memo-input', 'aria-label': 'メモを書く', placeholder: 'メモを書く', enterkeyhint: 'done',
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    onfocus: memoFocus,
    onkeydown: (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      addMemo(input);
    } });
  return h('div', { class: 'memo-box' },
    h('div', { class: 'mat-head' }, h('strong', {}, 'メモ'), h('span', { class: 'mat-count' }, `${work.memos.length}件`)),
    work.memos.length ? h('div', { class: 'mat-tags memo-tags' },
      work.memos.map((t) => h('button', { type: 'button', class: 'mat-tag memo-tag', dataset: { id: t.id }, onclick: () => renderMemoSheet(t.id) }, t.text || '（空）'))) : null,
    h('div', { class: 'memo-add' }, input,
      h('button', { type: 'button', class: 'memo-go ibtn', onmousedown: (e) => e.preventDefault(), onclick: () => addMemo(input) }, '足す')));
}

// 発想の書く入力が開いていたら閉じてから、メモの欄を使う
function memoFocus(e) {
  if (ideaCur || ui.ideaEdit) {
    ideaStopEdit();
    document.querySelectorAll('.mcell.editing').forEach((el) => el.classList.remove('editing'));
  }
  const el = e.target;
  setTimeout(() => { if (document.activeElement === el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 350);
}

// いまある欄を作り直す（描き直しはしない。入力を途切れさせないため）
function refreshMemoBoxes(focus) {
  document.querySelectorAll('.memo-box').forEach((el, k) => {
    const nb = memoBox();
    el.replaceWith(nb);
    if (focus && k === 0) nb.querySelector('.memo-input').focus({ preventScroll: true });
  });
}

function addMemo(input) {
  const v = input.value.trim();
  if (!v) return;
  work.memos.push({ id: uid(), text: v });
  changed(true);
  refreshMemoBoxes(true);
}

function closeMemo(id) {
  const t = work.memos.find((x) => x.id === id);
  if (t && !t.text.trim()) { work.memos = work.memos.filter((x) => x !== t); changed(true); }
  ideaShut();
  refreshMemoBoxes(false);
}

function renderMemoSheet(id) {
  ideaStopEdit();
  const t = work.memos.find((x) => x.id === id);
  if (!t) { ideaShut(); return; }
  const sheet = h('div', { class: 'sheet small-sheet memo-sheet', role: 'dialog', 'aria-label': 'メモ' },
    h('h2', {}, 'メモ'),
    h('label', { class: 'field' }, h('span', {}, '言葉'),
      h('input', { type: 'text', class: 'memo-edit', value: t.text, oninput: (e) => { t.text = e.target.value; changed(true); } })),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'mat-remove memo-remove', onclick: () => {
        work.memos = work.memos.filter((x) => x !== t);
        changed(true);
        ideaShut();
        refreshMemoBoxes(false);
      } }, '外す'),
      h('button', { type: 'button', class: 'ibtn mat-close memo-close', onclick: () => closeMemo(id) }, '閉じる')));
  modalRoot.replaceChildren(ideaOverlay(sheet, () => closeMemo(id)));
}

function openMaterial(id) { renderMaterialSheet(id); }

function closeMaterial(id) {
  const t = materialById(id);
  if (t && !t.src && !t.text.trim() && !hasTies(t)) {
    work.materials = work.materials.filter((x) => x !== t);
    changed();
  }
  ideaShut();
}

function renderMaterialSheet(id) {
  ideaStopEdit();
  const t = materialById(id);
  if (!t) { ideaShut(); return; }
  const m = t.src ? mandalaById(t.src.m) : null;
  const word = t.src
    ? h('div', { class: 'field' }, h('span', {}, '言葉'), h('div', { class: 'mat-word' }, t.text),
        h('small', {}, `出どころ：${m ? mandalaName(m) : ''}（言葉の直しはマスで）`))
    : h('label', { class: 'field' }, h('span', {}, '言葉'),
        h('input', { type: 'text', class: 'mat-input', value: t.text, placeholder: '拾った言葉',
          oninput: (e) => { t.text = e.target.value; changed(true); } }));
  const sheet = h('div', { class: 'sheet small-sheet mat-sheet', role: 'dialog', 'aria-label': '拾った言葉' },
    h('h2', {}, '拾った言葉'),
    word,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'mat-remove', onclick: () => {
        dropMaterial(t); ideaShut();
      } }, '拾った言葉から外す'),
      h('button', { type: 'button', class: 'ibtn mat-close', onclick: () => closeMaterial(id) }, '閉じる')));
  modalRoot.replaceChildren(ideaOverlay(sheet, () => closeMaterial(id)));
}

let ideaResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(ideaResizeTimer);
  ideaResizeTimer = setTimeout(() => {
    if (!work || ui.tab !== 'idea' || modalRoot.firstChild) return;
    if (!ui.ideaEdit) { renderMain(); return; }
    // 書いている途中：広い↔狭いが変わったら、確定して閉じて描き直す。同じなら入力欄の位置だけ付け直す
    if (ideaBar && ideaBar.el.classList.contains('wide') === !narrowMq.matches) { renderMain(); return; }
    const ch = ideaEndEdit();
    if (ch) changed(); else renderMain();
  }, 150);
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { if (narrowMq.matches) placeIdeaBar(); ideaEnsureVisible(); });
  window.visualViewport.addEventListener('scroll', () => { if (narrowMq.matches) placeIdeaBar(); });
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
    const main = ['conflict', 'event', 'change'].includes(key);
    return h(row ? 'div' : 'label', { class: 'field' + (main ? ' main' : ''), dataset: { field: key } },
      row ? h('div', { class: 'fhead' }, h('span', {}, label), row) : h('span', {}, label),
      ta, list);
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
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'del-start', onclick: () => {
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
              ? '二幕構成に変えます。「破」は「一幕後半・破」になり、空の「二幕前半・破」が加わります。「一幕後半・破」の最後に休憩が入ります。'
              : '一幕構成に変えます。「一幕後半・破」と「二幕前半・破」のカードを、「破」にまとめます。休憩はなくなります。';
            if (confirm(msg)) changeType(key);
            closeModal(); openSettings();
          } }), t.label))),
      null),
    h('div', { class: 'field' },
      h('span', {}, 'ファイルに書き出す'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'export-btn settings-export', onclick: exportWork }, '書き出す'),
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
      h('button', { type: 'button', class: 'settings-del', onclick: () => {
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
  return document.querySelector(`#app .card[data-card="${CSS.escape(l.id)}"]`);
}

function clearGaps() {
  document.querySelectorAll('.drop-gap').forEach((el) => el.remove());
}

// カードのあいだ・列の末尾に、置き場所を出す（位置は列の中で決める。カードの並びは動かさない）
function showGaps() {
  clearGaps();
  document.querySelectorAll('#cols .track').forEach((track) => {
    const bid = track.dataset.block;
    let idx = 0, emitted = false, bottom = null;
    const total = track.querySelectorAll(':scope > .card').length;
    const add = (index, y) => track.append(h('button', {
      type: 'button', class: 'drop-gap', dataset: { block: bid, index: String(index) },
      'aria-label': 'ここに置く', tabindex: '-1', style: `top:${y - 14}px`,
      onclick: () => { if (ui.lifted) placeLifted(bid, index); },
    }));
    for (const ch of Array.from(track.children)) {
      const isCard = ch.classList.contains('card');
      if (!isCard && !ch.classList.contains('break')) continue;
      if (!emitted) {
        // 末尾の休憩は空き枠のあとに出るので、置き場所は最後のカードの直後に出す
        add(idx, !isCard && idx === total && bottom != null ? bottom + 3 : ch.offsetTop - 3);
        emitted = true;
      }
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
  showGaps();
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
  return JSON.stringify({ blocks: work.blocks, pool: work.pool });
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
  clearUndo();
  if (u.item) ui.landed = { kind: u.item.kind, id: u.item.id, at: Date.now() };
  changed();
  if (u.item) afterMove(u.item, rects);
}

// ---------- 置いた場所が分かる動き ----------

const LANDED_MS = 1000;
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
  const mine = `c:${item.id}`;
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

// 持ち上げたカードを置く（どの列・保留へも）。fromRect：ドラッグで離したときのゴーストの位置
function placeItem(item, blockId, index, fromRect) {
  const before = moveSnapshot();
  const rects = layoutRects();
  moveCard(item.id, blockId, index);
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
  if (!document.querySelector('.drop-gap')) showGaps();
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

window.addEventListener('pagehide', () => { saveNow(); cloudFlushAll(); });
window.addEventListener('beforeunload', (e) => {
  // 書き出していない作品を開いたまま閉じようとしたときの確認（主にパソコンのブラウザ）
  if (work && exportUrgent(work)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveNow(); cloudFlushAll(); cloudPollStop(); } else cloudResume();
});
window.addEventListener('pageshow', cloudResume);
window.addEventListener('focus', cloudResume);
// 入力が終わったら、待たせていた他の端末の変更を取り込む
document.addEventListener('focusout', () => { if (cloud.pending.size || ui.renderPending) syncKick(250); });
narrowMq.addEventListener('change', () => renderMain());

ui.storageOk = storageAvailable();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
// 前回の作品が読めれば、一覧を飛ばして開く
try {
  const lastId = localStorage.getItem(LAST_KEY);
  const lastWork = lastId ? readWork(lastId) : null;
  if (lastWork) openWork(lastWork);
  else if (lastId) localStorage.removeItem(LAST_KEY);
} catch (e) { /* 一覧のまま */ }
if (!work) renderMain();
cloudInit(); // claude.ai の中なら、つながってからデータベースと合わせる（起動は待たせない）
