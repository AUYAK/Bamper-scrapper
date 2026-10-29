'use strict';
/**
 * Точка входа для pm2: полный проход по всем маркам + пометка ушедших.
 *
 * Ждёт освобождения замка до 40 минут: инкремент запускается каждые полчаса и
 * неизбежно пересечётся с ночным полным проходом. Просто выйти нельзя — полный
 * проход единственный, кто помечает ушедшие объявления, и его пропуск стоит суток.
 *
 *   pm2 start jobs/full.js --name bamper-full --no-autorestart --cron "0 3 * * *"
 */
process.env.SCRAPE_MODE = 'full';
process.env.SCRAPE_LOCK_WAIT_MS = process.env.SCRAPE_LOCK_WAIT_MS || String(40 * 60 * 1000);
require('../scrape.js');
