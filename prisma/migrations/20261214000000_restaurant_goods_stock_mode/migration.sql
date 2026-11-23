ALTER TABLE restaurant_menu_items
  DROP CONSTRAINT IF EXISTS restaurant_menu_items_stock_mode_check;

UPDATE restaurant_menu_items
SET stock_mode = 'goods'
WHERE stock_mode = 'direct';

ALTER TABLE restaurant_menu_items
  ADD CONSTRAINT restaurant_menu_items_stock_mode_check
    CHECK (stock_mode IN ('none', 'recipe', 'goods'));
