'use strict';
/**
 * Минимальный клиент Telegram Bot API. Без зависимостей — хватает встроенного fetch.
 *
 * Бот у проекта свой (@Stevokay_Scrapper_bot), отдельный от Listings: Telegram
 * допускает только одного слушателя getUpdates на бота, и общий токен в прошлый раз
 * давал вечный «Conflict: terminated by other getUpdates request».
 */

const config = require('../config');

const API = 'https://api.telegram.org/bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Экранирование под parse_mode=HTML: Telegram требует ровно эти три символа. */
const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, payload, { token = config.telegram.botToken, retries = 1 } = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      const json = await res.json();
      if (json.ok) return json.result;
      // 4xx от самого Telegram повторять бессмысленно: «chat not found» и подобное
      // от повтора не исправится
      throw new Error(`${method}: ${json.description || res.status}`);
    } catch (e) {
      const retriable = /fetch failed|timeout|ECONNRESET|ETIMEDOUT|socket/i.test(e.message);
      if (attempt >= retries || !retriable) throw e;
      // Один повтор — пропущенное уведомление это пропущенная сделка, а разовый
      // сетевой сбой к api.telegram.org на сервере случается регулярно.
      await sleep(2000);
    }
  }
}

const sendMessage = (chatId, text, opts = {}) =>
  call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...opts,
  });

/** Фото + подпись. Проверено: картинки bamper.by отдаются без Cloudflare, Telegram их тянет. */
const sendPhoto = (chatId, photoUrl, caption, opts = {}) =>
  call('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
    ...opts,
  });

const getUpdates = (opts = {}) => call('getUpdates', { timeout: 0, ...opts });

const getMe = () => call('getMe', {});

module.exports = { call, sendMessage, sendPhoto, getUpdates, getMe, esc };
