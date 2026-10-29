-- История по похожим объявлениям для одной позиции.
-- Подставьте external_id интересующего объявления в :target ниже
-- (в psql: \set target '''131232_22673''' , или заменить руками).

-- 1) Похожие: тот же размер + сезон + состояние, активные и уже ушедшие.
--    Ушедшие важнее всего: их цена — та, по которой позиция реально «уходила».
WITH target AS (
    SELECT size_key, season, condition, brand_tier, brand_slug, year, tread_mm, price_byn
      FROM scrapper.listings
     WHERE external_id = :'target'
)
SELECT l.external_id,
       l.brand,
       l.model,
       l.year,
       l.tread_mm,
       l.price_byn,
       l.status,
       l.posted_date,
       EXTRACT(DAY FROM (l.gone_at - l.first_seen))::INT      AS days_to_gone,
       (l.brand_slug = t.brand_slug)                          AS same_brand,
       l.url
  FROM scrapper.listings l
  CROSS JOIN target t
 WHERE l.size_key = t.size_key
   AND l.season IS NOT DISTINCT FROM t.season
   AND l.condition IS NOT DISTINCT FROM t.condition
   AND l.external_id <> :'target'
 ORDER BY same_brand DESC, l.status, l.price_byn;

-- 2) Вердикт по позиции: цена против медианы сопоставимых (активные + ушедшие
--    за последние 180 дней — так выборка больше и учитывает реально ушедшее).
WITH target AS (
    SELECT * FROM scrapper.listings WHERE external_id = :'target'
),
comparable AS (
    SELECT l.price_byn
      FROM scrapper.listings l
      CROSS JOIN target t
     WHERE l.size_key = t.size_key
       AND l.season IS NOT DISTINCT FROM t.season
       AND l.condition IS NOT DISTINCT FROM t.condition
       AND l.brand_tier = t.brand_tier
       AND l.price_byn IS NOT NULL
       AND l.external_id <> t.external_id
       AND (l.status = 'active' OR l.gone_at > now() - interval '180 days')
)
SELECT t.external_id,
       t.title,
       t.price_byn                                                        AS price,
       count(c.price_byn)                                                 AS comparables,
       round(percentile_cont(0.25) WITHIN GROUP (ORDER BY c.price_byn), 0) AS p25,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY c.price_byn), 0) AS median,
       round(percentile_cont(0.75) WITHIN GROUP (ORDER BY c.price_byn), 0) AS p75,
       round((t.price_byn / NULLIF(percentile_cont(0.50) WITHIN GROUP (ORDER BY c.price_byn), 0) - 1) * 100, 1)
                                                                          AS diff_from_median_pct
  FROM target t
  LEFT JOIN comparable c ON true
 GROUP BY t.external_id, t.title, t.price_byn;

-- 3) Своя история этого объявления: срез на каждое изменение и его причина.
SELECT e.scraped_at,
       e.reason,
       e.status,
       e.price_byn,
       e.price_usd,
       e.year,
       e.tread_mm
  FROM scrapper.listing_events e
  JOIN scrapper.listings l ON l.id = e.listing_id
 WHERE l.external_id = :'target'
 ORDER BY e.scraped_at;

-- 4) То же, но сразу «было -> стало» по каждому изменению.
SELECT c.scraped_at, c.reason,
       c.price_was, c.price_now,
       c.year_was,  c.year_now,
       c.status_was, c.status_now
  FROM scrapper.v_changes c
  JOIN scrapper.listings l ON l.id = c.listing_id
 WHERE l.external_id = :'target'
 ORDER BY c.scraped_at;
