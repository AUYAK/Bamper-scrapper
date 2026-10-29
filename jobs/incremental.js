'use strict';
// Точка входа для pm2: инкрементальный проход (первые страницы свежих).
// Отдельный файл, потому что pm2 на Windows аргументы после «--» принимает за имена
// скриптов (в логе это «Script not found: ...Scrapperincremental»). Здесь
// передавать нечего — режим зашит.
//
//   pm2 start jobs/incremental.js --name bamper-incremental --no-autorestart --cron "*/30 * * * *"
process.env.SCRAPE_MODE = 'incremental';
require('../scrape.js');
