'use strict';
/**
 * Офлайн-проверка парсера на сохранённых страницах (fixtures/).
 * Сети не требует. Запуск: node tools/test-parse.js
 *
 * Фикстуры сняты 29.09.2026 с новой вёрстки bamper.by (шаблон bamper_new).
 * Если сайт снова что-то поменяет, тест это покажет раньше, чем испортится БД.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseListPage,
  parseDetailPage,
  parseTitle,
  parseTread,
  idsFromUrl,
  nextPageUrl,
  rankFromIcon,
} = require('../lib/parse');

const fx = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + ': ' + e.message);
    process.exitCode = 1;
  }
};

console.log('idsFromUrl:');
check('пара продавец+артикул', () => {
  assert.deepStrictEqual(idsFromUrl('/shiny/detail_x_novye-131232_22673/'), {
    seller_id: 131232,
    seller_article: '22673',
    external_id: '131232_22673',
  });
});
check('буквенный артикул', () => {
  assert.strictEqual(idsFromUrl('/shiny/detail_x-131256_A794083/').external_id, '131256_A794083');
});
check('дефис в названии модели не ломает разбор', () => {
  assert.strictEqual(
    idsFromUrl('/shiny/detail_span_michelin_latitude_x-ice_north_2_275_40_r20_span-161841_7814264/').external_id,
    '161841_7814264',
  );
});

console.log('parseTitle:');
check('полный заголовок', () => {
  const r = parseTitle('Barum Polaris 6 255/40 R20, 4 шт., зимние, легковые, б/у, 2025 г.в.');
  assert.strictEqual(r.brand, 'Barum');
  assert.strictEqual(r.model, 'Polaris 6');
  assert.strictEqual(r.width, 255);
  assert.strictEqual(r.profile, 40);
  assert.strictEqual(r.diameter, 'R20');
  assert.strictEqual(r.qty, 4);
  assert.strictEqual(r.season, 'зимние');
  assert.strictEqual(r.vehicle_type, 'легковые');
  assert.strictEqual(r.condition, 'б/у');
  assert.strictEqual(r.year, 2025);
});
check('индекс C и легкогрузовые', () => {
  const r = parseTitle('Maxxis 195/65 R16C, 4 шт., всесезонные, легкогрузовые, б/у, 2020 г.в.');
  assert.strictEqual(r.is_c, true);
  assert.strictEqual(r.vehicle_type, 'легкогрузовые');
});
check('двузначный год', () => {
  assert.strictEqual(parseTitle('Michelin 215/65 R17, 4 шт., зимние, внедорожные, б/у, 21 г.в.').year, 2021);
});
check('составное название марки', () => {
  assert.strictEqual(parseTitle('General Grabber AT3 265/70 R16, 4 шт., летние').brand, 'General Grabber');
});

console.log('parseTread:');
check('остаток из описания', () => {
  assert.strictEqual(parseTread('Продам комплект остаток 8.5мм').tread_mm, 8.5);
});
check('диапазон', () => {
  assert.strictEqual(parseTread('Остаток протектора 2-3 мм. Дефекты на фото').tread_mm, 2.5);
});
check('не путать с шириной', () => {
  assert.strictEqual(parseTread('Шины 205 мм ширина, состояние отличное').tread_mm, null);
});

console.log('rankFromIcon:');
check('слаг спрайта -> номер и название', () => {
  assert.deepStrictEqual(rankFromIcon('/local/templates/bamper_new/public/rankIcons.svg#captain'), {
    seller_rank: 9,
    seller_rank_title: 'капитан',
  });
  assert.deepStrictEqual(rankFromIcon('/x/rankIcons.svg#colonel-general'), {
    seller_rank: 15,
    seller_rank_title: 'генерал-полковник',
  });
});
check('незнакомый слаг не теряется', () => {
  assert.deepStrictEqual(rankFromIcon('/x/rankIcons.svg#admiral'), { seller_rank: null, seller_rank_title: 'admiral' });
  assert.deepStrictEqual(rankFromIcon(undefined), { seller_rank: null, seller_rank_title: null });
});

console.log('parseListPage:');
const P1_URL = 'https://bamper.by/shiny/marka_vredestein/kolvo_4/?sort=DATE-DESC';
const p1 = fx('list-vredestein-p1.html');
const list = parseListPage(p1);
check('20 карточек', () => assert.strictEqual(list.items.length, 20));
check('все external_id уникальны', () =>
  assert.strictEqual(new Set(list.items.map((i) => i.external_id)).size, list.items.length));
check('обязательные поля заполнены у всех', () => {
  for (const key of ['external_id', 'seller_id', 'title', 'url', 'brand', 'width', 'diameter', 'qty', 'city', 'posted_date']) {
    const bad = list.items.filter((i) => i[key] == null);
    assert.strictEqual(bad.length, 0, `${key} пусто у ${bad.length} карточек`);
  }
});
check('полный заголовок собран из title галереи (сезон, состояние, год)', () => {
  const it = list.items.find((i) => i.external_id === '70938_9422761');
  assert.strictEqual(it.title, 'Vredestein 205/55 R17, 4 шт., зимние, легковые, новые, 2022 г.в.');
  assert.strictEqual(it.season, 'зимние');
  assert.strictEqual(it.condition, 'новые');
  assert.strictEqual(it.year, 2022);
});
check('цена за штуку, за комплект и справочный $ за штуку', () => {
  const it = list.items.find((i) => i.external_id === '70938_9422761');
  assert.strictEqual(it.price_byn, 242);
  assert.strictEqual(it.price_set_byn, 968);
  assert.strictEqual(it.price_usd, 80); // на карточке ~320$ за комплект
});
check('дата, город, доставка', () => {
  const it = list.items.find((i) => i.external_id === '70938_9422761');
  assert.strictEqual(it.city, 'Минск');
  assert.strictEqual(it.posted_date.toISOString().slice(5, 10), '09-29');
  assert.strictEqual(it.delivery, 'да');
  const noTruck = list.items.find((i) => i.external_id === '453318_9295722');
  assert.strictEqual(noTruck.delivery, null);
});
check('звание и рейтинг продавца с карточки', () => {
  const it = list.items.find((i) => i.external_id === '70938_9422761');
  assert.strictEqual(it.seller_rank, 9);
  assert.strictEqual(it.seller_rank_title, 'капитан');
  assert.strictEqual(it.seller_rating_pct, 100);
  const priv = list.items.find((i) => i.external_id === '453318_9295722');
  assert.strictEqual(priv.seller_rank, null);
  assert.strictEqual(priv.seller_rating_pct, null);
});
check('фото: карусель плюс «Ещё N фото»', () => {
  assert.ok(list.items.every((i) => i.photo_count > 0));
  const it = list.items.find((i) => i.external_id === '70938_9422761');
  assert.strictEqual(it.photo_count, 6);
  assert.strictEqual(it.photos.length, 6);
  assert.ok(it.photos[0].startsWith('https://bamper.by/upload/shiny/70938/'));
  const many = list.items.find((i) => i.external_id === '66576_8500400');
  assert.strictEqual(many.photo_count, 17);
});
check('остаток протектора из описания карточки', () => {
  const it = list.items.find((i) => i.external_id === '453318_9295722');
  assert.strictEqual(it.tread_mm, 5.5);
});
check('счётчика «Найдено» на странице больше нет', () => assert.strictEqual(list.totalFound, null));

const p2 = fx('list-vredestein-p2-last.html');
check('последняя страница: 7 карточек', () => assert.strictEqual(parseListPage(p2).items.length, 7));
check('за пределами выдачи: 0 карточек', () =>
  assert.strictEqual(parseListPage(fx('list-vredestein-p3-empty.html')).items.length, 0));

console.log('nextPageUrl:');
check('со страницы 1 — ссылка на 2, сортировка сохраняется', () => {
  assert.strictEqual(
    nextPageUrl(p1, P1_URL),
    'https://bamper.by/shiny/marka_vredestein/kolvo_4/?PAGEN_1=2&sort=DATE-DESC',
  );
});
check('с последней страницы — null (есть только ссылка назад)', () => {
  assert.strictEqual(nextPageUrl(p2, P1_URL + '&PAGEN_1=2'), null);
});

const list2 = parseListPage(fx('list-kolvo4-p1.html'));
check('общий раздел: 20 карточек разных марок', () => {
  assert.strictEqual(list2.items.length, 20);
  assert.ok(new Set(list2.items.map((i) => i.brand)).size > 5);
});

console.log('parseDetailPage:');
const d = parseDetailPage(fx('detail-shop.html'), { url: 'https://bamper.by/shiny/detail_x-70938_9422761/' });
check('идентичность и цены', () => {
  assert.strictEqual(d.external_id, '70938_9422761');
  assert.strictEqual(d.price_byn, 242);
  assert.strictEqual(d.price_set_byn, 968);
  assert.strictEqual(d.price_usd, 80);
});
check('атрибуты товара', () => {
  assert.strictEqual(d.brand, 'Vredestein');
  assert.strictEqual(d.year, 2022);
  assert.strictEqual(d.season, 'зимние');
  assert.strictEqual(d.condition, 'новые');
  assert.strictEqual(d.features['Год выпуска'], '2022');
  assert.strictEqual(d.delivery, 'по согласованию');
  assert.ok(d.description.includes('Гарантия на установку'), 'описание полное, не обрезанное');
});
check('фото только свои, без «похожих объявлений»', () => {
  assert.strictEqual(d.photo_count, 6);
  assert.ok(d.photos.every((p) => p.includes('/upload/shiny/70938/')));
});
check('магазин: имя, звание, рейтинг, телефон', () => {
  assert.strictEqual(d.seller.seller_id, 70938);
  assert.strictEqual(d.seller.kind, 'магазин');
  assert.strictEqual(d.seller.name, 'Premium Wheels / Оригинальные диски');
  assert.strictEqual(d.seller.city, 'Минск');
  assert.strictEqual(d.seller.rank, 9);
  assert.strictEqual(d.seller.rating_pct, 100);
  assert.strictEqual(d.seller.reviews, 2);
  assert.strictEqual(d.seller.on_site_since.toISOString().slice(0, 10), '2020-07-07');
  assert.ok(d.seller.phone && d.seller.phone.startsWith('+375'));
});
check('в features нет мусора из подвала сайта', () => {
  assert.ok(!('Объявления' in d.features));
  assert.ok(!('Служба поддержки' in d.features));
});

const dp = parseDetailPage(fx('detail-private.html'), { url: 'https://bamper.by/shiny/detail_x-453318_9295722/' });
check('частное лицо', () => {
  assert.strictEqual(dp.seller.kind, 'частное лицо');
  assert.strictEqual(dp.seller.city, 'Кобрин');
  assert.strictEqual(dp.seller.rank, null);
  assert.strictEqual(dp.condition, 'б/у');
  assert.strictEqual(dp.tread_mm, 5.5);
  assert.ok(dp.seller.phone && dp.seller.phone.startsWith('+375'));
});
check('страница без объявления -> null', () => {
  assert.strictEqual(parseDetailPage('<html><body><main><p>Ничего</p></main></body></html>', { url: 'x' }), null);
});

console.log(`\nпроверок пройдено: ${passed}`);
