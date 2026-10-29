-- Качество данных в базе: заполненность полей и подозрительные значения.
-- Смотреть после первых прогонов и потом периодически — если сайт поменяет
-- вёрстку, здесь это будет видно как провал заполненности.

SELECT count(*)                                                            AS listings,
       count(*) FILTER (WHERE status = 'active')                            AS active,
       round(100.0 * count(brand)        / count(*), 1)                     AS brand_pct,
       round(100.0 * count(model)        / count(*), 1)                     AS model_pct,
       round(100.0 * count(size_key)     / count(*), 1)                     AS size_pct,
       round(100.0 * count(season)       / count(*), 1)                     AS season_pct,
       round(100.0 * count(condition)    / count(*), 1)                     AS condition_pct,
       round(100.0 * count(year)         / count(*), 1)                     AS year_pct,
       round(100.0 * count(tread_mm)     / count(*), 1)                     AS tread_pct,
       round(100.0 * count(price_byn)    / count(*), 1)                     AS price_pct,
       round(100.0 * count(seller_id)    / count(*), 1)                     AS seller_pct,
       round(100.0 * count(detail_fetched_at) / count(*), 1)                AS detail_pct
  FROM scrapper.listings;

-- Цена комплекта должна быть равна цене за штуку, умноженной на количество.
-- Расхождения = либо ошибка разбора, либо продавец так и указал.
SELECT external_id, qty, price_byn, price_set_byn, title, url
  FROM scrapper.listings
 WHERE price_byn IS NOT NULL AND price_set_byn IS NOT NULL AND qty IS NOT NULL
   AND abs(price_byn * qty - price_set_byn) > 1
 ORDER BY abs(price_byn * qty - price_set_byn) DESC
 LIMIT 50;

-- Выбросы по цене внутри типоразмера: кандидаты и в «ошибка разбора», и в «сделка».
WITH stats AS (
    SELECT size_key, season, condition,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn) AS median,
           count(*) AS n
      FROM scrapper.listings
     WHERE status = 'active' AND price_byn IS NOT NULL
     GROUP BY 1, 2, 3
    HAVING count(*) >= 10
)
SELECT l.external_id, l.title, l.price_byn, round(s.median, 0) AS median, s.n, l.url
  FROM scrapper.listings l
  JOIN stats s USING (size_key, season, condition)
 WHERE l.status = 'active'
   AND (l.price_byn > s.median * 5 OR l.price_byn < s.median * 0.2)
 ORDER BY l.price_byn / s.median
 LIMIT 50;

-- Марка из заголовка против раздела сайта: если расходится часто,
-- надо править словарь марок или разбор заголовка.
SELECT brand_slug, brand, count(*) AS n
  FROM scrapper.listings
 GROUP BY 1, 2
 ORDER BY 1, n DESC;

-- Остаток протектора: проверить исходные подстроки на бред.
SELECT tread_mm, tread_raw, count(*) AS n
  FROM scrapper.listings
 WHERE tread_mm IS NOT NULL
 GROUP BY 1, 2
 ORDER BY n DESC
 LIMIT 50;

-- Прогоны: ошибки и объёмы, чтобы видеть деградацию.
SELECT id, mode, started_at, finished_at,
       finished_at - started_at AS duration,
       pages, listings_seen, new_count, changed_count, price_changed, gone_count, errors
  FROM scrapper.scrape_runs
 ORDER BY id DESC
 LIMIT 20;
