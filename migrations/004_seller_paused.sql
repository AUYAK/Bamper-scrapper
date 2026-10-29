-- Причина «продавец приостановил кабинет» + разовая переразметка накопленного.
--
-- Накатывать под владельцем схемы (lo_admin):
--   $env:DB_USER='lo_admin'; $env:DB_PASSWORD='...'; node tools/migrate.js
--
-- ЗАЧЕМ. У сайта есть кнопка «Приостановить рекламу», гасящая ВСЕ объявления
-- кабинета сразу, и юрлица платят по месяцам — не заплатил, магазин исчез целиком.
-- Такие объявления отдают 404 ровно как проданные, то есть выглядят подтверждёнными
-- продажами.
--
-- Замерено на живых данных за первые сутки: из 40 ушедших 16 принадлежали одному
-- магазину (104809) — новьё premium-размеров по 1000-2100 руб. за шину, шестнадцать
-- комплектов за сутки так не продаются. И вот что это делало с калибровкой цен сделок:
--
--   одиночные уходы (реальные продажи):   n=19, медиана цена/оценка = 0.813
--   кластеры магазинов (пауза кабинета):  n=13, медиана цена/оценка = 1.252
--   всё вместе, как считалось до этого:   n=32, медиана             = 1.063
--
-- То есть без разделения механизм сделал бы вывод «товар уходит ДОРОЖЕ рынка» и
-- завысил бы ожидаемые цены сделок примерно на треть.

-- ─── 1) разрешить новую причину события ──────────────────────────────────────
ALTER TABLE scrapper.listing_events DROP CONSTRAINT IF EXISTS listing_events_reason_chk;
ALTER TABLE scrapper.listing_events ADD CONSTRAINT listing_events_reason_chk CHECK (reason IN (
    'new',              -- первое появление: база отсчёта
    'changed',          -- продавец что-то поправил (цена, год, описание, ...)
    'gone_missing',     -- пропало из выдачи, страницу не проверяли
    'gone_confirmed',   -- сходили по ссылке: 404, реально снято
    'alive_on_page',    -- сходили: страница жива -> это наш промах, вернули в active
    'back_in_search',   -- снова появилось в выдаче
    'product_replaced', -- продавец переписал объявление под другой товар
    'seller_paused'     -- пропало вместе с остальными объявлениями кабинета:
                        -- пауза или неоплата, а не продажа
));

-- ─── 2) разовая переразметка того, что уже накопилось ────────────────────────
-- Критерий: у продавца ушло не меньше 5 объявлений И это не меньше половины всего,
-- что мы у него видели. Одна продажа из трёхсот — нормально; пятнадцать из
-- восемнадцати за сутки — это кабинет, а не покупатели.
--
-- Событие добавляется ПОСЛЕДНИМ, поэтому ценовая модель, которая смотрит на
-- последнюю причину, перестанет брать такие объявления в калибровку.
WITH per_seller AS (
    SELECT seller_id,
           count(*) FILTER (WHERE status = 'gone') AS gone_n,
           count(*)                                AS total_n
      FROM scrapper.listings
     WHERE seller_id IS NOT NULL
     GROUP BY seller_id
),
paused AS (
    SELECT seller_id FROM per_seller
     WHERE gone_n >= 5 AND gone_n >= total_n * 0.5
),
targets AS (
    SELECT l.id, l.status, l.price_byn, l.price_set_byn, l.price_usd,
           l.year, l.tread_mm, l.title, l.description, l.city
      FROM scrapper.listings l
      JOIN paused p ON p.seller_id = l.seller_id
     WHERE l.status = 'gone'
       AND NOT EXISTS (
         SELECT 1 FROM scrapper.listing_events e
          WHERE e.listing_id = l.id AND e.reason = 'seller_paused'
       )
)
INSERT INTO scrapper.listing_events
  (listing_id, reason, status, price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city)
SELECT id, 'seller_paused', status, price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city
  FROM targets;
