import { acquisition, byNewest, decodeCsv, dividendRows, isoDate, parseCsv, positivePrice, realized, sum } from './model.js';

const view = document.querySelector('#view');
const file = document.querySelector('#file');
const csv = document.querySelector('#csv');
const status = document.querySelector('#import-status');
const money = new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 2 });
const digits = new Intl.NumberFormat('ja-JP');
const yen = value => value == null ? '—' : money.format(value);
const percent = value => value == null ? '—' : (value * 100).toFixed(2) + '%';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const tone = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const label = { home: '運用状況', allocation: '構成', sales: '過去一覧', dividends: '過去受取配当' };
const palette = ['#245bab','#008272','#bb6332','#754fa1','#0085ad','#ad456b','#4563d6','#637732'];
const storageKey = 'kani-manual-dividends-v1';
let manual = {};
try { manual = JSON.parse(localStorage.getItem(storageKey)) ?? {}; } catch { /* unavailable or invalid storage */ }
let trades = [], imported = false, sort = 'value', generation = 0, pending = 0;
let market = new Map(), details = new Map();
let editing = null;

function stockName(code) { return market.get(code)?.name || code; }
function stockLink(code) {
  const name = stockName(code);
  return `<a class="stock" href="#stock/${code}">${esc(name)}</a>${name === code ? '' : ` <small>${code}</small>`}`;
}
function badge(value) {
  if (value !== 'NISA' && value !== '一部NISA') return '';
  return `<span class="badge ${value === 'NISA' ? 'nisa' : value === '一部NISA' ? 'mixed' : ''}">${esc(value)}</span>`;
}
function safeLink(url, name) {
  if (!/^https?:\/\//i.test(url ?? '')) return '—';
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>`;
}
function table(headers, rows, empty = '表示するデータがありません。') {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="scroll" tabindex="0" role="region" aria-label="データ表"><table><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function availableTotal(rows, key) {
  const known = rows.filter(row => row[key] != null);
  return !rows.length || known.length ? sum(known, row => row[key]) : null;
}
function groupTrades() {
  const groups = new Map();
  for (const trade of trades) {
    if (!groups.has(trade.code)) groups.set(trade.code, []);
    groups.get(trade.code).push(trade);
  }
  return groups;
}
function portfolio() {
  const groups = groupTrades();
  const holdings = [];
  const dividends = new Map();
  const date = today();
  for (const [code, lots] of groups) {
    const data = market.get(code);
    dividends.set(code, dividendRows(code, lots, data?.history, manual[code], date));
    const open = lots.filter(lot => !lot.sellDate);
    if (!open.length) continue;
    const shares = sum(open, lot => lot.shares);
    const cost = sum(open, acquisition);
    const value = data?.price == null ? null : data.price * shares;
    const gain = value == null ? null : value - cost;
    const forecast = data?.forecast == null ? null : data.forecast * shares;
    const nisaLots = open.filter(lot => lot.nisa === 'NISA').length;
    const nisa = nisaLots === open.length ? 'NISA' : nisaLots ? '一部NISA' : '';
    holdings.push({ code, shares, cost, value, gain, forecast, nisa, rate: gain == null ? null : gain / cost, data });
  }
  return { groups, holdings, dividends, sold: trades.filter(t => t.sellDate).sort(byNewest('sellDate')) };
}
function coverage(rows, key) {
  const count = rows.filter(row => row[key] != null).length;
  return count < rows.length ? `取得済み ${count} / ${rows.length} 銘柄で集計` : '';
}
function dividendCoverage(groups) {
  const missing = [...groups.keys()].filter(code => market.get(code)?.historyIncomplete !== false).length;
  return missing ? `${missing} 銘柄の公開配当履歴に未取得分があります。` : '';
}
function pastRows(dividends) {
  return [...dividends.values()].flat().filter(row => row.shares > 0).sort(byNewest('date'));
}
function dividendTotal(groups, rows) {
  if (rows.length || !groups.size || [...groups.keys()].every(code => market.get(code)?.historyIncomplete === false)) return sum(rows, row => row.total);
  return null;
}

function latestPriceTime(holdings) {
  const date = today();
  const year = Number(date.slice(0, 4));
  let latest = '', latestKey = '';
  for (const holding of holdings) {
    const asOf = holding.data?.asOf;
    if (holding.data?.price == null || !asOf) continue;
    const match = /^(?:(?:(\d{4})[/-])?(\d{1,2})[/-](\d{1,2}))?(?:\s*(\d{1,2}):(\d{2}))?$/.exec(asOf.trim());
    let key = '';
    if (match && (match[2] || match[4])) {
      const [, sourceYear, month, day, hour, minute] = match;
      const pad = part => part.padStart(2, '0');
      const monthDay = month ? `${pad(month)}-${pad(day)}` : '';
      const quoteYear = sourceYear ?? (monthDay > date.slice(5) ? year - 1 : year);
      const quoteDate = monthDay ? `${quoteYear}-${monthDay}` : date;
      key = `${quoteDate}T${pad(hour ?? '0')}:${minute ?? '00'}`;
    }
    if (!latest || key > latestKey) {
      latest = asOf;
      latestKey = key;
    }
  }
  return latest || '—';
}

function home({ holdings, groups, sold, dividends }) {
  const gain = availableTotal(holdings, 'gain');
  const cost = sum(holdings, h => h.cost);
  const pricedCost = sum(holdings.filter(h => h.gain != null), h => h.cost);
  const sales = sum(sold, realized);
  const received = dividendTotal(groups, pastRows(dividends));
  const total = !holdings.length && !sold.length ? 0 : gain == null && received == null && !sold.length ? null : (gain ?? 0) + sales + (received ?? 0);
  const issues = [coverage(holdings, 'gain'), dividendCoverage(groups)].filter(Boolean);
  const ordered = [...holdings].sort((a,b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity) || a.code.localeCompare(b.code));
  const rows = ordered.map(h => [stockLink(h.code), badge(h.nisa), digits.format(h.shares), yen(h.cost),
    yen(h.data?.price),
    yen(h.value), `<b class="${tone(h.gain)}">${yen(h.gain)}</b>`, `<b class="${tone(h.rate)}">${percent(h.rate)}</b>`]);
  return `${imported ? `<p class="muted price-time">株価の最新表示時点 ${esc(latestPriceTime(holdings))}</p>` : ''}<div class="summary">
    <div class="metric"><span>保有株の取得金額</span><b>${imported ? yen(cost) : '—'}</b><small>${holdings.length} 銘柄</small></div>
    <div class="metric"><span>保有株の評価損益</span><b class="${tone(gain)}">${imported ? yen(gain) : '—'}</b><small>上昇率 ${percent(pricedCost ? gain / pricedCost : null)}</small></div>
  </div>
  <section class="panel formula" aria-label="総運用損益の内訳">
    <div><span>評価損益</span><strong class="${tone(gain)}">${imported ? yen(gain) : '—'}</strong></div><div class="operator">＋</div>
    <div><span>過去売却損益</span><strong class="${tone(sales)}">${imported ? yen(sales) : '—'}</strong></div><div class="operator">＋</div>
    <div><span>過去受取配当金（推計）</span><strong>${imported ? yen(received) : '—'}</strong></div><div class="operator">＝</div>
    <div class="total"><span>総運用損益（配当込み）</span><strong>${imported ? yen(total) : '—'}</strong></div>
  </section>
  ${issues.length ? `<p class="notice warning">総運用損益は取得済みの項目による集計です。 ${issues.join('。 ')}</p>` : ''}
  <section class="panel"><div class="section-head"><h2>保有銘柄</h2><div><label for="sort" class="muted">並び替え </label><select id="sort"><option value="gain"${sort === 'gain' ? ' selected' : ''}>評価損益</option><option value="rate"${sort === 'rate' ? ' selected' : ''}>上昇率</option><option value="value"${sort === 'value' ? ' selected' : ''}>評価額</option></select> <a class="button" href="#sales">過去一覧を開く</a></div></div>
    ${imported ? table(['銘柄','NISA','株数','取得金額','株価','評価額','評価損益','上昇率'],rows,'現在保有している銘柄はありません。') : '<div class="empty"><p>取引CSVを読み込むと、保有銘柄と損益が表示されます。</p><button class="primary" data-pick>取引CSVを読み込む</button></div>'}</section>`;
}

function chart(title, rows, key, id, reference = '') {
  const positive = rows.filter(r => r[key] > 0).sort((a,b) => b[key] - a[key]);
  const legend = positive.map((r,i) => `<li><span class="swatch" style="background:${palette[i % palette.length]}"></span>${stockLink(r.code)}<b>${yen(r[key])}</b></li>`).join('');
  return `<section class="panel"><h2>${title}</h2><div class="chart-body"><canvas id="${id}" width="368" height="368" aria-label="${title}の円グラフ">構成は隣の一覧で確認できます。</canvas><div class="legend">${reference ? `<span class="muted">${reference}</span><b class="chart-total">${imported ? yen(availableTotal(rows,key)) : '—'}</b>` : ''}${legend ? `<ul class="legend">${legend}</ul>` : '<p class="muted">表示できる内訳はありません。</p>'}</div></div><p class="muted">${coverage(rows,key)}</p></section>`;
}
function draw(id, rows, key) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const values = rows.map(r => r[key]).filter(n => n > 0).sort((a,b) => b-a);
  const total = sum(values, x => x);
  let angle = -Math.PI / 2;
  (values.length ? values : [1]).forEach((value, i) => {
    const end = angle + Math.PI * 2 * (total ? value / total : 1);
    ctx.beginPath();
    ctx.arc(184,184,146,angle,end);
    ctx.lineWidth = 60;
    ctx.strokeStyle = total ? palette[i % palette.length] : '#e4ebf3';
    ctx.stroke();
    angle = end;
  });
}
function salesPage(sold) {
  const rows = sold.map(t => [stockLink(t.code), t.buyDate, t.sellDate, digits.format(t.shares), yen(t.buy), yen(t.sell), yen(acquisition(t)), yen(t.sell * t.shares), `<b class="${tone(realized(t))}">${yen(realized(t))}</b>`, percent(realized(t) / acquisition(t)), badge(t.nisa), `<span class="memo-text">${esc(t.memo) || '—'}</span>`]);
  return `<section class="panel"><div class="section-head"><h2>売却済み取引</h2><b>過去売却損益 ${imported ? yen(sum(sold,realized)) : '—'}</b></div>${table(['銘柄','購入日','売却日','株数','購入単価','売却単価','取得金額','売却金額','損益','損益率','NISA','備考'],rows)}</section>`;
}
function dividendsPage(groups, dividends) {
  const rows = pastRows(dividends);
  const note = dividendCoverage(groups);
  return `<section class="panel"><div class="section-head"><h2>配当明細</h2><b>推計受取額の合計 ${imported ? yen(dividendTotal(groups,rows)) : '—'}</b></div>
    <p class="muted">対象期末の保有株数に基づく税引前の推計です。 ${note}</p>
    ${table(['銘柄','対象期末','1株配当','対象株数','推計受取額','出典'],rows.map(r => [stockLink(r.code),r.date,yen(r.amount),digits.format(r.shares),yen(r.total),r.manual ? '手入力' : 'Yahoo!ファイナンス']))}</section>`;
}
function stockPage(code, lots, rows, holding) {
  const data = market.get(code), detail = details.get(code);
  const total = dividendTotal(new Map([[code,lots]]), rows.filter(r => r.shares > 0));
  const source = data?.source || `https://finance.yahoo.co.jp/quote/${code}.T`;
  const record = editing?.code === code ? editing : null;
  return `<section aria-label="現在の評価損益">
    ${holding ? `<div class="detail-grid">
      <div class="metric"><span>現在の評価損益</span><b class="${tone(holding.gain)}">${yen(holding.gain)}</b><small>上昇率 ${percent(holding.rate)}</small></div>
      <div class="metric"><span>評価額</span><b>${yen(holding.value)}</b><small>保有株数 ${digits.format(holding.shares)} 株</small></div>
      <div class="metric"><span>取得金額</span><b>${yen(holding.cost)}</b></div>
    </div>` : '<p class="notice muted">現在の保有株はありません。</p>'}
  </section>
  <div class="detail-grid">
    <div class="metric"><span>株価</span><b>${yen(data?.price)}</b><small>Yahoo!ファイナンス表示時点 ${esc(data?.asOf || '—')}</small></div>
    <div class="metric"><span>累計受取配当（推計）</span><b>${yen(total)}</b><small>${data?.historyIncomplete !== false ? '公開配当履歴に未取得分があります' : '税引前'}</small></div>
    <div class="metric"><span>年間予想1株配当</span><b>${yen(data?.forecast)}</b><small>会社予想</small></div>
  </div>
  <section class="panel"><div class="section-head"><h2>取引明細</h2></div>
    ${table(['購入日','購入単価','株数','売却日','売却単価','NISA','備考'],[...lots].sort(byNewest('buyDate')).map(t => [t.buyDate,yen(t.buy),digits.format(t.shares),t.sellDate || '保有中',yen(t.sell),badge(t.nisa),`<span class="memo-text">${esc(t.memo) || '—'}</span>`]))}</section>
  <section class="panel"><div class="section-head"><h2>配当履歴</h2></div>
    <p class="muted">同じ対象期末に手入力がある場合は、手入力の金額を集計に使います。</p>
    <form id="manual-form">
      <label>対象期末<input name="date" type="date" required value="${record?.date || ''}"></label>
      <label>1株配当（円）<input name="amount" type="number" min="0" step="any" required value="${record?.amount ?? ''}"></label>
      <button class="primary" type="submit">${record ? '修正を保存' : '配当を追加'}</button>
      ${record ? '<button type="button" data-cancel>キャンセル</button>' : ''}
    </form><p id="manual-error" role="status"></p>
    ${table(['対象期末','1株配当','対象株数','推計受取額','出典','操作'],rows.map(r => {
      const published = data?.history?.find(p => p.date === r.date);
      return [r.date, yen(r.amount), digits.format(r.shares), yen(r.total), r.manual ? `手入力${published ? ` <small>公開値 ${yen(published.amount)}</small>` : ''}` : 'Yahoo!ファイナンス', r.manual ? `<button data-edit="${r.date}">修正</button> <button data-delete="${r.date}">削除</button>` : '—'];
    }))}</section>
  <section class="panel"><h2>企業情報・株主優待</h2><p>${esc(detail?.benefit || '—')}</p>
  ${detail?.benefitTerms ? `<p class="muted">${esc(detail.benefitTerms)}</p>` : ''}
  <div class="detail-links"><span>企業公式サイト ${safeLink(detail?.website, '開く')}</span>${safeLink(source + '/incentive', 'Yahoo!ファイナンスの株主優待')}</div></section>`;
}

function route() { return location.hash.slice(1) || 'home'; }
function render() {
  const current = route();
  const code = /^stock\/([0-9A-Z]{4})$/.exec(current)?.[1];
  const model = portfolio();
  const knownStock = code && model.groups.has(code);
  const page = Object.hasOwn(label,current) ? current : 'home';
  document.querySelectorAll('nav a').forEach(a => {
    if (!knownStock && a.hash === '#' + page) a.setAttribute('aria-current','page');
    else a.removeAttribute('aria-current');
  });
  // A market response must not erase a dividend form the user is filling in.
  const form = view.querySelector('#manual-form');
  const draft = form && view.dataset.route === current ? new FormData(form) : null;
  const focused = form?.contains(document.activeElement) ? document.activeElement.name : null;
  const heading = knownStock ? stockName(code) : label[page];
  view.innerHTML = `<div class="heading"><h1>${esc(heading)} ${knownStock && heading !== code ? `<small>${code}</small>` : ''}</h1>
    ${pending ? `<span class="muted" role="status">市場データ取得中（残り ${pending} 銘柄）</span>` : ''}</div>`;
  if (knownStock) view.insertAdjacentHTML('beforeend', stockPage(code,model.groups.get(code),model.dividends.get(code),model.holdings.find(holding => holding.code === code)));
  else if (page === 'home') view.insertAdjacentHTML('beforeend', home(model));
  else if (page === 'sales') view.insertAdjacentHTML('beforeend', salesPage(model.sold));
  else if (page === 'dividends') view.insertAdjacentHTML('beforeend', dividendsPage(model.groups,model.dividends));
  else {
    view.insertAdjacentHTML('beforeend', `<div class="charts">${chart('保有株の評価額',model.holdings,'value','values')}${chart('年間予想配当の構成',model.holdings,'forecast','forecast','年間受取配当（参考）')}</div>`);
    draw('values',model.holdings,'value');
    draw('forecast',model.holdings,'forecast');
  }
  if (draft) {
    const next = view.querySelector('#manual-form');
    if (next) for (const field of ['date','amount']) next.elements[field].value = draft.get(field);
    if (focused && next?.elements[focused]) next.elements[focused].focus();
  }
  view.dataset.route = current;
  if (knownStock && !details.has(code)) {
    const token = generation;
    details.set(code, null);
    fetchMarket('detail',code).then(data => {
      if (token !== generation) return;
      details.set(code,data);
      if (route() === current) render();
    });
  }
}
async function fetchMarket(kind, code) {
  try {
    const response = await fetch(`/api/${kind}/${code}`, {signal: AbortSignal.timeout(22000)});
    return response.ok ? await response.json() : {};
  } catch { return {}; }
}
async function refresh() {
  const token = ++generation;
  const codes = [...groupTrades().keys()];
  market = new Map();
  details = new Map();
  pending = codes.length;
  render();
  let index = 0;
  async function worker() {
    while (token === generation && index < codes.length) {
      const code = codes[index++];
      const data = await fetchMarket('market', code);
      if (token !== generation) return;
      market.set(code,data);
      pending--;
      render();
    }
  }
  await Promise.all(Array.from({length:Math.min(6,codes.length)},worker));
}

document.querySelector('#pick').addEventListener('click', () => { csv.open = false; file.click(); });
file.addEventListener('change', async () => {
  const selected = file.files[0];
  if (!selected) return;
  file.value = '';
  try {
    const result = parseCsv(decodeCsv(await selected.arrayBuffer()));
    status.innerHTML = `<div class="notice ${result.errors.length ? 'warning' : ''}">
      ${result.headerValid ? `${esc(selected.name)} · ${result.trades.length} 取引 / ${new Set(result.trades.map(t => t.code)).size} 銘柄を読み込みました。` : 'CSVの見出しを確認してください。'}
      ${result.errors.length ? `<details><summary>${result.errors.length} 件の入力エラー</summary><ul>${result.errors.map(e => `<li>${e.line} 行目 · ${esc(e.name)} · ${esc(e.message)}</li>`).join('')}</ul></details>` : ''}</div>`;
    if (!result.headerValid || (!result.trades.length && result.errors.length)) return;
    trades = result.trades;
    imported = true;
    editing = null;
    if (location.hash !== '#home') location.hash = 'home';
    refresh();
  } catch {
    status.innerHTML = '<p class="notice warning">CSVを読み込めませんでした。UTF-8またはShift_JIS（CP932）のCSVを選択してください。</p>';
  }
});
function saveManual(code, entries) {
  const next = { ...manual, [code]: entries };
  try { localStorage.setItem(storageKey, JSON.stringify(next)); }
  catch {
    document.querySelector('#manual-error').textContent = 'このブラウザに配当を保存できませんでした。';
    return;
  }
  manual = next;
  editing = null;
  delete view.dataset.route;
  render();
}
view.addEventListener('change', event => {
  if (event.target.id === 'sort') {
    sort = event.target.value;
    render();
    document.querySelector('#sort').focus();
  }
});
view.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-pick')) file.click();
  const code = /^stock\/([0-9A-Z]{4})$/.exec(route())?.[1];
  if (!code) return;
  if (button.dataset.edit || button.hasAttribute('data-cancel')) {
    const date = button.dataset.edit;
    editing = date ? {code,date,amount:manual[code][date]} : null;
    delete view.dataset.route;
    render();
    document.querySelector('#manual-form input')?.focus();
  }
  if (button.dataset.delete) {
    const next = {...manual[code]};
    delete next[button.dataset.delete];
    saveManual(code,next);
  }
});
view.addEventListener('submit', event => {
  if (event.target.id !== 'manual-form') return;
  event.preventDefault();
  const code = /^stock\/([0-9A-Z]{4})$/.exec(route())?.[1];
  if (!code) return;
  const payload = new FormData(event.target);
  const date = isoDate(payload.get('date'));
  const raw = payload.get('amount');
  const amount = positivePrice(raw,true);
  if (!date || date > today() || amount == null) {
    document.querySelector('#manual-error').textContent = '対象期末は今日以前、1株配当は0以上の金額を入力してください。';
    return;
  }
  const next = {...manual[code]};
  if (editing && editing.date !== date) delete next[editing.date];
  next[date] = amount;
  saveManual(code,next);
});
window.addEventListener('hashchange', () => { editing = null; render(); });
render();
