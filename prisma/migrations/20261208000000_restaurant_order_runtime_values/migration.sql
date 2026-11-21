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
