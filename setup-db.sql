-- BTC Up/Down - Database Setup
-- Run: psql btcupdown < setup-db.sql
-- Safe to run multiple times (all IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  price NUMERIC(12,2) NOT NULL,
  source_count INTEGER NOT NULL DEFAULT 0,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp
  ON price_history (timestamp DESC);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT,
  username TEXT,
  photo_url TEXT,
  auth_date INTEGER NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 1000.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS btc_1m_outcomes (
  id BIGSERIAL PRIMARY KEY,
  minute_start TIMESTAMPTZ NOT NULL,
  price_to_beat NUMERIC(12,2) NOT NULL,
  final_price NUMERIC(12,2),
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_btc_1m_outcomes_minute
  ON btc_1m_outcomes (minute_start);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  round_start TIMESTAMPTZ NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  outcome TEXT NOT NULL CHECK (outcome IN ('yes','no')),
  book_side TEXT NOT NULL CHECK (book_side IN ('bid','ask')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market_fak','market_fok','limit','stop_limit')),
  price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 99),
  stop_price INTEGER CHECK (stop_price BETWEEN 1 AND 99),
  shares INTEGER NOT NULL CHECK (shares > 0),
  filled_shares INTEGER NOT NULL DEFAULT 0,
  remaining_shares INTEGER NOT NULL,
  cost_per_share INTEGER NOT NULL CHECK (cost_per_share BETWEEN 1 AND 99),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','partially_filled','filled','cancelled','expired','stopped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_round ON orders (round_start, status);

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  round_start TIMESTAMPTZ NOT NULL,
  bid_order_id BIGINT NOT NULL REFERENCES orders(id),
  ask_order_id BIGINT NOT NULL REFERENCES orders(id),
  yes_user_id BIGINT NOT NULL REFERENCES users(id),
  no_user_id BIGINT NOT NULL REFERENCES users(id),
  price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 99),
  shares INTEGER NOT NULL CHECK (shares > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_round ON trades (round_start);
CREATE INDEX IF NOT EXISTS idx_trades_yes_user ON trades (yes_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_no_user ON trades (no_user_id);
