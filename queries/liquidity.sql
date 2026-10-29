-- Ходовые позиции: что уходит быстро, что висит, сколько скидывают перед уходом.
--
-- ВАЖНО: уходы из-за паузы кабинета исключены. Продавец может выключить всю рекламу
-- сразу, и тогда десятки объявлений «уходят» за минуту, отдавая 404 как проданные.
-- Такие помечены причиной 'seller_paused' (см. миграцию 004) и ниже отфильтрованы —
-- иначе один приостановленный магазин портит статистику целого месяца.
--
-- ВАЖНО про «продано»: сайт не показывает причину снятия. Мы знаем только, что
-- объявление ушло из выдачи (status = 'gone'). Быстрый уход при живой цене —
-- скорее продажа, долгое висение и уход — скорее истечение срока. Поэтому ниже
-- везде «ушло», а не «продано», и минимальный срок наблюдения задан явно.

-- 1) Скорость уходов по типоразмеру и сезону: медиана дней от появления до ухода.
SELECT size_key,
       season,
       condition,
       count(*)                                                     AS gone_n,
       percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(DAY FROM (gone_at - first_seen))
       )                                                            AS median_days,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_byn)         AS median_price
  FROM scrapper.listings
 WHERE status = 'gone' AND gone_at IS NOT NULL AND price_byn IS NOT NULL
   AND id NOT IN (SELECT listing_id FROM scrapper.listing_events WHERE reason = 'seller_paused')
 GROUP BY 1, 2, 3
HAVING count(*) >= 5
 ORDER BY median_days;

-- 2) Оборачиваемость по маркам: доля ушедших и медиана срока.
SELECT brand,
       brand_tier,
       count(*)                                            AS total,
       count(*) FILTER (WHERE status = 'gone')              AS gone,
       round(100.0 * count(*) FILTER (WHERE status = 'gone') / count(*), 1) AS gone_pct,
       percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(DAY FROM (COALESCE(gone_at, now()) - first_seen))
       )                                                   AS median_days_tracked
  FROM scrapper.listings
 GROUP BY 1, 2
HAVING count(*) >= 20
 ORDER BY gone_pct DESC;

-- 3) Сколько скидывают перед уходом: суммарная динамика цены у ушедших.
SELECT l.brand,
       l.size_key,
       l.season,
       count(DISTINCT l.id)                                        AS listings,
       round(avg(pc.delta_pct), 1)                                 AS avg_change_pct,
       round(min(pc.delta_pct), 1)                                 AS max_drop_pct
  FROM scrapper.listings l
  JOIN scrapper.v_price_changes pc ON pc.listing_id = l.id
 WHERE l.status = 'gone'
 GROUP BY 1, 2, 3
HAVING count(DISTINCT l.id) >= 3
 ORDER BY avg_change_pct;

-- 4) Ушли быстро и без скидки — самый сильный сигнал «цена была рыночной или ниже».
--    Это и есть материал для калибровки детектора в queries/deals.sql.
--    Число изменений цены колонкой не хранится: считаем из истории.
WITH price_moves AS (
    SELECT listing_id, count(*) AS n
      FROM scrapper.v_price_changes
     GROUP BY listing_id
)
SELECT l.external_id,
       l.brand, l.model, l.size_key, l.season, l.condition, l.year, l.tread_mm,
       l.price_byn,
       EXTRACT(DAY FROM (l.gone_at - l.first_seen))::INT AS days_to_gone,
       l.url
  FROM scrapper.listings l
  LEFT JOIN price_moves m ON m.listing_id = l.id
 WHERE l.status = 'gone'
   AND l.price_byn IS NOT NULL
   AND l.gone_at - l.first_seen < interval '7 days'
   AND COALESCE(m.n, 0) = 0
 ORDER BY days_to_gone
 LIMIT 100;

-- 5) Наоборот: висит долго, цену уже снижали — переоценённые позиции.
WITH price_moves AS (
    SELECT listing_id,
           count(*)      AS moves,
           min(delta_pct) AS max_drop_pct
      FROM scrapper.v_price_changes
     GROUP BY listing_id
)
SELECT l.external_id,
       l.brand, l.model, l.size_key, l.season, l.year, l.tread_mm,
       l.price_byn,
       COALESCE(m.moves, 0)  AS price_moves,
       m.max_drop_pct,
       l.bump_count,
       (CURRENT_DATE - l.posted_date) AS days_since_posted,
       l.url
  FROM scrapper.listings l
  LEFT JOIN price_moves m ON m.listing_id = l.id
 WHERE l.status = 'active'
   AND l.price_byn IS NOT NULL
   AND l.posted_date < CURRENT_DATE - 60
 ORDER BY COALESCE(m.moves, 0) DESC, days_since_posted DESC
 LIMIT 100;

-- 6) Спрос по размерам: сколько всего объявлений и сколько ушло за 30 дней.
SELECT size_key,
       season,
       count(*)                                                                   AS active_now,
       (SELECT count(*) FROM scrapper.listings g
         WHERE g.size_key = l.size_key AND g.season = l.season
           AND g.gone_at > now() - interval '30 days')                            AS gone_30d
  FROM scrapper.listings l
 WHERE status = 'active'
 GROUP BY 1, 2
 ORDER BY gone_30d DESC NULLS LAST
 LIMIT 50;
