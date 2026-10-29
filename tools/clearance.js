'use strict';
/**
 * Управление куками Cloudflare.
 *
 *   node tools/clearance.js            показать состояние и проверить боем
 *   node tools/clearance.js --refresh  принудительно получить новый клиренс
 *
 * Chrome нужен только здесь. Дальше краулер ходит обычным HTTP.
 */

const fs = require('fs');
const config = require('../config');
const { BamperSession } = require('../lib/session');
const { parseListPage } = require('../lib/parse');

const force = process.argv.includes('--refresh');
const TEST_URL = 'https://bamper.by/shiny/marka_vredestein/kolvo_4/';

(async () => {
  const s = new BamperSession({ ...config.browserFor('tools'), log: (...a) => console.log(...a) });

  if (force) {
    try { fs.unlinkSync(s.clearanceFile); } catch { /* файла и не было */ }
  }

  console.log(`файл клиренса: ${s.clearanceFile}`);
  try {
    await s.start();
  } catch (e) {
    console.error(`\nОШИБКА: ${e.message}`);
    console.error('Chrome нужен только для получения клиренса — проверьте CHROME_PATH в .env');
    process.exitCode = 1;
    return;
  }

  console.log(`  получен:    ${s.clearance.mintedAt}`);
  console.log(`  действует:  до ${s.clearance.expiresAt || 'конца сессии'}`);
  if (s.clearance.noClearance) console.log('  ВНИМАНИЕ:   cf_clearance не выдан, Cloudflare челлендж не показал — работаем без него');
  console.log(`  User-Agent: ${s.clearance.userAgent}`);
  console.log(`  Chrome поднимался в этот раз: ${s.mintCount ? 'да' : 'нет, взят с диска'}`);

  process.stdout.write('\nпроверяю боем... ');
  const t0 = Date.now();
  const html = await s.get(TEST_URL, { retries: 1 });
  if (!html) {
    console.log('НЕ РАБОТАЕТ');
    console.log('Попробуйте: node tools/clearance.js --refresh');
    console.log("Посмотреть, что видит Chrome: $env:CHROME_VISIBLE='true'; node tools/clearance.js --refresh");
    process.exitCode = 1;
    return;
  }
  const cards = parseListPage(html).items.length;
  console.log(`ок: ${html.length} байт, карточек ${cards}, за ${Date.now() - t0} мс`);
  console.log('\nИТОГ: доступ к сайту есть, браузер для работы краулера не нужен');
  // без process.exit: с открытыми keep-alive сокетами он ловит ассерт libuv на Windows
})();
