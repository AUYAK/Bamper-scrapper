-- Исходы наших рекомендаций: что случилось с объявлением после уведомления.
--
-- Накатывать под владельцем схемы (lo_admin):
--   $env:DB_USER='lo_admin'; $env:DB_PASSWORD='...'; node tools/migrate.js 003_alert_outcomes.sql
--
-- ЗАЧЕМ ВЬЮХА, А НЕ ТАБЛИЦА. В deal_alerts хранится то, что НЕ выводится: мнение
-- модели на момент отправки (цена, оценка рынка, процент скидки). Модель со временем
-- меняется, поэтому этот снимок нужен обязательно. А исход — сколько дней прожило,
-- за сколько ушло, снижали ли цену — выводится из listings и listing_events, и
-- хранить его отдельно значило бы держать состояние, которое может разъехаться.
-- Ту же дисциплину мы применили, когда убрали price_changes и changed_fields.
--
-- Это и есть обучающая выборка: «мы сказали -45%, позиция ушла за 4 дня» против
-- «сказали -25%, висит 40 дней». По ней калибруются пороги и проверяется, стоит ли
-- вообще доверять модели.

CREATE OR REPLACE VIEW scrapper.v_alert_outcomes AS
WITH one_per_alert AS (
    -- одно уведомление могло уйти в несколько чатов: берём по одной строке на факт
    SELECT DISTINCT ON (listing_id, sent_at) *
      FROM scrapper.deal_alerts
     WHERE error IS NULL
     ORDER BY listing_id, sent_at, id
)
SELECT a.id                                                        AS alert_id,
       a.listing_id,
       a.sent_at,
       a.kind,
       a.price_byn                                                 AS alert_price,
       a.market_byn                                                AS alert_market,
       a.discount_pct,

       l.external_id,
       l.brand, l.model, l.size_key, l.season, l.condition, l.year, l.tread_mm,
       l.city, l.url,
       l.status,
       l.price_byn                                                 AS current_price,
       l.gone_at,

       -- сколько дней прошло после рекомендации: до исчезновения либо до сих пор
       round(
         EXTRACT(EPOCH FROM (COALESCE(l.gone_at, now()) - a.sent_at)) / 86400.0, 1
       )                                                           AS days_after_alert,
       (l.gone_at IS NOT NULL)                                     AS gone,

       -- снятие, подтверждённое прямой проверкой (404), — самый надёжный признак
       EXISTS (
         SELECT 1 FROM scrapper.listing_events e
          WHERE e.listing_id = l.id
            AND e.reason = 'gone_confirmed'
            AND e.scraped_at >= a.sent_at
       )                                                           AS gone_confirmed,

       -- если после нашей рекомендации цену ещё снижали, значит по той цене не брали
       (
         SELECT count(*) FROM scrapper.v_price_changes pc
          WHERE pc.listing_id = l.id AND pc.changed_at > a.sent_at
       )                                                           AS price_changes_after,
       (
         SELECT min(pc.new_price) FROM scrapper.v_price_changes pc
          WHERE pc.listing_id = l.id AND pc.changed_at > a.sent_at
       )                                                           AS min_price_after
  FROM one_per_alert a
  JOIN scrapper.listings l ON l.id = a.listing_id;

GRANT SELECT ON scrapper.v_alert_outcomes TO lo_agent;
