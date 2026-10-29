-- Сезонность: как двигаются цены, предложение и скорость уходов по сезонам.
--
-- ГЛАВНОЕ: отдельная таблица «индекс цен по месяцам» не нужна. Историю можно
-- восстановить из listing_events на ЛЮБУЮ прошлую дату:
--   объявление было активно на дату D, если first_seen <= D и (gone_at IS NULL или > D),
--   а его цена на дату D — последнее событие не позже D.
-- Поэтому чем дольше работает краулер, тем длиннее становится сезонный ряд, и
-- задним числом ничего досчитывать не придётся.
--
-- Осторожно: пока накоплен один-два дня наблюдений, все запросы ниже вернут одну
-- точку. Осмысленные кривые появятся через 4-6 недель, полный сезонный цикл — через год.

-- ─── 1) Срез рынка на произвольную дату ──────────────────────────────────────
-- Замените дату, чтобы посмотреть любой прошлый день.
WITH snap AS (
    SELECT DISTINCT ON (l.id)
           l.id, l.season, l.condition, l.size_key, l.brand,
           e.price_byn
      FROM scrapper.listings l
      JOIN scrapper.listing_events e ON e.listing_id = l.id
     WHERE l.first_seen::date <= DATE '2026-08-19'
       AND (l.gone_at IS NULL OR l.gone_at::date > DATE '2026-08-19')
       AND e.scraped_at::date <= DATE '2026-08-19'
     ORDER BY l.id, e.scraped_at DESC
)
SELECT season,
       condition,
       count(*)                                                AS listings,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)   AS median_price
  FROM snap
 WHERE price_byn IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- ─── 2) Индекс цены по неделям и сезонам ─────────────────────────────────────
-- Медиана цены за 1 шт. среди активных на конец каждой недели.
-- Это и есть сезонная кривая: летняя резина к весне дорожает, к осени дешевеет.
WITH weeks AS (
    SELECT generate_series(
             date_trunc('week', (SELECT min(first_seen) FROM scrapper.listings)),
             date_trunc('week', now()),
             interval '1 week'
           )::date AS wk
),
snap AS (
    SELECT DISTINCT ON (w.wk, l.id)
           w.wk, l.season, l.condition, e.price_byn
      FROM weeks w
      JOIN scrapper.listings l
        ON l.first_seen::date <= w.wk + 6
       AND (l.gone_at IS NULL OR l.gone_at::date > w.wk + 6)
      JOIN scrapper.listing_events e
        ON e.listing_id = l.id AND e.scraped_at::date <= w.wk + 6
     ORDER BY w.wk, l.id, e.scraped_at DESC
)
SELECT wk,
       season,
       count(*) FILTER (WHERE condition = 'б/у')                                    AS used_n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn) FILTER (WHERE condition = 'б/у')   AS used_median,
       count(*) FILTER (WHERE condition = 'новые')                                  AS new_n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn) FILTER (WHERE condition = 'новые') AS new_median
  FROM snap
 WHERE price_byn IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- ─── 3) Скорость уходов по сезонам и месяцам ─────────────────────────────────
-- Это ближайший к «спросу» показатель, который у нас есть: спрос мы не видим, но
-- видим, как быстро позиция уходит с рынка. Летом должна быстро уходить летняя,
-- осенью — зимняя.
SELECT to_char(gone_at, 'YYYY-MM')                                       AS month,
       season,
       count(*)                                                          AS gone_n,
       percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(DAY FROM (gone_at - first_seen))
       )                                                                 AS median_days,
       count(*) FILTER (
           WHERE gone_at - first_seen < interval '7 days'
       )                                                                 AS gone_fast
  FROM scrapper.listings
 WHERE status = 'gone' AND gone_at IS NOT NULL
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- ─── 4) Поток нового предложения по неделям ──────────────────────────────────
-- В конце сезона продавать начинают активнее, чем покупать: рост потока летних
-- объявлений в августе-сентябре при замедлении уходов — сигнал переизбытка.
SELECT date_trunc('week', first_seen)::date AS week,
       season,
       count(*)                             AS new_listings,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn) AS median_price
  FROM scrapper.listings
 GROUP BY 1, 2
 ORDER BY 1 DESC, 2;

-- ─── 5) Соотношение «пришло / ушло» по сезонам за месяц ──────────────────────
-- Больше 1 — предложение накапливается (рынок продавца слабеет),
-- меньше 1 — товар вымывается быстрее, чем поступает.
WITH inflow AS (
    SELECT season, count(*) n FROM scrapper.listings
     WHERE first_seen > now() - interval '30 days' GROUP BY 1
),
outflow AS (
    SELECT season, count(*) n FROM scrapper.listings
     WHERE gone_at > now() - interval '30 days' GROUP BY 1
)
SELECT COALESCE(i.season, o.season)                        AS season,
       COALESCE(i.n, 0)                                    AS came,
       COALESCE(o.n, 0)                                    AS left_market,
       round(COALESCE(i.n, 0)::numeric / NULLIF(o.n, 0), 2) AS came_per_left
  FROM inflow i
  FULL JOIN outflow o ON o.season = i.season
 ORDER BY 1;
