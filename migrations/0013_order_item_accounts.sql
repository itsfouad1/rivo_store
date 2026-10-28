CREATE TABLE order_item_accounts (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL DEFAULT '' CHECK(length(player_id) <= 150)
);
CREATE INDEX order_item_accounts_player ON order_item_accounts(player_id);
