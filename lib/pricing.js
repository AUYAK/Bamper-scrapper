'use strict';
/**
 * Модель цены шины: сколько должен стоить комплект с такими параметрами.
 *
 * ─── ИДЕЯ ────────────────────────────────────────────────────────────────────
 * цена ≈ база(размер, сезон, состояние) × k_марка × k_модель × k_возраст ×
 *         k_остаток × k_продавец
 *
 * База считается ЛОКАЛЬНО (медиана в разрезе), множители — ГЛОБАЛЬНО по всей базе.
 * Это принципиально: «остаток 3 мм против 7 мм» — тысячи наблюдений, даже если
 * конкретной модели в базе два объявления. Замерено: разрезов с 8+ объявлениями
 * хватает на 61% рынка, поэтому дробить данные ещё и по году/остатку нельзя —
 * останутся разрезы по одному объявлению.
 *
 * Множители и база подгоняются поочерёдно (alternating median fit): при известной
 * базе считаем множители как медианы остатков, при известных множителях — базу.
 * Медианы, а не средние: на рынке хватает объявлений с ценой «для вида».
 *
 * ─── ЧТО ЭТО ПРЕДСКАЗЫВАЕТ ───────────────────────────────────────────────────
 * Уровень ЦЕНЫ ПРЕДЛОЖЕНИЯ, а не цены сделки. Цен сделок сайт не показывает.
 * Когда накопится история уходов, поправку «предложение -> сделка» можно будет
 * оценить по объявлениям, ушедшим быстро и без снижения цены (см. TODO.md).
 */

const NEW_TREAD_MM = { зимние: 9, всесезонные: 8.5, летние: 8 };

const MIN_CELL = 8;   // сколько объявлений нужно разрезу, чтобы верить его медиане
// Сколько нужно ушедших наблюдений, чтобы считать поправку «предложение -> сделка».
// Порог именно на данных, а не на календаре: реальный оборот рынка мы узнаем только
// из своих наблюдений, и переключение должно произойти само.
const MIN_SOLD = Number(process.env.MIN_SOLD_OBSERVATIONS || 100);
// Ушло дольше этого — скорее истёк срок или почистили кабинет, чем продали.
const SOLD_MAX_DAYS = Number(process.env.SOLD_MAX_DAYS || 30);
const MIN_MODEL = 8;  // сколько нужно модели, чтобы у неё был свой множитель
const ITERATIONS = 3; // подгонок база <-> множители

// Опорная точка: комплект с остатком 5 мм, возрастом 3 года, у частного лица.
// Именно её и печатает таблица базовых цен — то самое «базовая цена при 5 мм».
const REF = { tread: '5-6', age: '2-3', seller: 'частное лицо', city: 'Минск' };

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Остаток протектора, пригодный для модели: указанный или выведенный для новых. */
function treadEff(l) {
  if (l.tread_mm != null) return Number(l.tread_mm);
  if (l.condition === 'новые') return NEW_TREAD_MM[l.season] || 8;
  return null; // б/у без указания — «неизвестно», выдумывать нельзя
}

function treadBucket(l) {
  // У новых шин остаток равен «полный» и выводится из состояния, а состояние уже
  // входит в ключ разреза. Отдельный множитель для них дублировал бы базу — и это
  // ломало монотонность: корзина «8+» из 2 900 новых давала множитель НИЖЕ, чем «7-8».
  if (l.condition === 'новые') return null;
  const t = treadEff(l);
  if (t == null) return 'неизвестно';
  if (t < 3) return '<3';
  if (t < 4) return '3-4';
  if (t < 5) return '4-5';
  if (t < 6) return '5-6';
  if (t < 7) return '6-7';
  if (t < 8) return '7-8';
  return '8+';
}

function ageBucket(l, currentYear) {
  // Та же ловушка, что с остатком: у НОВЫХ шин возраст подразумевается состоянием,
  // и состояние уже входит в ключ разреза. А год у новых указывают лишь 6% продавцов,
  // поэтому отдельный множитель превращался в премию «за то, что год написан»:
  // «0-1 год» ×1.155 против «неизвестно» ×0.836 — разрыв 38% на пустом месте.
  // Именно это давало ложные «61% ниже рынка» на новых шинах с указанным годом.
  if (l.condition === 'новые') return null;
  if (!l.year) return 'неизвестно';
  const a = currentYear - Number(l.year);
  if (a <= 1) return '0-1';
  if (a <= 3) return '2-3';
  if (a <= 5) return '4-5';
  if (a <= 8) return '6-8';
  if (a <= 12) return '9-12';
  return '13+';
}

/**
 * Класс ширины. Нужен как ступень между «точная ширина» и «только диаметр»:
 * без него узкая 155/60 R20 сравнивалась со всеми R20, где преобладают 255-315,
 * и модель выдавала «54% ниже рынка» там, где этого нет.
 */
function widthClass(l) {
  const w = Number(l.width);
  if (!(w > 0)) return 'нет';
  if (w <= 45) return 'дюймовые'; // внедорожные 31x10.5 и подобные
  if (w <= 175) return '<=175';
  if (w <= 205) return '185-205';
  if (w <= 235) return '215-235';
  if (w <= 265) return '245-265';
  if (w <= 295) return '275-295';
  return '305+';
}

const cellKeys = (l) => [
  // лестница отступления: от точного размера к всё более широкому разрезу
  ['size', `${l.size_key}|${l.season}|${l.condition}`],
  ['width', `${l.width}|${l.diameter}|${l.season}|${l.condition}`],
  ['widthClass', `${widthClass(l)}|${l.diameter}|${l.season}|${l.condition}`],
  ['diameter', `${l.diameter}|${l.season}|${l.condition}`],
  ['season', `${l.season}|${l.condition}`],
];

const modelKey = (l) => (l.brand_slug && l.model ? `${l.brand_slug}|${String(l.model).toLowerCase()}` : null);
const sellerKey = (l) => l.seller_kind || 'неизвестно';
const cityKey = (l) => l.city || 'неизвестно';

/**
 * Медианы по группам, нормированные так, что опорная группа = 1, со сжатием
 * к единице по числу наблюдений.
 *
 * Сжатие обязательно. Без него множитель редкой группы вбирает в себя всё, что
 * модель не объяснила: «Bridgestone Turanza T005» получал ×1.80, потому что эта
 * модель встречается в основном в дорогих размерах, — и объявление выглядело
 * дешевле рынка на 64% там, где реальная скидка была 36%.
 * k_итог = 1 + (k - 1) × n / (n + K): при n >> K множитель работает в полную силу,
 * при n ~ K ослаблен вдвое, при малом n группа фактически отступает на уровень выше
 * (модель -> марка), то есть ровно то поведение, которое нам и нужно.
 */
function factorTable(rows, keyFn, residFn, refKey, shrinkK = 10) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const v = residFn(r);
    if (!(v > 0)) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const table = new Map();
  for (const [k, vs] of groups) if (vs.length >= 3) table.set(k, { k: median(vs), n: vs.length });
  const ref = table.get(refKey);
  // нормируем на опорную группу; если её нет — на медиану всех множителей
  const norm = ref ? ref.k : median([...table.values()].map((v) => v.k)) || 1;
  for (const v of table.values()) {
    const raw = v.k / norm;
    const shrunk = 1 + (raw - 1) * (v.n / (v.n + shrinkK));
    // Жёсткая рамка на всякий случай: множитель ×3 не бывает свойством шины,
    // это всегда след чего-то неучтённого.
    v.k = Math.min(2, Math.max(0.5, shrunk));
    v.raw = raw;
  }
  return table;
}

/**
 * Построить модель по объявлениям.
 * Ожидает поля: price_byn, size_key, width, diameter, season, condition,
 * brand_slug, model, year, tread_mm, seller_kind.
 */
function buildModel(listings, { currentYear = new Date().getFullYear() } = {}) {
  const rows = listings.filter((l) => l.price_byn > 0 && l.size_key && l.season && l.condition);

  // База считается по АКТИВНЫМ объявлениям: нас интересует уровень цен сегодня, а не
  // среднее по всей истории. Ушедшие при этом остаются чистой оценочной выборкой —
  // по ним калибруется поправка «предложение -> сделка» (см. soldCalibration ниже).
  // Множители оцениваются по всем строкам: они структурные, и данных для них нужно больше.
  const activeRows = rows.filter((l) => l.status === 'active');
  const baseRows = activeRows.length >= 500 ? activeRows : rows;

  // ─── база: медиана цены в разрезе, по лестнице отступления ─────────────────
  const levels = ['size', 'width', 'widthClass', 'diameter', 'season'];
  const bases = Object.fromEntries(levels.map((l) => [l, new Map()]));
  const fillBases = (priceOf) => {
    for (const lvl of levels) {
      const acc = new Map();
      for (const r of baseRows) {
        const key = cellKeys(r).find(([n]) => n === lvl)[1];
        if (!acc.has(key)) acc.set(key, []);
        acc.get(key).push(priceOf(r));
      }
      const min = lvl === 'season' ? 1 : MIN_CELL;
      const out = new Map();
      for (const [k, vs] of acc) if (vs.length >= min) out.set(k, { base: median(vs), n: vs.length });
      bases[lvl] = out;
    }
  };

  /** Найти базу для объявления: самый узкий разрез, где хватает данных. */
  const lookupBase = (l) => {
    for (const [lvl, key] of cellKeys(l)) {
      const hit = bases[lvl].get(key);
      if (hit) return { level: lvl, ...hit };
    }
    return null;
  };

  fillBases((r) => Number(r.price_byn));

  let kTread = new Map();
  let kAge = new Map();
  let kBrand = new Map();
  let kModel = new Map();
  let kSeller = new Map();
  let kCity = new Map();
  const get = (table, key) => (key == null ? 1 : table.get(key)?.k ?? 1);

  const factorsOf = (l, { skip } = {}) =>
    (skip === 'tread' ? 1 : get(kTread, treadBucket(l))) *
    (skip === 'age' ? 1 : get(kAge, ageBucket(l, currentYear))) *
    (skip === 'brand' ? 1 : get(kBrand, l.brand_slug)) *
    (skip === 'model' ? 1 : get(kModel, modelKey(l))) *
    (skip === 'seller' ? 1 : get(kSeller, sellerKey(l))) *
    (skip === 'city' ? 1 : get(kCity, cityKey(l)));

  // множители оцениваем только там, где базе можно верить (узкий разрез)
  const trusted = rows.filter((r) => {
    const b = lookupBase(r);
    return b && (b.level === 'size' || b.level === 'width');
  });

  for (let it = 0; it < ITERATIONS; it++) {
    // остаток = цена / (база × остальные множители); медиана таких остатков и есть множитель
    const resid = (skip) => (r) => Number(r.price_byn) / (lookupBase(r).base * factorsOf(r, { skip }));
    kTread = factorTable(trusted, treadBucket, resid('tread'), REF.tread, 10);
    kAge = factorTable(trusted, (r) => ageBucket(r, currentYear), resid('age'), REF.age, 10);
    kBrand = factorTable(trusted, (r) => r.brand_slug, resid('brand'), null, 15);
    kModel = factorTable(
      trusted.filter((r) => modelKey(r)),
      modelKey,
      resid('model'),
      null,
      30, // модели сжимаем сильнее всех: их сотни, наблюдений на каждую мало
    );
    for (const [k, v] of kModel) if (v.n < MIN_MODEL) kModel.delete(k);
    kSeller = factorTable(trusted, sellerKey, resid('seller'), REF.seller, 20);
    kCity = factorTable(trusted, cityKey, resid('city'), REF.city, 15);

    // база при известных множителях = медиана «цены, приведённой к опорной точке»
    fillBases((r) => Number(r.price_byn) / factorsOf(r));
  }

  /**
   * Поправка «цена предложения -> цена, по которой реально уходит».
   *
   * Берём объявления, которые исчезли и подтверждены по прямой ссылке (404), причём
   * ушли быстро: долгое висение с последующим уходом — это скорее истёкший срок или
   * чистка кабинета, а не продажа. Их последняя цена делится на оценку рынка по
   * предложению, медиана таких отношений и есть поправка.
   *
   * Пока наблюдений меньше MIN_SOLD, поправка не применяется — но считается и
   * отдаётся наружу, чтобы было видно, как она набирается.
   */
  const soldRatios = [];
  for (const r of rows) {
    if (r.status !== 'gone' || !r.gone_at || !r.first_seen) continue;
    // Только подтверждённое 404 снятие. Этим же условием отсекается 'seller_paused':
    // пауза кабинета выглядит как продажа, но продажей не является — замерено, что
    // такие уходы сдвигают медиану отношения цена/оценка с 0.81 до 1.25.
    if (r.last_reason && r.last_reason !== 'gone_confirmed') continue;
    const days = (new Date(r.gone_at) - new Date(r.first_seen)) / 86400000;
    if (days > SOLD_MAX_DAYS) continue;
    const b = lookupBase(r);
    if (!b || b.level === 'season' || b.level === 'diameter') continue;
    const marketAsk = b.base * factorsOf(r, { skip: 'seller' });
    if (marketAsk > 0) soldRatios.push(Number(r.price_byn) / marketAsk);
  }
  const soldCalibration = {
    n: soldRatios.length,
    needed: MIN_SOLD,
    k: soldRatios.length ? median(soldRatios) : null,
    applied: soldRatios.length >= MIN_SOLD,
  };

  const model = {
    currentYear,
    soldCalibration,
    bases,
    factors: { tread: kTread, age: kAge, brand: kBrand, model: kModel, seller: kSeller, city: kCity },
    stats: { rows: rows.length, trusted: trusted.length },
    lookupBase,
    factorsOf,
  };

  /**
   * Предсказать цену за 1 шт.
   * Возвращает уровень разреза и число сопоставимых — без них числу верить нельзя.
   */
  model.predict = (l) => {
    const b = lookupBase(l);
    if (!b) return null;
    const parts = {
      tread: get(kTread, treadBucket(l)),
      age: get(kAge, ageBucket(l, currentYear)),
      brand: get(kBrand, l.brand_slug),
      model: get(kModel, modelKey(l)),
      seller: get(kSeller, sellerKey(l)),
      city: get(kCity, cityKey(l)),
    };
    // Две разные величины, и путать их нельзя:
    //   price  — сколько ЗАПРОСЯТ за такой комплект у такого продавца в таком городе.
    //            Множители продавца и города здесь нужны: они реально объясняют цену
    //            (магазин просит на треть больше частника) и улучшают точность.
    //   market — сколько комплект стоит НА РЫНКЕ, приведённо к частнику в Минске.
    //            Для перекупа это и есть ориентир: продавать вы будете по рынку, а не
    //            по прайсу магазина, у которого покупаете. Сравнивать цену объявления
    //            надо именно с market, иначе любое объявление магазина выглядит
    //            «дорогим», а любое частное — «дешёвым» просто из-за типа продавца.
    const market = b.base * parts.tread * parts.age * parts.brand * parts.model;
    const price = market * parts.seller * parts.city;
    // Ожидаемая цена сделки: рынок предложения, умноженный на поправку по ушедшим.
    // Пока наблюдений мало — null, и это честнее любой цифры.
    const expectedSale = soldCalibration.applied
      ? Math.round(market * soldCalibration.k * 100) / 100
      : null;
    return {
      price: Math.round(price * 100) / 100,
      market: Math.round(market * 100) / 100,
      expectedSale,
      base: Math.round(b.base * 100) / 100,
      level: b.level,
      comparables: b.n,
      // Ненадёжны уровни, где ширина потеряна: «только диаметр» смешивает 155-ю
      // с 315-й (замерено 28% ошибки против 20% на размере), а «только сезон» дал
      // 124%. Такие прогнозы нельзя показывать как цену — только как «данных мало».
      reliable: b.level === 'size' || b.level === 'width' || b.level === 'widthClass',
      factors: parts,
      treadUsed: treadEff(l),
      treadKnown: treadEff(l) != null,
    };
  };

  return model;
}

module.exports = { buildModel, treadEff, treadBucket, ageBucket, widthClass, median, NEW_TREAD_MM, REF, MIN_CELL, MIN_SOLD, SOLD_MAX_DAYS };
