'use strict';
// Точка входа для pm2: уведомления о выгодных позициях.
// Отдельный файл, потому что pm2 на Windows аргументы после «--» принимает за
// имена скриптов.
//
//   pm2 start jobs/notify.js --name bamper-notify --no-autorestart --cron "10,40 * * * *"
require('../notify.js');
