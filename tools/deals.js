'use strict';
/**
 * Поиск позиций ниже рынка: прогоняет ценовую модель по всем активным объявлениям
 * и сортирует по выгоде.
 *
 *   node tools/deals.js                      топ по абсолютной выгоде за комплект
 *   node tools/deals.js --pct                топ по проценту ниже рынка
 *   node tools/deals.js --min-margin 300     только с выгодой от 300 руб. за комплект
 *   node tools/deals.js --brand michelin     только эта марка
 *   node tools/deals.js --size 225/45R18     только этот типоразмер
 *   node tools/deals.js --min-tread 6       поднять требование к остатку
 *   node tools/deals.js --limit 40
 *
 * ВАЖНО: это ШОРТЛИСТ, а не приговор. Замерено, что у модели толстый хвост —
 * 90-й процентиль ошибки около 85%, каждый пятый прогноз мимо больше чем на 60%.
 * Поэтому под каждой находкой печатаются РЕАЛЬНЫЕ сопоставимые с ценами: смотреть
 * надо на них, а прогноз лишь помогает отсортировать 6 000 объявлений.
 *
 * ЧТО ЭТО ЗА ЧИСЛА. Сравнение идёт с рыночной стоимостью (market): цена, приведённая
 * к частнику в Минске — то есть к тому уровню, по которому позицию можно перепродать.
 * Это отклонение ЦЕН ПРЕДЛОЖЕНИЯ, а не гарантия прибыли: цен сделок сайт не
 * показывает. Медианная ошибка модели на отложенной выборке — около 22%, поэтому
 * отклонение в 15-20% это шум, а осмысленный сигнал начинается от 35-40%.
 *
 * Дешевле 25% от рынка — почти всегда не сделка, а ошибка объявления (цена за 1 шт.
 * вместо комплекта, приманка, опечатка). Такие скрыты, показать: --include-suspicious.
 */

const config = require('../config');
const store = require('../lib/store');
const { buildModel } = require('../lib/pricing');

const S = config.db.schema;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

/**
 * Калибровка появилась в lib/pricing.js позже, чем код, который её читает. Если на
 * машине лежат файлы разных версий (частичное копирование на сервер), model.soldCalibration
 * будет undefined — раньше это валило весь прогон с «Cannot read properties of undefined».
 */
const calibrationOf = (model) =>
  model.soldCalibration || { n: 0, needed: 0, k: null, applied: false, stale: true };

const MIN_COMPARABLES = Number(opt('--min-comparables', 8));
const MIN_MARGIN = Number(opt('--min-margin', 0));
const LIMIT = Number(opt('--limit', 25));
const SUSPICIOUS_BELOW = 0.25; // дешевле четверти рынка — скорее ошибка объявления
// Отсекаем только заведомо изношенное. Неизвестный остаток оставляем: у б/у он
// указан лишь в 35% объявлений, отбрасывать остальные — терять две трети рынка.
const MIN_TREAD = Number(opt('--min-tread', process.env.DEAL_MIN_TREAD_MM || 5));
/**
 * Проверка фактами: объявление обязано быть дешевле медианы живых сопоставимых
 * своего типоразмера. Модель нормализует сопоставимые к опорной точке и потом
 * применяет множители объявления, и в дешёвых изношенных сегментах это переоценивает:
 * у 195/55R16 сопоставимые стояли по 25-76 руб., а модель дала 208 — объявление за 152
 * выглядело «на 27% ниже рынка», будучи на 52% ДОРОЖЕ медианы.
 * Если сопоставимых меньше PEER_MIN_COUNT, проверять нечем — показываем с пометкой.
 */
const PEER_MIN_DISCOUNT = Number(process.env.DEAL_PEER_MIN_DISCOUNT || 0.15);
const PEER_MIN_COUNT = Number(process.env.DEAL_PEER_MIN_COUNT || 3);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

(async () => {
  try {
    const { rows } = await store.q(
      `SELECT l.external_id, l.price_byn, l.price_set_byn, l.size_key, l.width, l.diameter,
              l.season, l.condition, l.brand, l.brand_slug, l.model, l.year, l.tread_mm,
              l.city, l.qty, l.title, l.url, l.status, l.posted_date, l.gone_at, l.first_seen,
              s.kind AS seller_kind, s.rank_title,
              (SELECT e.reason FROM ${S}.listing_events e
                WHERE e.listing_id = l.id ORDER BY e.scraped_at DESC LIMIT 1) AS last_reason
         FROM ${S}.listings l
         LEFT JOIN ${S}.sellers s ON s.seller_id = l.seller_id
        WHERE l.status <> 'replaced' AND l.price_byn IS NOT NULL`,
    );

    // База считается по активным (текущий рынок), ушедшие идут на калибровку
    // поправки «предложение -> сделка» — она включится сама, когда их накопится довольно.
    const model = buildModel(rows);
    const sc = calibrationOf(model);

    const brandFilter = opt('--brand', null);
    const sizeFilter = opt('--size', null);

    // сопоставимые того же типоразмера — и доказательство, и фильтр
    const byExactSize = new Map();
    for (const r of rows) {
      if (r.status !== 'active' || !r.size_key) continue;
      const k = `${r.size_key}|${r.season}|${r.condition}`;
      if (!byExactSize.has(k)) byExactSize.set(k, []);
      byExactSize.get(k).push(r);
    }

    const found = [];
    const skipped = { unreliable: 0, thin: 0, worn: 0, suspicious: 0, notCheapVsPeers: 0 };

    for (const r of rows) {
      if (r.status !== 'active') continue;
      if (brandFilter && r.brand_slug !== brandFilter) continue;
      if (sizeFilter && r.size_key !== sizeFilter) continue;

      const p = model.predict(r);
      if (!p) continue;
      if (!p.reliable) { skipped.unreliable++; continue; }
      if (p.comparables < MIN_COMPARABLES) { skipped.thin++; continue; }

      // изношенный протектор — мимо; неизвестный остаётся на ручной просмотр
      if (r.tread_mm != null && Number(r.tread_mm) < MIN_TREAD) {
        skipped.worn++;
        continue;
      }

      const price = Number(r.price_byn);
      const ratio = price / p.market;
      if (ratio >= 1) continue;
      if (ratio < SUSPICIOUS_BELOW && !flag('--include-suspicious')) { skipped.suspicious++; continue; }

      // проверка фактами: дешевле ли живых сопоставимых своего типоразмера
      const peerPrices = (byExactSize.get(`${r.size_key}|${r.season}|${r.condition}`) || [])
        .filter((x) => x.external_id !== r.external_id)
        .map((x) => Number(x.price_byn))
        .filter((x) => x > 0);
      const peerMid = median(peerPrices);
      if (peerPrices.length >= PEER_MIN_COUNT && peerMid > 0 && price > peerMid * (1 - PEER_MIN_DISCOUNT)) {
        skipped.notCheapVsPeers++;
        continue;
      }

      const qty = r.qty || 4;
      const marginSet = (p.market - price) * qty;
      if (marginSet < MIN_MARGIN) continue;

      found.push({ r, p, price, ratio, marginSet, qty });
    }

    found.sort((a, b) => (flag('--pct') ? a.ratio - b.ratio : b.marginSet - a.marginSet));

    console.log(
      `\nАктивных объявлений с ценой: ${rows.filter((r) => r.status === 'active').length}. ` +
        `Ниже рынка: ${found.length}.`,
    );
    console.log(
      `Отброшено: слишком широкий разрез ${skipped.unreliable}, мало сопоставимых ${skipped.thin}, ` +
        `остаток меньше ${MIN_TREAD} мм ${skipped.worn}, не дешевле сопоставимых ${skipped.notCheapVsPeers}, ` +
        `подозрительно дёшево ${skipped.suspicious}`,
    );
    console.log(
      `Сортировка: ${flag('--pct') ? 'по проценту ниже рынка' : 'по выгоде за комплект'}. ` +
        `Показано до ${LIMIT}.`,
    );
    console.log(
      sc.stale
        ? 'Калибровка недоступна: lib/pricing.js старой версии — скопируйте файлы целиком'
        : `Калибровка по ушедшим: ${sc.n}/${sc.needed} наблюдений` +
        (sc.applied
          ? `, поправка ×${sc.k.toFixed(3)} применяется — числа ниже это ожидаемые цены сделок`
          : ' — сравнение идёт с ценами предложения') +
        '\n',
    );

    let i = 0;
    for (const f of found.slice(0, LIMIT)) {
      const { r, p } = f;
      i++;
      const age = r.year ? `${new Date().getFullYear() - r.year} г.` : 'год ?';
      const tread = r.tread_mm != null ? `${r.tread_mm} мм` : r.condition === 'новые' ? 'новая' : 'остаток ?';
      console.log(
        `${String(i).padStart(2)}. ${String(Math.round((1 - f.ratio) * 100)).padStart(2)}% ниже рынка  ` +
          `выгода ${String(Math.round(f.marginSet)).padStart(4)} руб./компл.`,
      );
      console.log(
        `    ${r.brand} ${r.model || ''} ${r.size_key} ${r.season}, ${r.condition}, ${age}, ${tread}`.replace(/\s+/g, ' '),
      );
      if (p.expectedSale) {
        console.log(`    ожидаемая цена сделки ~${p.expectedSale} руб./шт (по ушедшим)`);
      }
      console.log(
        `    цена ${f.price} -> рынок ${p.market} руб./шт  |  ${r.city}` +
          `${r.seller_kind ? ', ' + r.seller_kind : ''}` +
          `  |  сопоставимых ${p.comparables} (${p.level})`,
      );
      console.log(`    ${r.url}`);

      // то же самое, но фактами: цены живых объявлений того же типоразмера
      const peers = (byExactSize.get(`${r.size_key}|${r.season}|${r.condition}`) || [])
        .filter((x) => x.external_id !== r.external_id)
        .sort((a, b) => Number(a.price_byn) - Number(b.price_byn));
      if (peers.length) {
        const prices = peers.map((x) => Number(x.price_byn));
        const mid = median(prices);
        console.log(
          `    сопоставимые ${r.size_key} ${r.season} ${r.condition}: ` +
            `${peers.length} шт, медиана ${mid} руб., от ${prices[0]} до ${prices[prices.length - 1]}`,
        );
        console.log(
          '      ' +
            peers.slice(0, 5).map((x) => `${x.price_byn} (${x.brand}${x.tread_mm ? ' ' + x.tread_mm + 'мм' : ''})`).join(', ') +
            (peers.length > 5 ? ' ...' : ''),
        );
        const vsPeers = Number(r.price_byn) / mid - 1;
        console.log(
          `      против медианы точного размера: ${Math.round(vsPeers * 100)}%` +
            `${Math.abs(vsPeers) < 0.15 ? '  <- по факту не сделка, модель преувеличила' : ''}`,
        );
      } else {
        console.log('    сопоставимых того же типоразмера в продаже нет — проверять вручную');
      }
    }

    if (!found.length) console.log('Ничего не нашлось при текущих порогах — попробуйте --any-tread или --min-comparables 5.');
  } catch (e) {
    console.error('ошибка:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
