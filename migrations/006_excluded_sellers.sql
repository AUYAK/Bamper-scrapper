-- 006: исключить продавца 336639 из аналитики.
--
-- Замерено 29.09.2026: у продавца 336639 цены 27 000-58 000 руб. за шину (похоже на
-- российские рубли или ошибку ввода), 60+ активных объявлений. Они попадали в медианы
-- по редким размерам и в базу ценовой модели.
--
-- Статус 'excluded' — четвёртый после active | gone | replaced. Он нигде специально
-- не обрабатывается, и в этом смысл: модель цен берёт только active, калибровка
-- сделок — только gone, пометка ушедших — только active, check-status считает по
-- статусам. Строки остаются в базе для истории, но ни во что не входят.
--
-- Краулер новые объявления этого продавца больше не пишет (EXCLUDED_SELLERS в .env,
-- по умолчанию 336639 в config.js). Событие в listing_events не пишем: CHECK-ограничение
-- на reason менять ради этого не стоит.
--
-- Накатывать вручную:  psql ... -f migrations/006_excluded_sellers.sql
-- Откат: UPDATE scrapper.listings SET status = 'active' WHERE status = 'excluded';
-- (все исключённые на момент миграции были active или gone; gone восстановить по gone_at IS NOT NULL)

BEGIN;

UPDATE scrapper.listings
   SET status = 'excluded'
 WHERE seller_id IN (336639)
   AND status IN ('active', 'gone');

-- уведомления по этим объявлениям больше не нужны
DELETE FROM scrapper.deal_alerts
 WHERE listing_id IN (SELECT id FROM scrapper.listings WHERE status = 'excluded');

COMMIT;

-- проверка: должно быть 0 active/gone у продавца и ~80 excluded
SELECT status, count(*) FROM scrapper.listings WHERE seller_id = 336639 GROUP BY 1;
