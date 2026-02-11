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
