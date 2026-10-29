'use strict';
/**
 * Перепарсить уже сохранённые объявления по текущим правилам.
 *
 *   node tools/reparse.js --dry     показать, что изменится, ничего не писать
 *   node tools/reparse.js           применить
 *
 * Нужен, когда правила разбора улучшились: сайт заново обходить не надо, заголовки
 * и описания уже лежат в базе.
 *
 * ВАЖНО: события в listing_events НЕ пишутся. Правка парсера — не действие продавца,
 * и попадание её в историю изменений исказило бы аналитику: выглядело бы так, будто
 * продавец что-то поменял.
 */

const config = require('../config');
const store = require('../lib/store');
const { parseTitle, parseTread } = require('../lib/parse');

const S = config.db.schema;
const dry = process.argv.includes('--dry');

// что пересчитываем: только выведенное из текста, идентичность и цены не трогаем
const FIELDS = ['tread_mm', 'tread_raw', 'year', 'model', 'season', 'condition', 'vehicle_type'];
// Размер разбирается ТОЛЬКО из заголовка, других источников у него нет. Поэтому его
// пишем всегда, включая обнуление: неправдоподобный размер (индекс нагрузки, принятый
// за размер) портит чужие разрезы в ценовой модели, пустой — просто не участвует.
const SIZE_FIELDS = ['width', 'profile', 'diameter', 'is_c', 'size_key'];

const numEq = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) < 0.005;
};

(async () => {
  try {
    const { rows } = await store.q(
      `SELECT id, external_id, title, description, tread_mm, tread_raw, year, model,
              season, condition, vehicle_type, width, profile, diameter, is_c, size_key
         FROM ${S}.listings`,
    );
    console.log(`объявлений в базе: ${rows.length}${dry ? ' (пробный прогон, записи не будет)' : ''}`);

    const stats = { touched: 0, byField: {}, filled: 0, fixed: 0, lost: 0 };
    const examples = [];

    for (const row of rows) {
      const attrs = parseTitle(row.title || '');
      const tread = parseTread(row.description || '', { season: attrs.season || row.season });
      const fresh = { ...attrs, ...tread };

      const changes = {};
      const sizeKey =
        fresh.width && fresh.diameter
          ? `${fresh.width}${fresh.profile ? '/' + fresh.profile : ''}${fresh.diameter}${fresh.is_c ? 'C' : ''}`
          : null;
      for (const f of SIZE_FIELDS) {
        const newV = f === 'size_key' ? sizeKey : fresh[f] ?? null;
        const oldV = row[f] ?? null;
        const same = f === 'width' || f === 'profile' ? numEq(oldV, newV) : oldV === newV;
        if (!same) changes[f] = [oldV, newV];
      }
      for (const f of FIELDS) {
        const oldV = row[f];
        const newV = fresh[f] === undefined ? null : fresh[f];
        // NULL из парсера не затирает то, что могло прийти со страницы объявления
        if (newV == null) continue;
        const same = f === 'tread_mm' ? numEq(oldV, newV) : (oldV ?? null) === (newV ?? null);
        if (!same) changes[f] = [oldV, newV];
      }
      if (!Object.keys(changes).length) continue;

      stats.touched++;
      for (const f of Object.keys(changes)) stats.byField[f] = (stats.byField[f] || 0) + 1;
      if (changes.tread_mm) {
        if (changes.tread_mm[0] == null) stats.filled++;
        else stats.fixed++;
        if (examples.length < 10) {
          examples.push(
            `${row.external_id}: остаток ${changes.tread_mm[0] ?? '—'} -> ${changes.tread_mm[1]}  ` +
              `«${String(row.description).slice(0, 70).replace(/\s+/g, ' ')}»`,
          );
        }
      }

      if (!dry) {
        const sets = Object.keys(changes).map((f, i) => `${f} = $${i + 2}`);
        await store.q(
          `UPDATE ${S}.listings SET ${sets.join(', ')} WHERE id = $1`,
          [row.id, ...Object.keys(changes).map((f) => changes[f][1])],
        );
      }
    }

    console.log(`\nизменится объявлений: ${stats.touched}`);
    console.log(`по полям: ${JSON.stringify(stats.byField)}`);
    console.log(`остаток протектора: заполнено впервые ${stats.filled}, исправлено ${stats.fixed}`);
    if (examples.length) {
      console.log('\nпримеры по остатку:');
      for (const e of examples) console.log('  •', e);
    }

    const [after] = (await store.q(
      `SELECT count(*) AS n, count(tread_mm) AS with_tread
         FROM ${S}.listings WHERE condition = 'б/у'`,
    )).rows;
    console.log(
      `\nб/у: ${after.with_tread} из ${after.n} с остатком ` +
        `(${((after.with_tread / after.n) * 100).toFixed(1)}%)`,
    );
  } catch (e) {
    console.error('ошибка:', e.message);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
