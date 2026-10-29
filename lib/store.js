'use strict';
/**
 * Доступ к Postgres, схема scrapper.
 *
 * Модель: listings — текущее состояние (одна строка на объявление), listing_events —
 * строка на каждое изменение. Проверка без изменений строки не создаёт, обновляется
 * только last_checked_at.
 *
 * Событие всегда пишется ПОСЛЕ обновления listings и копирует значения оттуда
 * (INSERT ... SELECT). Так срез в истории гарантированно совпадает с тем, что
 * лежит в listings, и разъехаться они не могут.
 */

const { Pool } = require('pg');
const config = require('../config');

const S = config.db.schema;

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.max,
  idle_in_transaction_session_timeout: 30000,
});

// Без этого обработчика ошибка на простаивающем соединении (ECONNRESET на сервере
// бывает регулярно) валит весь процесс, и pm2 уходит в краш-луп — так уже было в
// проекте Listings. Обработчик обязателен, а не «на будущее».
pool.on('error', (err) => {
  console.error('[db] ошибка простаивающего соединения:', err.message);
});

const q = (text, params) => pool.query(text, params);

/**
 * Поля, изменение которых считаем изменением объявления (пишем событие).
 *
 * price_usd сюда НЕ входит намеренно: сайт пересчитывает его по курсу НБРБ, и он
 * меняется сам собой при движении рубля. В событиях он хранится, но события собой
 * не вызывает — иначе история заполнится движениями курса, а не действиями продавца.
 */
const TRACKED = [
  'price_byn', 'price_set_byn',
  'title', 'description', 'city',
  'year', 'tread_mm', 'model', 'season', 'condition',
];

/**
 * Смена любого из этих полей — не правка, а другой товар: продавец переписал
 * объявление под другие шины. Истории цен склеивать нельзя.
 */
const IDENTITY = ['brand_slug', 'size_key', 'qty'];

/**
 * Поля, для которых NULL из источника означает «стало пусто», а не «не знаем».
 * Цена всегда есть в выдаче, и «цена не указана» — реальное состояние.
 * Для остальных полей NULL значит, что источник их просто не показал (год есть не
 * в каждом заголовке, остаток протектора — не в каждом описании), поэтому такие
 * NULL не перезаписывают уже известное значение и не считаются изменением.
 */
const NULL_IS_MEANINGFUL = new Set(['price_byn', 'price_set_byn', 'price_usd']);

const NUMERIC_FIELDS = new Set(['price_byn', 'price_set_byn', 'price_usd', 'tread_mm', 'width', 'profile']);
const PRICE_FIELDS = new Set(['price_byn', 'price_set_byn']);

/**
 * Минимальное относительное изменение цены, которое считаем действием продавца.
 *
 * Зачем: магазины держат цены в долларах, а сайт показывает их в рублях по курсу
 * НБРБ. Курс шевельнулся — и цены пересчитались сами. Замерено на живых данных:
 * за один ночной проход 864 объявления «подешевели» на 1-3 рубля (784 -> 781,
 * 243 -> 242) при неизменной цене в долларах (275 -> 275, 80 -> 80).
 *
 * Без порога это давало 900+ фальшивых изменений цены в сутки: мусор в истории,
 * ложные кандидаты на уведомления и испорченный признак «ушло без снижения цены».
 * Реальные скидки продавцов — это 5% и больше, поэтому 1% отсекает курс, не задевая
 * настоящие изменения.
 */
const PRICE_MIN_REL = Number(process.env.PRICE_MIN_REL_CHANGE || 0.01);

const priceMeaningful = (oldV, newV) => {
  if (oldV == null || newV == null) return (oldV ?? null) !== (newV ?? null);
  const o = Number(oldV);
  const n = Number(newV);
  if (!(o > 0)) return n !== o;
  return Math.abs(n / o - 1) >= PRICE_MIN_REL;
};

const numEq = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
};

/**
 * Дата -> 'YYYY-MM-DD'. Передавать Date в колонку DATE нельзя: драйвер отправит
 * timestamptz (UTC-полночь), и при таймзоне сервера западнее UTC дата съедет на день.
 */
const toDate = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
};

const sizeKey = (item) =>
  item.width && item.diameter
    ? `${item.width}${item.profile ? '/' + item.profile : ''}${item.diameter}${item.is_c ? 'C' : ''}`
    : null;

// ─── продавцы ────────────────────────────────────────────────────────────────

async function upsertSeller(seller) {
  if (!seller || !seller.seller_id) return null;
  const { rows } = await q(
    `INSERT INTO ${S}.sellers (seller_id, name, kind, city, on_site_since, rank, rank_title, phone, email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (seller_id) DO UPDATE SET
       name          = COALESCE(EXCLUDED.name, ${S}.sellers.name),
       kind          = COALESCE(EXCLUDED.kind, ${S}.sellers.kind),
       city          = COALESCE(EXCLUDED.city, ${S}.sellers.city),
       on_site_since = COALESCE(EXCLUDED.on_site_since, ${S}.sellers.on_site_since),
       rank          = COALESCE(EXCLUDED.rank, ${S}.sellers.rank),
       rank_title    = COALESCE(EXCLUDED.rank_title, ${S}.sellers.rank_title),
       phone         = COALESCE(EXCLUDED.phone, ${S}.sellers.phone),
       email         = COALESCE(EXCLUDED.email, ${S}.sellers.email),
       last_seen     = now()
     RETURNING seller_id`,
    [
      seller.seller_id, seller.name || null, seller.kind || null, seller.city || null,
      toDate(seller.on_site_since), seller.rank || null, seller.rank_title || null,
      seller.phone || null, seller.email || null,
    ],
  );
  return rows[0].seller_id;
}

/** Продавец из карточки выдачи: id и звание есть прямо там. */
const upsertSellerFromCard = (item) =>
  item.seller_id
    ? upsertSeller({ seller_id: item.seller_id, rank: item.seller_rank, rank_title: item.seller_rank_title })
    : Promise.resolve(null);

// ─── объявления ──────────────────────────────────────────────────────────────

/** Текущая (не подменённая) строка по паре продавец+артикул. */
async function getListing(baseExternalId) {
  const { rows } = await q(
    `SELECT * FROM ${S}.listings
      WHERE base_external_id = $1 AND status <> 'replaced'
      ORDER BY revision DESC LIMIT 1`,
    [baseExternalId],
  );
  return rows[0] || null;
}

/**
 * Записать событие. Значения копируются из listings, поэтому вызывать строго
 * ПОСЛЕ обновления самой строки.
 */
async function insertEvent(listingId, reason) {
  await q(
    `INSERT INTO ${S}.listing_events
       (listing_id, reason, status, price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city)
     SELECT id, $2, status, price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city
       FROM ${S}.listings WHERE id = $1`,
    [listingId, reason],
  );
}

async function insertListing(item, brandTier, { revision = 1, replacedFrom = null } = {}) {
  const base = item.external_id;
  const externalId = revision === 1 ? base : `${base}#${revision}`;
  const { rows } = await q(
    `INSERT INTO ${S}.listings
      (external_id, base_external_id, revision, replaced_from, seller_id, seller_article, url,
       title, description, brand, brand_slug, brand_tier, model,
       width, profile, diameter, is_c, size_key, qty, season, vehicle_type, condition, year,
       tread_mm, tread_raw, city, photo_count, delivery,
       price_byn, price_set_byn, price_usd, posted_date, status, last_changed_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
             $24,$25,$26,$27,$28,$29,$30,$31,$32,'active',now(),$33)
     ON CONFLICT (external_id) DO NOTHING
     RETURNING *`,
    [
      externalId, base, revision, replacedFrom, item.seller_id || null, item.seller_article || null, item.url,
      item.title, item.description, item.brand, item.brand_slug, brandTier, item.model,
      item.width, item.profile, item.diameter, item.is_c, sizeKey(item), item.qty,
      item.season, item.vehicle_type, item.condition, item.year,
      item.tread_mm, item.tread_raw, item.city, item.photo_count, item.delivery,
      item.price_byn, item.price_set_byn, item.price_usd, toDate(item.posted_date),
      JSON.stringify({
        photos: item.photos || [],
        seller_rank_title: item.seller_rank_title || null,
        seller_rating_pct: item.seller_rating_pct ?? null,
      }),
    ],
  );
  const listing = rows[0] || (await getListing(base));
  if (rows[0]) await insertEvent(listing.id, 'new');
  return { listing, inserted: Boolean(rows[0]) };
}

/** Объявление встретилось, но ничего не изменилось: только отметка о проверке. */
async function touch(listingId) {
  await q(`UPDATE ${S}.listings SET last_checked_at = now() WHERE id = $1`, [listingId]);
}

/** Сравнить наблюдение с сохранённым состоянием. */
function diffFields(existing, item, fields) {
  const changed = [];
  for (const f of fields) {
    const oldV = existing[f];
    const newV = item[f] === undefined ? null : item[f];
    // NULL из источника для большинства полей = «источник не показал», не изменение
    if (newV == null && !NULL_IS_MEANINGFUL.has(f)) continue;
    const same = PRICE_FIELDS.has(f)
      ? !priceMeaningful(oldV, newV)
      : NUMERIC_FIELDS.has(f)
        ? numEq(oldV, newV)
        : (oldV ?? null) === (newV ?? null);
    if (!same) changed.push(f);
  }
  return changed;
}

/**
 * Продавец переписал объявление под другой товар: закрываем строку и заводим
 * следующую ревизию со своей историей цен.
 */
async function replaceProduct(existing, item, brandTier) {
  await q(
    `UPDATE ${S}.listings SET status = 'replaced', gone_at = now(), last_checked_at = now(),
                              last_changed_at = now()
      WHERE id = $1`,
    [existing.id],
  );
  await insertEvent(existing.id, 'product_replaced');
  const { listing } = await insertListing(item, brandTier, {
    revision: existing.revision + 1,
    replacedFrom: existing.id,
  });
  return listing;
}

/**
 * Обновить объявление данными из выдачи.
 * Возвращает { changedFields, priceChanged, bumped, revived, replaced }.
 */
async function applyUpdate(existing, item, brandTier) {
  // size_key в наблюдении не приходит готовым, его надо посчитать — иначе подмена
  // товара по размеру не задетектится (сравнение с null всегда пропускается)
  const observed = { ...item, size_key: sizeKey(item) };
  const identityChanged = diffFields(existing, observed, IDENTITY);
  if (identityChanged.length) {
    const listing = await replaceProduct(existing, item, brandTier);
    return { changedFields: identityChanged, priceChanged: false, bumped: false, revived: false, replaced: true, listing };
  }

  const changed = diffFields(existing, observed, TRACKED);
  const priceChanged = changed.includes('price_byn');
  const oldPosted = existing.posted_date ? new Date(existing.posted_date) : null;
  const newPosted = item.posted_date ? new Date(item.posted_date) : null;
  const bumped = Boolean(oldPosted && newPosted && newPosted.getTime() > oldPosted.getTime());
  const revived = existing.status !== 'active';

  if (!changed.length && !bumped && !revived) {
    await touch(existing.id);
    return { changedFields: [], priceChanged: false, bumped: false, revived: false, replaced: false };
  }

  // Если сдвиг цены ниже порога (курсовой пересчёт), НЕ обновляем и саму цену:
  // иначе дрейф по рублю накапливался бы молча, без единого события в истории.
  const writePrice = changed.includes('price_byn') || changed.includes('price_set_byn');
  const priceByn = writePrice ? item.price_byn : existing.price_byn;
  const priceSet = writePrice ? item.price_set_byn : existing.price_set_byn;
  const priceUsd = writePrice ? item.price_usd : existing.price_usd;

  // COALESCE только там, где NULL означает «источник не показал»
  await q(
    `UPDATE ${S}.listings SET
       url = $2, title = COALESCE($3, title), description = COALESCE($4, description),
       city = COALESCE($5, city),
       price_byn = $6, price_set_byn = $7, price_usd = $8,
       year = COALESCE($9, year), tread_mm = COALESCE($10, tread_mm),
       tread_raw = COALESCE($11, tread_raw), model = COALESCE($12, model),
       season = COALESCE($13, season), condition = COALESCE($14, condition),
       vehicle_type = COALESCE($15, vehicle_type),
       photo_count = COALESCE($16, photo_count), delivery = COALESCE($17, delivery),
       seller_id = COALESCE(seller_id, $18), seller_article = COALESCE($19, seller_article),
       posted_date = GREATEST(posted_date, $20::date),
       bump_count = bump_count + $21,
       last_bumped_at = CASE WHEN $21 = 1 THEN now() ELSE last_bumped_at END,
       status = 'active', gone_at = NULL,
       last_checked_at = now(),
       last_changed_at = CASE WHEN $22 THEN now() ELSE last_changed_at END
     WHERE id = $1`,
    [
      existing.id, item.url, item.title, item.description, item.city,
      priceByn, priceSet, priceUsd,
      item.year, item.tread_mm, item.tread_raw, item.model,
      item.season, item.condition, item.vehicle_type,
      item.photo_count, item.delivery,
      item.seller_id || null, item.seller_article || null,
      toDate(item.posted_date), bumped ? 1 : 0,
      changed.length > 0,
    ],
  );

  // Поднятие объявления само по себе события не создаёт: продавцы поднимают
  // почти ежедневно, история заполнилась бы мусором. Считаем агрегатом выше.
  if (changed.length || revived) {
    await insertEvent(existing.id, revived ? 'back_in_search' : 'changed');
  }

  return { changedFields: changed, priceChanged, bumped, revived, replaced: false };
}

/** Данные со страницы объявления: продавец и поля, которых нет в выдаче. */
async function applyDetail(listingId, detail) {
  const sellerId = await upsertSeller(detail.seller);
  const { rows } = await q(`SELECT * FROM ${S}.listings WHERE id = $1`, [listingId]);
  const existing = rows[0];
  if (!existing) return { changedFields: [] };

  // description сознательно не сверяем: выдача и страница объявления могут отдавать
  // его с разными пробелами, и взаимная перезапись плодила бы ложные изменения.
  // Со страницы им только заполняем пустое поле.
  const changed = diffFields(existing, detail, ['year', 'tread_mm', 'season', 'condition']);

  await q(
    `UPDATE ${S}.listings SET
       seller_id    = COALESCE($2, seller_id),
       description  = COALESCE(description, $3),
       year         = COALESCE($4, year),
       season       = COALESCE($5, season),
       condition    = COALESCE($6, condition),
       vehicle_type = COALESCE($7, vehicle_type),
       tread_mm     = COALESCE($8, tread_mm),
       tread_raw    = COALESCE($9, tread_raw),
       photo_count  = GREATEST(COALESCE(photo_count, 0), $10),
       detail_fetched_at = now(),
       last_checked_at   = now(),
       last_changed_at   = CASE WHEN $11 THEN now() ELSE last_changed_at END
     WHERE id = $1`,
    [
      listingId, sellerId, detail.description, detail.year, detail.season,
      detail.condition, detail.vehicle_type, detail.tread_mm, detail.tread_raw,
      detail.photo_count || 0, changed.length > 0,
    ],
  );

  if (changed.length) await insertEvent(listingId, 'changed');
  return { changedFields: changed };
}

/**
 * Пометить ушедшими активные объявления, не встреченные в свежем полном проходе.
 * Ограничиваем разрезом реально пройденных марок, иначе полный проход по премиуму
 * «похоронит» всё остальное.
 */
/**
 * Признак паузы кабинета — АБСОЛЮТНОЕ число ушедших разом, а не доля.
 *
 * Доля оказалась негодной: замерено, что у магазина 283219 пакетное снятие дало
 * 72 объявления из 658 (11%), у 104809 — 16 из 2067 (1%). Условие «не меньше
 * половины его объявлений» не срабатывало никогда, и десятки пакетных снятий шли
 * в статистику как продажи.
 *
 * Абсолютное число разделяет чисто: 29 продавцов потеряли ровно по 1 объявлению
 * (обычные продажи), дальше провал — и сразу 3, 11, 16, 72.
 *
 * Доля осталась вторым условием: она нужна для мелких продавцов, у которых кабинет
 * исчез целиком (3 объявления из 3).
 */
/**
 * Максимальная доля активных объявлений, которую полному проходу позволено пометить
 * ушедшими за один раз. Выше — считаем, что обход неполный, и не помечаем ничего.
 */
const GONE_MAX_SHARE = Number(process.env.GONE_MAX_SHARE || 0.15);

const PAUSE_MIN_COUNT = Number(process.env.SELLER_PAUSE_MIN_COUNT || 5);
const PAUSE_SMALL_COUNT = Number(process.env.SELLER_PAUSE_SMALL_COUNT || 3);
const PAUSE_MIN_SHARE = Number(process.env.SELLER_PAUSE_MIN_SHARE || 0.5);

async function markGoneExcept(seenExternalIds, brandSlugs, runStartedAt) {
  // Сначала СМОТРИМ, кто уходит, и только потом решаем причину: пропало по одному
  // (похоже на продажу) или у продавца исчез весь кабинет (пауза либо неоплата).
  // Замерено, что без этого различения 13 «продаж» приостановленного магазина
  // задирали калибровку цен сделок с 0.81 до 1.06 — то есть на треть.
  const { rows: candidates } = await q(
    `SELECT id, seller_id FROM ${S}.listings
      WHERE status = 'active'
        AND brand_slug = ANY($1::text[])
        AND last_checked_at < $2
        AND NOT (external_id = ANY($3::text[]))`,
    [brandSlugs, runStartedAt, seenExternalIds],
  );
  if (!candidates.length) return { gone: 0, paused: 0, pausedSellers: [] };

  /**
   * Предохранитель от массового ложного ухода. Рынок не теряет пятую часть
   * предложения за ночь — если проход собирается похоронить такую долю, это почти
   * наверняка обрезанная выдача на нашей стороне.
   *
   * Замерено: полный проход 21.08 увидел 4 933 объявления вместо обычных 6 230 и
   * пометил ушедшими 1 319. Назавтра 1 282 из них вернулись в выдачу, 1 201 активны
   * до сих пор — то есть 97% того «ухода» было нашим сбоем. Разделы при этом
   * завершились штатно (ссылка «След.» просто кончилась раньше), так что признак
   * «дошли до конца» такое не ловит, нужен именно порог на масштаб.
   */
  const { rows: [act] } = await q(
    `SELECT count(*)::int AS n FROM ${S}.listings
      WHERE status = 'active' AND brand_slug = ANY($1::text[])`,
    [brandSlugs],
  );
  const activeN = act ? act.n : 0;
  if (activeN && candidates.length > activeN * GONE_MAX_SHARE) {
    const pct = ((candidates.length / activeN) * 100).toFixed(1);
    return {
      gone: 0,
      paused: 0,
      pausedSellers: [],
      refused: { candidates: candidates.length, active: activeN, pct },
    };
  }

  // сколько объявлений продавца мы вообще видели: доля важна не меньше числа,
  // одна продажа из трёхсот — не пауза, пятнадцать из восемнадцати — пауза
  const sellerIds = [...new Set(candidates.map((c) => c.seller_id).filter(Boolean).map(String))];
  const { rows: totals } = sellerIds.length
    ? await q(
        `SELECT seller_id, count(*) AS n FROM ${S}.listings
          WHERE seller_id = ANY($1::bigint[]) GROUP BY seller_id`,
        [sellerIds],
      )
    : { rows: [] };

  const totalBySeller = new Map(totals.map((r) => [String(r.seller_id), Number(r.n)]));
  const goneBySeller = new Map();
  for (const c of candidates) {
    if (!c.seller_id) continue;
    const k = String(c.seller_id);
    goneBySeller.set(k, (goneBySeller.get(k) || 0) + 1);
  }

  const pausedSellers = new Set();
  for (const [seller, goneN] of goneBySeller) {
    const totalN = totalBySeller.get(seller) || goneN;
    // либо пакет (много разом), либо мелкий продавец исчез целиком
    const batch = goneN >= PAUSE_MIN_COUNT;
    const wholeAccount = goneN >= PAUSE_SMALL_COUNT && goneN >= totalN * PAUSE_MIN_SHARE;
    if (batch || wholeAccount) pausedSellers.add(seller);
  }

  const split = { seller_paused: [], gone_missing: [] };
  for (const c of candidates) {
    const paused = c.seller_id && pausedSellers.has(String(c.seller_id));
    split[paused ? 'seller_paused' : 'gone_missing'].push(c.id);
  }

  for (const [reason, ids] of Object.entries(split)) {
    if (!ids.length) continue;
    await q(
      `UPDATE ${S}.listings SET status = 'gone', gone_at = now(), last_changed_at = now()
        WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    // событие пишем ПОСЛЕ обновления и статус подставляем константой: в одном
    // запросе результат UPDATE не был бы виден части SELECT (снимок один)
    const insertEvents = (why) =>
      q(
        `INSERT INTO ${S}.listing_events
           (listing_id, reason, status, price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city)
         SELECT id, $2, 'gone', price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city
           FROM ${S}.listings WHERE id = ANY($1::bigint[])`,
        [ids, why],
      );
    try {
      await insertEvents(reason);
    } catch (e) {
      // Код мог попасть на сервер раньше миграции 004, которая разрешает причину
      // 'seller_paused'. Тогда пишем как обычный уход и говорим об этом вслух —
      // терять весь полный проход из-за ограничения нельзя.
      if (reason === 'seller_paused' && /listing_events_reason_chk/.test(e.message)) {
        console.error('[db] причина seller_paused не разрешена — накатите migrations/004_seller_paused.sql');
        await insertEvents('gone_missing');
      } else {
        throw e;
      }
    }
  }

  return {
    gone: candidates.length,
    paused: split.seller_paused.length,
    pausedSellers: [...pausedSellers],
  };
}

/** Проверка ушедшего по прямой ссылке: подтвердить снятие или вернуть в active. */
async function confirmGone(listingId) {
  await q(`UPDATE ${S}.listings SET status = 'gone', gone_at = COALESCE(gone_at, now()) WHERE id = $1`, [listingId]);
  await insertEvent(listingId, 'gone_confirmed');
}

async function reviveFromCheck(listingId) {
  await q(
    `UPDATE ${S}.listings SET status = 'active', gone_at = NULL,
                              last_checked_at = now(), last_changed_at = now()
      WHERE id = $1`,
    [listingId],
  );
  await insertEvent(listingId, 'alive_on_page');
}

// ─── прогоны и служебное ─────────────────────────────────────────────────────

/**
 * Закрыть прогоны, оставшиеся незавершёнными. Вызывается, когда замок уже наш:
 * значит другого краулера нет, и любая строка без finished_at — это прогон,
 * убитый на ходу (pm2 delete/restart, падение). Иначе такие строки навсегда
 * остаются «идущими» и портят отчёт по прогонам.
 */
async function closeAbandonedRuns() {
  const { rows } = await q(
    `UPDATE ${S}.scrape_runs
        SET finished_at = now(),
            note = COALESCE(note || ' | ', '') || 'прерван, счётчики потеряны'
      WHERE finished_at IS NULL
      RETURNING id`,
  );
  return rows.length;
}

async function startRun(mode, note) {
  const { rows } = await q(
    `INSERT INTO ${S}.scrape_runs (mode, note) VALUES ($1,$2) RETURNING id`,
    [mode, note || null],
  );
  return rows[0].id;
}

async function finishRun(runId, stats) {
  await q(
    `UPDATE ${S}.scrape_runs SET
       finished_at = now(), pages = $2, listings_seen = $3, new_count = $4,
       changed_count = $5, price_changed = $6, replaced = $7, gone_count = $8,
       errors = $9, note = COALESCE($10, note)
     WHERE id = $1`,
    [
      runId, stats.pages || 0, stats.seen || 0, stats.new || 0, stats.changed || 0,
      stats.priceChanged || 0, stats.replaced || 0, stats.gone || 0, stats.errors || 0,
      stats.note || null,
    ],
  );
}

/** Объявления, по которым пора (пере)качать страницу с продавцом. */
async function listingsNeedingDetail(brandSlugs, refreshDays, limit) {
  const { rows } = await q(
    `SELECT id, external_id, url FROM ${S}.listings
      WHERE status = 'active'
        AND brand_slug = ANY($1::text[])
        AND (detail_fetched_at IS NULL OR detail_fetched_at < now() - ($2 || ' days')::interval)
      ORDER BY detail_fetched_at NULLS FIRST, last_checked_at DESC
      LIMIT $3`,
    [brandSlugs, String(refreshDays), limit],
  );
  return rows;
}

async function getPriceHistory(listingId) {
  const { rows } = await q(
    `SELECT scraped_at, price_byn, price_usd, reason FROM ${S}.listing_events
      WHERE listing_id = $1 ORDER BY scraped_at`,
    [listingId],
  );
  return rows;
}

async function close() {
  await pool.end().catch(() => {});
}

module.exports = {
  pool, q, sizeKey, toDate,
  upsertSeller, upsertSellerFromCard,
  getListing, insertListing, insertEvent, touch, applyUpdate, applyDetail,
  replaceProduct, markGoneExcept, confirmGone, reviveFromCheck,
  startRun, finishRun, closeAbandonedRuns, listingsNeedingDetail, getPriceHistory,
  close,
  TRACKED, IDENTITY,
};
