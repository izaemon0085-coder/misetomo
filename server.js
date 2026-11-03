// みせとも（β版）：お店のアプリ。今あるレジの表（CSV）とつないで、タグシールで在庫と防犯
// 「ともはねでログイン」：ともはねが出した1分だけ・1回だけの通行証を、ともはねに確かめる。パスワードはここに置かない
// ともはねに返すものはない（お店の在庫やお客さんのことは、ともはねに送らない）
// 読み取り機（レジ・出口のゲート・棚卸し）は、店長が見られる「読み取り機の合言葉」で /api/reader に送る。外部パッケージなし
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShop, HttpError, PLACES } from './shop.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8' };
const COOKIE = 'misetomo_session';
export const TOMOHANE_URL = (process.env.TOMOHANE_URL || 'http://localhost:3000').replace(/\/+$/, '');
export const LINK_SECRET = process.env.LINK_SECRET || 'tomohane-dev-link-secret';

async function readJson(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'リクエストが大きすぎます');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON の形式が正しくありません');
  }
}
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
};
const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// MISETOMO_DATA で、記録の置き場所を変えられる（ふだんは data/。git に入らない）
export function createApp({ tomohaneUrl = TOMOHANE_URL, linkSecret = LINK_SECRET, fetchImpl = fetch, shop = createShop({ file: join(process.env.MISETOMO_DATA || join(ROOT, 'data'), 'shop.json') }) } = {}) {
  const sessions = new Map(); // トークン → スタッフの番号
  const who = (req) => {
    const id = sessions.get(readCookie(req, COOKIE));
    return shop.member(id) ? id : null;
  };

  const routes = [
    ['GET', '/api/health', () => ({ ok: true })],
    ['GET', '/api/config', () => ({ tomohaneUrl, places: PLACES })],
    ['GET', '/api/state', ({ me }) => {
      if (!me) return null;
      const m = shop.member(me);
      return m.role === 'waiting' ? { me: { name: m.name, role: 'waiting' } } : shop.overview(me);
    }],
    ['POST', '/api/import/products', ({ me, body }) => shop.importProducts(me, body.text)],
    ['POST', '/api/import/sales', ({ me, body }) => shop.importSales(me, body.text)],
    ['POST', '/api/tags', ({ me, body }) => ({ tagIds: shop.addTags(me, { ...body, count: Number(body.count) }) })],
    ['GET', '/api/tags', ({ me, url }) => ({ tagIds: shop.listTags(me, url.searchParams.get('jan'), url.searchParams.get('status') || 'stock') })],
    ['POST', '/api/discard', ({ me, body }) => ({ count: shop.discard(me, { jan: body.jan, count: Number(body.count) }) })],
    ['POST', '/api/alerts/resolve', ({ me, body }) => shop.resolveAlert(me, body.id, body.result)],
    ['POST', '/api/staff', ({ me, body }) => shop.setRole(me, body.id, body.role) ?? { ok: true }],
  ];

  const sendJson = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data));
  };

  async function callback(req, res, url) {
    const ticket = url.searchParams.get('ticket') || '';
    if (!/^[\w-]{16,64}$/.test(ticket)) throw new HttpError(400, '通行証がありません');
    let info;
    try {
      const r = await fetchImpl(`${tomohaneUrl}/api/link/misetomo-ticket/${ticket}`, { headers: { 'X-Link-Secret': linkSecret }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error();
      info = await r.json();
    } catch {
      throw new HttpError(401, '通行証を確かめられませんでした。ともはねからもう一度どうぞ');
    }
    const m = shop.login(info);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, m.id);
    res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`, Location: '/' });
    res.end();
  }

  // 店員さんのスマホへ：知らせと、画面の更新
  function events(req, res, me) {
    shop.overview(me); // スタッフか確かめる
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    const off = shop.subscribe((type, data) => {
      if (!shop.member(me)) return res.end();
      res.write(`event: ${type}\ndata: ${JSON.stringify(type === 'alert' ? { id: data.id, line: data.line, items: data.items } : {})}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { off(); clearInterval(ping); });
  }

  async function serveStatic(pathname, res) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'URL が正しくありません'); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(PUBLIC, `.${rel}`);
    if (!file.startsWith(PUBLIC + sep)) throw new HttpError(403, 'Forbidden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      throw new HttpError(404, 'Not Found');
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/auth/callback' && req.method === 'GET') return await callback(req, res, url);
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sessions.delete(readCookie(req, COOKIE));
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
      }
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && origin !== 'null') {
          let host = null;
          try { host = new URL(origin).host; } catch { /* noop */ }
          if (host !== req.headers.host) throw new HttpError(403, 'ほかのページからは操作できません');
        }
        const me = who(req);
        // 読み取り機：合言葉（本物の機械）か、スタッフのログイン（読み取り機のまね）
        if (url.pathname === '/api/reader' && req.method === 'POST') {
          const byKey = same(req.headers['x-reader-key'], shop.readerKey());
          if (!byKey) shop.overview(me); // スタッフか確かめる
          const body = await readJson(req, 64 * 1024);
          return sendJson(res, 200, shop.readerEvent(body.kind, body.tagIds));
        }
        if (url.pathname === '/api/events' && req.method === 'GET') return events(req, res, me);
        if (url.pathname === '/api/export.csv' && req.method === 'GET') {
          const csv = shop.exportStock(me);
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="zaiko.csv"', 'Cache-Control': 'no-store' });
          return res.end(csv);
        }
        const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
        if (!route) throw new HttpError(404, 'API が見つかりません');
        const body = req.method === 'POST' ? await readJson(req, url.pathname.startsWith('/api/import/') ? 2 * 1024 * 1024 : 64 * 1024) : {};
        return sendJson(res, 200, await route[2]({ me, body, url }));
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method Not Allowed');
      return await serveStatic(url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.end();
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラーが発生しました' : err.message });
    }
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3600;
  if (!process.env.LINK_SECRET) console.warn('⚠️ LINK_SECRET が未設定です（開発用の値を使います）。本番では ともはね と同じ値を設定してください');
  http.createServer(createApp()).listen(port, () => console.log(`みせとも（β版）起動: http://localhost:${port}/`));
}
