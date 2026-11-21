export function isoDate(value) {
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (!match || +match[1] < 1000) return null;
  const [, year, , month, day] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day) return null;
  return date.toISOString().slice(0, 10);
}

export function decodeCsv(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  }
}

function records(text) {
  const rows = [];
  let cells = [], cell = '', quoted = false, closed = false, invalid = false;
  let line = 1, start = 1;
  const pushCell = () => {
    cells.push(cell);
    cell = '';
    closed = false;
  };
  const pushRow = () => {
    pushCell();
    if (cells.some(v => v.trim()) || invalid) rows.push({ cells, line: start, invalid });
    cells = [];
    invalid = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (quoted) cell += '\n';
      else pushRow();
      line++;
      if (!quoted) start = line;
    } else if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (ch === ',') pushCell();
    else if (ch === '"' && !cell && !closed) quoted = true;
    else if (closed || ch === '"') invalid = true;
    else cell += ch;
  }
  invalid ||= quoted;
  pushRow();
  return rows;
}

export function positivePrice(text, allowZero = false) {
  const clean = text.normalize('NFKC');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(clean)) return null;
  const value = Number(clean.replaceAll(',', ''));
  return Number.isFinite(value) && (allowZero || value > 0) ? value : null;
}

export function parseCsv(text) {
  const rows = records(text.replace(/^\uFEFF/, ''));
  const header = rows.shift();
  const trades = [], errors = [];
  const names = header?.cells.map(v => v.trim().replace(/^購入数$/, '株数')) ?? [];
  const required = ['銘柄コード', '株数', '購入日', '購入価格', '売却日', '売却価格'];
  for (const name of required.filter(name => !names.includes(name))) errors.push({ line: header?.line ?? 1, name, message: '見出しがありません' });
  for (const name of [...required, 'NISA', '備考']) {
    if (names.indexOf(name) !== names.lastIndexOf(name)) errors.push({ line: header.line, name, message: '見出しが重複しています' });
  }
  if (header?.invalid) errors.push({ line: header.line, name: '見出し', message: '引用符の形式が不正です' });
  if (errors.length) return { trades, errors, headerValid: false };
  for (const row of rows) {
    const get = name => (row.cells[names.indexOf(name)] ?? '').trim();
    const add = (name, message) => errors.push({ line: row.line, name, message });
    const before = errors.length;
    if (row.invalid) add('CSV形式', '引用符の形式が不正です');
    if (row.cells.length > names.length) add('列数', '見出しより項目が多くあります');
    const code = get('銘柄コード').normalize('NFKC').toUpperCase();
    if (!/^(?=[0-9A-Z]*[0-9])[0-9A-Z]{4}$/.test(code)) add('銘柄コード', '数字を含む4文字の英数字を入力してください');
    const shares = positivePrice(get('株数'));
    if (!Number.isSafeInteger(shares)) add(names.includes('株数') && header.cells[names.indexOf('株数')].trim() === '購入数' ? '購入数' : '株数', '正の整数を入力してください');
    const buyDate = isoDate(get('購入日'));
    if (!buyDate) add('購入日', '有効な日付を入力してください');
    const buy = positivePrice(get('購入価格'));
    if (buy === null) add('購入価格', '正の金額を入力してください');
    const sellDate = isoDate(get('売却日'));
    const sell = positivePrice(get('売却価格'), true);
    if (get('売却日') || get('売却価格')) {
      if (!sellDate || (buyDate && sellDate < buyDate)) add('売却日', '購入日以降の有効な日付を入力してください');
      if (sell === null) add('売却価格', '0以上の金額を入力してください');
    }
    const rawNisa = get('NISA').toLowerCase();
    const nisa = { yes: 'NISA', 'はい': 'NISA', no: '対象外', 'いいえ': '対象外', '': '未判定' };
    if (!Object.hasOwn(nisa, rawNisa)) add('NISA', 'yes、no、はい、いいえ、空欄のいずれかを入力してください');
    if (errors.length === before) trades.push({ code, shares, buyDate, buy, sellDate, sell, nisa: nisa[rawNisa], memo: get('備考') });
  }
  return { trades, errors, headerValid: true };
}

export const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
export const byNewest = field => (a, b) => b[field].localeCompare(a[field]);
export const acquisition = trade => trade.buy * trade.shares;
export const realized = trade => (trade.sell - trade.buy) * trade.shares;

export function dividendRows(code, trades, publicRows, manual, today) {
  const entries = new Map((publicRows ?? []).map(row => [row.date, { amount: row.amount, manual: false }]));
  for (const [date, amount] of Object.entries(manual ?? {})) entries.set(date, { amount, manual: true });
  return Array.from(entries, ([date, entry]) => {
    const shares = date > today ? 0 : sum(trades.filter(t => t.buyDate <= date && (!t.sellDate || date < t.sellDate)), t => t.shares);
    return { code, date, shares, ...entry, total: shares * entry.amount };
  }).sort(byNewest('date'));
}
