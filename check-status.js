'use strict';
/**
 * Суточная сводка + проверка «ушедших» объявлений по прямой ссылке.
 *
 *   node check-status.js            сводка + проверка до VERIFY_LIMIT ушедших
 *   node check-status.js --no-verify
 *
 * Зачем проверка: если объявление выпало из выдачи, но страница жива, значит это
 * не снятие, а наш пропуск (сбой краула или сдвиг пагинации). Такие возвращаем в
 * active — иначе статистика «продано» будет завышена нашими же промахами.
 *
 * Проверено вживую: удалённое объявление отдаёт HTTP 404, существующее — 200,
 * причём слаг в ссылке значения не имеет. Поэтому 404 — надёжный признак снятия,
 * а любая другая неудача (таймаут, обрыв, блокировка) статус НЕ меняет: лучше
 * оставить объявление в неизвестном состоянии, чем записать сетевой сбой в продажи.
 */

const config = require('./config');
const store = require('./lib/store');
const { BamperSession } = require('./lib/session');
const { parseDetailPage } = require('./lib/parse');

const S = config.db.schema;
const VERIFY_LIMIT = Number(process.env.VERIFY_LIMIT || 40);
const verify = !process.argv.includes('--no-verify');
const log = (...a) => console.log(...a);

async function summary() {
  const rows = async (sql, params) => (await store.q(sql, params)).rows;

  const [totals] = await rows(`
    SELECT count(*)                                          AS all_listings,
           count(*) FILTER (WHERE status = 'active')          AS active,
           count(*) FILTER (WHERE status = 'gone')            AS gone,
           count(*) FILTER (WHERE status = 'replaced')        AS replaced,
           count(*) FILTER (WHERE price_byn IS NULL)          AS no_price,
           count(*) FILTER (WHERE detail_fetched_at IS NULL)  AS without_detail
      FROM ${S}.listings`);

  const [day] = await rows(`
    SELECT
      (SELECT count(*) FROM ${S}.listings        WHERE first_seen > now() - interval '24 hours') AS new_24h,
      (SELECT count(*) FROM ${S}.v_price_changes WHERE changed_at > now() - interval '24 hours') AS price_changes_24h,
      (SELECT count(*) FROM ${S}.listings        WHERE gone_at    > now() - interval '24 hours') AS gone_24h,
      (SELECT count(*) FROM ${S}.listing_events  WHERE reason = 'product_replaced'
                                                   AND scraped_at > now() - interval '24 hours') AS replaced_24h`);

  log('\n=== Сводка ===');
  log(
    `всего ${totals.all_listings} | активных ${totals.active} | ушедших ${totals.gone} | ` +
      `подменённых ${totals.replaced}`,
  );
  log(`без цены ${totals.no_price} | без страницы объявления ${totals.without_detail}`);
  log(
    `за сутки: новых ${day.new_24h}, изменений цены ${day.price_changes_24h}, ` +
      `ушло ${day.gone_24h}, подмен товара ${day.replaced_24h}`,
  );

  // качество собственной детекции: сколько «ушедших» оказались живыми
  const [quality] = await rows(`
    SELECT count(*) FILTER (WHERE reason = 'gone_confirmed') AS confirmed,
           count(*) FILTER (WHERE reason = 'alive_on_page')  AS false_gone
      FROM ${S}.listing_events
     WHERE scraped_at > now() - interval '30 days'`);
  const checked = Number(quality.confirmed) + Number(quality.false_gone);
  if (checked) {
    log(
      `за 30 дней проверено ушедших: ${checked}, подтверждено снятие ${quality.confirmed}, ` +
        `ложных ${quality.false_gone} (${((quality.false_gone / checked) * 100).toFixed(1)}%)`,
    );
  }

  // Прогресс к переходу на цены сделок: сколько ушедших подтверждено по ссылке и
  // ушло быстро — именно они годятся для калибровки «предложение -> сделка».
  const [sold] = await rows(`
    SELECT count(*) AS n
      FROM ${S}.listings l
     WHERE l.status = 'gone' AND l.price_byn IS NOT NULL
       AND l.gone_at - l.first_seen < interval '30 days'
       AND EXISTS (
         SELECT 1 FROM ${S}.listing_events e
          WHERE e.listing_id = l.id AND e.reason = 'gone_confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM ${S}.listing_events e
          WHERE e.listing_id = l.id AND e.reason = 'seller_paused'
       )`);
  const [paused] = await rows(`
    SELECT count(DISTINCT listing_id) AS n FROM ${S}.listing_events
     WHERE reason = 'seller_paused'`);
  log(`уходов из-за паузы кабинета (в продажи не идут): ${paused.n}`);
  log(
    `наблюдений для калибровки цен сделок: ${sold.n} из 100 нужных` +
      (Number(sold.n) >= 100 ? ' — модель уже считает ожидаемую цену сделки' : ''),
  );

  const drops = await rows(`
    SELECT l.external_id, l.title, pc.old_price, pc.new_price, pc.delta_pct
      FROM ${S}.v_price_changes pc
      JOIN ${S}.listings l ON l.id = pc.listing_id
     WHERE pc.changed_at > now() - interval '24 hours' AND pc.delta < 0
     ORDER BY pc.delta_pct ASC
     LIMIT 10`);
  if (drops.length) {
    log('\nсамые крупные снижения цены за сутки:');
    for (const d of drops) {
      log(`  ${d.old_price} -> ${d.new_price} руб. (${Number(d.delta_pct).toFixed(1)}%)  ${d.title}`);
    }
  }

  const brands = await rows(`
    SELECT brand, count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn) AS median
      FROM ${S}.listings
     WHERE status = 'active' AND price_byn IS NOT NULL
     GROUP BY brand ORDER BY n DESC LIMIT 15`);
  if (brands.length) {
    log('\nактивные по маркам (медиана руб./шт):');
    for (const b of brands) {
      log(`  ${String(b.brand).padEnd(14)} ${String(b.n).padStart(5)}  ${Number(b.median).toFixed(0)}`);
    }
  }
}

async function verifyGone() {
  const { rows } = await store.q(
    // Уже подтверждённые пропускаем: иначе каждый запуск заново ходит по тем же
    // ссылкам и плодит дубли gone_confirmed в истории (замечено на живых данных).
    `SELECT l.id, l.external_id, l.url FROM ${S}.listings l
      WHERE l.status = 'gone' AND l.gone_at > now() - interval '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM ${S}.listing_events e
           WHERE e.listing_id = l.id
             -- 'seller_paused' тоже пропускаем: причина ухода уже известна, идти по
             -- ссылке незачем. Плюс проверка перезаписала бы её на 'gone_confirmed',
             -- и пауза кабинета снова стала бы выглядеть продажей.
             AND e.reason IN ('gone_confirmed', 'alive_on_page', 'seller_paused')
        )
      ORDER BY l.gone_at DESC LIMIT $1`,
    [VERIFY_LIMIT],
  );
  if (!rows.length) {
    log('\nпроверять нечего: свежих ушедших нет');
    return;
  }

  log(`\n=== Проверка ушедших по ссылке: ${rows.length} ===`);
  const session = new BamperSession({ ...config.browserFor('status'), log });
  await session.start();
  let alive = 0;
  let dead = 0;
  let unknown = 0;
  try {
    for (const r of rows) {
      const { status, html } = await session.request(r.url, { retries: 1 });
      const detail = html ? parseDetailPage(html, { url: r.url }) : null;

      if (detail && detail.title) {
        alive++;
        await store.reviveFromCheck(r.id);
        log(`  жив: ${r.external_id} — вернул в active`);
      } else if (status === 404 || status === 410) {
        dead++;
        await store.confirmGone(r.id);
      } else {
        // сеть, блокировка, пустой ответ — статус не трогаем
        unknown++;
        log(`  неясно (ответ ${status ?? 'нет'}): ${r.external_id} — статус не меняю`);
      }
    }
  } finally {
    await session.stop();
  }
  log(`подтверждено снятых: ${dead}, ложных ${alive} (вернули в active), неясных ${unknown}`);
}

(async () => {
  try {
    await summary();
    if (verify) await verifyGone();
  } catch (e) {
    console.error('ошибка:', e.message);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
