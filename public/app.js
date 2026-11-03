// みせとも の画面：在庫・知らせ・表の取りこみ・読み取り機のまね・スタッフ
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null ? '－' : `${Number(n).toLocaleString('ja-JP')}円`);
const time = (t) => new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
let config = null;
let state = null;
let extraLines = []; // 取りこみ・棚卸しのひとこと（次の操作まで出しておく）

async function api(path, body) {
  const res = await fetch(`/api/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
const tryApi = async (fn) => {
  $('#error').textContent = '';
  try { return await fn(); } catch (e) { $('#error').textContent = e.message; return null; }
};
// ともはねのアドレス：このパソコン（localhost）のとき、スマホからも届くように、いま開いているアドレスに合わせる
function tomohaneUrl(path) {
  const u = new URL(path, config.tomohaneUrl);
  if (['localhost', '127.0.0.1'].includes(u.hostname) && !['localhost', '127.0.0.1'].includes(location.hostname)) u.hostname = location.hostname;
  return u.href;
}
const lineHtml = (l) => `<li class="line"><img src="/avatars/${esc(l.agent)}.svg" alt=""><p>${esc(l.text)}</p></li>`;

function render() {
  $('#signin').hidden = Boolean(state);
  $('#waiting').hidden = state?.me?.role !== 'waiting';
  $('#app').hidden = !state || state.me.role === 'waiting';
  if (!state || state.me.role === 'waiting') {
    if (state) $('#waiting-name').textContent = state.me.name;
    return;
  }
  $('#lines').innerHTML = [...extraLines, ...state.lines].map(lineHtml).join('');
  const options = state.products.map((p) => `<option value="${esc(p.jan)}">${esc(p.name)}</option>`).join('');
  for (const sel of $$('.product-select')) {
    const v = sel.value;
    sel.innerHTML = options || '<option value="">（まず商品の表を取りこんでください）</option>';
    if (v && state.products.some((p) => p.jan === v)) sel.value = v;
  }
  $('#stock-body').innerHTML = state.products.map((p) => `
    <tr class="${p.low ? 'low' : ''}">
      <td>${esc(p.name)}<span class="jan">${esc(p.jan)}</span></td>
      <td>${yen(p.price)}</td>
      <td class="num-stock">${p.stock}</td>
      <td>${p.backyard}</td>
      <td>${p.reorderAt ?? '－'}</td>
      <td class="${p.expirySoon ? 'soon' : ''}">${esc(p.nextExpiry ?? '－')}</td>
      <td>${p.sold}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">まだ商品がありません。「表の取りこみ」から始めましょう</td></tr>';
  const open = state.alerts.filter((a) => a.status === 'open');
  $('#alert-count').hidden = !open.length;
  $('#alert-count').textContent = open.length;
  $('#alert-list').innerHTML = state.alerts.map((a) => `
    <li class="${a.status}">
      <span class="when">${time(a.at)}</span>
      <p>${esc(a.items.map((x) => `${x.name} ×${x.count}`).join('、'))}</p>
      ${a.status === 'open' ? `<div class="acts">
        <button type="button" class="btn small" data-resolve="${esc(a.id)}" data-result="paid">支払いずみだった</button>
        <button type="button" class="btn small ghost" data-resolve="${esc(a.id)}" data-result="returned">商品がもどった</button>
        <button type="button" class="btn small ghost" data-resolve="${esc(a.id)}" data-result="other">そのほか</button>
      </div>` : `<p class="small muted">確かめた：${esc(a.resultLabel)}（${esc(a.doneBy)}・${time(a.doneAt)}）</p>`}
    </li>`).join('') || '<li class="muted">知らせはありません</li>';
  $('#tab-staff').hidden = state.me.role !== 'owner';
  if (state.staff) {
    $('#staff-list').innerHTML = state.staff.map((s) => `
      <li><strong>${esc(s.name)}</strong><span class="role">${{ owner: '店長', staff: 'スタッフ', waiting: '承認待ち' }[s.role]}</span>
        ${s.role === 'owner' ? '' : `<span class="acts">
          ${s.role === 'waiting' ? `<button type="button" class="btn small" data-staff="${esc(s.id)}" data-role="staff">認める</button>` : ''}
          <button type="button" class="btn small ghost" data-staff="${esc(s.id)}" data-role="remove">${s.role === 'waiting' ? 'ことわる' : 'はずす'}</button></span>`}
      </li>`).join('');
  }
  $('#reader-key').hidden = !state.shop.readerKey;
  if (state.shop.readerKey) {
    $('#reader-example').textContent = `curl -X POST ${location.origin}/api/reader \\\n  -H "Content-Type: application/json" \\\n  -H "X-Reader-Key: ${state.shop.readerKey}" \\\n  -d '{"kind":"gate","tagIds":["T0123ABCD"]}'\n\n# kind：register（レジ）・gate（出口）・count（棚卸し）`;
  }
}

async function refresh() {
  state = await api('state');
  render();
}

// タブ
function showTab(name) {
  extraLines = [];
  if (state?.lines) $('#lines').innerHTML = state.lines.map(lineHtml).join('');
  for (const t of $$('[role="tab"]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== name;
}
for (const t of $$('[role="tab"]')) t.addEventListener('click', () => showTab(t.dataset.tab));

// 在庫：シールを貼った・捨てた
$('#tag-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (await tryApi(() => api('tags', { jan: f.get('jan'), count: Number(f.get('count')), expiry: f.get('expiry') || null, place: f.get('place') }))) refresh();
});
$('#discard-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (await tryApi(() => api('discard', { jan: f.get('jan'), count: Number(f.get('count')) }))) refresh();
});

// 知らせ：確かめた結果
$('#alert-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-resolve]');
  if (!b) return;
  if (await tryApi(() => api('alerts/resolve', { id: b.dataset.resolve, result: b.dataset.result }))) {
    $('#banner').hidden = true;
    refresh();
  }
});

// スタッフ
$('#staff-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-staff]');
  if (!b) return;
  if (b.dataset.role === 'remove' && !confirm('この人を はずしますか？')) return;
  if (await tryApi(() => api('staff', { id: b.dataset.staff, role: b.dataset.role }))) refresh();
});

// 表の取りこみ：UTF-8 で読めなければ Shift_JIS（古いレジや Excel の表）
async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('shift_jis').decode(buf); }
}
for (const form of $$('form.import')) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) return void ($('#error').textContent = 'CSV のファイルを選んでください');
    if (file.size > 2 * 1024 * 1024) return void ($('#error').textContent = 'ファイルが大きすぎます（2MB まで）');
    const r = await tryApi(async () => api(`import/${form.dataset.kind}`, { text: await readCsvFile(file) }));
    if (!r) return;
    $('#import-errors').innerHTML = r.errors.map((x) => `<li>${x.line}行目：${esc(x.reason)}</li>`).join('');
    extraLines = form.dataset.kind === 'sales' ? [{ agent: 'mogu', text: `売れたものを読んだよ。タグの付いた ${r.sold}個を「支払いずみ」にした（タグなし ${r.untagged}個）。` }] : r.lines;
    await refresh();
    form.reset();
  });
}

// 読み取り機のまね
const simLog = (text) => { $('#sim-log').insertAdjacentHTML('afterbegin', `<li>${esc(text)}</li>`); };
async function pick(jan, status) {
  const { tagIds } = await api(`tags?jan=${encodeURIComponent(jan)}&status=${status}`);
  return tagIds;
}
$$('[data-sim]').forEach((b) => b.addEventListener('click', () => tryApi(async () => {
  const jan = $('#sim-product').value;
  if (!jan) throw new Error('まず商品の表を取りこんでください');
  const name = $('#sim-product').selectedOptions[0].textContent;
  const kind = b.dataset.sim;
  if (kind === 'register') {
    const [id] = await pick(jan, 'stock');
    if (!id) throw new Error('この商品の在庫のタグがありません（「在庫」で、シールを貼った を登録）');
    await api('reader', { kind: 'register', tagIds: [id] });
    simLog(`🧾 レジ：${name}（${id}）→ 支払いずみ`);
  } else if (kind === 'gate-paid') {
    const [id] = await pick(jan, 'sold');
    if (!id) throw new Error('支払いずみのタグがまだありません（先に「レジで1つ読む」）');
    const r = await api('reader', { kind: 'gate', tagIds: [id] });
    simLog(`🚪 出口：${name}（支払いずみ）→ ${r.alert ? '知らせ' : '何も残さない'}`);
  } else if (kind === 'gate-unpaid') {
    const [id] = await pick(jan, 'stock');
    if (!id) throw new Error('この商品の在庫のタグがありません');
    const r = await api('reader', { kind: 'gate', tagIds: [id] });
    simLog(`🚪 出口：${name}（支払いがまだ）→ ${r.alert ? '店員さんに知らせた' : 'もう知らせ中'}`);
  } else if (kind === 'gate-other') {
    const id = `OTHER-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    const r = await api('reader', { kind: 'gate', tagIds: [id] });
    simLog(`🚪 出口：ほかのお店のタグ（${id}）→ ${r.alert ? '知らせ' : '何も残さない'}`);
  } else if (kind === 'count') {
    const all = (await Promise.all(state.products.map((p) => pick(p.jan, 'stock')))).flat();
    const r = await api('reader', { kind: 'count', tagIds: all.length > 1 ? all.slice(1) : all.length ? all : ['NONE-0000'] });
    simLog(`📋 棚卸し：${all.length}個のうち ${Math.max(all.length - 1, 0)}個を読んだ → 見つからない ${r.missing}個`);
    extraLines = r.lines;
  }
  await refresh();
})));

// 店員さんのスマホへの知らせ（画面を開いているあいだ）
function listen() {
  const es = new EventSource('/api/events');
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    $('#banner-text').textContent = a.line.text;
    $('#banner').hidden = false;
    navigator.vibrate?.([200, 100, 200]);
    refresh();
  });
  es.addEventListener('update', () => refresh());
}
$('#banner-go').addEventListener('click', () => {
  showTab('alerts');
  $('#banner').hidden = true;
});

config = await api('config');
$('#signin-link').href = tomohaneUrl('/api/link/misetomo-start');
$('#back').href = tomohaneUrl('/');
await refresh();
if (state && state.me.role !== 'waiting') listen();
