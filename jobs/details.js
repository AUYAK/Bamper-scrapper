'use strict';
// Точка входа для pm2: только добор страниц объявлений (продавцы, полные описания).
// Обычно не нужна — детали добираются после каждого прохода, — но полезна, чтобы
// разово догнать бэклог.
//
//   pm2 start jobs/details.js --name bamper-details --no-autorestart --cron "0 */4 * * *"
process.env.SCRAPE_MODE = 'details';
require('../scrape.js');
