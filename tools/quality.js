'use strict';
/**
 * Качество разбора по результатам dry-run: насколько заполнены поля и как
 * распределены значения. Запуск после `node scrape.js full --dry-run`:
 *
 *   node tools/quality.js [data/dry-run/listings.jsonl]
 *
 * Для той же проверки по живой базе есть queries/quality.sql.
 */

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'data', 'dry-run', 'listings.jsonl');
if (!fs.existsSync(file)) {
  console.error(`нет файла ${file} — сначала прогоните краул с --dry-run`);
  process.exit(1);
}

const rows = fs
  .readFileSync(file, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.log(`объявлений: ${rows.length}`);
const uniq = new Set(rows.map((r) => r.external_id));
console.log(`уникальных external_id: ${uniq.size}${uniq.size === rows.length ? '' : '  <-- ЕСТЬ ДУБЛИ'}`);

const FIELDS = [
  'external_id', 'title', 'url', 'seller_id', 'seller_article',
  'brand', 'model', 'width', 'profile', 'diameter', 'size_key', 'qty',
  'season', 'vehicle_type', 'condition', 'year', 'tread_mm',
  'city', 'posted_date', 'price_byn', 'price_set_byn', 'price_usd',
  'photo_count', 'delivery', 'seller_rank',
];

console.log('\nзаполненность полей:');
for (const f of FIELDS) {
  const filled = rows.filter((r) => r[f] != null && r[f] !== '').length;
  const pct = ((filled / rows.length) * 100).toFixed(1);
  const bar = '█'.repeat(Math.round(filled / rows.length * 30)).padEnd(30, '·');
  console.log(`  ${f.padEnd(15)} ${bar} ${String(pct).padStart(5)}%  (${filled})`);
}

const dist = (f, limit = 12) => {
  const m = {};
  for (const r of rows) {
    const k = r[f] == null ? '(нет)' : String(r[f]);
    m[k] = (m[k] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, limit);
};

for (const f of ['brand', 'season', 'condition', 'vehicle_type', 'diameter', 'city', 'year']) {
  console.log(`\n${f}:`);
  for (const [k, n] of dist(f)) console.log(`  ${String(k).padEnd(18)} ${n}`);
}

const prices = rows.map((r) => r.price_byn).filter((p) => p != null).sort((a, b) => a - b);
if (prices.length) {
  const p = (q) => prices[Math.floor(prices.length * q)];
  console.log(
    `\nцена за 1 шт., руб.: min ${prices[0]}, p25 ${p(0.25)}, медиана ${p(0.5)}, p75 ${p(0.75)}, max ${prices[prices.length - 1]}`,
  );
  console.log(`без цены: ${rows.length - prices.length}`);
}

// сходится ли цена комплекта с ценой за штуку (проверка разбора цен)
const bad = rows.filter(
  (r) => r.price_byn && r.price_set_byn && r.qty && Math.abs(r.price_byn * r.qty - r.price_set_byn) > 1,
);
console.log(`\nцена комплекта != цена x количество: ${bad.length}`);
for (const r of bad.slice(0, 5)) {
  console.log(`  ${r.external_id}: ${r.price_byn} x ${r.qty} != ${r.price_set_byn}  ${r.title}`);
}
