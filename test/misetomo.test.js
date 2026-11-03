import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';
import { createShop } from '../shop.js';
import { parseCsv, toCsv } from '../csv.js';

const PRODUCTS = '﻿JANコード,商品名,売価,発注点\r\n4901234567894,"純米酒 720ml",1980,3\r\n4909876543210,"乾電池, 単3 4本",398,5\r\n123,だめな行,100,\r\n';
function setup() {
  let t = Date.parse('2026-11-03T10:00:00Z');
  const shop = createShop({ now: () => t });
  shop.login({ gameId: 'm_owner', name: '店長さん' });
  shop.importProducts('m_owner', PRODUCTS);
  return { shop, step: (ms) => { t += ms; } };
}

test('CSV：かこみの中のカンマ・"" ・BOM を読める。書き出しは式にならない', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.equal(toCsv([['=1+1', '-2', 'ok']]), '﻿\'=1+1,\'-2,ok\r\n');
});

test('はじめての人が店長。ほかの人は店長が認めるまで何も見られない', () => {
  const { shop } = setup();
  assert.equal(shop.member('m_owner').role, 'owner');
  shop.login({ gameId: 'm_staff', name: 'アルバイトさん' });
  assert.throws(() => shop.overview('m_staff'), /承認を待って/);
  assert.throws(() => shop.setRole('m_staff', 'm_staff', 'staff'), /承認を待って/);
  shop.setRole('m_owner', 'm_staff', 'staff');
  assert.equal(shop.overview('m_staff').me.role, 'staff');
  assert.equal(shop.overview('m_staff').shop.readerKey, undefined, '読み取り機の合言葉は店長だけ');
  assert.ok(shop.overview('m_owner').shop.readerKey);
});

test('モグ：レジの表を取りこむ（読めない行は知らせる）', () => {
  const { shop } = setup();
  const o = shop.overview('m_owner');
  assert.equal(o.products.length, 2);
  assert.equal(o.products[1].name, '乾電池, 単3 4本');
  const r = shop.importProducts('m_owner', 'JAN,商品名\n4901234567894,純米酒 720ml（新）\n');
  assert.equal(r.updated, 1);
  assert.equal(shop.overview('m_owner').products[0].reorderAt, 3, '発注点の列がなくても、前の値をのこす');
  assert.throws(() => shop.importProducts('m_owner', '品番,値段\n1,2\n'), /JAN/);
});

test('在庫：シールを貼る → レジの売上の表で、賞味期限の近いものから支払いずみ → 発注の目安', () => {
  const { shop } = setup();
  shop.addTags('m_owner', { jan: '4901234567894', count: 3, expiry: '2026-12-01' });
  shop.addTags('m_owner', { jan: '4901234567894', count: 2, expiry: '2026-11-05', place: 'バックヤード' });
  const r = shop.importSales('m_owner', 'JAN,数量\n4901234567894,3\n4909876543210,2\n');
  assert.deepEqual([r.sold, r.untagged], [3, 2], 'タグのない商品は、そのまま数えるだけ');
  const p = shop.overview('m_owner').products[0];
  assert.equal(p.stock, 2);
  assert.equal(p.nextExpiry, '2026-12-01', '近い期限のものから売れた');
  assert.equal(p.low, true);
  assert.ok(shop.overview('m_owner').lines.some((l) => l.agent === 'yamaneko' && /発注の目安/.test(l.text)));
});

test('賞味期限が近い・捨てた数（もったいない）', () => {
  const { shop } = setup();
  shop.addTags('m_owner', { jan: '4901234567894', count: 2, expiry: '2026-11-04' });
  assert.ok(shop.overview('m_owner').lines.some((l) => /賞味期限/.test(l.text)));
  shop.discard('m_owner', { jan: '4901234567894', count: 1 });
  assert.equal(shop.overview('m_owner').wasteThisMonth, 1);
});

test('出口：支払いがまだのタグだけ知らせる。支払いずみ・ほかのお店のタグは何も残さない', () => {
  const { shop } = setup();
  const [a, b] = shop.addTags('m_owner', { jan: '4901234567894', count: 2 });
  shop.readerEvent('register', [a]);
  assert.equal(shop.readerEvent('gate', [a, 'OTHERSHOP-1234']).alert, null);
  const { alert } = shop.readerEvent('gate', [a, b]);
  assert.equal(alert.items[0].count, 1);
  assert.match(alert.line.text, /決めつけず/);
  assert.doesNotMatch(alert.line.text, /犯人|万引/);
  assert.equal(shop.readerEvent('gate', [b]).alert, null, '同じタグで何度も鳴らさない');
  shop.resolveAlert('m_owner', alert.id, 'paid');
  assert.equal(shop.overview('m_owner').products[0].stock, 0, 'レジの読みのこし → 支払いずみに');
  assert.equal(shop.overview('m_owner').alerts[0].tagIds, undefined, '画面にはタグの番号を出さない');
});

test('知らせの記録は30日で消える', () => {
  const { shop, step } = setup();
  const [a] = shop.addTags('m_owner', { jan: '4901234567894', count: 1 });
  shop.readerEvent('gate', [a]);
  step(31 * 86400000);
  assert.equal(shop.overview('m_owner').alerts.length, 0);
});

test('棚卸し：読めなかったタグを数える', () => {
  const { shop } = setup();
  const ids = shop.addTags('m_owner', { jan: '4909876543210', count: 4 });
  const r = shop.readerEvent('count', ids.slice(0, 3));
  assert.equal(r.missing, 1);
  assert.ok(r.lines.some((l) => l.agent === 'shiba'));
});

// ---- サーバー：ともはねでログイン・読み取り機の合言葉 ----
let server;
let base;
let shop;
const fakeTomohane = async (url, opts = {}) => {
  const u = new URL(url);
  if (opts.headers?.['X-Link-Secret'] !== 'test-secret') return { ok: false, json: async () => ({}) };
  const m = u.pathname.match(/^\/api\/link\/misetomo-ticket\/(\w+)-ticket-1234567890$/);
  if (m) return { ok: true, json: async () => ({ gameId: `m_${m[1]}`, name: m[1], ageGroup: 'adult' }) };
  return { ok: false, json: async () => ({}) };
};
before(async () => {
  shop = createShop();
  server = http.createServer(createApp({ tomohaneUrl: 'http://tomohane.test', linkSecret: 'test-secret', fetchImpl: fakeTomohane, shop }));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('ともはねでログイン → 表の取りこみ → 読み取り機は合言葉がいる', async () => {
  const cb = await fetch(`${base}/auth/callback?ticket=owner-ticket-1234567890`, { redirect: 'manual' });
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  const post = (path, body, headers = { Cookie: cookie }) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/import/products', { text: PRODUCTS })).status, 200);
  const { tagIds } = await (await post('/api/tags', { jan: '4901234567894', count: 1 })).json();
  assert.equal((await post('/api/reader', { kind: 'gate', tagIds }, {})).status, 401, 'ログインも合言葉もない');
  assert.equal((await post('/api/reader', { kind: 'gate', tagIds }, { 'X-Reader-Key': 'wrong' })).status, 401);
  const ok = await (await post('/api/reader', { kind: 'gate', tagIds }, { 'X-Reader-Key': shop.readerKey() })).json();
  assert.equal(ok.alert.items[0].count, 1);
  const csv = await (await fetch(`${base}/api/export.csv`, { headers: { Cookie: cookie } })).text();
  assert.match(csv, /純米酒 720ml,1980,1/);
  // 2人目は承認待ち
  const cb2 = await fetch(`${base}/auth/callback?ticket=staff-ticket-1234567890`, { redirect: 'manual' });
  const c2 = cb2.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await fetch(`${base}/api/state`, { headers: { Cookie: c2 } })).json(), { me: { name: 'staff', role: 'waiting' } });
  assert.equal((await fetch(`${base}/api/export.csv`, { headers: { Cookie: c2 } })).status, 403);
});
