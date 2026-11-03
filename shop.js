// みせとも の頭脳：商品・タグ・在庫・出口の知らせ
// 原則は「商品を追う・人は追わない」
// ・記録するのは商品とタグと時刻だけ。お客さんのこと（顔・名前・姿）は記録しない
// ・レジを通ったタグは「支払いずみ」。それからは追わない（出口で読んでも何も残さない）
// ・知らせるのは、支払いがまだのタグが出口を通ったときだけ。店員さんにだけ、「確かめてください」と
// ・このお店のものではないタグ（お客さんの持ち物など）は、出口で読んでも無視する
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseCsv, findColumns, toCsv } from './csv.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PLACES = ['売り場', 'バックヤード'];
const ALERT_KEEP_MS = 30 * 86400000; // 知らせの記録は30日で消す
const EXPIRY_SOON_DAYS = 3;
const TAG_RE = /^[A-Za-z0-9:_-]{4,64}$/;
const JAN_RE = /^\d{8}$|^\d{13}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const say = (agent, text) => ({ agent, text });

export function createShop({ file = null, now = () => Date.now() } = {}) {
  const fresh = () => ({ shop: { name: 'わたしのお店', readerKey: randomBytes(18).toString('base64url') }, staff: {}, products: {}, tags: {}, alerts: [], waste: [] });
  const state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fresh();
  const listeners = new Set();
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  };
  const emit = (type, data) => listeners.forEach((fn) => fn(type, data));
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const daysUntil = (date) => Math.round((Date.parse(date) - Date.parse(today())) / 86400000);
  const productOf = (jan) => {
    const p = state.products[jan];
    if (!p) throw new HttpError(404, `商品が見つかりません（${jan}）`);
    return p;
  };
  const tagsOf = (jan, status = 'stock') => Object.values(state.tags).filter((t) => t.jan === jan && t.status === status);
  // 賞味期限の近いものから（期限なしは最後）
  const byExpiry = (a, b) => (a.expiry ?? '9999').localeCompare(b.expiry ?? '9999') || a.addedAt - b.addedAt;
  const cleanup = () => {
    const before = state.alerts.length;
    state.alerts = state.alerts.filter((a) => now() - a.at < ALERT_KEEP_MS);
    return before !== state.alerts.length;
  };

  // ---- スタッフ（ともはねでログイン。はじめの人が店長、ほかの人は店長が認める） ----
  function login({ gameId, name }) {
    if (!gameId || !name) throw new HttpError(400, 'ともはねからの情報が足りません');
    const first = Object.keys(state.staff).length === 0;
    state.staff[gameId] ??= { id: gameId, role: first ? 'owner' : 'waiting', since: now() };
    state.staff[gameId].name = name;
    save();
    emit('update');
    return state.staff[gameId];
  }
  const member = (id) => state.staff[id] ?? null;
  function requireStaff(id) {
    const m = member(id);
    if (!m) throw new HttpError(401, 'ともはねでログインしてください');
    if (m.role === 'waiting') throw new HttpError(403, '店長の承認を待っています');
    return m;
  }
  function requireOwner(id) {
    const m = requireStaff(id);
    if (m.role !== 'owner') throw new HttpError(403, '店長だけができます');
    return m;
  }
  function setRole(ownerId, targetId, role) {
    requireOwner(ownerId);
    const t = member(targetId);
    if (!t || t.role === 'owner') throw new HttpError(400, 'この人は変えられません');
    if (role === 'remove') delete state.staff[targetId];
    else if (role === 'staff') t.role = 'staff';
    else throw new HttpError(400, '役目がちがいます');
    save();
    emit('update');
  }

  // ---- 🐹 モグ：レジの表（CSV）を取りこむ ----
  function importProducts(by, text) {
    requireStaff(by);
    const rows = parseCsv(text);
    if (rows.length < 2) throw new HttpError(400, '表が空です（1行目は見出しにしてください）');
    const col = findColumns(rows[0], {
      jan: ['JAN', 'JANコード', '商品コード', 'バーコード', 'jan_code'],
      name: ['商品名', '名前', '品名', 'name'],
      price: ['値段', '価格', '売価', '単価', 'price'],
      reorderAt: ['発注点', '発注の目安', 'reorder'],
    });
    if (col.jan < 0 || col.name < 0) throw new HttpError(400, '見出しに「JAN」と「商品名」の列が必要です');
    let added = 0;
    let updated = 0;
    const errors = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const jan = String(r[col.jan] ?? '').trim();
      const name = String(r[col.name] ?? '').trim().slice(0, 80);
      if (!JAN_RE.test(jan)) return errors.push({ line, reason: 'JAN は8けたか13けたの数字' });
      if (!name) return errors.push({ line, reason: '商品名がありません' });
      const num = (k) => (col[k] >= 0 && String(r[col[k]] ?? '').trim() !== '' ? Number(String(r[col[k]]).replace(/[,円¥\s]/g, '')) : null);
      const price = num('price');
      const reorderAt = num('reorderAt');
      if ((price !== null && !(price >= 0)) || (reorderAt !== null && !(Number.isInteger(reorderAt) && reorderAt >= 0))) return errors.push({ line, reason: '値段か発注点が数字ではありません' });
      if (state.products[jan]) updated++; else added++;
      state.products[jan] = { ...state.products[jan], jan, name, price, reorderAt: reorderAt ?? state.products[jan]?.reorderAt ?? null };
    });
    save();
    emit('update');
    const lines = [say('mogu', `表を読んだよ。新しい商品 ${added}つ、更新 ${updated}つ。${errors.length ? `読めなかった行が ${errors.length}つ（${errors.slice(0, 3).map((e) => `${e.line}行目：${e.reason}`).join('、')}）。` : ''}`)];
    return { added, updated, errors, lines };
  }

  // レジの「売れたもの」の表：JAN と 数。タグの付いた商品は、賞味期限の近いものから「支払いずみ」に
  function importSales(by, text) {
    requireStaff(by);
    const rows = parseCsv(text);
    if (rows.length < 2) throw new HttpError(400, '表が空です');
    const col = findColumns(rows[0], { jan: ['JAN', 'JANコード', '商品コード', 'バーコード'], qty: ['数', '数量', '個数', '販売数', 'qty'] });
    if (col.jan < 0 || col.qty < 0) throw new HttpError(400, '見出しに「JAN」と「数」の列が必要です');
    let sold = 0;
    let untagged = 0;
    const errors = [];
    rows.slice(1).forEach((r, i) => {
      const jan = String(r[col.jan] ?? '').trim();
      const qty = Number(String(r[col.qty] ?? '').trim());
      if (!JAN_RE.test(jan) || !Number.isInteger(qty) || qty < 1) return errors.push({ line: i + 2, reason: 'JAN か 数 が正しくありません' });
      const tags = tagsOf(jan).sort(byExpiry).slice(0, qty);
      tags.forEach((t) => { t.status = 'sold'; t.soldAt = now(); });
      sold += tags.length;
      untagged += qty - tags.length; // タグを貼っていない分（それでかまわない）
    });
    save();
    emit('update');
    return { sold, untagged, errors };
  }

  // ---- タグ ----
  // 新しいシールを貼った（β版：番号はここで作る）。本物の RFID シールは tagIds で番号をわたす
  function addTags(by, { jan, count, tagIds, expiry = null, place = '売り場' }) {
    requireStaff(by);
    productOf(jan);
    if (expiry !== null && expiry !== '' && !DATE_RE.test(expiry)) throw new HttpError(400, '賞味期限は 2026-11-30 の形で');
    if (!PLACES.includes(place)) throw new HttpError(400, '置き場所がちがいます');
    let ids = tagIds;
    if (!ids) {
      if (!Number.isInteger(count) || count < 1 || count > 500) throw new HttpError(400, '枚数は1〜500');
      ids = Array.from({ length: count }, () => `T${randomBytes(6).toString('hex').toUpperCase()}`);
    }
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every((x) => TAG_RE.test(x))) throw new HttpError(400, 'タグの番号が正しくありません');
    const dup = ids.filter((x) => state.tags[x]);
    if (dup.length) throw new HttpError(409, `もう登録されているタグがあります（${dup[0]}）`);
    for (const tagId of ids) state.tags[tagId] = { tagId, jan, status: 'stock', expiry: expiry || null, place, addedAt: now(), seenAt: null };
    save();
    emit('update');
    return ids;
  }

  // 期限切れなどで捨てた（賞味期限の近いものから）
  function discard(by, { jan, count }) {
    requireStaff(by);
    productOf(jan);
    if (!Number.isInteger(count) || count < 1) throw new HttpError(400, '数がちがいます');
    const tags = tagsOf(jan).sort(byExpiry).slice(0, count);
    if (!tags.length) throw new HttpError(400, '在庫がありません');
    tags.forEach((t) => { t.status = 'waste'; });
    state.waste.push({ jan, count: tags.length, at: now() });
    save();
    emit('update');
    return tags.length;
  }

  // ---- 読み取り機（レジ・出口のゲート・棚卸し）から ----
  function readerEvent(kind, tagIds) {
    if (!Array.isArray(tagIds) || !tagIds.length || tagIds.length > 1000 || !tagIds.every((x) => typeof x === 'string' && TAG_RE.test(x))) throw new HttpError(400, 'タグの番号が正しくありません');
    const ours = [...new Set(tagIds)].map((x) => state.tags[x]).filter(Boolean); // このお店のタグだけ
    if (kind === 'register') {
      const stock = ours.filter((t) => t.status === 'stock');
      stock.forEach((t) => { t.status = 'sold'; t.soldAt = now(); });
      save();
      emit('update');
      return { sold: stock.length };
    }
    if (kind === 'gate') {
      // 支払いずみ・捨てたもの・ほかのお店のタグ → 何も残さない
      const openTags = new Set(state.alerts.filter((a) => a.status === 'open').flatMap((a) => a.tagIds));
      const unpaid = ours.filter((t) => t.status === 'stock' && !openTags.has(t.tagId));
      if (!unpaid.length) return { alert: null };
      const items = {};
      for (const t of unpaid) items[t.jan] = (items[t.jan] ?? 0) + 1;
      const list = Object.entries(items).map(([jan, n]) => ({ jan, name: state.products[jan]?.name ?? jan, count: n }));
      const alert = {
        id: randomBytes(6).toString('hex'), at: now(), status: 'open', items: list, tagIds: unpaid.map((t) => t.tagId),
        line: say('fukurou', `ほう、出口で、支払いがまだの商品のタグを読みましたぞ：${list.map((x) => `${x.name} ×${x.count}`).join('、')}。お客さんを決めつけず、まずはていねいに確かめてくだされ。`),
      };
      cleanup();
      state.alerts.push(alert);
      save();
      emit('alert', alert);
      return { alert };
    }
    if (kind === 'count') {
      // 棚卸し：読めたタグに「見た」しるし。読めなかったタグは「見つからない」として数える
      const seen = new Set(ours.map((t) => t.tagId));
      ours.forEach((t) => { t.seenAt = now(); });
      const report = Object.values(state.products).map((p) => {
        const stock = tagsOf(p.jan);
        return { jan: p.jan, name: p.name, expected: stock.length, found: stock.filter((t) => seen.has(t.tagId)).length };
      }).filter((r) => r.expected > 0);
      const missing = report.reduce((n, r) => n + r.expected - r.found, 0);
      save();
      emit('update');
      return {
        report, missing,
        lines: [say('shiba', `棚卸し、${seen.size}個かぞえ終わったっす！ おつかれさまっす！`), ...(missing ? [say('yamaneko', `見つからないタグが ${missing}個。置き場所ちがいか、読みのこしかもしれない。もう一度かざしてみよう。`)] : [])],
      };
    }
    throw new HttpError(400, '読み取り機の種類がちがいます');
  }

  // 知らせの後：店員さんが確かめた結果（お客さんのことは書かない）
  const RESULTS = { paid: '支払いずみだった（レジの読みのこし）', returned: '商品がもどった', other: 'そのほか' };
  function resolveAlert(by, id, result) {
    const m = requireStaff(by);
    const a = state.alerts.find((x) => x.id === id);
    if (!a || a.status !== 'open') throw new HttpError(404, '知らせが見つかりません');
    if (!RESULTS[result]) throw new HttpError(400, '結果がちがいます');
    if (result === 'paid') a.tagIds.forEach((x) => { if (state.tags[x]?.status === 'stock') Object.assign(state.tags[x], { status: 'sold', soldAt: now() }); });
    Object.assign(a, { status: 'done', result, resultLabel: RESULTS[result], doneBy: m.name, doneAt: now() });
    save();
    emit('update');
    return a;
  }

  // ---- 🐱 ヤマネコ：在庫の見通し ----
  function overview(by) {
    const me = requireStaff(by);
    if (cleanup()) save();
    const products = Object.values(state.products).map((p) => {
      const stock = tagsOf(p.jan);
      const soon = stock.filter((t) => t.expiry && daysUntil(t.expiry) <= EXPIRY_SOON_DAYS);
      return {
        ...p, stock: stock.length, sold: tagsOf(p.jan, 'sold').length,
        backyard: stock.filter((t) => t.place === 'バックヤード').length,
        expirySoon: soon.length, nextExpiry: stock.map((t) => t.expiry).filter(Boolean).sort()[0] ?? null,
        low: p.reorderAt !== null && stock.length <= p.reorderAt,
      };
    }).sort((a, b) => a.jan.localeCompare(b.jan));
    const month = today().slice(0, 7);
    const wasteThisMonth = state.waste.filter((w) => new Date(w.at).toISOString().slice(0, 7) === month).reduce((n, w) => n + w.count, 0);
    const lines = [];
    for (const p of products.filter((x) => x.low)) lines.push(say('yamaneko', `${p.name} の在庫が ${p.stock}個。発注の目安（${p.reorderAt}個）を下まわった。`));
    for (const p of products.filter((x) => x.expirySoon)) lines.push(say('yamaneko', `${p.name} が ${p.expirySoon}個、${EXPIRY_SOON_DAYS}日以内に賞味期限。値引きか、早めの声かけを。`));
    if (wasteThisMonth) lines.push(say('yamaneko', `今月捨てた商品は ${wasteThisMonth}個。もったいないを、いっしょに減らそう。`));
    if (!lines.length) lines.push(say('shiba', `${me.name}さん、今日もおつかれさまっす！ 在庫は落ちついてるっす。`));
    return {
      me: { id: me.id, name: me.name, role: me.role },
      shop: { name: state.shop.name, readerKey: me.role === 'owner' ? state.shop.readerKey : undefined },
      products, lines, wasteThisMonth,
      alerts: state.alerts.slice().reverse().slice(0, 50).map(({ tagIds, ...a }) => a),
      staff: me.role === 'owner' ? Object.values(state.staff).map(({ id, name, role }) => ({ id, name, role })) : undefined,
    };
  }

  // 読み取り機のまね用：その商品のタグの番号
  function listTags(by, jan, status = 'stock') {
    requireStaff(by);
    productOf(jan);
    if (!['stock', 'sold', 'waste'].includes(status)) throw new HttpError(400, '状態がちがいます');
    return tagsOf(jan, status).sort(byExpiry).slice(0, 500).map((t) => t.tagId);
  }

  function exportStock(by) {
    requireStaff(by);
    const rows = [['JAN', '商品名', '値段', '在庫', 'うちバックヤード', '発注点', 'いちばん近い賞味期限']];
    for (const p of overview(by).products) rows.push([p.jan, p.name, p.price ?? '', p.stock, p.backyard, p.reorderAt ?? '', p.nextExpiry ?? '']);
    return toCsv(rows);
  }

  return {
    login, member, setRole, importProducts, importSales, addTags, discard, readerEvent, resolveAlert, overview, exportStock, listTags,
    readerKey: () => state.shop.readerKey,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
