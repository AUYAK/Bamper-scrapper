-- Схема scrapper: шины с bamper.by.
--
-- Накатывать под владельцем схемы (lo_admin): CREATE SCHEMA и GRANT требуют его прав.
--   $env:DB_USER='lo_admin'; $env:DB_PASSWORD='...'; node tools/migrate.js
--   psql "host=postgres-ha.local.modsen.app dbname=lodb user=lo_admin" -f migrations/001_scrapper_schema.sql
--
-- ВНИМАНИЕ: файл пересоздаёт схему с нуля. Пока данных нет — это нормально; когда
-- данные появятся, защита ниже не даст их потерять, и менять схему нужно будет
-- отдельной миграцией 002_*.sql.
--
-- ─── УСТРОЙСТВО ──────────────────────────────────────────────────────────────
-- 4 таблицы:
--   listings       одна строка на объявление: неизменяемые параметры шин +
--                  ТЕКУЩЕЕ состояние + last_checked_at
--   listing_events строка на КАЖДОЕ изменение (полный срез меняющихся полей).
--                  Проверка без изменений строки не создаёт — обновляется только
--                  last_checked_at в listings. Полный проход трогает 6 200
--                  объявлений в сутки, а реальных изменений порядка 1 500 в месяц,
--                  поэтому писать строку на каждую проверку смысла нет.
--   sellers        продавец: 1 371 продавец на 6 246 объявлений, данные о нём
--                  приходят со страницы объявления — хранить их на каждое
--                  объявление значило бы ходить на сайт лишний раз
--   scrape_runs    метрики прогонов: отвечает на вопрос «рынок замер или краулер сломался»
--
-- Чего здесь сознательно НЕТ, потому что выводится из listing_events:
--   * таблицы price_changes  -> вьюха v_price_changes (lag по цене)
--   * колонки changed_fields -> вьюха v_changes (сравнение с предыдущей строкой)
--   * таблицы status_logs    -> статус и причина лежат в самих событиях
-- Хранится только то, что НЕ выводится: срез значений и reason (см. ниже).

CREATE SCHEMA IF NOT EXISTS scrapper;

-- ─── защита: не сносить схему, если в ней уже есть данные ────────────────────
DO $$
DECLARE n BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'scrapper' AND table_name = 'listings') THEN
        EXECUTE 'SELECT count(*) FROM scrapper.listings' INTO n;
        IF n > 0 THEN
            RAISE EXCEPTION
                'В scrapper.listings % строк — пересоздание схемы уничтожит их. Пишите миграцию 002_*.sql.', n;
        END IF;
    END IF;
END $$;

DROP VIEW  IF EXISTS scrapper.v_market_stats;
DROP VIEW  IF EXISTS scrapper.v_price_changes;
DROP VIEW  IF EXISTS scrapper.v_changes;
DROP VIEW  IF EXISTS scrapper.v_gone;
DROP VIEW  IF EXISTS scrapper.v_active;
DROP TABLE IF EXISTS scrapper.listing_events;
DROP TABLE IF EXISTS scrapper.listing_snapshots;    -- из прежней версии схемы
DROP TABLE IF EXISTS scrapper.price_changes;        -- из прежней версии схемы
DROP TABLE IF EXISTS scrapper.listing_status_logs;  -- из прежней версии схемы
DROP TABLE IF EXISTS scrapper.listings;
DROP TABLE IF EXISTS scrapper.sellers;
DROP TABLE IF EXISTS scrapper.scrape_runs;



-- ─── продавцы ────────────────────────────────────────────────────────────────
CREATE TABLE scrapper.sellers (
    seller_id     BIGINT PRIMARY KEY,         -- id кабинета на bamper.by
    name          TEXT,
    kind          TEXT,                       -- 'частное лицо' | 'магазин'
    city          TEXT,
    on_site_since DATE,
    rank          INT,                        -- «погоны» из рейтинга bamper
    rank_title    TEXT,                       -- «капитан» и т.п.
    phone         TEXT,
    email         TEXT,
    first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── объявления ──────────────────────────────────────────────────────────────
-- ИДЕНТИЧНОСТЬ: глобального id объявления bamper.by не показывает. В URL и в поле
-- «Артикул» стоит ВНУТРЕННИЙ артикул продавца, между продавцами он не уникален
-- (проверено: артикул 22673 есть и у 131232, и у 283219; бывают буквенные, A794083).
-- Ключ — пара продавец+артикул: base_external_id = '<seller_id>_<article>'.
-- Слаг в ссылке в ключ НЕ входит: проверено, что сайт отдаёт объявление по одному
-- хвосту (detail_x-161841_3584841/ работает), а слаг меняется от любой правки.
--
-- ПОДМЕНА ТОВАРА: продавцы переписывают старое объявление под другие шины. Тогда
-- ключ тот же, но товар другой, и склеивать истории цен нельзя — аналитика увидит
-- обвал цены там, где его не было. Такой случай (сменились марка/размер/количество)
-- закрывает строку статусом 'replaced' и создаёт новую с revision = 2, 3, ...
-- Правки года, сезона, состояния, модели подменой НЕ считаются.
CREATE TABLE scrapper.listings (
    id                  BIGSERIAL PRIMARY KEY,
    external_id         TEXT        NOT NULL UNIQUE,      -- '161841_3584841' или '161841_3584841#2'
    base_external_id    TEXT        NOT NULL,             -- '161841_3584841'
    revision            INT         NOT NULL DEFAULT 1,
    replaced_from       BIGINT      REFERENCES scrapper.listings(id),
    seller_id           BIGINT      REFERENCES scrapper.sellers(seller_id),
    seller_article      TEXT,
    url                 TEXT        NOT NULL,

    -- параметры товара: меняются только при правке продавцом
    title               TEXT,
    description         TEXT,
    brand               TEXT,
    brand_slug          TEXT,
    brand_tier          TEXT,                             -- A премиум | B верхний middle | C прочее
    model               TEXT,
    width               NUMERIC(6,2),
    profile             NUMERIC(6,2),
    diameter            TEXT,                             -- 'R20', у грузовых 'R22.5'
    is_c                BOOLEAN     NOT NULL DEFAULT false,
    size_key            TEXT,                             -- '225/45R18' — разрез для «похожих»
    qty                 INT,
    season              TEXT,                             -- зимние | летние | всесезонные
    vehicle_type        TEXT,                             -- легковые | внедорожные | ...
    condition           TEXT,                             -- новые | б/у | наварные
    year                INT,                              -- год выпуска шины
    tread_mm            NUMERIC(4,1),                     -- остаток протектора из описания
    tread_raw           TEXT,                             -- исходная подстрока (для проверки правил)
    city                TEXT,
    photo_count         INT,
    delivery            TEXT,

    -- цены: BYN — настоящая валюта сайта, USD — его же справочный пересчёт
    -- (округлён до целых долларов). Держим обе: рубль дрейфует, и сравнивать
    -- цены во времени по USD часто честнее.
    price_byn           NUMERIC(12,2),                    -- NULL = цена не указана
    price_set_byn       NUMERIC(12,2),
    price_usd           NUMERIC(12,2),

    posted_date         DATE,                             -- дата объявления на сайте
    -- поднятия сознательно не пишем в историю: продавцы поднимают почти ежедневно,
    -- это дало бы десятки тысяч строк без пользы. Держим агрегат.
    bump_count          INT         NOT NULL DEFAULT 0,
    last_bumped_at      TIMESTAMPTZ,

    status              TEXT        NOT NULL DEFAULT 'active',  -- active | gone | replaced
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),     -- видели в выдаче
    last_changed_at     TIMESTAMPTZ,                            -- когда реально что-то изменилось
    gone_at             TIMESTAMPTZ,
    detail_fetched_at   TIMESTAMPTZ,
    raw                 JSONB
);

CREATE UNIQUE INDEX listings_base_rev_idx ON scrapper.listings (base_external_id, revision);
CREATE INDEX listings_base_live_idx  ON scrapper.listings (base_external_id) WHERE status <> 'replaced';
CREATE INDEX listings_brand_idx      ON scrapper.listings (brand_slug);
CREATE INDEX listings_size_idx       ON scrapper.listings (size_key);
CREATE INDEX listings_status_idx     ON scrapper.listings (status);
CREATE INDEX listings_posted_idx     ON scrapper.listings (posted_date);
CREATE INDEX listings_seller_idx     ON scrapper.listings (seller_id);
-- основной разрез для «похожих объявлений» и рыночной медианы
CREATE INDEX listings_market_idx     ON scrapper.listings (size_key, season, condition, brand_slug);

-- ─── история изменений ───────────────────────────────────────────────────────
-- Строка = полный срез меняющихся полей на момент изменения. Поэтому «что было до»
-- отдельно не хранится: предыдущая строка истории и есть «до» (вьюха v_changes).
--
-- reason — единственное, что из значений НЕ выводится: переход active -> gone
-- выглядит одинаково, а означает разное (пропало из выдачи / подтверждённое 404 /
-- наш промах при проверке).
CREATE TABLE scrapper.listing_events (
    id            BIGSERIAL PRIMARY KEY,
    listing_id    BIGINT      NOT NULL REFERENCES scrapper.listings(id) ON DELETE CASCADE,
    scraped_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason        TEXT        NOT NULL,
    status        TEXT        NOT NULL,
    price_byn     NUMERIC(12,2),
    price_set_byn NUMERIC(12,2),
    price_usd     NUMERIC(12,2),
    year          INT,
    tread_mm      NUMERIC(4,1),
    title         TEXT,
    description   TEXT,
    city          TEXT,
    CONSTRAINT listing_events_reason_chk CHECK (reason IN (
        'new',              -- первое появление: база отсчёта
        'changed',          -- продавец что-то поправил (цена, год, описание, ...)
        'gone_missing',     -- пропало из выдачи, страницу не проверяли
        'gone_confirmed',   -- сходили по ссылке: 404, реально снято
        'alive_on_page',    -- сходили: страница жива -> это наш промах, вернули в active
        'back_in_search',   -- снова появилось в выдаче
        'product_replaced'  -- продавец переписал объявление под другой товар
    ))
);
CREATE INDEX events_listing_idx ON scrapper.listing_events (listing_id, scraped_at DESC);
CREATE INDEX events_time_idx    ON scrapper.listing_events (scraped_at DESC);
CREATE INDEX events_reason_idx  ON scrapper.listing_events (reason);

-- ─── прогоны краулера ────────────────────────────────────────────────────────
CREATE TABLE scrapper.scrape_runs (
    id            BIGSERIAL PRIMARY KEY,
    mode          TEXT,                       -- full | incremental | details | status
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    pages         INT NOT NULL DEFAULT 0,
    listings_seen INT NOT NULL DEFAULT 0,
    new_count     INT NOT NULL DEFAULT 0,
    changed_count INT NOT NULL DEFAULT 0,
    price_changed INT NOT NULL DEFAULT 0,
    replaced      INT NOT NULL DEFAULT 0,
    gone_count    INT NOT NULL DEFAULT 0,
    errors        INT NOT NULL DEFAULT 0,
    note          TEXT
);

-- ─── представления ───────────────────────────────────────────────────────────

-- Активный рынок с посчитанным «сколько дней висит».
CREATE OR REPLACE VIEW scrapper.v_active AS
SELECT l.*,
       (CURRENT_DATE - l.posted_date)                AS days_since_posted,
       EXTRACT(DAY FROM (now() - l.first_seen))::INT AS days_tracked
FROM scrapper.listings l
WHERE l.status = 'active';

-- Ушедшие: кандидаты в «продано». Причину снятия сайт не сообщает, поэтому это
-- эвристика. Смотреть вместе с reason последнего события.
CREATE OR REPLACE VIEW scrapper.v_gone AS
SELECT l.*,
       EXTRACT(DAY FROM (l.gone_at - l.first_seen))::INT AS days_to_gone
FROM scrapper.listings l
WHERE l.status = 'gone';

-- Что именно изменилось: сравнение каждой строки истории с предыдущей.
-- IS DISTINCT FROM, а не <>, потому что цена бывает NULL («цена не указана»),
-- и обычное сравнение такие переходы проглатывает.
CREATE OR REPLACE VIEW scrapper.v_changes AS
SELECT e.id,
       e.listing_id,
       e.scraped_at,
       e.reason,
       lag(e.price_byn)   OVER w AS price_was,
       e.price_byn               AS price_now,
       lag(e.price_usd)   OVER w AS price_usd_was,
       e.price_usd               AS price_usd_now,
       lag(e.year)        OVER w AS year_was,
       e.year                    AS year_now,
       lag(e.tread_mm)    OVER w AS tread_was,
       e.tread_mm                AS tread_now,
       lag(e.status)      OVER w AS status_was,
       e.status                  AS status_now,
       lag(e.title)       OVER w AS title_was,
       e.title                   AS title_now,
       lag(e.description) OVER w AS description_was,
       e.description             AS description_now,
       lag(e.city)        OVER w AS city_was,
       e.city                    AS city_now
FROM scrapper.listing_events e
WINDOW w AS (PARTITION BY e.listing_id ORDER BY e.scraped_at);

-- Только изменения цены — замена прежней таблицы price_changes.
CREATE OR REPLACE VIEW scrapper.v_price_changes AS
SELECT c.listing_id,
       c.scraped_at                                     AS changed_at,
       c.price_was                                      AS old_price,
       c.price_now                                      AS new_price,
       (c.price_now - c.price_was)                      AS delta,
       round((c.price_now / c.price_was - 1) * 100, 2)   AS delta_pct
FROM scrapper.v_changes c
WHERE c.price_was IS DISTINCT FROM c.price_now
  AND c.reason <> 'new';

-- Рыночная статистика по разрезу «размер + сезон + состояние + сегмент марки».
-- База для детектора «ниже рынка».
CREATE OR REPLACE VIEW scrapper.v_market_stats AS
SELECT size_key,
       season,
       condition,
       brand_tier,
       count(*)                                                AS n,
       min(price_byn)                                          AS price_min,
       percentile_cont(0.25) WITHIN GROUP (ORDER BY price_byn)  AS p25,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY price_byn)  AS median,
       percentile_cont(0.75) WITHIN GROUP (ORDER BY price_byn)  AS p75,
       max(price_byn)                                          AS price_max,
       avg(price_byn)                                          AS avg_price
FROM scrapper.listings
WHERE status = 'active' AND price_byn IS NOT NULL
GROUP BY size_key, season, condition, brand_tier;

-- ─── права для приложения (выполняет владелец схемы) ─────────────────────────
-- lo_agent не может выдать права сам себе — только владелец схемы или суперюзер.
GRANT USAGE ON SCHEMA scrapper TO lo_agent;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA scrapper TO lo_agent;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA scrapper TO lo_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA scrapper GRANT ALL PRIVILEGES ON TABLES TO lo_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA scrapper GRANT ALL PRIVILEGES ON SEQUENCES TO lo_agent;
