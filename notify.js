'use strict';
/**
 * Уведомления в Telegram о позициях сильно ниже рынка.
 *
 *   node notify.js              разобрать свежие события и отправить, что нашлось
 *   node notify.js --dry-run    показать сообщения в консоль, ничего не отправляя
 *   node notify.js --hours 48   шире окно событий (по умолчанию 6 часов)
 *   node notify.js --dry-run --raw  показать сырой HTML сообщения (видно ссылки и разметку)
 *   node notify.js --backfill   записать текущих кандидатов как «уже показанных»,
 *                               ничего не отправляя — разово, перед вводом в работу
 *                               (с --dry-run только показывает список, база не трогается)
 *
 * Срабатывает на два события: появилось новое объявление либо у известного снизили
 * цену. Порог — DEAL_ALERT_PCT (по умолчанию 20% ниже рынка).
 *
 * Отбрасываются позиции с ЗАВЕДОМО изношенным протектором (меньше DEAL_MIN_TREAD_MM).
 * Объявления без указанного остатка остаются: у б/у он известен лишь в 35% случаев.
 *
 * В сообщение попадает не только вердикт модели, но и доказательства: живые
 * сопоставимые того же типоразмера, цены похожих УШЕДШИХ объявлений и своя история
 * цены. У модели толстый хвост (каждый пятый прогноз мимо больше чем на 60%),
 * поэтому решение принимает человек, а бот лишь приносит кандидата с фактами.
 */

const config = require('./config');
const store = require('./lib/store');
const tg = require('./lib/telegram');
const { buildModel } = require('./lib/pricing');
const { canonicalUrl } = require('./lib/parse');

const S = config.db.schema;
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
/**
 * Окно событий. По умолчанию сутки, а не 6 часов — и вот почему.
 *
 * Ночной полный проход даёт основную пачку событий разом. Пока задача уведомлений
 * падала несколько часов, все они ушли из шестичасового окна и потерялись
 * безвозвратно: восемь подходящих позиций мы просто не увидели. Сутки дают запас
 * на простой, перезапуск и сдвиг расписания.
 *
 * Спама от широкого окна нет: повторно об одном объявлении не пишем (deal_alerts),
 * а перебор тысячи кандидатов вместо сотни — это пара секунд процессора.
 */
const HOURS = Number((args.includes('--hours') && args[args.indexOf('--hours') + 1]) || process.env.NOTIFY_WINDOW_HOURS || 24);
const THRESHOLD = Number(process.env.DEAL_ALERT_PCT || 20) / 100;
/**
 * Отсекаем только то, про что ТОЧНО ЗНАЕМ, что протектор изношен: перепродавать
 * комплект с остатком меньше 5 мм смысла нет. Если остаток не указан — оставляем и
 * смотрим вручную: у б/у он известен лишь в 35% случаев, и отбрасывать остальные
 * значило бы терять две трети рынка. У новых шин остаток не указан почти никогда,
 * но там он полный по определению, и такие объявления тоже остаются.
 */
const MIN_TREAD = Number(process.env.DEAL_MIN_TREAD_MM || 5);
/**
 * Проверка фактами, а не только моделью.
 *
 * Модель нормализует сопоставимые к опорной точке (5-6 мм, 2-3 года) и потом
 * применяет к объявлению его собственные множители. В дешёвых изношенных сегментах
 * это переоценивает: у 195/55R16 сопоставимые стояли по 25-76 руб., а модель с
 * премией за протектор 7.2 мм и за Michelin дала оценку 208 — и объявление за 152
 * попало в «27% ниже рынка», хотя оно ДОРОЖЕ медианы точного размера на 52%.
 *
 * Поэтому объявление обязано быть дешевле медианы своего типоразмера минимум на
 * PEER_MIN_DISCOUNT. Если сопоставимых меньше PEER_MIN_COUNT, проверять нечем —
 * такие пропускаем в отправку, но в сообщении об этом сказано прямо.
 */
const PEER_MIN_DISCOUNT = Number(process.env.DEAL_PEER_MIN_DISCOUNT || 0.15);
const PEER_MIN_COUNT = Number(process.env.DEAL_PEER_MIN_COUNT || 3);

/** Медиана: при чётном числе значений — среднее двух средних, а не «то, что попалось». */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const MIN_COMPARABLES = Number(process.env.DEAL_MIN_COMPARABLES || 8);
const SUSPICIOUS_BELOW = 0.25; // дешевле четверти рынка — почти всегда ошибка объявления
const REALERT_DROP = 0.1;      // повторно шумим, только если цена упала ещё на 10%
// Потолок на прогон. Нужен из-за первого запуска: после первичного обхода новыми
// оказываются все объявления сразу, и без потолка в чат улетело бы 141 сообщение.
// В обычном режиме (проверка каждые полчаса) потолок почти никогда не срабатывает.
// Потолок сообщений за прогон. По умолчанию его НЕТ: замерено, что в устойчивом
// режиме инкремент находит 0.6 новых объявлений за прогон, а порог 40% проходят 2.3%
// объявлений — то есть меньше одного уведомления в сутки, ограничивать нечего.
// Ставится через DEAL_MAX_ALERTS, если понадобится (0 или пусто = без ограничения).
const MAX_ALERTS = Number(process.env.DEAL_MAX_ALERTS || 0) || Infinity;
/**
 * Разовый режим для первого запуска. После первичного обхода «новыми» оказываются
 * все 6 200 объявлений сразу, и порог проходят 142 — они сливались бы по 10 за прогон
 * семь часов подряд. --backfill записывает их в deal_alerts как kind='backfill' без
 * отправки: дальше срабатывают только настоящие новые события.
 *
 * Для обучения эти записи даже ценнее отправленных: мы на их исход не влияли,
 * то есть не могли сами купить и тем самым «подтвердить» свою же рекомендацию.
 */
const BACKFILL = args.includes('--backfill');

/**
 * Калибровка появилась в lib/pricing.js позже, чем код, который её читает. Если на
 * машине лежат файлы разных версий (частичное копирование на сервер), model.soldCalibration
 * будет undefined — раньше это валило весь прогон с «Cannot read properties of undefined».
 */
const calibrationOf = (model) =>
  model.soldCalibration || { n: 0, needed: 0, k: null, applied: false, stale: true };

const log = (...a) => console.log(`[${new Date().toISOString().slice(0, 19).replace('T', ' ')}]`, ...a);
const fmt = (n) => (n == null ? '?' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 0 }));

/**
 * Марка и модель для таблицы ушедших. Типоразмер, сезон и состояние у всех строк
 * общие (это ключ подбора), поэтому различает строки именно название шины — без него
 * непонятно, с чем сравниваем: Scorpion Winter 2 и Cinturato P7 в одном размере
 * стоят по-разному. Ширину держим в 20 знаков, иначе таблица уезжает за экран.
 */
const TIRE_NAME_MAX = 20;
function tireName(s) {
  const name = [s.brand, s.model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!name) return '—';
  if (name.length <= TIRE_NAME_MAX) return name;
  // обрезаем по ширине, но без висящего пробела перед многоточием
  return `${name.slice(0, TIRE_NAME_MAX - 1).trimEnd()}…`;
}

/**
 * Собрать текст уведомления.
 *
 * Порядок блоков — порядок решения перекупа: вердикт и деньги, потом доказательства,
 * потом подвох, и только затем служебное.
 *
 * Главное число — отклонение от МЕДИАНЫ ЖИВЫХ АНАЛОГОВ, а не от оценки модели:
 * у модели медианная ошибка около 21%, а медиана аналогов — факт. Оценка модели
 * остаётся, но во второй роли.
 *
 * Описание продавца показывается всегда, когда есть: именно оно объясняет, почему
 * дёшево. «На одном латка», «внутренние края спилены», «3 mm» — без этого проблемная
 * позиция выглядит находкой.
 *
 * Проданные аналоги идут таблицей в <pre>: Telegram таблиц не умеет, но монospace-блок
 * держит колонки, и сравнивать «за сколько и как быстро ушло» становится можно глазами.
 */
function buildMessage({ r, p, kind, priceHistory, peers, sold, peerMid }) {
  const price = Number(r.price_byn);
  const qty = r.qty || 4;
  const hasPeers = peers.length >= PEER_MIN_COUNT && peerMid > 0;

  const vsPeers = hasPeers ? Math.round((price / peerMid - 1) * 100) : null;
  const vsModel = Math.round((price / p.market - 1) * 100);
  // выгода считается от факта (медиана аналогов), если аналогов достаточно
  const marginSet = Math.round(((hasPeers ? peerMid : p.market) - price) * qty);

  const head = kind === 'new' ? '🆕 Новое объявление' : '📉 Снижена цена';
  const basis = hasPeers
    ? `дешевле аналогов на ${Math.abs(vsPeers)}%`
    : `ниже оценки рынка на ${Math.abs(vsModel)}%`;

  const attrs = [
    tg.esc(r.size_key),
    tg.esc(r.season),
    tg.esc(r.condition),
    r.year ? `${r.year} г.` : 'год не указан',
  ];
  if (r.tread_mm != null) attrs.push(`остаток ${r.tread_mm} мм`);
  else if (r.condition !== 'новые') attrs.push('остаток не указан');

  const lines = [
    `${head} — <b>${basis}</b>`,
    '',
    `<b>${tg.esc([r.brand, r.model].filter(Boolean).join(' '))}</b>`,
    attrs.join(' · '),
    '',
    `Цена: <b>${fmt(price)} руб./шт</b> · ${fmt(r.price_set_byn)} руб. за комплект`,
    `Выгода: <b>${fmt(marginSet)} руб.</b> за комплект`,
  ];

  // ─── доказательства: живые аналоги того же типоразмера ──────────────────────
  if (peers.length) {
    lines.push('');
    lines.push(
      `<b>В продаже сейчас</b> (${peers.length}), медиана ${fmt(peerMid)} руб.` +
        (hasPeers ? '' : ' — <i>аналогов мало, проверьте вручную</i>'),
    );
    lines.push(
      peers
        .slice(0, 5)
        .map(
          (x) =>
            `<a href="${tg.esc(canonicalUrl(x.external_id))}">${fmt(x.price_byn)}</a>` +
            `${x.tread_mm ? ' (' + x.tread_mm + 'мм)' : ''}`,
        )
        .join(' · '),
    );
  } else {
    lines.push('');
    lines.push('<b>В продаже сейчас</b>: аналогов того же типоразмера нет — <i>проверьте вручную</i>');
  }

  // ─── таблица проданных аналогов ────────────────────────────────────────────
  if (sold.length) {
    const rows = sold.slice(0, 5).map((s) => {
      const day = s.gone_at ? s.gone_at.toISOString().slice(5, 10).split('-').reverse().join('.') : '  —  ';
      return (
        day.padEnd(6) +
        String(fmt(s.price_byn)).padStart(5) +
        ' ' + String(s.year || '—').padStart(4) +
        ' ' + String(s.tread_mm == null ? '—' : s.tread_mm).padStart(4) +
        ' ' + String(s.days == null ? '—' : s.days).padStart(3) +
        '  ' + tireName(s)
      );
    });
    lines.push('');
    lines.push('<b>Ушли ранее</b> (тот же типоразмер)');
    lines.push(
      `<pre>дата   цена  год  ост  дн  шина\n${rows.join('\n')}</pre>`,
    );
  }

  const model = [`оценка модели ${fmt(p.market)} руб./шт (${vsModel > 0 ? '+' : ''}${vsModel}%)`];
  if (p.expectedSale) model.push(`ожидаемая цена сделки ~${fmt(p.expectedSale)} руб./шт`);
  lines.push('');
  lines.push(model.join(' · '));

  // ─── подвох: описание продавца ─────────────────────────────────────────────
  if (r.description) {
    const d = String(r.description).replace(/\s+/g, ' ').trim();
    lines.push('');
    lines.push(`<blockquote>${tg.esc(d.slice(0, 200))}${d.length > 200 ? '…' : ''}</blockquote>`);
  }

  // ─── история цены: подряд идущие одинаковые цены схлопываем ────────────────
  const priceLine = [];
  for (const h of priceHistory) {
    const prev = priceLine[priceLine.length - 1];
    if (prev && ((prev.price == null && h.price == null) || Number(prev.price) === Number(h.price))) continue;
    priceLine.push(h);
  }
  if (priceLine.length > 1) {
    lines.push('');
    lines.push('<b>История цены</b>');
    let prev = null;
    for (const h of priceLine) {
      const day = h.at.toISOString().slice(5, 10).split('-').reverse().join('.');
      const value = h.price == null ? 'без цены' : `${fmt(h.price)} руб.`;
      // процент показываем со второй строки: видно шаг, а не только уровень
      let delta = '';
      if (prev != null && h.price != null) {
        const step = Math.round((Number(h.price) / prev - 1) * 100);
        if (step !== 0) delta = ` (${step > 0 ? '+' : ''}${step}%)`;
      }
      lines.push(`${day} — ${value}${delta}`);
      if (h.price != null) prev = Number(h.price);
    }
  }

  // ─── служебное ─────────────────────────────────────────────────────────────
  const meta = [tg.esc(r.city)];
  if (r.seller_kind) meta.push(tg.esc(r.seller_kind));
  if (r.posted_date) {
    const days = Math.round((Date.now() - new Date(r.posted_date)) / 86400000);
    meta.push(days <= 0 ? 'подано сегодня' : `подано ${days} дн. назад`);
  }
  lines.push('');
  lines.push(meta.join(' · '));
  lines.push(
    `<a href="${tg.esc(r.url)}">Открыть объявление</a>` +
      ` · разрез ${p.level}, ${p.comparables} сопоставимых`,
  );

  return lines.join('\n');
}

(async () => {
  const chatIds = config.telegram.chatIds;
  if (!chatIds.length && !DRY) {
    log('TELEGRAM_CHAT_IDS пуст — некому отправлять. Получатели должны написать боту /start,');
    log('потом узнать их id: node tools/telegram-chats.js');
    await store.close();
    return;
  }

  let runId = null;
  try {
    // ─── свежие события: новое объявление или снижение цены ──────────────────
    const { rows: candidates } = await store.q(
      `WITH fresh AS (
         SELECT e.listing_id,
                min(CASE WHEN e.reason = 'new' THEN 1 ELSE 2 END) AS kind_rank
           FROM ${S}.listing_events e
          WHERE e.scraped_at > now() - ($1 || ' hours')::interval
            AND e.reason IN ('new', 'changed')
          GROUP BY 1
       ),
       drops AS (
         SELECT DISTINCT listing_id FROM ${S}.v_price_changes
          WHERE changed_at > now() - ($1 || ' hours')::interval AND delta < 0
       )
       SELECT l.*, s.kind AS seller_kind,
              (f.kind_rank = 1) AS is_new,
              (d.listing_id IS NOT NULL) AS is_drop
         FROM fresh f
         JOIN ${S}.listings l ON l.id = f.listing_id
         LEFT JOIN drops d ON d.listing_id = l.id
         LEFT JOIN ${S}.sellers s ON s.seller_id = l.seller_id
        WHERE l.status = 'active' AND l.price_byn IS NOT NULL`,
      [String(HOURS)],
    );
    log(`событий за ${HOURS} ч: кандидатов ${candidates.length}`);
    // Прогон фиксируем в scrape_runs (mode='notify'): без этого «работает ли
    // уведомлятор» видно только в логах pm2 на сервере, а туда лезть неудобно.
    runId = await store.startRun('notify', `окно ${HOURS} ч, кандидатов ${candidates.length}`);
    if (!candidates.length) {
      await store.finishRun(runId, { seen: 0, new: 0, note: 'кандидатов нет' });
      await store.close();
      return;
    }

    // ─── модель на всём рынке ────────────────────────────────────────────────
    const { rows: all } = await store.q(
      `SELECT l.id, l.external_id, l.price_byn, l.size_key, l.width, l.diameter, l.season,
              l.condition, l.brand, l.brand_slug, l.model, l.year, l.tread_mm, l.city,
              l.status, l.gone_at, l.first_seen, s.kind AS seller_kind,
              (SELECT e.reason FROM ${S}.listing_events e
                WHERE e.listing_id = l.id ORDER BY e.scraped_at DESC LIMIT 1) AS last_reason
         FROM ${S}.listings l
         LEFT JOIN ${S}.sellers s ON s.seller_id = l.seller_id
        WHERE l.status <> 'replaced' AND l.price_byn IS NOT NULL`,
    );
    const model = buildModel(all);
    const sc = calibrationOf(model);
    if (sc.stale) {
      log('ВНИМАНИЕ: lib/pricing.js старой версии — калибровка по ушедшим недоступна.');
      log('Скопируйте файлы проекта целиком, иначе цены сделок считаться не будут.');
    } else {
      log(
        `калибровка по ушедшим: ${sc.n}/${sc.needed}` +
          (sc.applied ? ` — применяется, поправка ×${sc.k.toFixed(3)}` : ' — пока цены предложения'),
      );
    }

    // Сначала отбираем всех подходящих и только потом отправляем лучших по выгоде.
    // Иначе при первом запуске (когда «новыми» разом оказываются все объявления)
    // порядок был бы произвольным, и потолок отрезал бы не самое интересное.
    const qualified = [];
    let skipped = 0;
    for (const r of candidates) {
      const kind = r.is_new ? 'new' : r.is_drop ? 'price_drop' : null;
      if (!kind) { skipped++; continue; } // изменилось что-то, кроме цены

      const p = model.predict(r);
      if (!p || !p.reliable || p.comparables < MIN_COMPARABLES) { skipped++; continue; }
      // изношенный протектор — сразу мимо; неизвестный остаётся на ручной просмотр
      if (r.tread_mm != null && Number(r.tread_mm) < MIN_TREAD) { skipped++; continue; }

      const ratio = Number(r.price_byn) / p.market;
      if (ratio > 1 - THRESHOLD) { skipped++; continue; }
      if (ratio < SUSPICIOUS_BELOW) { skipped++; continue; }

      // уже уведомляли? повторяем только при дальнейшем падении цены.
      // В пробном прогоне таблицу не трогаем: она нужна только для реальных отправок,
      // и --dry-run должен работать до накатывания миграции 002.
      if (!DRY) {
        const { rows: prev } = await store.q(
          `SELECT price_byn FROM ${S}.deal_alerts WHERE listing_id = $1 ORDER BY sent_at DESC LIMIT 1`,
          [r.id],
        );
        if (prev.length && Number(r.price_byn) > Number(prev[0].price_byn) * (1 - REALERT_DROP)) {
          skipped++;
          continue;
        }
      }

      // ─── доказательства (нужны ДО решения: они же и проверка) ─────────────
      const { rows: peers } = await store.q(
        `SELECT price_byn, tread_mm, brand, external_id FROM ${S}.listings
          WHERE status = 'active' AND size_key = $1 AND season = $2 AND condition = $3
            AND id <> $4 AND price_byn IS NOT NULL
          ORDER BY price_byn`,
        [r.size_key, r.season, r.condition, r.id],
      );
      const { rows: sold } = await store.q(
        // Проданные аналоги для таблицы. Паузы кабинетов исключены: они отдают 404
        // ровно как продажи, но продажами не являются — на первых сутках один такой
        // магазин дал 16 «продаж» из 40.
        `SELECT l.price_byn, l.year, l.tread_mm, l.gone_at, l.brand, l.model, l.brand, l.model,
                EXTRACT(DAY FROM (l.gone_at - l.first_seen))::INT AS days
           FROM ${S}.listings l
          WHERE l.status = 'gone' AND l.size_key = $1 AND l.season = $2 AND l.condition = $3
            AND l.price_byn IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${S}.listing_events e
               WHERE e.listing_id = l.id AND e.reason = 'seller_paused'
            )
          ORDER BY l.gone_at DESC LIMIT 4`,
        [r.size_key, r.season, r.condition],
      );
      // Главная проверка: объявление должно быть дешевле живых сопоставимых своего
      // типоразмера. Модель ошибается на четверть, факты — нет.
      const peerPrices = peers.map((x) => Number(x.price_byn)).filter((x) => x > 0);
      const peerMid = median(peerPrices);
      if (peerPrices.length >= PEER_MIN_COUNT && peerMid > 0) {
        if (Number(r.price_byn) > peerMid * (1 - PEER_MIN_DISCOUNT)) {
          skipped++;
          continue;
        }
      }

      const { rows: hist } = await store.q(
        `SELECT scraped_at AS at, price_byn AS price FROM ${S}.listing_events
          WHERE listing_id = $1 ORDER BY scraped_at`,
        [r.id],
      );

      qualified.push({
        r,
        p,
        kind,
        ratio,
        marginSet: (p.market - Number(r.price_byn)) * (r.qty || 4),
        peerMid,
        hist,
        peers,
        sold,
      });
    }

    qualified.sort((a, b) => b.marginSet - a.marginSet);

    if (BACKFILL) {
      // --dry-run обязан оставаться безвредным. Раньше backfill писал в deal_alerts
      // и в пробном прогоне тоже — а запись туда глушит будущие уведомления по этим
      // объявлениям, то есть «просто посмотреть» молча съедало настоящие алерты.
      if (DRY) {
        log(`backfill (пробный прогон): записал бы ${qualified.length} кандидатов, база не тронута`);
        for (const { r, p, ratio } of qualified) {
          log(`  ${r.external_id}  ${fmt(r.price_byn)} руб./шт  (-${Math.round((1 - ratio) * 100)}% к оценке ${fmt(p.market)})`);
        }
        await store.close();
        return;
      }
      for (const { r, p, ratio } of qualified) {
        await store.q(
          `INSERT INTO ${S}.deal_alerts (listing_id, kind, price_byn, market_byn, discount_pct)
           VALUES ($1,'backfill',$2,$3,$4)`,
          [r.id, r.price_byn, p.market, (1 - ratio) * 100],
        );
      }
      log(`backfill: записано ${qualified.length} кандидатов без отправки`);
      log('дальше уведомления пойдут только по новым событиям');
      await store.close();
      return;
    }

    const toSend = Number.isFinite(MAX_ALERTS) ? qualified.slice(0, MAX_ALERTS) : qualified;
    if (qualified.length > toSend.length) {
      log(
        `подходящих ${qualified.length}, отправлю ${toSend.length} лучших по выгоде ` +
          `(потолок DEAL_MAX_ALERTS=${MAX_ALERTS})`,
      );
    } else if (qualified.length > 20) {
      // Больше двадцати за раз бывает только на первом запуске, когда «новыми»
      // оказались все объявления сразу. Дальше это признак сбоя порога.
      log(`внимание: подходящих ${qualified.length} — это накопленный запас, а не поток`);
      log('если не хотите разовую пачку, прервите и выполните: node notify.js --backfill');
    }

    let sent = 0;
    for (const { r, p, kind, ratio, hist, peers, sold, peerMid } of toSend) {
      const text = buildMessage({ r, p, kind, priceHistory: hist, peers, sold, peerMid });
      const photo = (r.raw && r.raw.photos && r.raw.photos[0]) || null;

      if (DRY) {
        console.log('\n' + '─'.repeat(70));
        // --raw печатает разметку как есть: единственный способ убедиться, что
        // ссылки и таблица действительно попали в сообщение, ничего не отправляя
        console.log(args.includes('--raw') ? text : text.replace(/<[^>]+>/g, ''));
        sent++;
        continue;
      }

      for (const chatId of chatIds) {
        try {
          // подпись к фото ограничена 1024 символами — длинные шлём отдельным текстом
          const res =
            photo && text.length <= 1000
              ? await tg.sendPhoto(chatId, photo, text)
              : await tg.sendMessage(chatId, text);
          await store.q(
            `INSERT INTO ${S}.deal_alerts (listing_id, kind, price_byn, market_byn, discount_pct, chat_id, message_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [r.id, kind, r.price_byn, p.market, (1 - ratio) * 100, String(chatId), res.message_id],
          );
        } catch (e) {
          log(`не отправилось в ${chatId}: ${e.message}`);
          await store.q(
            `INSERT INTO ${S}.deal_alerts (listing_id, kind, price_byn, market_byn, discount_pct, chat_id, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [r.id, kind, r.price_byn, p.market, (1 - ratio) * 100, String(chatId), e.message.slice(0, 300)],
          );
        }
      }
      sent++;
      log(`${kind}: ${r.external_id} на ${Math.round((1 - ratio) * 100)}% ниже рынка — отправлено`);
    }

    log(`итог: отправлено ${sent}, пропущено ${skipped}${DRY ? ' (пробный прогон)' : ''}`);
    if (runId && !DRY) {
      await store.finishRun(runId, {
        seen: candidates.length,
        new: sent,
        note: `окно ${HOURS} ч; подходящих ${qualified.length}, отправлено ${sent}, пропущено ${skipped}`,
      });
    }
  } catch (e) {
    console.error('ошибка:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
