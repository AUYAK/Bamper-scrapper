-- Что влияет на цену. Все запросы — по активным объявлениям с указанной ценой.
-- Смотреть их имеет смысл, когда набралось хотя бы несколько тысяч строк.

-- 1) Сегмент марки: медиана цены за 1 шт. внутри одного типоразмера.
--    Сравнивать марки «в целом» нельзя — премиум чаще стоит на дорогих размерах,
--    поэтому фиксируем размер и сезон.
SELECT size_key,
       season,
       brand_tier,
       brand,
       count(*)                                               AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)  AS median
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL AND condition = 'б/у'
 GROUP BY 1, 2, 3, 4
HAVING count(*) >= 3
 ORDER BY size_key, season, median DESC;

-- 2) Год выпуска: насколько дешевеет шина с возрастом (внутри размера и сезона).
SELECT size_key,
       season,
       year,
       count(*)                                               AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)  AS median
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL AND condition = 'б/у' AND year IS NOT NULL
 GROUP BY 1, 2, 3
HAVING count(*) >= 3
 ORDER BY size_key, season, year DESC;

-- 3) Остаток протектора: корреляция с ценой и медиана по интервалам остатка.
SELECT width_bucket(tread_mm, 0, 12, 6) AS tread_bucket,
       min(tread_mm)                                          AS tread_from,
       max(tread_mm)                                          AS tread_to,
       count(*)                                               AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)  AS median
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL AND condition = 'б/у' AND tread_mm IS NOT NULL
 GROUP BY 1
 ORDER BY 1;

SELECT corr(tread_mm, price_byn)  AS corr_tread_price,
       corr(year, price_byn)      AS corr_year_price,
       count(*)                   AS n
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL AND condition = 'б/у';

-- 4) Тип продавца и его звание: магазин против частника при прочих равных.
SELECT s.kind,
       s.rank_title,
       count(*)                                                 AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_byn)  AS median
  FROM scrapper.listings l
  JOIN scrapper.sellers s ON s.seller_id = l.seller_id
 WHERE l.status = 'active' AND l.price_byn IS NOT NULL AND l.condition = 'б/у'
 GROUP BY 1, 2
HAVING count(*) >= 10
 ORDER BY median DESC;

-- 5) Новые против б/у: наценка за новизну в том же размере.
SELECT size_key,
       season,
       condition,
       count(*)                                               AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)  AS median
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL
 GROUP BY 1, 2, 3
HAVING count(*) >= 3
 ORDER BY size_key, season, condition;

-- 6) Диаметр как ценовой драйвер (сводно по рынку).
SELECT diameter,
       count(*)                                               AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)  AS median
  FROM scrapper.listings
 WHERE status = 'active' AND price_byn IS NOT NULL AND condition = 'б/у' AND vehicle_type = 'легковые'
 GROUP BY 1
 ORDER BY median DESC;
