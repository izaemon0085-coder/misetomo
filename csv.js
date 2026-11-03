// CSV（表のファイル）の読み書き。どこのレジでも出せる形なので、まずはこれでつなぐ
// ・"…" でかこんだ中のカンマや改行、"" も読める
// ・先頭の BOM はとる（Excel で保存した表によく付いている）
// ・書き出すとき、= + - @ で始まる中身は先頭に ' を付けて、表計算ソフトで式として動かないようにする

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// 1行目の見出しから、列をさがす（レジの会社ごとに言い方がちがうので、いくつかの言い方を受けつける）
export function findColumns(header, wanted) {
  const norm = (x) => String(x).trim().replace(/[\s　]/g, '').toLowerCase();
  const h = header.map(norm);
  const found = {};
  for (const [key, names] of Object.entries(wanted)) {
    const i = h.findIndex((x) => names.some((n) => x === norm(n)));
    found[key] = i;
  }
  return found;
}

const safe = (v) => {
  let x = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(x)) x = `'${x}`;
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
};
export const toCsv = (rows) => `﻿${rows.map((r) => r.map(safe).join(',')).join('\r\n')}\r\n`;
