'use strict';
/**
 * Разбор страниц bamper.by.
 *
 * Вёрстка с сентября 2026 — новый шаблон «bamper_new» на Tailwind: осмысленных
 * классов почти нет, зато есть устойчивые якоря — ссылки, иконки из спрайта и
 * подписи полей. На них и держимся:
 *   список:   a.ad-card-carousel-wrapper[href*="/detail_"] — галерея карточки, её
 *             родитель — сама карточка (20 на страницу); полный заголовок в
 *             атрибуте title галереи; цена за комплект крупно (div.font-bold),
 *             «р./шт.» — за штуку; дата у иконки #calendar, город — ссылка
 *             /catalog/gorod_*, доставка — иконка #truck, звание продавца —
 *             иконка rankIcons.svg#<slug>, рейтинг — бейдж «96%»
 *   объявление: h2 (короткий заголовок), meta[itemprop=price] (за комплект),
 *             блоки <p class="font-semibold">Подпись</p><p>значение</p>,
 *             продавец — блок с «на Bamber.by с dd.mm.yyyy» (звание тут по-старому
 *             картинкой /images/pogony/N.svg), телефон — a[href^=tel:]
 *   пагинация: ссылки ?PAGEN_1=N, слова «След.» больше нет — см. nextPageUrl
 */

const cheerio = require('cheerio');
const { detectBrand } = require('./brands');

const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** "2 680 руб." -> 2680 ; "670" -> 670 */
function num(s) {
  if (s == null) return null;
  const m = String(s).replace(/ /g, ' ').replace(/\s/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Цена вида 670<sup>00</sup> -> 670.00 (копейки в надстрочном теге). */
function priceFromNode($, node) {
  if (!node || !node.length) return null;
  const c = node.clone();
  c.find('div').remove();
  c.find('span').remove(); // вложенные «руб./шт» и блоки других валют
  const kop = clean(c.find('sup').text());
  c.find('sup').remove();
  // берём только первую группу цифр: в h1 после цены идёт «руб. за 1 шт.»
  const whole = (clean(c.text()).match(/\d[\d ]*/) || [''])[0].replace(/\D/g, '');
  if (!whole) return null;
  const value = Number(whole) + (kop ? Number(kop) / 100 : 0);
  // 0 руб. = цена не указана; пишем NULL, иначе появление реальной цены
  // потом не отличить от «цена не менялась»
  return value > 0 ? value : null;
}

/** "~ 222$" / "~222$ • ~18 814₽" / "≈ 320 $" -> {usd, rub} */
function altCurrencies(title) {
  const t = clean(title);
  const usd = t.match(/[~≈]\s*([\d\s]+)\s*\$/);
  const rub = t.match(/[~≈]\s*([\d\s]+)\s*₽/);
  return { usd: usd ? num(usd[1]) : null, rub: rub ? num(rub[1]) : null };
}

/**
 * Разбор заголовка: "Barum Polaris 6 255/40 R20, 4 шт., зимние, легковые, б/у, 2025 г.в."
 * Возвращает нормализованные атрибуты товара.
 */
function parseTitle(title) {
  const t = clean(title).replace(/\s*г\.?\s*в\.?/i, ' г.в.');
  const out = {
    brand: null,
    brand_slug: null,
    model: null,
    width: null,
    profile: null,
    diameter: null,
    is_c: false,
    qty: null,
    season: null,
    vehicle_type: null,
    condition: null,
    year: null,
    is_studded: null,
  };

  // Размер ищем в три захода, от строгого к свободному. Порядок важен: в заголовках
  // хватает чисел, похожих на размер, и свободный шаблон на них ловится первым.
  // Проверено на живых данных, что ломалось:
  //   «Nokian Nordman RS2 94R 205/55 R16» — индекс нагрузки 94R давал «94 R20»;
  //   «Toyo R888r 265/40 R19»            — название модели R888r давало «888 R26»;
  //   «Bridgestone ... 305 40 r20 зад ... 275 45 20п» — два размера в одном заголовке.
  const sizePatterns = [
    // строгий: 255/40 R20, 195/65 ZR16C — три цифры ширины, две профиля
    /(\d{3})\s*[\/xх]\s*(\d{2})\s*Z?R\s*(\d{2}(?:[.,]\d)?)\s*(C)?/i,
    // внедорожный дюймовый: 31x10.5 R15, 31/10 R15
    /(\d{2}(?:[.,]\d)?)\s*[\/xх]\s*(\d{1,2}(?:[.,]\d)?)\s*Z?R\s*(\d{2}(?:[.,]\d)?)\s*(C)?/i,
    // без профиля: 165 R13, 5.00 R12
    /(\d{3}(?:[.,]\d+)?)\s*Z?R\s*(\d{2}(?:[.,]\d)?)\s*(C)?/i,
  ];
  let m = null;
  let noProfile = false;
  for (let i = 0; i < sizePatterns.length; i++) {
    const hit = t.match(sizePatterns[i]);
    if (!hit) continue;
    // у третьего шаблона профиля нет: подставляем пустую группу, чтобы дальше был один вид
    m = i === 2 ? [hit[0], hit[1], undefined, hit[2], hit[3]] : hit;
    m.index = hit.index;
    noProfile = i === 2;
    break;
  }
  if (m) {
    const w = num(m[1]);
    const pr = m[2] ? num(m[2]) : null;
    const d = num(m[3]);
    // Правдоподобность: легковые 125..395 мм и профиль 25..85, дюймовые внедорожные
    // 26..40 дюймов. Неправдоподобный размер лучше не записать вовсе, чем записать
    // неверный: с пустым размером объявление просто не попадёт в ценовую модель,
    // а с неверным — испортит чужой разрез.
    const okMetric = w >= 125 && w <= 395 && (pr == null || (pr >= 25 && pr <= 85));
    const okInch = w >= 26 && w <= 40 && !noProfile;
    const okDia = d >= 10 && d <= 26;
    if (!((okMetric || okInch) && okDia)) m = null;
  }
  if (m) {
    out.width = num(m[1]);
    out.profile = m[2] ? num(m[2]) : null;
    out.diameter = 'R' + String(num(m[3])); // грузовые бывают дробными: R22.5
    out.is_c = Boolean(m[4]);
    const head = t.slice(0, m.index).replace(/[,\s]+$/, '');
    const b = detectBrand(head);
    if (b) {
      out.brand = b.name;
      out.brand_slug = b.slug;
      out.model = b.rest || null;
    } else {
      out.brand = head.split(/\s+/)[0] || null;
      out.model = head.split(/\s+/).slice(1).join(' ') || null;
    }
  } else {
    const b = detectBrand(t);
    if (b) {
      out.brand = b.name;
      out.brand_slug = b.slug;
    }
  }

  const qty = t.match(/(\d+)\s*шт/i);
  if (qty) out.qty = Number(qty[1]);

  if (/всесезонн/i.test(t)) out.season = 'всесезонные';
  else if (/зимн/i.test(t)) out.season = 'зимние';
  else if (/летн/i.test(t)) out.season = 'летние';

  const vt = t.match(/(легкогрузов\w*|легков\w*|грузов\w*|внедорожн\w*|мото|квадроцикл\w*|спецтехник\w*)/i);
  if (vt) {
    const v = vt[1].toLowerCase();
    out.vehicle_type = v.startsWith('легкогруз')
      ? 'легкогрузовые'
      : v.startsWith('легков')
        ? 'легковые'
        : v.startsWith('грузов')
          ? 'грузовые'
          : v.startsWith('внедорожн')
            ? 'внедорожные'
            : v.startsWith('квадроцикл')
              ? 'квадроциклы'
              : v.startsWith('спецтехник')
                ? 'спецтехника'
                : 'мото';
  }

  // внимание: \b в JS — ASCII-граница слова, с кириллицей она не срабатывает
  if (/наварн/i.test(t)) out.condition = 'наварные';
  else if (/б\/у|б_у/i.test(t)) out.condition = 'б/у';
  else if (/новые/i.test(t)) out.condition = 'новые';

  const y = t.match(/(\d{2,4})\s*г\.в\./i);
  if (y) {
    let v = Number(y[1]);
    if (v < 100) v += v > 50 ? 1900 : 2000;
    if (v >= 1980 && v <= new Date().getFullYear() + 1) out.year = v;
  }

  return out;
}

/** Глубина протектора новой шины — для пересчёта «остаток 70%» в миллиметры. */
const NEW_TREAD_MM = { зимние: 9, всесезонные: 8.5, летние: 8 };

/**
 * Остаток протектора из свободного текста описания.
 *
 * Замерено на 2 823 объявлениях б/у с описанием: распознаётся 38%. Продавцы пишут
 * это десятком способов, поддержаны все встреченные формы:
 *   «остаток 5мм», «протектор 6-7мм», «остаток 4,5-5,5 мм», «6/7мм», «6+мм», «остаток 90%»
 *
 * Неочевидные грабли, каждые из которых уже стоили неверных данных:
 *   - запятые заменяем ВСЕ (replace без /g менял только первую, и диапазон
 *     «4,5-5,5» разбирался неправильно);
 *   - дробная часть бывает из ДВУХ знаков. При одном знаке «остаток - 7,84мм»
 *     разбиралось как диапазон «от 7,8 до 4» и давало 5,9 — молчаливо неверно;
 *   - в диапазоне разделитель обязателен, иначе «7.84» само становится «диапазоном»;
 *   - (?<![\d.]) обязателен, иначе «205 мм ширина» даёт «05» -> 5 мм;
 *   - остаток часто пишут по каждой шине: «7,84мм, 7,84мм, 7,81мм и 7,43мм».
 *     Берём среднее по всем найденным значениям одного вида.
 */
function parseTread(text, { season } = {}) {
  const t = clean(text).toLowerCase().replace(/,/g, '.');
  if (!t) return { tread_mm: null, tread_raw: null };
  const newDepth = NEW_TREAD_MM[season] || 8;
  const N = '(\\d{1,2}(?:\\.\\d{1,2})?)'; // 6, 6.5, 7.84
  const KEY = '(?:остаток|остаётся|протектор\\w*|глубина)';
  // «мм» пишут и латиницей: «5mm.», «6.5mm», «протектор 5-5.8mm». Замерено 41 такое
  // объявление, и это самые вредные пропуски: изношенная шина с нераспознанным
  // остатком выглядит выгодной покупкой — видели «3 mm» в списке как скидку 75%.
  const MM = '(?:мм|mm)';

  // Границы разные: числу рядом со словом «остаток» можно верить (1..14 мм, у
  // грузовых протектор глубокий), числу без такого слова — нет. Иначе «болты 12мм»
  // или «проступь 11мм» уедут в остаток протектора. Для непривязанных чисел берём
  // диапазон легкового протектора.
  const ANCHORED = [1, 14];
  const LOOSE = [1.5, 10];

  const patterns = [
    // «остаток 4.5-5.5 мм» — диапазон рядом с ключевым словом
    [`${KEY}[^\\d%]{0,25}(?<![\\d.])${N}\\s*(?:-|–|\\/|до)\\s*${N}\\s*${MM}`, 'range', ANCHORED],
    // «6+мм» — «не меньше шести»
    [`(?<![\\d.])${N}\\s*\\+\\s*${MM}`, 'single', LOOSE],
    // просто диапазон «4-5 мм», «6/7мм»
    [`(?<![\\d.])${N}\\s*(?:-|–|\\/|до)\\s*${N}\\s*${MM}`, 'range', LOOSE],
    // «остаток 5мм»
    [`${KEY}[^\\d%]{0,25}(?<![\\d.])${N}\\s*${MM}`, 'single', ANCHORED],
    // одиночное «6мм» — самая рискованная форма, границы самые узкие
    [`(?<![\\d.])${N}\\s*${MM}`, 'single', LOOSE],
    // проценты остатка — пересчёт приблизительный, зависит от глубины новой шины
    [`${KEY}[^\\d]{0,20}(\\d{2,3})\\s*%`, 'pct', ANCHORED],
    [`(\\d{2,3})\\s*%\\s*(?:остат|протект)`, 'pct', ANCHORED],
  ];

  for (const [src, kind, bounds] of patterns) {
    const plausible = (v) => v >= bounds[0] && v <= bounds[1];
    if (!new RegExp(src).test(t)) continue;
    // забираем ВСЕ вхождения этого вида: остаток нередко указан по каждой шине
    const values = [];
    let firstRaw = null;
    for (const m of t.matchAll(new RegExp(src, 'g'))) {
      if (kind === 'range') {
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        // Диапазон обязан возрастать, и ОБА конца должны быть правдоподобны.
        // Иначе «фото 10-17 - 7мм» читается как диапазон 17..7 и даёт 12 мм —
        // это номера фотографий, а не протектор.
        if (lo <= hi && plausible(lo) && plausible(hi)) values.push((lo + hi) / 2);
      } else if (kind === 'pct') {
        const p = Number(m[1]);
        if (p >= 5 && p <= 100 && plausible((p / 100) * newDepth)) values.push((p / 100) * newDepth);
      } else if (plausible(Number(m[1]))) {
        values.push(Number(m[1]));
      }
      if (values.length && !firstRaw) firstRaw = m[0];
    }
    if (!values.length) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return { tread_mm: Math.round(avg * 10) / 10, tread_raw: firstRaw };
  }
  return { tread_mm: null, tread_raw: null };
}

/** "18.08" (без года) -> Date. Если дата в будущем — значит это прошлый год. */
function parseShortDate(s, now = new Date()) {
  const m = clean(s).match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  if (yyyy) return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  let year = now.getUTCFullYear();
  let d = new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
  if (d.getTime() - now.getTime() > 24 * 3600 * 1000) d = new Date(Date.UTC(year - 1, Number(mm) - 1, Number(dd)));
  return d;
}

/**
 * Идентичность объявления из ссылки:
 *   /shiny/detail_..._novye-131232_22673/  ->  продавец 131232, артикул продавца «22673»
 *
 * ВАЖНО: последний номер — это НЕ id объявления на сайте, а внутренний артикул
 * продавца. Проверено вживую: у продавцов 131232 и 283219 есть объявления с
 * одинаковым артикулом 22673 (разные шины, разная цена), а бывают и буквенные
 * артикулы («A794083»). Глобального id объявления сайт не показывает, поэтому
 * идентичность — пара (продавец, артикул), она же в именах фото:
 * /upload/shiny/131232/131232_22673_127227687.jpg
 *
 * Регексп с жадным `.*` намеренно: он привязывается к ПОСЛЕДНЕМУ «-<цифры>_»,
 * иначе дефис внутри названия модели (Pilot-4_...) уводит разбор не туда.
 */
function idsFromUrl(url) {
  const m = String(url || '')
    .replace(/[?#].*$/, '')
    .match(/^.*-(\d+)_([^/]+)\/?$/);
  if (!m) return { seller_id: null, seller_article: null, external_id: null };
  const seller_id = Number(m[1]);
  const seller_article = decodeURIComponent(m[2]);
  return { seller_id, seller_article, external_id: `${seller_id}_${seller_article}` };
}

/**
 * Звания продавца. В новой вёрстке карточка списка показывает звание иконкой
 * из спрайта rankIcons.svg#<slug>, а страница объявления — как раньше, картинкой
 * /images/pogony/<N>.svg. Номера сверены вживую 29.09.2026 по продавцам, видным
 * и в списке, и на странице объявления: captain 9, major 10, colonel 12,
 * major-general 13, lieutenant-general 14, colonel-general 15. Остальные — по
 * порядку лестницы званий (не сверены); если слага нет в таблице, номер
 * остаётся пустым, а название — латинским слагом из спрайта.
 */
const RANKS = {
  private: [1, 'рядовой'],
  corporal: [2, 'ефрейтор'],
  'junior-sergeant': [3, 'младший сержант'],
  sergeant: [4, 'сержант'],
  'senior-sergeant': [5, 'старший сержант'],
  'junior-lieutenant': [6, 'младший лейтенант'],
  lieutenant: [7, 'лейтенант'],
  'senior-lieutenant': [8, 'старший лейтенант'],
  captain: [9, 'капитан'],
  major: [10, 'майор'],
  'lieutenant-colonel': [11, 'подполковник'],
  colonel: [12, 'полковник'],
  'major-general': [13, 'генерал-майор'],
  'lieutenant-general': [14, 'генерал-лейтенант'],
  'colonel-general': [15, 'генерал-полковник'],
  general: [16, 'генерал армии'],
  'army-general': [16, 'генерал армии'],
  marshal: [17, 'маршал'],
};

function rankFromIcon(href) {
  const slug = (String(href || '').match(/rankIcons\.svg#([\w-]+)/) || [])[1];
  if (!slug) return { seller_rank: null, seller_rank_title: null };
  const known = RANKS[slug];
  return { seller_rank: known ? known[0] : null, seller_rank_title: known ? known[1] : slug };
}

/** Текст атрибута title, в котором сайт оставляет разметку: «<span>Vredestein…</span> 4 шт.» */
const stripTags = (s) => clean(String(s || '').replace(/<[^>]+>/g, ' '));

/** «968 р.» / «242 р./шт.» -> число; «0 р.» -> null (цена не указана). */
function priceFromText(s) {
  const v = num(clean(s).replace(/р\.?\/шт\.?|р\./g, ''));
  return v && v > 0 ? v : null;
}

/** Адрес фото без суффикса миниатюры: обе версии одной картинки считаем одной. */
const photoKey = (src) => String(src).replace(/_t(\.\w+)$/, '$1');

function uniquePhotos($, nodes, baseUrl) {
  const seen = new Set();
  const out = [];
  nodes.each((_, im) => {
    const src = $(im).attr('src');
    if (!src || !src.includes('/upload/')) return;
    const key = photoKey(src);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(key.startsWith('http') ? key : baseUrl + key);
  });
  return out;
}

/**
 * Ссылка на следующую страницу выдачи.
 *
 * Новая вёрстка (сентябрь 2026) не подписывает кнопки словом «След.»: пагинация —
 * ряд кнопок с номерами и стрелка со ссылкой. Ссылки на страницы несут PAGEN_1=N
 * и сохраняют sort=. Поэтому определяем номер текущей страницы из её URL и ищем
 * на странице ссылку ровно на N+1: если её нет — выдача кончилась. За пределами
 * выдачи сайт отдаёт 200 с «Ничего не найдено» и без ссылок, так что лишнего
 * круга не будет.
 */
function nextPageUrl(html, currentUrl, { baseUrl = 'https://bamper.by' } = {}) {
  const $ = cheerio.load(html);
  const pageOf = (u) => Number((String(u || '').match(/[?&]PAGEN_1=(\d+)/) || [])[1] || 1);
  const want = pageOf(currentUrl) + 1;
  let best = null;
  $('a[href*="PAGEN_1="]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (pageOf(href) !== want) return;
    // сайт печатает две формы ссылки: чистую и с ACTION=REWRITED&FORM_DATA — берём чистую
    if (!best || (/ACTION=REWRITED/.test(best) && !/ACTION=REWRITED/.test(href))) best = href;
  });
  if (!best) return null;
  return best.startsWith('http') ? best : baseUrl + best;
}

/**
 * Разбор страницы результатов поиска.
 *
 * totalFound: с сентября 2026 сайт счётчик «Найдено N» по разделу не печатает
 * (в вёрстке он закомментирован), поэтому здесь почти всегда null. Сверка
 * «собрали меньше обещанного» в scrape.js при null не срабатывает; защита от
 * неполного обхода остаётся на уровне прохода (GONE_MAX_SHARE в store.js).
 */
function parseListPage(html, { baseUrl = 'https://bamper.by', now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const totalFound = num((clean($('body').text()).match(/Найдено объявлений:\s*([\d\s]+)/) || [])[1]);
  const items = [];

  $('a.ad-card-carousel-wrapper[href*="/detail_"]').each((_, el) => {
    const gallery = $(el);
    const card = gallery.parent();
    const href = gallery.attr('href');
    if (!href) return;
    const url = href.startsWith('http') ? href : baseUrl + href;
    const ids = idsFromUrl(url);
    if (!ids.external_id) return;

    const body = card.children().eq(1);
    const titleLink = body.find('a[href*="/detail_"]').first();
    // строка «зимние, новые, легковые» и год живут отдельно от названия; полный
    // заголовок в прежнем виде сайт кладёт в title галереи (с тегами внутри)
    const specLine = clean(body.find('span.text-neutral-950').first().text());
    const shortTitle = clean(titleLink.text());
    const title = stripTags(gallery.attr('title')) || clean([shortTitle, specLine].filter(Boolean).join(', '));

    const description = clean(body.find('p.line-clamp-3').first().text()).replace(/\.\.\.$/, '').trim();
    const articleText =
      clean(body.find('p').filter((_, p) => /Артикул/.test($(p).text())).first().find('span').text()) || null;

    const dateText = clean(body.find('use[href$="#calendar"]').closest('div').find('span').first().text());
    const city = clean(body.find('a[href*="/catalog/gorod_"] span').first().text());
    const delivery = body.find('use[href$="#truck"]').length ? 'да' : null;

    const rank = rankFromIcon(body.find('use[href*="rankIcons.svg#"]').first().attr('href'));
    const ratingBadge = body
      .find('span')
      .filter((_, s) => /^\d{1,3}%$/.test(clean($(s).text())))
      .first();
    const seller_rating_pct = ratingBadge.length ? num(ratingBadge.text()) : null;

    // цены: крупно — за комплект, мелко — «р./шт.»; справочные $ и ₽ даны за комплект
    const priceCol = body.children().first();
    const price_set_byn = priceFromText(priceCol.find('div.font-bold').first().text());
    const price_byn = priceFromText(
      priceCol
        .children('div')
        .filter((_, d) => /р\.\s*\/\s*шт/.test($(d).text()))
        .first()
        .text(),
    );
    const altSet = altCurrencies(priceCol.text());
    // в БД справочные валюты хранятся за 1 шт. — как было в старой вёрстке
    const perUnit = price_byn && price_set_byn ? price_byn / price_set_byn : null;
    const price_usd = altSet.usd != null && perUnit ? Math.round(altSet.usd * perUnit) : null;
    const price_rub = altSet.rub != null && perUnit ? Math.round(altSet.rub * perUnit) : null;

    // карусель показывает до 6 фото; на последнем — плашка «Ещё N фото»
    const photos = uniquePhotos($, gallery.find('.carousel-item img'), baseUrl);
    const more = num((clean(gallery.text()).match(/Ещё\s*(\d+)\s*фото/i) || [])[1]);
    const photo_count = more ? photos.length - 1 + more : photos.length;

    const attrs = parseTitle(title);
    const tread = parseTread(description, { season: attrs.season });

    items.push({
      external_id: ids.external_id,
      seller_id: ids.seller_id,
      seller_article: ids.seller_article,
      article_text: articleText,
      seller_rank: rank.seller_rank,
      seller_rank_title: rank.seller_rank_title,
      seller_rating_pct,
      url,
      title,
      description: description || null,
      city: city || null,
      posted_date: parseShortDate(dateText, now),
      price_byn,
      price_set_byn,
      price_usd,
      price_rub,
      photos,
      photo_count,
      delivery,
      ...attrs,
      ...tread,
    });
  });

  return { totalFound, items };
}

/** Разбор страницы одного объявления. */
function parseDetailPage(html, { url = null, baseUrl = 'https://bamper.by', now = new Date() } = {}) {
  const $ = cheerio.load(html);
  const priceMeta = $('meta[itemprop="price"]').first();
  const labels = $('p.font-semibold');
  if (!priceMeta.length && !labels.filter((_, p) => clean($(p).text()) === 'Артикул').length) return null;

  // «подпись -> значение»: <div><p class="font-semibold">Год выпуска</p><p>2022</p></div>
  // Такие же <p class="font-semibold"> есть в подвале (меню) и в блоке продавца —
  // отсекаем всё, где рядом с подписью ссылки или кнопки.
  const features = {};
  labels.each((_, el) => {
    const heading = clean($(el).text());
    if (!$(el).closest('main').length || $(el).parent().find('a, button').length) return;
    const valueNode = $(el).parent().children().not('p.font-semibold, input, label');
    const lis = valueNode.find('li');
    const value = clean(lis.length ? lis.map((_, li) => $(li).text()).get().join('; ') : valueNode.text());
    if (heading && value && !features[heading]) features[heading] = value;
  });

  const shortTitle = clean($('h2').first().text());
  const specLine = clean(
    $('span.text-neutral-950')
      .filter((_, s) => !/\d{2}\.\d{2}\.\d{4}/.test($(s).text()))
      .first()
      .text(),
  );
  const yearFeature = num(features['Год выпуска']);
  // собираем заголовок в прежнем виде «Марка размер, 4 шт., зимние, легковые, б/у, 2025 г.в.»
  const title = clean(
    [shortTitle, specLine, yearFeature ? `${yearFeature} г.в.` : null].filter(Boolean).join(', '),
  );

  const price_set_byn = priceFromText(priceMeta.attr('content') || $('#product-price-tooltip-trigger').text());
  const price_byn = priceFromText(
    $('div')
      .filter((_, d) => $(d).children().length === 0 && /р\.\s*\/\s*шт/.test($(d).text()))
      .first()
      .text(),
  );
  const altSet = altCurrencies($('#product-price-tooltip').text());
  const perUnit = price_byn && price_set_byn ? price_byn / price_set_byn : null;
  const price_usd = altSet.usd != null && perUnit ? Math.round(altSet.usd * perUnit) : null;
  const price_rub = altSet.rub != null && perUnit ? Math.round(altSet.rub * perUnit) : null;

  const description = features['Описание'] || '';
  const dateText = clean(
    $('span.text-neutral-950')
      .filter((_, s) => /\d{2}\.\d{2}\.\d{4}/.test($(s).text()))
      .first()
      .text(),
  );

  const ids = idsFromUrl(url);
  // фото объявления — карусель товара; «похожие объявления» ниже тоже карусель,
  // но их картинки лежат в чужих каталогах /upload/shiny/<другой продавец>/
  const own = ids.seller_id ? `/upload/shiny/${ids.seller_id}/` : '/upload/';
  const photos = uniquePhotos(
    $,
    $('.carousel-item img').filter((_, im) => String($(im).attr('src') || '').includes(own)),
    baseUrl,
  );

  // продавец: блок с «на Bamber.by с dd.mm.yyyy» (сайт печатает его дважды —
  // для мобильной и настольной раскладки, берём первый)
  const sinceNode = $('p')
    .filter((_, p) => /на Bamb?er\.by с/i.test($(p).text()))
    .first();
  const panel = sinceNode.parent();
  const sellerName =
    clean(panel.find('a[href^="/seller/"]').first().text()) || clean(panel.children('p').first().text());
  const since = clean(sinceNode.text()).match(/(\d{2}\.\d{2}\.\d{4})/);
  const ratingHref = panel.find('a[href*="/rating/"]').first().attr('href') || '';
  const seller_id =
    ids.seller_id ||
    num(panel.find('[data-seller-id]').first().attr('data-seller-id')) ||
    num((ratingHref.match(/id=(\d+)/) || [])[1]);
  const rankImg = panel.find('img[src*="/pogony/"]').first().attr('src') || '';
  const seller_rank = num((rankImg.match(/pogony\/(\d+)/) || [])[1]);
  const sellerCity = clean(panel.find('use[href$="#location"]').closest('p,div').find('span').first().text());
  const phone = clean(panel.find('a[href^="tel:"]').first().text()) || null;
  const email = clean(panel.find('a[href^="mailto:"]').first().attr('href') || '').replace(/^mailto:/, '') || null;
  const ratingTitle = panel.find('[title*="положительных"]').first().attr('title') || '';
  const rating = ratingTitle.match(/(\d{1,3})%.*?из\s*(\d+)/);

  const attrsFromTitle = parseTitle(title);
  const attrs = { ...attrsFromTitle };
  if (!attrs.year && yearFeature) attrs.year = yearFeature;
  if (!attrs.condition && features['Состояние']) {
    attrs.condition = parseTitle('X 000/00 R00, ' + features['Состояние']).condition;
  }

  const tread = parseTread(description, { season: attrs.season });

  return {
    external_id: ids.external_id,
    seller_article: ids.seller_article,
    article_text: features['Артикул'] || null,
    url,
    title,
    description: description || null,
    price_byn,
    price_set_byn,
    price_usd,
    price_rub,
    posted_date: parseShortDate(dateText, now),
    photos,
    photo_count: photos.length,
    spec_line: specLine || null,
    delivery: features['Доставка'] || null,
    ...attrs,
    ...tread,
    seller: {
      seller_id,
      name: sellerName || null,
      kind: /частное лицо/i.test(sellerName) ? 'частное лицо' : sellerName ? 'магазин' : null,
      city: sellerCity || null,
      on_site_since: since ? parseShortDate(since[1], now) : null,
      rank: seller_rank,
      rating_pct: rating ? Number(rating[1]) : null,
      reviews: rating ? Number(rating[2]) : null,
      phone,
      email,
    },
    features,
  };
}

/**
 * Короткая каноническая ссылка на объявление из external_id.
 *
 * Проверено вживую: слаг в URL декоративный, сайт находит объявление по одному
 * хвосту «-<продавец>_<артикул>» — работает даже с чужой маркой в слаге.
 * Нужна для сообщений в Telegram: полный URL занимает ~130 символов, короткий ~50,
 * и пять ссылок на сопоставимые перестают выбивать подпись за лимит 1024.
 */
const canonicalUrl = (externalId, baseUrl = 'https://bamper.by') =>
  `${baseUrl}/shiny/detail_x-${externalId}/`;

module.exports = {
  canonicalUrl,
  nextPageUrl,
  rankFromIcon,
  parseListPage,
  parseDetailPage,
  parseTitle,
  parseTread,
  parseShortDate,
  idsFromUrl,
  num,
  clean,
};
