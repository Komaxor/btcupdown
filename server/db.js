const { Pool } = require('pg');

const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 5 }
  : { database: 'btcupdown', max: 5 }
);

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

async function init() {
  await pool.query(`
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
      slug TEXT,
      price_to_beat NUMERIC(12,2),
      final_price NUMERIC(12,2),
      outcome TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_btc_1m_outcomes_minute
      ON btc_1m_outcomes (minute_start);

    CREATE TABLE IF NOT EXISTS positions (
      user_id BIGINT NOT NULL REFERENCES users(id),
      round_start TIMESTAMPTZ NOT NULL,
      yes_shares INTEGER NOT NULL DEFAULT 0,
      no_shares INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, round_start)
    );

    CREATE TABLE IF NOT EXISTS liquidity_provisions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      round_start TIMESTAMPTZ NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lp_round
      ON liquidity_provisions (round_start);

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
  `);

  // Migrations for existing databases
  await pool.query(`
    ALTER TABLE btc_1m_outcomes ADD COLUMN IF NOT EXISTS slug TEXT;
  `);
  await pool.query(`
    ALTER TABLE btc_1m_outcomes ALTER COLUMN price_to_beat DROP NOT NULL;
  `);

  // Backfill slugs for existing rows that don't have one
  await pool.query(`
    UPDATE btc_1m_outcomes
    SET slug = 'btc-' || TO_CHAR(minute_start AT TIME ZONE 'UTC', 'YYYYMMDD-HH24MI')
    WHERE slug IS NULL
  `);

  // Create slug index after column is guaranteed to exist
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_btc_1m_outcomes_slug
      ON btc_1m_outcomes (slug);
  `);

  console.log('Database initialized (price_history + users + btc_1m_outcomes + orders + trades + positions + liquidity_provisions tables ready)');
}

async function insertPrice(price, sourceCount, timestamp) {
  await pool.query(
    'INSERT INTO price_history (price, source_count, timestamp) VALUES ($1, $2, $3)',
    [price.toFixed(2), sourceCount, new Date(timestamp)]
  );
}

async function getRecentPrices(limit = 60) {
  const result = await pool.query(
    'SELECT price, source_count, timestamp FROM price_history ORDER BY timestamp DESC LIMIT $1',
    [limit]
  );
  // Return in chronological order (oldest first)
  return result.rows.reverse().map(row => ({
    price: parseFloat(row.price),
    sources: row.source_count,
    timestamp: new Date(row.timestamp).getTime()
  }));
}

async function upsertUser(telegramUser) {
  const result = await pool.query(`
    INSERT INTO users (id, first_name, last_name, username, photo_url, auth_date)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      username = EXCLUDED.username,
      photo_url = EXCLUDED.photo_url,
      auth_date = EXCLUDED.auth_date,
      updated_at = NOW()
    RETURNING id, first_name, last_name, username, photo_url, balance, created_at
  `, [telegramUser.id, telegramUser.first_name, telegramUser.last_name || null,
      telegramUser.username || null, telegramUser.photo_url || null, telegramUser.auth_date]);
  return result.rows[0];
}

async function getUser(userId) {
  const result = await pool.query(
    'SELECT id, first_name, last_name, username, photo_url, balance FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

async function updateBalance(userId, newBalance) {
  await pool.query(
    'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
    [newBalance.toFixed(2), userId]
  );
}

async function insertMinuteStart(minuteStart, priceToBeat) {
  await pool.query(
    `INSERT INTO btc_1m_outcomes (minute_start, price_to_beat)
     VALUES ($1, $2)
     ON CONFLICT (minute_start) DO NOTHING`,
    [new Date(minuteStart), priceToBeat ? priceToBeat.toFixed(2) : null]
  );
}

async function insertMarket(minuteStart, slug) {
  await pool.query(
    `INSERT INTO btc_1m_outcomes (minute_start, slug)
     VALUES ($1, $2)
     ON CONFLICT (minute_start) DO NOTHING`,
    [new Date(minuteStart), slug]
  );
}

async function updatePriceToBeat(minuteStart, priceToBeat) {
  await pool.query(
    `UPDATE btc_1m_outcomes
     SET price_to_beat = $2
     WHERE minute_start = $1 AND price_to_beat IS NULL`,
    [new Date(minuteStart), priceToBeat.toFixed(2)]
  );
}

async function getMarketBySlug(slug) {
  const result = await pool.query(
    `SELECT minute_start, slug, price_to_beat, final_price, outcome, created_at
     FROM btc_1m_outcomes WHERE slug = $1`,
    [slug]
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    minuteStart: new Date(row.minute_start).getTime(),
    slug: row.slug,
    priceToBeat: row.price_to_beat ? parseFloat(row.price_to_beat) : null,
    finalPrice: row.final_price ? parseFloat(row.final_price) : null,
    outcome: row.outcome,
    createdAt: new Date(row.created_at).getTime()
  };
}

async function getActiveMarkets() {
  const result = await pool.query(
    `SELECT minute_start, slug, price_to_beat, outcome
     FROM btc_1m_outcomes
     WHERE outcome IS NULL
     ORDER BY minute_start ASC`
  );
  return result.rows.map(row => ({
    minuteStart: new Date(row.minute_start).getTime(),
    slug: row.slug,
    priceToBeat: row.price_to_beat ? parseFloat(row.price_to_beat) : null,
    outcome: row.outcome
  }));
}

async function getAllMarkets(limit = 20) {
  const result = await pool.query(
    `SELECT minute_start, slug, price_to_beat, final_price, outcome
     FROM btc_1m_outcomes
     ORDER BY minute_start DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => ({
    minuteStart: new Date(row.minute_start).getTime(),
    slug: row.slug,
    priceToBeat: row.price_to_beat ? parseFloat(row.price_to_beat) : null,
    finalPrice: row.final_price ? parseFloat(row.final_price) : null,
    outcome: row.outcome
  }));
}

async function completeMinuteOutcome(minuteStart, finalPrice) {
  await pool.query(
    `UPDATE btc_1m_outcomes
     SET final_price = $2,
         outcome = CASE WHEN $2 >= price_to_beat THEN 'up' ELSE 'down' END
     WHERE minute_start = $1 AND outcome IS NULL`,
    [new Date(minuteStart), finalPrice.toFixed(2)]
  );
}

async function getRecentOutcomes(limit = 5) {
  const result = await pool.query(
    `SELECT price_to_beat, final_price, outcome
     FROM btc_1m_outcomes
     WHERE outcome IS NOT NULL
     ORDER BY minute_start DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.reverse().map(row => ({
    priceToBeat: parseFloat(row.price_to_beat),
    finalPrice: parseFloat(row.final_price),
    outcome: row.outcome
  }));
}

async function close() {
  await pool.end();
  console.log('Database pool closed');
}

module.exports = { pool, init, insertPrice, getRecentPrices, upsertUser, getUser, updateBalance, insertMinuteStart, insertMarket, updatePriceToBeat, getMarketBySlug, getActiveMarkets, getAllMarkets, completeMinuteOutcome, getRecentOutcomes, close };
