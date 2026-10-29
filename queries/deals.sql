-- Детектор «ниже рынка»: активные объявления дешевле медианы сопоставимых.
--
-- Сопоставимые = тот же типоразмер + сезон + состояние + сегмент марки.
-- Требуем минимум 5 объявлений в группе, иначе «медиана» — это шум.
-- Порог 0.80 (дешевле медианы на 20%+) — крутите под себя.

WITH stats AS (
    SELECT size_key,
           season,
           condition,
           brand_tier,
           count(*)                                                AS n,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY price_byn)  AS p25,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY price_byn)  AS median
      FROM scrapper.listings
     WHERE status = 'active' AND price_byn IS NOT NULL
     GROUP BY 1, 2, 3, 4
    HAVING count(*) >= 5
)
SELECT l.external_id,
       l.brand,
       l.model,
       l.size_key,
       l.season,
       l.condition,
       l.year,
       l.tread_mm,
       l.price_byn,
       round(s.median, 0)                                AS market_median,
       round((l.price_byn / s.median - 1) * 100, 1)       AS diff_pct,
       s.n                                               AS comparables,
       l.city,
       sel.kind                                          AS seller_kind,
       (CURRENT_DATE - l.posted_date)                    AS days_since_posted,
       l.url
  FROM scrapper.listings l
  JOIN stats s USING (size_key, season, condition, brand_tier)
  LEFT JOIN scrapper.sellers sel ON sel.seller_id = l.seller_id
 WHERE l.status = 'active'
   AND l.price_byn IS NOT NULL
   AND l.price_byn < s.median * 0.80
 ORDER BY diff_pct
 LIMIT 100;

-- Вариант строже: сопоставимые той же марки и с похожим остатком протектора.
-- Точнее, но групп с n >= 5 будет заметно меньше — применимо там, где данных много.
--
-- WITH stats AS (
--     SELECT brand_slug, size_key, season, condition,
--            width_bucket(COALESCE(tread_mm, 0), 0, 12, 4) AS tread_bucket,
--            count(*) AS n,
--            percentile_cont(0.50) WITHIN GROUP (ORDER BY price_byn) AS median
--       FROM scrapper.listings
--      WHERE status = 'active' AND price_byn IS NOT NULL
--      GROUP BY 1, 2, 3, 4, 5
--     HAVING count(*) >= 5
-- )
-- SELECT ...
