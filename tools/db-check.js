'use strict';
/**
 * Проверка доступа к базе перед запуском краулера: сеть, пользователь, схема,
 * таблицы и право записи. Запись проверяется в транзакции с ROLLBACK, так что
 * в базе после проверки ничего не остаётся.
 *
 *   node tools/db-check.js
 */

const { Pool } = require('pg');
const config = require('../config');

const S = config.db.schema;
const NEEDED = ['listings', 'listing_events', 'sellers', 'scrape_runs'];
const NEEDED_VIEWS = ['v_active', 'v_gone', 'v_changes', 'v_price_changes', 'v_market_stats'];

(async () => {
  console.log(`подключаюсь: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}, схема ${S}`);
  const pool = new Pool({ ...config.db, connectionTimeoutMillis: 15000 });
  let ok = true;
  try {
    const who = await pool.query('SELECT current_user, current_database(), current_setting($1) AS tz', ['TimeZone']);
    console.log(`  ок: пользователь ${who.rows[0].current_user}, база ${who.rows[0].current_database}, TZ ${who.rows[0].tz}`);

    const { rows: schemas } = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [S]);
    if (!schemas.length) {
      console.error(`  ОШИБКА: схемы ${S} нет — накатите migrations/001_scrapper_schema.sql под lo_admin`);
      process.exit(1);
    }
    console.log(`  ок: схема ${S} существует`);

    const { rows: tables } = await pool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
      [S],
    );
    const have = new Set(tables.map((t) => t.table_name));
    const missing = NEEDED.filter((t) => !have.has(t));
    if (missing.length) {
      console.error(`  ОШИБКА: не хватает таблиц: ${missing.join(', ')}`);
      ok = false;
    } else {
      console.log(`  ок: все таблицы на месте (${NEEDED.length})`);
    }

    // право записи — в транзакции с откатом
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ${S}.scrape_runs (mode, note) VALUES ('db-check', 'проверка прав, будет откачена')`,
      );
      await client.query('ROLLBACK');
      console.log('  ок: запись разрешена (проверка откачена)');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ОШИБКА записи: ${e.message}`);
      console.error('    нужны GRANT от lo_admin — см. конец migrations/001_scrapper_schema.sql');
      ok = false;
    } finally {
      client.release();
    }

    const { rows: views } = await pool.query(
      'SELECT table_name FROM information_schema.views WHERE table_schema = $1',
      [S],
    );
    const haveViews = new Set(views.map((v) => v.table_name));
    const missingViews = NEEDED_VIEWS.filter((v) => !haveViews.has(v));
    if (missingViews.length) {
      console.error(`  ОШИБКА: не хватает представлений: ${missingViews.join(', ')}`);
      ok = false;
    } else {
      console.log(`  ок: представления на месте (${NEEDED_VIEWS.length})`);
    }

    const { rows: counts } = await pool.query(`
      SELECT (SELECT count(*) FROM ${S}.listings)       AS listings,
             (SELECT count(*) FROM ${S}.listing_events) AS events,
             (SELECT count(*) FROM ${S}.sellers)        AS sellers,
             (SELECT count(*) FROM ${S}.scrape_runs)    AS runs`);
    console.log(
      `  данные: объявлений ${counts[0].listings}, событий ${counts[0].events}, ` +
        `продавцов ${counts[0].sellers}, прогонов ${counts[0].runs}`,
    );
  } catch (e) {
    console.error(`  ОШИБКА подключения: ${e.message}`);
    if (/EACCES|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/.test(e.message)) {
      console.error('    база видна только из сети сервера — нужен VPN или запуск с сервера');
    }
    ok = false;
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(ok ? '\nИТОГ: база готова' : '\nИТОГ: есть проблемы, см. выше');
  process.exit(ok ? 0 : 1);
})();
