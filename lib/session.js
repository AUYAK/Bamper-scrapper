'use strict';
/**
 * Сессия доступа к bamper.by: обычный HTTP + кука cf_clearance.
 *
 * Замерено вживую: с валидным cf_clearance встроенный fetch Node отдаёт страницы
 * без всякого браузера (15/15 страниц подряд при полностью погашенном Chrome),
 * а сама кука живёт год. Поэтому Chrome поднимается только когда клиренса нет или
 * он перестал приниматься — это единицы раз, а не на каждый запрос.
 *
 * Клиренс лежит в data/clearance.json и переживает перезапуски процесса.
 */

const fs = require('fs');
const path = require('path');
const { mintClearance, looksLikeChallenge } = require('./chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Заголовки как у Chrome: клиренс привязан к User-Agent, менять его нельзя. */
function buildHeaders(clearance, referer) {
  const major = (String(clearance.userAgent).match(/Chrome\/(\d+)/) || [])[1] || '131';
  return {
    'User-Agent': clearance.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(referer ? { Referer: referer } : {}),
    ...(clearance.cookie ? { Cookie: clearance.cookie } : {}),
  };
}

class BamperSession {
  constructor(opts = {}) {
    this.chromePath = opts.chromePath;
    this.profileDir = opts.profileDir;
    this.port = opts.port || 9333;
    this.warmupUrl = opts.warmupUrl || 'https://bamper.by/shiny/';
    this.solveWaitMs = opts.solveWaitMs || 18000;
    this.maxSolveAttempts = opts.maxSolveAttempts || 3;
    this.hidden = opts.hidden !== false;
    this.keepProfile = Boolean(opts.keepProfile);
    this.minDelayMs = opts.minDelayMs || 1800;
    this.jitterMs = opts.jitterMs || 900;
    this.requestTimeoutMs = opts.requestTimeoutMs || 45000;
    this.clearanceFile = opts.clearanceFile || path.join(__dirname, '..', 'data', 'clearance.json');
    this.log = opts.log || ((...a) => console.log(...a));

    this.clearance = null;
    this.lastRequestAt = 0;
    this.lastUrl = null;
    this.requestCount = 0;
    this.mintCount = 0;
  }

  /** Поднять сессию: взять клиренс с диска или получить новый через Chrome. */
  async start() {
    this.clearance = this._load();
    if (this.clearance) {
      this.log(`[session] клиренс с диска от ${this.clearance.mintedAt.slice(0, 19).replace('T', ' ')}`);
      return;
    }
    await this.refreshClearance('клиренса нет');
  }

  async refreshClearance(reason) {
    this.log(`[session] получаю cf_clearance через Chrome (${reason})`);
    this.clearance = await mintClearance({
      chromePath: this.chromePath,
      profileDir: this.profileDir,
      port: this.port,
      warmupUrl: this.warmupUrl,
      solveWaitMs: this.solveWaitMs,
      attempts: this.maxSolveAttempts,
      hidden: this.hidden,
      keepProfile: this.keepProfile,
      log: this.log,
    });
    this.mintCount++;
    this._save();
  }

  /**
   * Запрос страницы. Возвращает { status, html } — вызывающему нужна именно
   * разница между «страницы нет» (404) и «нас не пустили / сеть отвалилась»:
   * по первому check-status.js делает вывод «снято/продано», по второму —
   * не делает никакого.
   *
   * 404 считается окончательным ответом: обновлять из-за него клиренс (то есть
   * поднимать Chrome) бессмысленно.
   */
  async request(url, { retries = 2 } = {}) {
    let last = { status: null, html: null };
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!this.clearance) await this.start();
      await this._throttle();

      let status = null;
      let html = null;
      try {
        const res = await fetch(url, {
          headers: buildHeaders(this.clearance, this.lastUrl),
          redirect: 'follow',
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        status = res.status;
        html = await res.text();
        this._mergeSetCookie(res);
      } catch (e) {
        this.log(`[session] ошибка запроса ${url}: ${String(e.message).slice(0, 160)}`);
      }
      this.requestCount++;
      last = { status, html };

      if (status === 200 && !looksLikeChallenge(html)) {
        this.lastUrl = url;
        return { status, html };
      }
      if (status === 404 || status === 410) return { status, html: null };

      if (attempt < retries) {
        this.log(`[session] ответ ${status ?? 'нет'} на ${url} — обновляю клиренс`);
        await this.refreshClearance(`ответ ${status ?? 'нет'}`).catch((e) =>
          this.log(`[session] обновить клиренс не вышло: ${e.message}`),
        );
        await sleep(1000);
      }
    }
    return { status: last.status, html: null };
  }

  /** HTML страницы или null. Когда важен код ответа — используйте request(). */
  async get(url, opts) {
    const { html } = await this.request(url, opts);
    return html;
  }

  /** Совместимость с прежним API: гасить нечего, браузер и так не запущен. */
  async stop() {}

  // ─── внутреннее ────────────────────────────────────────────────────────────

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.clearanceFile, 'utf8'));
      // cookie может быть пустой, если Cloudflare не показал челлендж и куку не выдал
      if (raw.cookie == null || !raw.userAgent) return null;
      if (raw.expiresAt && new Date(raw.expiresAt).getTime() < Date.now()) {
        this.log('[session] сохранённый клиренс истёк');
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.clearanceFile), { recursive: true });
      fs.writeFileSync(this.clearanceFile, JSON.stringify(this.clearance, null, 1));
    } catch (e) {
      this.log(`[session] не удалось сохранить клиренс: ${e.message}`);
    }
  }

  /** Сайт обновляет PHPSESSID и прочее — подхватываем, клиренс не трогаем. */
  _mergeSetCookie(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (!set.length) return;
    const jar = new Map(
      this.clearance.cookie.split('; ').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)];
      }),
    );
    let changed = false;
    for (const line of set) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (name === 'cf_clearance' && !value) continue;
      if (jar.get(name) !== value) {
        jar.set(name, value);
        changed = true;
      }
    }
    if (changed) {
      this.clearance.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      this._save();
    }
  }

  async _throttle() {
    const wait =
      this.minDelayMs + Math.floor(Math.random() * this.jitterMs) - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

module.exports = { BamperSession, looksLikeChallenge };
