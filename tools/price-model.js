'use strict';
/**
 * Построить ценовую модель, показать множители и проверить её качество.
 *
 *   node tools/price-model.js                 таблицы множителей + проверка
 *   node tools/price-model.js --base          таблица базовых цен (при 5 мм, 3 года)
 *   node tools/price-model.js --predict 161841_3584841   прогноз по объявлению
 *
 * Проверка обязательна: 20% объявлений скрываются, модель учится на остальных и
 * предсказывает скрытые. Сравнение идёт с тривиальной базой «медиана того же
 * размера, сезона и состояния» — если модель её не бьёт, множители это шум.
 */

const config = require('../config');
const store = require('../lib/store');
const { buildModel, median, treadEff, REF } = require('../lib/pricing');

const S = config.db.schema;
const args = process.argv.slice(2);
const wantBase = args.includes('--base');
const predictId = (args.find((a) => a.startsWith('--predict')) ? args[args.indexOf('--predict') + 1] : null);

/** Устойчивое разбиение по external_id: одно и то же объявление всегда в одной части. */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Калибровка появилась в lib/pricing.js позже, чем код, который её читает. Если на
 * машине лежат файлы разных версий (частичное копирование на сервер), model.soldCalibration
 * будет undefined — раньше это валило весь прогон с «Cannot read properties of undefined».
 */
const calibrationOf = (model) =>
  model.soldCalibration || { n: 0, needed: 0, k: null, applied: false, stale: true };

const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
const factorRow = (k, v) => `  ${String(k).padEnd(16)} ×${v.k.toFixed(3).padStart(6)}   (${v.n} объявлений)`;

(async () => {
  try {
    const { rows } = await store.q(
      `SELECT l.external_id, l.price_byn, l.size_key, l.width, l.diameter, l.season, l.condition,
              l.brand, l.brand_slug, l.model, l.year, l.tread_mm, l.city, l.title, l.url,
              s.kind AS seller_kind, l.status, l.gone_at, l.first_seen,
              (SELECT e.reason FROM ${S}.listing_events e
                WHERE e.listing_id = l.id ORDER BY e.scraped_at DESC LIMIT 1) AS last_reason
         FROM ${S}.listings l
         LEFT JOIN ${S}.sellers s ON s.seller_id = l.seller_id
        WHERE l.status <> 'replaced' AND l.price_byn IS NOT NULL`,
    );
    console.log(`объявлений с ценой: ${rows.length}`);

    // ─── прогноз по одному объявлению ────────────────────────────────────────
    if (predictId) {
      const model = buildModel(rows.filter((r) => r.external_id !== predictId));
      const target = rows.find((r) => r.external_id === predictId);
      if (!target) {
        console.error(`объявление ${predictId} не найдено`);
        process.exitCode = 1;
        return;
      }
      const p = model.predict(target);
      console.log(`\n${target.title}`);
      console.log(target.url);
      console.log(`\n  фактическая цена:   ${target.price_byn} руб./шт`);
      if (!p) {
        console.log('  прогноз невозможен: нет сопоставимых');
        return;
      }
      console.log(`  ожидаемый запрос:   ${p.price} руб./шт${p.reliable ? '' : '  (НЕНАДЁЖНО: разрез слишком широкий)'}`);
      console.log(`  рыночная стоимость: ${p.market} руб./шт  (приведено к частнику в Минске)`);
      console.log(`  отклонение от рынка: ${pct(target.price_byn / p.market - 1)}`);
      console.log(`\n  разрез:             ${p.level} (${p.comparables} сопоставимых)`);
      console.log(`  база разреза:       ${p.base} руб. (опорная точка: остаток ${REF.tread} мм, возраст ${REF.age} г.)`);
      console.log(`  остаток протектора: ${p.treadKnown ? p.treadUsed + ' мм' : 'неизвестен'}`);
      console.log('  множители:');
      for (const [k, v] of Object.entries(p.factors)) console.log(`    ${k.padEnd(8)} ×${v.toFixed(3)}`);
      return;
    }

    // ─── модель на всех данных: таблицы множителей ───────────────────────────
    const full = buildModel(rows);
    const sc = calibrationOf(full);
    console.log(
      `калибровка по ушедшим: наблюдений ${sc.n} из ${sc.needed} нужных` +
        (sc.k ? `, текущая поправка ×${sc.k.toFixed(3)}` : '') +
        (sc.applied ? ' — ПРИМЕНЯЕТСЯ' : ' — пока не применяется, показываем цены предложения'),
    );
    console.log(`разрезов с 8+ объявлениями: ${full.bases.size.size}, объявлений для оценки множителей: ${full.stats.trusted}`);

    const show = (title, table, order) => {
      console.log(`\n=== ${title} ===`);
      const entries = [...table.entries()];
      if (order) entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
      else entries.sort((a, b) => b[1].n - a[1].n);
      for (const [k, v] of entries) console.log(factorRow(k, v));
    };

    show('Остаток протектора (опора 5-6 мм = 1.000)', full.factors.tread,
      ['неизвестно', '<3', '3-4', '4-5', '5-6', '6-7', '7-8', '8+']);
    show('Возраст шины (опора 2-3 года = 1.000)', full.factors.age,
      ['неизвестно', '0-1', '2-3', '4-5', '6-8', '9-12', '13+']);
    show('Марка', full.factors.brand);
    show('Тип продавца', full.factors.seller);
    console.log('\n=== Город (топ-10, опора Минск = 1.000) ===');
    for (const [k, v] of [...full.factors.city.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
      console.log(factorRow(k, v));
    }

    console.log('\n=== Модели (топ-15 по числу объявлений) ===');
    for (const [k, v] of [...full.factors.model.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) {
      console.log(factorRow(k, v));
    }

    if (wantBase) {
      console.log(`\n=== Базовые цены разрезов (руб./шт при остатке ${REF.tread} мм, возрасте ${REF.age} г.) ===`);
      const cells = [...full.bases.size.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30);
      for (const [k, v] of cells) {
        const [size, season, cond] = k.split('|');
        console.log(`  ${size.padEnd(12)} ${season.padEnd(12)} ${String(cond).padEnd(6)} ${String(Math.round(v.base)).padStart(5)} руб.  (${v.n} объявлений)`);
      }
    }

    // ─── проверка на отложенной выборке ──────────────────────────────────────
    const train = rows.filter((r) => hash(r.external_id) >= 0.2);
    const test = rows.filter((r) => hash(r.external_id) < 0.2);
    const model = buildModel(train);

    // тривиальная база для сравнения: медиана того же размера/сезона/состояния
    const plain = new Map();
    for (const r of train) {
      const k = `${r.size_key}|${r.season}|${r.condition}`;
      if (!plain.has(k)) plain.set(k, []);
      plain.get(k).push(Number(r.price_byn));
    }
    const plainMedian = new Map([...plain].filter(([, v]) => v.length >= 3).map(([k, v]) => [k, median(v)]));

    const errModel = [];
    const errPlain = [];
    const byLevel = {};
    let noPrediction = 0;
    for (const r of test) {
      const p = model.predict(r);
      if (!p) { noPrediction++; continue; }
      const e = Math.abs(Number(r.price_byn) / p.price - 1);
      errModel.push(e);
      byLevel[p.level] = byLevel[p.level] || [];
      byLevel[p.level].push(e);
      const pm = plainMedian.get(`${r.size_key}|${r.season}|${r.condition}`);
      if (pm) errPlain.push(Math.abs(Number(r.price_byn) / pm - 1));
    }

    console.log(`\n=== Проверка на отложенной выборке ===`);
    console.log(`  обучение ${train.length} | проверка ${test.length} | без прогноза ${noPrediction}`);
    console.log(`  медианная ошибка МОДЕЛИ:            ${pct(median(errModel))}`);
    console.log(`  медианная ошибка тривиальной базы:  ${pct(median(errPlain))}  (медиана размера/сезона/состояния)`);
    const within = (xs, t) => xs.filter((e) => e <= t).length / xs.length;
    console.log(`  попаданий в ±20%: модель ${pct(within(errModel, 0.2))}, база ${pct(within(errPlain, 0.2))}`);
    console.log(`  попаданий в ±35%: модель ${pct(within(errModel, 0.35))}, база ${pct(within(errPlain, 0.35))}`);
    // Для детектора сделок важнее хвост, а не середина: ложные «находки» рождаются
    // там, где модель промахнулась сильно.
    const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
    console.log(`  хвост (90-й процентиль ошибки): модель ${pct(p90(errModel))}, база ${pct(p90(errPlain))}`);
    console.log(`  промахов больше 60%: модель ${pct(1 - within(errModel, 0.6))}, база ${pct(1 - within(errPlain, 0.6))}`);
    console.log('\n  ошибка по уровню разреза:');
    for (const [lvl, es] of Object.entries(byLevel)) {
      console.log(`    ${lvl.padEnd(9)} ${String(es.length).padStart(4)} объявлений, медианная ошибка ${pct(median(es))}`);
    }
  } catch (e) {
    console.error('ошибка:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
