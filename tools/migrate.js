'use strict';
/**
 * Накатить SQL-миграции (чтобы не требовать psql на машине).
 *
 *   node tools/migrate.js                     # все файлы из migrations/
 *   node tools/migrate.js 001_scrapper_schema.sql
 *
 * CREATE SCHEMA и GRANT требуют прав владельца, поэтому запускать под lo_admin:
 *   DB_USER=lo_admin DB_PASSWORD=... node tools/migrate.js
 * Под lo_agent сработает только если схема уже создана и права выданы.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../config');

const dir = path.join(__dirname, '..', 'migrations');
const only = process.argv[2];
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql') && (!only || f === only))
  .sort();

(async () => {
  if (!files.length) {
    console.error('нет файлов миграций');
    process.exit(1);
  }
  const pool = new Pool({ ...config.db, connectionTimeoutMillis: 15000 });
  try {
    const who = await pool.query('SELECT current_user, current_database()');
    console.log(`подключён как ${who.rows[0].current_user} к ${who.rows[0].current_database}`);
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      console.log(`--- ${f} ---`);
      await pool.query(sql);
      console.log(`${f}: ок`);
    }
    const t = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [config.db.schema],
    );
    console.log(`таблицы в ${config.db.schema}:`, t.rows.map((r) => r.table_name).join(', ') || '(нет)');
  } catch (e) {
    console.error('ОШИБКА миграции:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
