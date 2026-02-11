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
      price_to_beat NUMERIC(12,2) NOT NULL,
      final_price NUMERIC(12,2),
      outcome TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_btc_1m_outcomes_minute
      ON btc_1m_outcomes (minute_start);
  `);
  console.log('Database initialized (price_history + users + btc_1m_outcomes tables ready)');
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
    [new Date(minuteStart), priceToBeat.toFixed(2)]
  );
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

module.exports = { init, insertPrice, getRecentPrices, upsertUser, getUser, updateBalance, insertMinuteStart, completeMinuteOutcome, getRecentOutcomes, close };
