'use strict';
/**
 * Разведка: сколько объявлений в каждом сегменте (марка + kolvo_N) и как
 * выглядит ссылка на следующую страницу. Результат — data/brand-counts.json,
 * по нему планируется объём краула.
 *
 *   node tools/brand-counts.js            # тиры из конфига
 *   node tools/brand-counts.js A B        # явно
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { BamperSession } = require('../lib/session');
const { slugsForTiers, brandBySlug, tierOf } = require('../lib/brands');
const { parseListPage, nextPageUrl } = require('../lib/parse');

const tiers = process.argv.slice(2).length ? process.argv.slice(2) : config.crawl.tiers;

(async () => {
  const slugs = slugsForTiers(tiers);
  console.log(`Тиры ${tiers.join(',')} -> ${slugs.length} марок`);

  const session = new BamperSession(config.browserFor('tools'));
  await session.start();

  const out = [];
  for (const slug of slugs) {
    const url = `${config.crawl.baseUrl}/shiny/marka_${slug}/kolvo_${config.crawl.kolvo}/`;
    const html = await session.get(url);
    if (!html) {
      console.log(`${slug}: НЕ ЗАГРУЗИЛОСЬ`);
      out.push({ slug, error: true });
      continue;
    }
    // с сентября 2026 сайт счётчик «Найдено N» не печатает: found почти всегда null,
    // а объём оценивается по числу страниц (карточек на странице 20)
    const { items, totalFound: found } = parseListPage(html);
    const cards = items.length;
    const next = nextPageUrl(html, url, { baseUrl: config.crawl.baseUrl });
    out.push({ slug, name: brandBySlug(slug)?.name, tier: tierOf(slug), found, cards, next });
    console.log(`${slug}: найдено ${found}, карточек ${cards}, next=${next}`);
  }

  await session.stop();
  fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'brand-counts.json'), JSON.stringify(out, null, 1));
  const total = out.reduce((s, b) => s + (b.found || 0), 0);
  console.log(`\nИТОГО ${total} объявлений, ~${Math.ceil(total / 20)} страниц списка`);
  // без process.exit: с открытыми keep-alive сокетами он ловит ассерт libuv на Windows
})();
