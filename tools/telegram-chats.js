'use strict';
// Узнать chat_id получателей: каждый должен один раз написать боту /start,
// иначе Telegram ответит «chat not found» при отправке.
//
//   node tools/telegram-chats.js
const tg = require('../lib/telegram');

(async () => {
  try {
    const me = await tg.getMe();
    console.log(`бот: @${me.username}`);
    const updates = await tg.getUpdates({ limit: 100 });
    if (!updates.length) {
      console.log('\nОбновлений нет. Попросите получателей написать боту /start и запустите снова.');
      console.log('Если боту уже писали давно, Telegram мог удалить старые обновления —');
      console.log('пусть напишут ещё раз.');
      return;
    }
    const chats = new Map();
    for (const u of updates) {
      const m = u.message || u.edited_message || u.channel_post;
      if (m && m.chat) chats.set(m.chat.id, m.chat);
    }
    console.log('\nнайденные чаты:');
    for (const c of chats.values()) {
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || '';
      console.log(`  ${c.id}\t${c.type}\t${name}${c.username ? ' @' + c.username : ''}`);
    }
    console.log('\nдля .env:');
    console.log(`TELEGRAM_CHAT_IDS=${[...chats.keys()].join(',')}`);
  } catch (e) {
    console.error('ошибка:', e.message);
    process.exitCode = 1;
  }
})();
