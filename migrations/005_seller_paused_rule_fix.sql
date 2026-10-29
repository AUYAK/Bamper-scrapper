-- Исправление правила «пауза кабинета» + переразметка по нему.
--
-- Накатывать вручную под владельцем схемы (lo_admin), после 004.
--
-- ЧТО БЫЛО НЕ ТАК. В 004 условие было «ушло не меньше 5 объявлений И это не меньше
-- половины всего, что мы видели у продавца». Доля оказалась негодным признаком:
-- замерено на живых данных за двое суток —
--
--   продавец 283219 (магазин):  ушло  72 из  658 объявлений =  11%
--   продавец 104809 (магазин):  ушло  16 из 2067 объявлений =   1%
--   продавец 209626 (магазин):  ушло  11 из  235 объявлений =   5%
--   продавец 416396 (частник):  ушло   3 из    3 объявлений = 100%
--
-- У крупного магазина пакетное снятие даёт 1-11% его склада, то есть условие на
-- половину не срабатывает никогда, и все эти уходы шли в статистику как продажи.
--
-- ЧТО ЯВЛЯЕТСЯ ПРИЗНАКОМ. Абсолютное число. Распределение по всем продавцам:
-- 29 продавцов потеряли ровно по 1 объявлению (обычные продажи), затем провал —
-- и сразу 3, 11, 16, 72. Поэтому:
--
--   пауза = ушло >= 5 объявлений
--           ИЛИ (ушло >= 3 И это >= половины всего, что мы у него видели)
--
-- Второе слагаемое — для мелких продавцов, у которых исчез весь кабинет целиком.
--
-- Цена ошибки асимметрична: если крупный дилер действительно продал 6 комплектов за
-- сутки, мы потеряем 6 наблюдений из калибровки. Если же примем пакетное снятие за
-- продажи, получим десятки фальшивых — а они, как замерено, переворачивают вывод
-- (медиана цена/оценка 1.25 против 0.81 у настоящих продаж).

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
     WHERE gone_n >= 5
        OR (gone_n >= 3 AND gone_n >= total_n * 0.5)
),
targets AS (
    SELECT l.id, l.price_byn, l.price_set_byn, l.price_usd,
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
SELECT id, 'seller_paused', 'gone', price_byn, price_set_byn, price_usd, year, tread_mm, title, description, city
  FROM targets;
