'use strict';
/**
 * Что случилось с нашими рекомендациями: ушли ли позиции, за сколько дней,
 * приходилось ли продавцу ещё снижать цену.
 *
 *   node tools/alert-outcomes.js            сводка по корзинам скидки
 *   node tools/alert-outcomes.js --list     список рекомендаций с исходами
 *
 * Это обучающая выборка для калибровки порогов. Читается из вьюхи v_alert_outcomes:
 * мнение модели берётся из deal_alerts (снимок на момент отправки), исход выводится
 * из listings и listing_events.
 *
 * ДВЕ ОГОВОРКИ, без которых цифры обманут:
 *
 * 1. Контрольной группы здесь нет. Мы видим только те объявления, о которых
 *    уведомили. Чтобы понять, лучше ли наш отбор случайного, нужна и вторая
 *    половина — «о чём не уведомили». Хранить прогнозы по всем 6 200 объявлениям
 *    ежедневно не нужно: схема позволяет восстановить рынок на любую прошлую дату,
 *    поэтому позже можно будет прогнать честный бэктест (модель на данных по дату D
 *    против того, что случилось после).
 *
 * 2. Мы сами влияем на исход. Если вы купили комплект по нашей рекомендации,
 *    объявление исчезнет быстро — и метрика запишет «ушло за 2 дня, отличная
 *    рекомендация», то есть модель подтвердит саму себя. Такие случаи надо помечать
 *    отдельно (см. TODO: отметка «купил» через бота).
 */

const config = require('../config');
const store = require('../lib/store');

const S = config.db.schema;
const wantList = process.argv.includes('--list');
const pct = (x) => (x == null ? '—' : (Number(x) * 100).toFixed(0) + '%');

(async () => {
  try {
    const { rows: all } = await store.q(`SELECT * FROM ${S}.v_alert_outcomes ORDER BY sent_at DESC`);
    if (!all.length) {
      console.log('рекомендаций пока нет — notify.js ещё ничего не отправлял');
      return;
    }

    const byKind = all.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
    console.log(`\nвсего записей: ${all.length}  ${JSON.stringify(byKind)}`);
    console.log(
      '  kind=backfill — кандидаты, зафиксированные без отправки: на их исход мы не влияли,\n' +
        '  поэтому для обучения они чище отправленных',
    );
    const gone = all.filter((r) => r.gone);
    const confirmed = all.filter((r) => r.gone_confirmed);
    console.log(`ушли с рынка: ${gone.length} (подтверждено 404: ${confirmed.length})`);
    console.log(`ещё в продаже: ${all.length - gone.length}`);

    const median = (xs) => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    // ─── по корзинам скидки: главный вопрос — уходят ли «сильные» скидки быстрее ──
    const buckets = [
      ['40-50%', 40, 50],
      ['50-60%', 50, 60],
      ['60%+', 60, 999],
    ];
    console.log('\n=== по глубине скидки ===');
    console.log('  корзина   рекомендаций   ушло   медиана дней до ухода   ещё висят, медиана дней');
    for (const [name, lo, hi] of buckets) {
      const inB = all.filter((r) => Number(r.discount_pct) >= lo && Number(r.discount_pct) < hi);
      if (!inB.length) continue;
      const g = inB.filter((r) => r.gone);
      const alive = inB.filter((r) => !r.gone);
      console.log(
        `  ${name.padEnd(9)} ${String(inB.length).padStart(12)} ${String(g.length).padStart(6)}` +
          `   ${String(median(g.map((r) => Number(r.days_after_alert))) ?? '—').padStart(21)}` +
          `   ${String(median(alive.map((r) => Number(r.days_after_alert))) ?? '—').padStart(22)}`,
      );
    }

    // ─── снижали ли цену после нашей рекомендации ────────────────────────────
    // Считаем только ЗНАЧИМЫЕ снижения. Магазины держат прайс в долларах, сайт каждый
    // день пересчитывает его в рубли по курсу, и «шевеление» на доли процента идёт почти
    // по всему рынку — по счётчику событий выходило «149 из 351 снижал цену» при медиане
    // -1%, хотя реальных снижений больше чем на 5% всего четыре.
    const CUT_MIN = Number(process.env.PRICE_MIN_REL || 0.01) * 5;
    const drops = all
      .filter((r) => r.min_price_after != null && Number(r.alert_price) > 0)
      .map((r) => Number(r.min_price_after) / Number(r.alert_price) - 1);
    const cut = drops.filter((d) => d < -CUT_MIN);
    console.log('\n=== цена после рекомендации ===');
    console.log(
      `  продавец снижал цену дальше больше чем на ${Math.round(CUT_MIN * 100)}%: ` +
        `${cut.length} из ${all.length}`,
    );
    if (cut.length) {
      console.log(`  медианное дополнительное снижение: ${pct(median(cut))}`);
      console.log('  (если снижали дальше — значит по нашей цене не забирали, порог можно строже)');
    } else {
      console.log('  цену держат — значит рынку наша цена завышенной не показалась');
    }

    if (wantList) {
      console.log('\n=== список ===');
      for (const r of all) {
        const state = r.gone
          ? `ушло за ${r.days_after_alert} дн.${r.gone_confirmed ? ' (404)' : ''}`
          : `висит ${r.days_after_alert} дн.`;
        console.log(
          `  ${r.sent_at.toISOString().slice(0, 16).replace('T', ' ')}  -${Math.round(r.discount_pct)}%  ` +
            `${String(r.alert_price).padStart(6)} руб.  ${state}`,
        );
        console.log(`     ${r.brand} ${r.model || ''} ${r.size_key} ${r.season} ${r.condition}`.replace(/\s+/g, ' '));
      }
    }

    console.log(
      '\nВыводы можно делать, когда наберётся хотя бы несколько десятков исходов:' +
        '\nдо этого разница между корзинами — случайность.',
    );
  } catch (e) {
    console.error('ошибка:', e.message);
    if (/v_alert_outcomes/.test(e.message)) {
      console.error('вьюхи нет — накатите migrations/003_alert_outcomes.sql под lo_admin');
    }
    process.exitCode = 1;
  } finally {
    await store.close();
  }
})();
