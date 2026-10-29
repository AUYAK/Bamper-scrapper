'use strict';
/**
 * Подмена store.js для прогона без Postgres (`node scrape.js full --dry-run`).
 * Тот же API, но «база» живёт в памяти, а записи дублируются в data/dry-run/*.jsonl.
 * Нужен, чтобы проверять краул и парсинг там, где до базы нет сети, и чтобы
 * гонять полные проходы, не засоряя рабочую базу.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'dry-run');
fs.mkdirSync(DIR, { recursive: true });

const listings = new Map(); // base_external_id -> строка (текущая ревизия)
const sellers = new Map();
let nextId = 1;

const streams = {};
function write(file, obj) {
  if (!streams[file]) streams[file] = fs.createWriteStream(path.join(DIR, file + '.jsonl'), { flags: 'a' });
  streams[file].write(JSON.stringify(obj) + '\n');
}

const sizeKey = (item) =>
  item.width && item.diameter
    ? `${item.width}${item.profile ? '/' + item.profile : ''}${item.diameter}${item.is_c ? 'C' : ''}`
    : null;

const toDate = (v) => (v ? (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10)) : null);

// те же правила, что в store.js
const TRACKED = ['price_byn', 'price_set_byn', 'title', 'description', 'city', 'year', 'tread_mm', 'model', 'season', 'condition'];
const IDENTITY = ['brand_slug', 'size_key', 'qty'];
const NULL_IS_MEANINGFUL = new Set(['price_byn', 'price_set_byn', 'price_usd']);
const NUMERIC_FIELDS = new Set(['price_byn', 'price_set_byn', 'price_usd', 'tread_mm']);
// см. комментарий в store.js: курсовой пересчёт двигает рублёвую цену на десятые
// доли процента, и без порога это давало 900+ фальшивых изменений в сутки
const PRICE_FIELDS = new Set(['price_byn', 'price_set_byn']);
const PRICE_MIN_REL = Number(process.env.PRICE_MIN_REL_CHANGE || 0.01);
const priceMeaningful = (a, b) => {
  if (a == null || b == null) return (a ?? null) !== (b ?? null);
  const o = Number(a);
  if (!(o > 0)) return Number(b) !== o;
  return Math.abs(Number(b) / o - 1) >= PRICE_MIN_REL;
};

function diffFields(existing, item, fields) {
  const changed = [];
  for (const f of fields) {
    const a = existing[f];
    const b = item[f] === undefined ? null : item[f];
    if (b == null && !NULL_IS_MEANINGFUL.has(f)) continue;
    const same = PRICE_FIELDS.has(f)
      ? !priceMeaningful(a, b)
      : NUMERIC_FIELDS.has(f)
        ? (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005)
        : (a ?? null) === (b ?? null);
    if (!same) changed.push(f);
  }
  return changed;
}

async function upsertSeller(seller) {
  if (!seller || !seller.seller_id) return null;
  const prev = sellers.get(seller.seller_id) || {};
  const merged = { ...prev, ...Object.fromEntries(Object.entries(seller).filter(([, v]) => v != null)) };
  sellers.set(seller.seller_id, merged);
  write('sellers', merged);
  return seller.seller_id;
}

const upsertSellerFromCard = (item) =>
  item.seller_id
    ? upsertSeller({ seller_id: item.seller_id, rank: item.seller_rank, rank_title: item.seller_rank_title })
    : Promise.resolve(null);

async function getListing(baseExternalId) {
  const row = listings.get(baseExternalId);
  return row && row.status !== 'replaced' ? row : null;
}

async function insertEvent(listingId, reason) {
  const row = [...listings.values()].find((l) => l.id === listingId);
  if (!row) return;
  write('events', {
    listing_id: listingId,
    scraped_at: new Date().toISOString(),
    reason,
    status: row.status,
    price_byn: row.price_byn,
    price_set_byn: row.price_set_byn,
    price_usd: row.price_usd,
    year: row.year,
    tread_mm: row.tread_mm,
    title: row.title,
    city: row.city,
  });
}

async function insertListing(item, brandTier, { revision = 1, replacedFrom = null } = {}) {
  const base = item.external_id;
  const row = {
    id: nextId++,
    external_id: revision === 1 ? base : `${base}#${revision}`,
    base_external_id: base,
    revision,
    replaced_from: replacedFrom,
    ...item,
    brand_tier: brandTier,
    size_key: sizeKey(item),
    posted_date: toDate(item.posted_date),
    status: 'active',
    bump_count: 0,
    first_seen: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  };
  delete row.photos;
  listings.set(base, row);
  write('listings', row);
  await insertEvent(row.id, 'new');
  return { listing: row, inserted: true };
}

async function touch(listingId) {
  const row = [...listings.values()].find((l) => l.id === listingId);
  if (row) row.last_checked_at = new Date().toISOString();
}

async function replaceProduct(existing, item, brandTier) {
  existing.status = 'replaced';
  await insertEvent(existing.id, 'product_replaced');
  const { listing } = await insertListing(item, brandTier, {
    revision: existing.revision + 1,
    replacedFrom: existing.id,
  });
  return listing;
}

async function applyUpdate(existing, item, brandTier) {
  const observed = { ...item, size_key: sizeKey(item) };
  const identityChanged = diffFields(existing, observed, IDENTITY);
  if (identityChanged.length) {
    const listing = await replaceProduct(existing, item, brandTier);
    return { changedFields: identityChanged, priceChanged: false, bumped: false, revived: false, replaced: true, listing };
  }

  const changed = diffFields(existing, observed, TRACKED);
  const priceChanged = changed.includes('price_byn');
  const revived = existing.status !== 'active';
  if (!changed.length && !revived) {
    await touch(existing.id);
    return { changedFields: [], priceChanged: false, bumped: false, revived: false, replaced: false };
  }

  for (const f of TRACKED) {
    const v = item[f];
    if (v != null || NULL_IS_MEANINGFUL.has(f)) existing[f] = v ?? null;
  }
  existing.status = 'active';
  existing.last_checked_at = new Date().toISOString();
  existing.last_changed_at = existing.last_checked_at;
  await insertEvent(existing.id, revived ? 'back_in_search' : 'changed');
  return { changedFields: changed, priceChanged, bumped: false, revived, replaced: false };
}

async function applyDetail(listingId, detail) {
  await upsertSeller(detail.seller);
  const row = [...listings.values()].find((l) => l.id === listingId);
  if (!row) return { changedFields: [] };
  const changed = diffFields(row, detail, ['year', 'tread_mm', 'season', 'condition']);
  for (const f of ['year', 'tread_mm', 'tread_raw', 'season', 'condition', 'vehicle_type']) {
    if (row[f] == null && detail[f] != null) row[f] = detail[f];
  }
  for (const f of changed) row[f] = detail[f];
  row.detail_fetched_at = new Date().toISOString();
  write('details', { listing_id: listingId, seller: detail.seller, changed });
  if (changed.length) await insertEvent(listingId, 'changed');
  return { changedFields: changed };
}

async function markGoneExcept() {
  return { gone: 0, paused: 0, pausedSellers: [] }; // в dry-run прошлых прогонов нет
}

async function confirmGone(listingId) {
  await insertEvent(listingId, 'gone_confirmed');
}

async function reviveFromCheck(listingId) {
  await insertEvent(listingId, 'alive_on_page');
}

async function closeAbandonedRuns() {
  return 0;
}

async function startRun(mode, note) {
  write('runs', { mode, note, started_at: new Date().toISOString() });
  return 0;
}

async function finishRun(runId, stats) {
  write('runs', { finished_at: new Date().toISOString(), ...stats });
}

async function listingsNeedingDetail(_slugs, _days, limit) {
  return [...listings.values()]
    .filter((l) => l.status === 'active')
    .slice(0, limit)
    .map((l) => ({ id: l.id, external_id: l.external_id, url: l.url }));
}

async function getPriceHistory() {
  return [];
}

async function close() {
  for (const s of Object.values(streams)) s.end();
  console.log(`[dry-run] объявлений в памяти: ${listings.size}, продавцов: ${sellers.size}, файлы в ${DIR}`);
}

module.exports = {
  pool: null, q: async () => ({ rows: [] }), sizeKey, toDate,
  upsertSeller, upsertSellerFromCard,
  getListing, insertListing, insertEvent, touch, applyUpdate, applyDetail,
  replaceProduct, markGoneExcept, confirmGone, reviveFromCheck,
  startRun, finishRun, closeAbandonedRuns, listingsNeedingDetail, getPriceHistory, close,
  TRACKED, IDENTITY,
};
