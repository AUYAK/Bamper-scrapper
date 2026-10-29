'use strict';
require('dotenv').config();

const path = require('path');

const env = (k, def) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : def);
const int = (k, def) => Number(env(k, def));
const bool = (k, def) => String(env(k, def)).toLowerCase() === 'true';

module.exports = {
  browser: {
    // ОБЯЗАТЕЛЬНО настоящий Chrome и ОБЯЗАТЕЛЬНО с окном:
    // headless=new Cloudflare режет (проверено).
    chromePath: env('CHROME_PATH', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    profileDir: env('CHROME_PROFILE_DIR', path.join(__dirname, '.cf-profile')),
    port: int('CDP_PORT', 9333),
    warmupUrl: 'https://bamper.by/shiny/',
    solveWaitMs: int('CF_SOLVE_WAIT_MS', 18000),
    minDelayMs: int('REQUEST_DELAY_MS', 1800), // вежливая пауза между запросами
    jitterMs: int('REQUEST_JITTER_MS', 900),
    maxSolveAttempts: int('CF_SOLVE_ATTEMPTS', 3),
    // окно Chrome уводится за пределы экрана; CHROME_VISIBLE=true — показать (отладка)
    hidden: !bool('CHROME_VISIBLE', 'false'),
    // сюда сохраняется cf_clearance, чтобы Chrome не поднимался при каждом старте
    clearanceFile: env('CLEARANCE_FILE', path.join(__dirname, 'data', 'clearance.json')),
  },

  /**
   * Отдельный профиль и порт Chrome на каждый процесс — на случай, если двум
   * процессам одновременно понадобится обновить клиренс: на одном --user-data-dir
   * второй Chrome не поднимется, а гашение по каталогу профиля прибило бы чужой.
   * Файл клиренса при этом ОБЩИЙ: получил один процесс — пользуются все.
   */
  browserFor(name) {
    const b = module.exports.browser;
    if (!name) return b;
    const offsets = { scrape: 0, status: 1, tools: 2 };
    return {
      ...b,
      profileDir: `${b.profileDir}-${name}`,
      port: b.port + (offsets[name] ?? 3),
    };
  },

  crawl: {
    baseUrl: 'https://bamper.by',
    // какие сегменты марок краулим: A — премиум, B — верхний middle.
    // Расширить охват = добавить 'B' (или 'C' для всего рынка) — код не меняется.
    tiers: env('BRAND_TIERS', 'A').split(',').map((s) => s.trim()).filter(Boolean),
    kolvo: int('KOLVO', 4), // комплекты по 4 шт.
    maxPagesPerBrand: int('MAX_PAGES_PER_BRAND', 200),
    // сколько страниц свежих объявлений смотреть в инкрементальном режиме
    incrementalPages: int('INCREMENTAL_PAGES', 3),
    // Продавцы, чьи объявления не пишем вовсе. Замерено 29.09.2026: у 336639 цены
    // 27 000-58 000 руб. за шину (похоже на российские рубли или ошибку ввода), и его
    // 60 позиций задирали медианы по редким размерам. Уже записанные строки переводит
    // в статус 'excluded' миграция 006.
    excludedSellers: new Set(
      env('EXCLUDED_SELLERS', '336639').split(',').map((s) => Number(s.trim())).filter(Boolean),
    ),
    // подтягивать страницу объявления (продавец, полное описание) для новых позиций
    fetchDetails: bool('FETCH_DETAILS', 'true'),
    // не чаще, чем раз в N дней, обновлять деталь по уже известному объявлению
    detailRefreshDays: int('DETAIL_REFRESH_DAYS', 30),
    // сколько страниц объявлений добирать за один прогон (бюджет запросов):
    // на старте бэклог = весь охват, поэтому покрытие набирается за несколько дней
    detailBudget: int('DETAIL_BUDGET', 300),
    // в инкрементальном режиме (каждые 30 мин) бюджет меньше: иначе краулер почти
    // непрерывно шлёт запросы к сайту
    detailBudgetIncremental: int('DETAIL_BUDGET_INCREMENTAL', 60),

    // режим loop
    incrementalIntervalMs: int('INCREMENTAL_INTERVAL_MS', 30 * 60 * 1000),
    fullIntervalMs: int('FULL_INTERVAL_MS', 24 * 60 * 60 * 1000),
  },

  // Уведомления. Бот отдельный от Listings: Telegram допускает только одного
  // слушателя getUpdates на бота, общий токен в прошлый раз давал вечный Conflict.
  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN', ''),
    chatIds: env('TELEGRAM_CHAT_IDS', '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  db: {
    host: env('DB_HOST', 'postgres-ha.local.modsen.app'),
    port: int('DB_PORT', 5432),
    database: env('DB_NAME', 'lodb'),
    user: env('DB_USER', 'lo_agent'),
    password: env('DB_PASSWORD', ''),
    schema: env('DB_SCHEMA', 'scrapper'),
    max: int('DB_POOL_MAX', 5),
  },
};
