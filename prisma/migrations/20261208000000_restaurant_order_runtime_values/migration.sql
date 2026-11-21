CREATE TABLE IF NOT EXISTS "restaurant_order_events" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "order_id" CHAR(24) NOT NULL,
  "version" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "event_type" VARCHAR(32) NOT NULL,
  "payload_json" JSONB NOT NULL,
  "actor_id" CHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_order_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_order_events_idempotency_key" UNIQUE ("company_id", "idempotency_key"),
  CONSTRAINT "restaurant_order_events_order_version_key" UNIQUE ("company_id", "order_id", "version")
);

CREATE INDEX IF NOT EXISTS "restaurant_order_events_order_created_idx"
  ON "restaurant_order_events"("company_id", "order_id", "created_at");

ALTER TABLE "restaurant_order_events"
  DROP CONSTRAINT IF EXISTS "restaurant_order_events_type_check",
  ADD CONSTRAINT "restaurant_order_events_type_check"
    CHECK ("event_type" IN (
      'ORDER_OPENED',
      'ITEM_ADDED',
      'ITEM_VOIDED',
      'ROUND_SENT',
      'ORDER_CANCELLED',
      'TABLE_TRANSFERRED',
      'TABLE_MERGED',
      'TAB_CARRIED',
      'TAB_WRITTEN_OFF',
      'ITEMS_UPDATED',
      'TICKET_STATUS_UPDATED',
      'SENT_ITEM_VOIDED'
    ));

CREATE TABLE IF NOT EXISTS "restaurant_kitchen_tickets" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "order_id" CHAR(24) NOT NULL,
  "round_number" INTEGER NOT NULL,
  "station" VARCHAR(16) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "idempotency_key" VARCHAR(160) NOT NULL,
  "print_job_id" CHAR(24),
  "payload_json" JSONB NOT NULL,
  "reprint_count" INTEGER NOT NULL DEFAULT 0,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "fallback_agent_id" CHAR(24),
  "fallback_printer_id" CHAR(24),
  "fallback_attempted" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "restaurant_kitchen_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_kitchen_tickets_print_job_id_key" UNIQUE ("print_job_id"),
  CONSTRAINT "restaurant_kitchen_tickets_idempotency_key" UNIQUE ("company_id", "idempotency_key"),
  CONSTRAINT "restaurant_kitchen_tickets_round_station_key" UNIQUE ("company_id", "order_id", "round_number", "station")
);

CREATE INDEX IF NOT EXISTS "restaurant_kitchen_tickets_status_created_idx"
  ON "restaurant_kitchen_tickets"("company_id", "status", "created_at");

ALTER TABLE "restaurant_kitchen_tickets"
  DROP CONSTRAINT IF EXISTS "restaurant_kitchen_tickets_status_check",
  ADD CONSTRAINT "restaurant_kitchen_tickets_status_check"
    CHECK ("status" IN (
      'queued',
      'transmitting',
      'transmitted',
      'confirmed',
      'failed',
      'uncertain',
      'deferred',
      'cancelled',
      'preparing',
      'ready',
      'picked_up'
    ));
