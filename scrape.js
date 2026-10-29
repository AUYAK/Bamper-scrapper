'use strict';
/**
 * Краулер шин bamper.by.
 *
 *   node scrape.js full          полный проход по маркам из конфига (+ пометка ушедших)
 *   node scrape.js incremental   только первые страницы свежих (новые + смена цены)
 *   node scrape.js details       добор страниц объявлений (продавец, полное описание)
 *   node scrape.js loop          incremental по интервалу + full раз в сутки + details
 *
 * Полный проход по премиуму (тир A, ~6 200 объявлений) — примерно 310 страниц,
 * то есть 12-15 минут с вежливой паузой между запросами.
 */

const config = require('./config');

// --dry-run: без Postgres, всё в data/dry-run/*.jsonl. Нужно для проверки краула
// там, где база недоступна по сети (БД видна только из сети сервера).
const DRY = process.argv.includes('--dry-run');
const store = DRY ? require('./lib/store-dry') : require('./lib/store');
const { BamperSession } = require('./lib/session');
const { parseListPage, parseDetailPage, nextPageUrl } = require('./lib/parse');
const { slugsForTiers, brandBySlug, tierOf } = require('./lib/brands');

const OVERRIDE = { brands: null, pages: null };

/**
 * Какую долю от обещанного сайтом («Найдено N») надо собрать, чтобы считать раздел
 * пройденным полностью. Ниже этого — не помечаем по нему ушедших: скорее всего
 * выдача обрезалась на нашей стороне.
 */
const COMPLETE_MIN_SHARE = Number(process.env.COMPLETE_MIN_SHARE || 0.9);

/**
 * Замок от одновременного запуска. Нужен, потому что режимы ставятся отдельными
 * задачами по расписанию: ночной full идёт ~25 минут и обязательно наложится на
 * очередной incremental. Два процесса не должны совпасть — они полезут за одной
 * кукой Cloudflare в один профиль Chrome, а пометка ушедших в full может принять
 * объявления, которые прямо сейчас обновляет incremental, за исчезнувшие.
 */
const LOCK_FILE = require('path').join(__dirname, 'data', 'scrape.lock');

/**
 * Попытка взять замок. Возвращает true, либо объект-держатель, либо null, если
 * замок оказался брошенным и снят (тогда имеет смысл попробовать снова).
 */
function tryLock(mode) {
  const fs = require('fs');
  fs.mkdirSync(require('path').dirname(LOCK_FILE), { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, mode, startedAt: new Date().toISOString() }), {
      flag: 'wx',
    });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    /* битый файл — считаем замок брошенным */
  }
  if (holder && holder.pid && isAlive(holder.pid)) return holder;
  log('замок остался от упавшего процесса — снимаю');
  try { fs.unlinkSync(LOCK_FILE); } catch { /* уже сняли */ }
  return null;
}

/**
 * Взять замок, при необходимости подождав.
 *
 * Ждать нужно полному проходу: инкремент идёт каждые полчаса, и ночной full
 * неизбежно застаёт его работающим. Если full просто выйдет, полный проход
 * пропадёт на сутки — а это единственный режим, который помечает ушедшие
 * объявления. Инкременту ждать незачем: следующий будет через полчаса.
 */
async function acquireLock(mode, waitMs = Number(process.env.SCRAPE_LOCK_WAIT_MS || 0)) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const r = tryLock(mode);
    if (r === true) return true;
    if (r === null) continue; // сняли брошенный замок, пробуем сразу
    if (Date.now() >= deadline) {
      log(`уже работает ${r.mode} (pid ${r.pid}, с ${r.startedAt}) — выхожу`);
      return false;
    }
    if (!announced) {
      log(`уже работает ${r.mode} (pid ${r.pid}) — жду до ${Math.round(waitMs / 60000)} мин`);
      announced = true;
    }
    await sleep(15000);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // процесс есть, но не наш — считаем живым
  }
}

function releaseLock() {
  try {
    const holder = JSON.parse(require('fs').readFileSync(LOCK_FILE, 'utf8'));
    if (holder.pid === process.pid) require('fs').unlinkSync(LOCK_FILE);
  } catch {
    /* нечего снимать */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`получен ${sig} — завершаюсь после текущей страницы`);
    stopping = true;
  });
}

function newStats() {
  return {
    pages: 0, seen: 0, new: 0, changed: 0, priceChanged: 0, replaced: 0, gone: 0,
    errors: 0, clearanceRefreshes: 0, paused: 0, excluded: 0,
    // Разбивка ошибок по видам. Раньше в scrape_runs был только счётчик, и когда
    // инкременты начали давать по 14-18 ошибок за прогон, понять причину по базе
    // было нельзя — приходилось лезть в логи pm2 на сервере.
    errorKinds: {},
  };
}

const countError = (stats, kind) => {
  stats.errors++;
  stats.errorKinds[kind] = (stats.errorKinds[kind] || 0) + 1;
};

/**
 * Записать одно объявление из выдачи.
 * В seen кладём external_id ТОЙ строки, которую реально затронули: при подмене
 * товара это новая ревизия ('..#2'), и если положить базовый ключ, пометка ушедших
 * в конце полного прохода похоронит только что созданную строку.
 */
async function processItem(item, slug, stats, seen, newListings) {
  // Классификация марки берётся от сайта (мы краулим именно этот раздел),
  // разбор заголовка оставляем в raw — он может ошибаться на моделях.
  const dictBrand = brandBySlug(slug);
  const parsedBrand = item.brand_slug;
  item.brand_slug = slug;
  item.brand = dictBrand ? dictBrand.name : item.brand;
  const tier = tierOf(slug);

  // Исключённый продавец: не пишем и не обновляем, но отмечаем как виденного —
  // иначе его старые строки (до миграции 006) ушли бы в gone как «продажи».
  if (config.crawl.excludedSellers.has(Number(item.seller_id))) {
    seen.add(item.external_id);
    stats.excluded++;
    return;
  }

  await store.upsertSellerFromCard(item);
  const existing = await store.getListing(item.external_id);

  if (!existing) {
    const { listing, inserted } = await store.insertListing(item, tier);
    if (!listing) return;
    seen.add(listing.external_id);
    if (inserted) {
      stats.new++;
      newListings.push({ id: listing.id, url: item.url, external_id: listing.external_id });
      if (parsedBrand && parsedBrand !== slug) {
        log(`  ! марка из заголовка (${parsedBrand}) не совпала с разделом (${slug}): ${item.url}`);
      }
    }
    return;
  }

  const oldPrice = existing.price_byn;
  const res = await store.applyUpdate(existing, item, tier);

  if (res.replaced) {
    stats.replaced++;
    seen.add(res.listing ? res.listing.external_id : existing.external_id);
    log(`  ↺ ${existing.external_id}: продавец подменил товар -> ${item.title}`);
    return;
  }

  seen.add(existing.external_id);
  if (res.changedFields.length) stats.changed++;
  if (res.priceChanged) {
    stats.priceChanged++;
    log(
      `  ₽ ${existing.external_id}: ${oldPrice ?? 'без цены'} -> ${item.price_byn ?? 'без цены'} руб./шт  ${item.title}`,
    );
  }
}

/** Пройти раздел одной марки. Возвращает {completed} — дошли ли до конца выдачи. */
async function crawlBrand(session, slug, mode, stats, seen, newListings) {
  const pageLimit =
    OVERRIDE.pages || (mode === 'incremental' ? config.crawl.incrementalPages : config.crawl.maxPagesPerBrand);
  let url = `${config.crawl.baseUrl}/shiny/marka_${slug}/kolvo_${config.crawl.kolvo}/?sort=DATE-DESC`;
  let page = 0;
  let completed = false;
  let claimed = null;   // сколько объявлений обещает сам сайт («Найдено N»)
  let collected = 0;    // сколько мы реально собрали

  while (url && page < pageLimit && !stopping) {
    const html = await session.get(url);
    if (!html) {
      countError(stats, 'список');
      log(`  ${slug}: страница ${page + 1} не загрузилась — раздел пройден не полностью`);
      return { completed: false };
    }
    page++;
    stats.pages++;

    const { items, totalFound } = parseListPage(html);
    if (page === 1) {
      // с сентября 2026 сайт счётчик по разделу не печатает — тогда сверка ниже не работает
      log(`  ${slug}: найдено ${totalFound ?? 'счётчика на странице нет'}`);
      claimed = totalFound;
    }
    if (!items.length) {
      completed = true;
      break;
    }

    collected += items.length;
    for (const item of items) {
      stats.seen++;
      try {
        await processItem(item, slug, stats, seen, newListings);
      } catch (e) {
        countError(stats, 'запись в базу');
        log(`  ошибка записи ${item.external_id}: ${e.message}`);
      }
    }

    const next = nextPageUrl(html, url, { baseUrl: config.crawl.baseUrl });
    if (!next) completed = true;
    url = next;
  }

  // упёрлись в лимит страниц — считаем раздел незавершённым только в полном режиме
  if (!completed && page >= pageLimit && mode !== 'incremental') {
    log(`  ${slug}: достигнут лимит ${pageLimit} страниц`);
  }

  /**
   * Сверка с тем, что обещал сайт. Без неё 21.08 полный проход собрал 4 933
   * объявления вместо 6 230, разделы при этом завершились «нормально» (ссылка
   * «След.» просто кончилась раньше), и 1 319 живых объявлений были помечены
   * ушедшими. Назавтра 1 282 из них вернулись — то есть 97% того «ухода» было
   * нашим сбоем, а не рынком.
   */
  if (mode !== 'incremental' && completed && claimed && collected < claimed * COMPLETE_MIN_SHARE) {
    log(
      `  ${slug}: собрано ${collected} из ${claimed} обещанных — раздел считаю неполным, ` +
        'ушедшие по нему помечаться не будут',
    );
    return { completed: false };
  }
  return { completed: completed || mode === 'incremental' };
}

/** Догрузить страницы объявлений: продавец, полное описание, год. */
async function crawlDetails(session, slugs, limit, stats, priority = []) {
  const backlog = await store.listingsNeedingDetail(slugs, config.crawl.detailRefreshDays, limit);
  const seenIds = new Set();
  const queue = [];
  for (const r of [...priority, ...backlog]) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    queue.push(r);
    if (queue.length >= limit) break;
  }
  if (!queue.length) return 0;

  log(`деталь: в очереди ${queue.length}`);
  let done = 0;
  for (const row of queue) {
    if (stopping) break;
    const { status, html } = await session.request(row.url);
    stats.pages++;
    if (!html) {
      // 404 — объявление уже снято, это не сбой краула, а нормальный исход
      countError(stats, status === 404 ? 'деталь: 404 (снято)' : `деталь: ответ ${status ?? 'нет'}`);
      continue;
    }
    try {
      const detail = parseDetailPage(html, { url: row.url });
      if (!detail) {
        countError(stats, 'деталь: страница не разобралась');
        continue;
      }
      await store.applyDetail(row.id, detail);
      done++;
    } catch (e) {
      countError(stats, 'деталь: ошибка записи');
      log(`  ошибка детали ${row.external_id}: ${e.message}`);
    }
  }
  log(`деталь: обновлено ${done}`);
  return done;
}

async function runOnce(mode, session) {
  const slugs = OVERRIDE.brands || slugsForTiers(config.crawl.tiers);
  const stats = newStats();
  const seen = new Set();
  const newListings = [];
  const completedSlugs = [];
  const runStartedAt = new Date();
  const mintsBefore = session.mintCount;
  const runId = await store.startRun(mode, `тиры ${config.crawl.tiers.join(',')}, ${slugs.length} марок`);

  log(`=== ${mode}: ${slugs.length} марок (тиры ${config.crawl.tiers.join(',')}) ===`);

  for (const slug of slugs) {
    if (stopping) break;
    const { completed } = await crawlBrand(session, slug, mode, stats, seen, newListings);
    if (completed) completedSlugs.push(slug);
  }

  // Ушедшие помечаем только в полном режиме и только по маркам, пройденным
  // до конца: иначе сетевой сбой «похоронит» живые объявления.
  if (mode === 'full' && !stopping && completedSlugs.length) {
    const res = await store.markGoneExcept([...seen], completedSlugs, runStartedAt);
    if (res.refused) {
      const { candidates, active, pct } = res.refused;
      log(
        `СТОП: проход собрался пометить ушедшими ${candidates} из ${active} активных (${pct}%) — ` +
          'это выше порога, обход считаю неполным. Ничего не помечено.',
      );
      countError(stats, 'неполный обход: пометка ушедших отменена');
    }
    stats.gone = res.gone;
    stats.paused = res.paused;
    log(`ушли из выдачи: ${res.gone}`);
    if (res.paused) {
      // Кабинет целиком исчез — это не продажи. Такие уходы помечены отдельной
      // причиной и в калибровку цен сделок не попадают.
      log(
        `из них ${res.paused} — приостановленные кабинеты (продавцы: ${res.pausedSellers.join(', ')})`,
      );
    }
  }

  // детали: сначала новые объявления этого прохода, потом бэклог
  if (config.crawl.fetchDetails && !stopping) {
    const budget = mode === 'full' ? config.crawl.detailBudget : config.crawl.detailBudgetIncremental;
    await crawlDetails(session, slugs, budget, stats, newListings);
  }

  // сколько раз за прогон пришлось поднимать Chrome за новой кукой: заявленный срок
  // жизни cf_clearance — год, но Cloudflare отзывает её и раньше. Чтобы знать реальную
  // частоту, считаем её здесь, а не гадаем.
  stats.clearanceRefreshes = session.mintCount - mintsBefore;
  const kinds = Object.entries(stats.errorKinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  stats.note =
    `тиры ${config.crawl.tiers.join(',')}; обновлений клиренса ${stats.clearanceRefreshes}` +
    (kinds ? `; ошибки — ${kinds}` : '');
  await store.finishRun(runId, stats);
  log(
    `=== ${mode} готово: страниц ${stats.pages}, объявлений ${stats.seen}, ` +
      `новых ${stats.new}, изменений ${stats.changed} (цена ${stats.priceChanged}), ` +
      `подмен товара ${stats.replaced}, ушло ${stats.gone}` +
      (stats.paused ? ` (из них пауз кабинета ${stats.paused})` : '') +
      `, ошибок ${stats.errors}, ` +
      `обновлений клиренса ${stats.clearanceRefreshes} ===`,
  );
  return stats;
}

/** Когда закончился прошлый полный проход (мс). 0, если его не было. */
async function lastFullRunAt() {
  if (DRY) return 0;
  try {
    const { rows } = await store.q(
      `SELECT max(started_at) AS t FROM ${config.db.schema}.scrape_runs
        WHERE mode = 'full' AND finished_at IS NOT NULL`,
    );
    return rows[0] && rows[0].t ? new Date(rows[0].t).getTime() : 0;
  } catch (e) {
    log(`не смог прочитать время прошлого полного прохода: ${e.message}`);
    return 0;
  }
}

async function main() {
  // Режим: аргумент командной строки, иначе SCRAPE_MODE, иначе incremental.
  // Переменная нужна из-за pm2: он принимает аргументы после «--» за имена скриптов
  // (в логе это выглядит как «Script not found: ...\Scrapper\full»).
  const arg = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
  const mode = (arg || process.env.SCRAPE_MODE || 'incremental').toLowerCase();
  if (!['full', 'incremental', 'details', 'loop'].includes(mode)) {
    console.error('Режим: full | incremental | details | loop');
    process.exit(1);
  }

  // --brands=michelin,toyo — ограничить прогон конкретными марками (проверка/добор)
  const brandsArg = (process.argv.find((a) => a.startsWith('--brands=')) || '').split('=')[1];
  const pagesArg = (process.argv.find((a) => a.startsWith('--pages=')) || '').split('=')[1];
  if (brandsArg) OVERRIDE.brands = brandsArg.split(',').map((s) => s.trim()).filter(Boolean);
  if (pagesArg) OVERRIDE.pages = Number(pagesArg);
  if (DRY) log('РЕЖИМ DRY-RUN: Postgres не используется');

  if (!(await acquireLock(mode))) return;
  process.on('exit', releaseLock);

  // Замок наш, значит других краулеров нет: всё незакрытое — прогоны, убитые на ходу.
  const abandoned = await store.closeAbandonedRuns();
  if (abandoned) log(`закрыл незавершённых прогонов: ${abandoned} (убиты на ходу)`);

  const session = new BamperSession({ ...config.browserFor('scrape'), log });
  await session.start();

  try {
    if (mode === 'details') {
      const slugs = slugsForTiers(config.crawl.tiers);
      const stats = newStats();
      const runId = await store.startRun('details', null);
      await crawlDetails(session, slugs, config.crawl.detailBudget, stats);
      await store.finishRun(runId, stats);
    } else if (mode === 'loop') {
      // Время последнего полного прохода берём из базы, а не из памяти процесса:
      // иначе каждый рестарт pm2 запускал бы лишний полный проход.
      let lastFull = await lastFullRunAt();
      while (!stopping) {
        const needFull = Date.now() - lastFull > config.crawl.fullIntervalMs;
        await runOnce(needFull ? 'full' : 'incremental', session);
        if (needFull) lastFull = Date.now();
        if (stopping) break;
        log(`пауза ${Math.round(config.crawl.incrementalIntervalMs / 60000)} мин`);
        const until = Date.now() + config.crawl.incrementalIntervalMs;
        while (Date.now() < until && !stopping) await sleep(5000);
      }
    } else {
      await runOnce(mode, session);
    }
  } finally {
    await session.stop();
    await store.close();
  }
}

main().catch(async (e) => {
  console.error('фатально:', e);
  await store.close().catch(() => {});
  process.exit(1);
});
