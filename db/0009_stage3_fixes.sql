-- Stage 3 (FIX 14b): refunds write a payments row with status
-- 'refunded' (full) or 'partially_refunded' (partial). The old
-- varchar(14) cannot hold 'partially_refunded' (18 chars).
ALTER TABLE payments ALTER COLUMN status TYPE varchar(20);
