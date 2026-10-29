'use strict';
/**
 * Chrome нужен ровно для одного: получить куку cf_clearance от Cloudflare.
 * После этого он гасится, а все страницы тянутся обычным HTTP (см. lib/session.js).
 *
 * Почему без Chrome совсем нельзя: bamper.by закрыт non-interactive challenge,
 * clearance выдаётся только после исполнения JS-челленджа в настоящем браузере.
 * Проверено вживую, что НЕ работает:
 *   - curl/fetch без клиренса, с любыми заголовками -> 403 «Just a moment…»;
 *   - Playwright обычным запуском и rebrowser-playwright -> вечный спиннер:
 *     они включают домены CDP (Runtime/Page), и скрипт CF это видит;
 *   - chrome --headless=new -> не проходит.
 * Работает: Chrome стартует отдельным процессом, сам решает челлендж, а мы
 * подключаемся к нему по CDP напрямую и НЕ включаем ни одного домена
 * (Runtime.evaluate работает и без Runtime.enable, поэтому детектор нас не видит).
 *
 * Зависимостей нет: CDP — это JSON поверх WebSocket, встроенного в Node 22+.
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (typeof WebSocket === 'undefined') {
  throw new Error('Нужен Node 22+ (используется встроенный WebSocket). Текущий: ' + process.version);
}

/**
 * Флаги Chrome. Половина — чтобы профиль не разрастался: без них Chrome тащит
 * ML-модели, компоненты и Safe Browsing, и каталог пухнет до 260 МБ (замерено).
 * С этими флагами — около 25 МБ.
 */
const LEAN_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--disable-features=OptimizationGuideModelDownloading,OptimizationHints,MediaRouter,Translate,InterestFeedContentSuggestions',
  '--disk-cache-size=16777216',
  '--media-cache-size=16777216',
  '--lang=ru-RU',
  '--window-size=1200,900',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Минимальный клиент CDP: только Runtime.evaluate и Storage.getCookies. */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
  }

  async connect(timeoutMs = 15000) {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('таймаут подключения к CDP')), timeoutMs);
      this.ws.onopen = () => { clearTimeout(t); resolve(); };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error('не удалось подключиться к CDP')); };
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    };
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP-соединение закрыто'));
      this.pending.clear();
      this.ws = null;
    };
  }

  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.connected) return Promise.reject(new Error('CDP не подключён'));
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`таймаут CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  /** Выполнить JS во вкладке. Runtime.enable намеренно не вызывается. */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'ошибка в странице');
    }
    return r.result?.value;
  }

  close() {
    try { this.ws && this.ws.close(); } catch { /* уже закрыт */ }
    this.ws = null;
  }
}

function targets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('таймаут /json/list')); });
  });
}

/** Погасить только свой Chrome — ищем процесс по каталогу профиля. */
function killChrome(profileDir) {
  const marker = path.basename(profileDir);
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | ` +
        `Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
      { stdio: 'ignore', timeout: 30000 },
    );
  } catch {
    /* нечего гасить */
  }
}

const CHALLENGE_MARKERS = ['Just a moment', 'Один момент', '_cf_chl_opt', 'Выполнение проверки безопасности'];
const looksLikeChallenge = (html) =>
  !html || html.length < 15000 || CHALLENGE_MARKERS.some((m) => html.includes(m));

/** Страница блокировки Cloudflare (ошибка 1020 и подобные) — это не челлендж, ждать нечего. */
const BLOCK_MARKERS = ['you have been blocked', 'Вы заблокированы', 'cf-error-details', 'Access denied', 'error code: 10'];
const looksBlocked = (html) => Boolean(html) && BLOCK_MARKERS.some((m) => html.includes(m));

/** Настоящая страница bamper.by (новый шаблон bamper_new), а не заглушка. */
const looksLikeBamper = (html) =>
  Boolean(html) && (html.includes('id="bamper-app"') || html.includes('ad-card-carousel-wrapper'));

/**
 * Поднять Chrome, дождаться прохождения челленджа и забрать клиренс.
 * Возвращает { cookie, userAgent, mintedAt, expiresAt } и гасит Chrome за собой.
 */
async function mintClearance(opts) {
  const {
    chromePath,
    profileDir,
    port = 9333,
    warmupUrl = 'https://bamper.by/shiny/',
    solveWaitMs = 18000,
    attempts = 3,
    hidden = true,
    keepProfile = false,
    log = console.log,
  } = opts;

  if (!fs.existsSync(chromePath)) {
    throw new Error(
      `Chrome не найден: ${chromePath}. Укажите CHROME_PATH в .env — Chrome нужен только для получения cf_clearance.`,
    );
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    killChrome(profileDir);
    await sleep(800);
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      ...LEAN_FLAGS,
      // окно за пределами экрана: процесс остаётся headed (headless CF режет),
      // но на рабочем столе ничего не мелькает
      ...(hidden ? ['--window-position=-32000,-32000'] : []),
      warmupUrl,
    ];
    const proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    proc.on('error', (e) => log('[clearance] не удалось запустить Chrome:', e.message));

    try {
      // ждём порт, потом даём Chrome самому решить челлендж — не подключаясь
      const deadline = Date.now() + 25000;
      let up = false;
      while (Date.now() < deadline) {
        if (await targets(port).then(() => true).catch(() => false)) { up = true; break; }
        await sleep(500);
      }
      if (!up) {
        throw new Error(
          `Chrome не открыл порт отладки ${port}. Проверьте CHROME_PATH и что процессу доступен рабочий стол.`,
        );
      }
      await sleep(solveWaitMs);

      const list = await targets(port);
      const page = list.find((t) => t.type === 'page' && t.url.includes('bamper.by')) || list.find((t) => t.type === 'page');
      if (!page) throw new Error('в Chrome нет подходящей вкладки');

      const cdp = new CdpClient(page.webSocketDebuggerUrl);
      await cdp.connect();
      try {
        let html = await cdp.evaluate('document.documentElement.outerHTML', { awaitPromise: false });
        if (looksLikeChallenge(html)) {
          log(`[clearance] челлендж ещё не пройден, ждём (попытка ${attempt})`);
          await sleep(15000);
          html = await cdp.evaluate('document.documentElement.outerHTML', { awaitPromise: false });
        }
        if (looksBlocked(html)) {
          throw new Error('Cloudflare заблокировал этот IP (страница «Access denied»), челлендж тут не поможет');
        }
        if (looksLikeChallenge(html)) throw new Error('челлендж не пройден');

        const { cookies } = await cdp.send('Storage.getCookies', {});
        const bamper = cookies.filter((c) => c.domain.includes('bamper.by'));
        const clearance = bamper.find((c) => c.name === 'cf_clearance');
        const userAgent = await cdp.evaluate('navigator.userAgent', { awaitPromise: false });
        const cookie = bamper.map((c) => `${c.name}=${c.value}`).join('; ');

        if (!clearance) {
          // Страница открылась, но куки нет. Два варианта: Cloudflare не стал
          // показывать челлендж этому IP (тогда кука и не нужна — работаем с тем,
          // что есть, а боевой запрос в session.js покажет), либо Chrome показал
          // что-то не то. Печатаем, что именно видит Chrome, чтобы не гадать.
          const title = await cdp.evaluate('document.title', { awaitPromise: false });
          const href = await cdp.evaluate('location.href', { awaitPromise: false });
          const text = await cdp.evaluate(
            "(document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)",
            { awaitPromise: false },
          );
          log(`[clearance] cf_clearance не выдан. Вкладка: ${href} | title: ${title} | куки: ${
            bamper.map((c) => c.name).join(', ') || 'нет'
          } | текст: ${text}`);
          if (!looksLikeBamper(html)) throw new Error('cf_clearance не выдан, и это не страница bamper.by');
          log('[clearance] страница настоящая — Cloudflare челлендж не показал; пробуем работать без cf_clearance');
          return { cookie, userAgent, mintedAt: new Date().toISOString(), expiresAt: null, noClearance: true };
        }

        const expiresAt = clearance.expires > 0 ? new Date(clearance.expires * 1000).toISOString() : null;
        log(`[clearance] получен, действует до ${expiresAt || 'сессии'}`);
        return { cookie, userAgent, mintedAt: new Date().toISOString(), expiresAt };
      } finally {
        cdp.close();
      }
    } catch (e) {
      log(`[clearance] попытка ${attempt} не удалась: ${e.message}`);
      if (attempt === attempts) throw e;
    } finally {
      killChrome(profileDir);
      // профиль нужен только на время получения куки: Chrome успевает нанести
      // в него ~25 МБ служебных данных, а следующее получение будет нескоро
      if (!keepProfile) {
        await sleep(1500); // дать Chrome отпустить файлы
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* занят — переживём */ }
      }
    }
  }
  throw new Error('не удалось получить cf_clearance');
}

module.exports = { mintClearance, killChrome, looksLikeChallenge, looksBlocked, CdpClient, LEAN_FLAGS };
