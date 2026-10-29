-- Отправленные уведомления о выгодных позициях.
--
-- Накатывать под владельцем схемы (lo_admin):
--   $env:DB_USER='lo_admin'; $env:DB_PASSWORD='...'; node tools/migrate.js 002_deal_alerts.sql
--
-- Зачем таблица: без неё одно и то же объявление уходило бы в Telegram при каждом
-- прогоне. Повторное уведомление допускается только если цена упала ещё заметно
-- ниже, чем была на момент прошлой отправки.

CREATE TABLE IF NOT EXISTS scrapper.deal_alerts (
    id           BIGSERIAL PRIMARY KEY,
    listing_id   BIGINT      NOT NULL REFERENCES scrapper.listings(id) ON DELETE CASCADE,
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind         TEXT        NOT NULL,            -- new | price_drop
    price_byn    NUMERIC(12,2),                   -- цена на момент уведомления
    market_byn   NUMERIC(12,2),                   -- оценка рынка моделью
    discount_pct NUMERIC(6,2),                    -- насколько ниже рынка, %
    chat_id      TEXT,
    message_id   BIGINT,
    error        TEXT                             -- если отправка не удалась
);

CREATE INDEX IF NOT EXISTS deal_alerts_listing_idx ON scrapper.deal_alerts (listing_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS deal_alerts_time_idx    ON scrapper.deal_alerts (sent_at DESC);

GRANT ALL PRIVILEGES ON scrapper.deal_alerts TO lo_agent;
GRANT ALL PRIVILEGES ON SEQUENCE scrapper.deal_alerts_id_seq TO lo_agent;
