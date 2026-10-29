'use strict';
/**
 * Словарь марок шин. Полный список (429 шт.) выгружен с самого bamper.by
 * (select#marka на странице поиска) в data/brands.json — там пары slug/name,
 * ровно те slug'и, которые сайт понимает в URL: /shiny/marka_<slug>/kolvo_4/
 *
 * Тир — наша классификация сегмента, нужна для аналитики (цена сильно зависит
 * от сегмента) и для выбора того, что вообще краулить.
 *   A — премиум
 *   B — верхний middle (часто «вторые бренды» премиум-концернов)
 *   C — всё остальное (бюджет/китай/неизвестное) — по умолчанию не краулим
 */

const DICT = require('../data/brands.json');

/** A — премиум. */
const TIER_A = [
  'michelin',
  'continental',
  'bridgestone',
  'pirelli',
  'goodyear',
  'dunlop',
  'nokian',
  'yokohama',
  'toyo',
  'hankook',
  'vredestein',
  'falken',
];

/** B — верхний middle: вторые бренды концернов и крепкий средний класс. */
const TIER_B = [
  'bfgoodrich',
  'kumho',
  'nexen',
  'kleber',
  'fulda',
  'gislaved',
  'uniroyal',
  'firestone',
  'semperit',
  'general',
  'general-grabber',
  'nitto',
  'cooper',
  'marshal',
  'barum',
  'matador',
  'sava',
  'maxxis',
  'gt-radial',
  'ikon-tyres',
];

const TIER_BY_SLUG = new Map();
for (const s of TIER_A) TIER_BY_SLUG.set(s, 'A');
for (const s of TIER_B) TIER_BY_SLUG.set(s, 'B');

const BY_SLUG = new Map(DICT.map((b) => [b.slug, b]));

// для распознавания марки в заголовке: сначала длинные названия («General Grabber»
// должен победить «General», «GT Radial» — «GT»)
const BY_NAME = [...DICT]
  .sort((a, b) => b.name.length - a.name.length)
  .map((b) => ({ ...b, lc: b.name.toLowerCase() }));

function tierOf(slug) {
  return TIER_BY_SLUG.get(slug) || 'C';
}

function brandBySlug(slug) {
  return BY_SLUG.get(slug) || null;
}

/** Найти марку в начале строки заголовка. Возвращает {slug, name, rest}. */
function detectBrand(text) {
  if (!text) return null;
  const lc = text.toLowerCase().trim();
  for (const b of BY_NAME) {
    if (lc === b.lc || lc.startsWith(b.lc + ' ')) {
      return { slug: b.slug, name: b.name, rest: text.trim().slice(b.name.length).trim() };
    }
  }
  return null;
}

/** Слаги марок, которые нужно краулить, по списку тиров из конфига. */
function slugsForTiers(tiers) {
  const set = new Set(tiers);
  return DICT.map((b) => b.slug).filter((s) => set.has(tierOf(s)));
}

module.exports = { DICT, TIER_A, TIER_B, tierOf, brandBySlug, detectBrand, slugsForTiers };
