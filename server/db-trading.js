const { pool } = require('./db');

// ============================================
// ORDER OPERATIONS
// ============================================

/**
 * Insert a new order into the database.
 * @param {object} order - Order data
 * @param {number} order.userId - Telegram user ID
 * @param {string} order.roundStart - Round start timestamp (ISO or ms)
 * @param {string} order.side - Original user side: 'buy' or 'sell'
 * @param {string} order.outcome - Original user outcome: 'yes' or 'no'
 * @param {string} order.bookSide - Normalized book side: 'bid' or 'ask'
 * @param {string} order.orderType - 'market_fak', 'market_fok', 'limit', or 'stop_limit'
 * @param {number} order.price - Normalized YES-scale price (1-99)
 * @param {number|null} order.stopPrice - Stop trigger price for stop-limit orders
 * @param {number} order.shares - Total shares ordered
 * @param {number} order.costPerShare - What this user pays per share (cents)
 * @param {string} order.status - Initial status ('open' or 'stopped')
 * @param {import('pg').PoolClient} [client] - Optional transaction client
 * @returns {Promise<object>} The inserted order row
 */
async function insertOrder(order, client) {
  const conn = client || pool;
  const result = await conn.query(
    `INSERT INTO orders
       (user_id, round_start, side, outcome, book_side, order_type, price, stop_price,
        shares, filled_shares, remaining_shares, cost_per_share, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $9, $10, $11)
     RETURNING *`,
    [order.userId, new Date(order.roundStart), order.side, order.outcome,
     order.bookSide, order.orderType, order.price, order.stopPrice || null,
     order.shares, order.costPerShare, order.status]
  );
  return result.rows[0];
}

/**
 * Update an order's fill state after a trade.
 * @param {number} orderId - Order ID
 * @param {number} filledQty - Additional shares filled in this trade
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<object>} Updated order row
 */
async function updateOrderFill(orderId, filledQty, client) {
  const result = await client.query(
    `UPDATE orders
     SET filled_shares = filled_shares + $2,
         remaining_shares = remaining_shares - $2,
         status = CASE
           WHEN remaining_shares - $2 = 0 THEN 'filled'
           ELSE 'partially_filled'
         END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId, filledQty]
  );
  return result.rows[0];
}

/**
 * Cancel an order by setting its status to 'cancelled'.
 * Only cancels if the order is currently 'open', 'partially_filled', or 'stopped'.
 * @param {number} orderId - Order ID
 * @param {number} userId - Must match order owner
 * @param {import('pg').PoolClient} [client] - Optional transaction client
 * @returns {Promise<object|null>} Cancelled order row, or null if not found/not cancellable
 */
async function cancelOrder(orderId, userId, client) {
  const conn = client || pool;
  const result = await conn.query(
    `UPDATE orders
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2
       AND status IN ('open', 'partially_filled', 'stopped')
     RETURNING *`,
    [orderId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Cancel all open/partially-filled/stopped orders for a given round.
 * Used during settlement to close out the round.
 * @param {string} roundStart - Round start timestamp
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<object[]>} Array of cancelled order rows
 */
async function cancelAllRoundOrders(roundStart, client) {
  // First capture orders with their original status before updating
  const snapshot = await client.query(
    `SELECT id, user_id, remaining_shares, cost_per_share, status, order_type
     FROM orders
     WHERE round_start = $1
       AND status IN ('open', 'partially_filled', 'stopped')
     FOR UPDATE`,
    [new Date(roundStart)]
  );

  if (snapshot.rows.length > 0) {
    await client.query(
      `UPDATE orders
       SET status = 'cancelled', updated_at = NOW()
       WHERE round_start = $1
         AND status IN ('open', 'partially_filled', 'stopped')`,
      [new Date(roundStart)]
    );
  }

  return snapshot.rows; // rows with original status intact
}

/**
 * Get an order by ID.
 * @param {number} orderId - Order ID
 * @param {import('pg').PoolClient} [client] - Optional transaction client
 * @returns {Promise<object|null>} Order row or null
 */
async function getOrder(orderId, client) {
  const conn = client || pool;
  const result = await conn.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return result.rows[0] || null;
}

/**
 * Get all orders for a user, optionally filtered.
 * @param {number} userId - User ID
 * @param {object} [filters] - Optional filters
 * @param {string} [filters.status] - Filter by status ('open', 'filled', 'cancelled', etc.)
 * @param {string} [filters.roundStart] - Filter by round
 * @param {number} [filters.limit] - Max rows (default 50)
 * @returns {Promise<object[]>} Array of order rows
 */
async function getUserOrders(userId, filters = {}) {
  const conditions = ['user_id = $1'];
  const params = [userId];
  let idx = 2;

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'open') {
      conditions.push(`status IN ('open', 'partially_filled', 'stopped')`);
    } else {
      conditions.push(`status = $${idx}`);
      params.push(filters.status);
      idx++;
    }
  }

  if (filters.roundStart) {
    conditions.push(`round_start = $${idx}`);
    params.push(new Date(filters.roundStart));
    idx++;
  }

  const limit = Math.min(filters.limit || 50, 200);

  const result = await pool.query(
    `SELECT * FROM orders
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ${limit}`
  , params);
  return result.rows;
}

/**
 * Get all open resting orders for a round (for rebuilding in-memory book on restart).
 * @param {string} roundStart - Round start timestamp
 * @returns {Promise<object[]>} Array of open order rows
 */
async function getOpenRoundOrders(roundStart) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE round_start = $1 AND status IN ('open', 'partially_filled')
     ORDER BY created_at ASC`,
    [new Date(roundStart)]
  );
  return result.rows;
}

/**
 * Get all stopped (pending stop-limit) orders for a round.
 * @param {string} roundStart - Round start timestamp
 * @returns {Promise<object[]>} Array of stopped order rows
 */
async function getStoppedRoundOrders(roundStart) {
  const result = await pool.query(
    `SELECT * FROM orders
     WHERE round_start = $1 AND status = 'stopped' AND order_type = 'stop_limit'
     ORDER BY created_at ASC`,
    [new Date(roundStart)]
  );
  return result.rows;
}

/**
 * Activate a stop-limit order (change status from 'stopped' to 'open').
 * @param {number} orderId - Order ID
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<object>} Updated order row
 */
async function activateStopOrder(orderId, client) {
  const result = await client.query(
    `UPDATE orders
     SET status = 'open', updated_at = NOW()
     WHERE id = $1 AND status = 'stopped'
     RETURNING *`,
    [orderId]
  );
  return result.rows[0];
}

// ============================================
// TRADE OPERATIONS
// ============================================

/**
 * Insert a trade (fill) record.
 * @param {object} trade - Trade data
 * @param {string} trade.roundStart - Round start timestamp
 * @param {number} trade.bidOrderId - Bid-side order ID
 * @param {number} trade.askOrderId - Ask-side order ID
 * @param {number} trade.yesUserId - User receiving YES shares
 * @param {number} trade.noUserId - User receiving NO shares
 * @param {number} trade.price - Execution price (YES-scale, cents)
 * @param {number} trade.shares - Number of shares traded
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<object>} Inserted trade row
 */
async function insertTrade(trade, client) {
  const result = await client.query(
    `INSERT INTO trades
       (round_start, bid_order_id, ask_order_id, yes_user_id, no_user_id, price, shares)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [new Date(trade.roundStart), trade.bidOrderId, trade.askOrderId,
     trade.yesUserId, trade.noUserId, trade.price, trade.shares]
  );
  return result.rows[0];
}

/**
 * Get all trades for a specific order.
 * @param {number} orderId - Order ID (matches either bid or ask side)
 * @returns {Promise<object[]>} Array of trade rows
 */
async function getOrderTrades(orderId) {
  const result = await pool.query(
    `SELECT * FROM trades
     WHERE bid_order_id = $1 OR ask_order_id = $1
     ORDER BY created_at ASC`,
    [orderId]
  );
  return result.rows;
}

// ============================================
// POSITION OPERATIONS
// ============================================

/**
 * Upsert a user's position for a round. Atomically adds to yes/no shares.
 * @param {number} userId
 * @param {number|string} roundStart - Round start timestamp (ms or ISO)
 * @param {number} yesDelta - Shares to add to yes_shares (can be 0)
 * @param {number} noDelta - Shares to add to no_shares (can be 0)
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<{yesShares: number, noShares: number}>} Updated position
 */
async function upsertPosition(userId, roundStart, yesDelta, noDelta, client) {
  const result = await client.query(
    `INSERT INTO positions (user_id, round_start, yes_shares, no_shares)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, round_start) DO UPDATE SET
       yes_shares = positions.yes_shares + $3,
       no_shares = positions.no_shares + $4
     RETURNING yes_shares, no_shares`,
    [userId, new Date(roundStart), yesDelta, noDelta]
  );
  return {
    yesShares: result.rows[0].yes_shares,
    noShares: result.rows[0].no_shares
  };
}

/**
 * Get a user's position for a round.
 * @param {number} userId
 * @param {number|string} roundStart
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<{yesShares: number, noShares: number}>}
 */
async function getPosition(userId, roundStart, client) {
  const conn = client || pool;
  const result = await conn.query(
    'SELECT yes_shares, no_shares FROM positions WHERE user_id = $1 AND round_start = $2',
    [userId, new Date(roundStart)]
  );
  if (!result.rows[0]) return { yesShares: 0, noShares: 0 };
  return {
    yesShares: result.rows[0].yes_shares,
    noShares: result.rows[0].no_shares
  };
}

/**
 * Get all positions for a round (for settlement).
 * @param {number|string} roundStart
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Array<{userId: number, yesShares: number, noShares: number}>>}
 */
async function getAllPositions(roundStart, client) {
  const result = await client.query(
    'SELECT user_id, yes_shares, no_shares FROM positions WHERE round_start = $1',
    [new Date(roundStart)]
  );
  return result.rows.map(r => ({
    userId: Number(r.user_id),
    yesShares: r.yes_shares,
    noShares: r.no_shares
  }));
}

// ============================================
// LIQUIDITY PROVISION OPERATIONS
// ============================================

/**
 * Record a liquidity provision.
 * @param {number} userId
 * @param {number|string} roundStart
 * @param {number} amount - Integer dollar amount
 * @param {import('pg').PoolClient} client
 * @returns {Promise<object>} Inserted row
 */
async function insertLiquidityProvision(userId, roundStart, amount, client) {
  const result = await client.query(
    `INSERT INTO liquidity_provisions (user_id, round_start, amount)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, new Date(roundStart), amount]
  );
  return result.rows[0];
}

/**
 * Get total liquidity for a round.
 * @param {number|string} roundStart
 * @returns {Promise<number>} Total dollar amount
 */
async function getTotalLiquidity(roundStart) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM liquidity_provisions WHERE round_start = $1',
    [new Date(roundStart)]
  );
  return Number(result.rows[0].total);
}

// ============================================
// BALANCE OPERATIONS (transactional)
// ============================================

/**
 * Deduct balance from a user (for order placement).
 * Fails if insufficient balance.
 * @param {number} userId - User ID
 * @param {number} amount - Amount in dollars (e.g. 6.00 for 600 cents)
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<number>} New balance
 * @throws {Error} If insufficient balance
 */
async function deductBalance(userId, amount, client) {
  const result = await client.query(
    `UPDATE users
     SET balance = balance - $2, updated_at = NOW()
     WHERE id = $1 AND balance >= $2
     RETURNING balance`,
    [userId, amount.toFixed(2)]
  );
  if (result.rows.length === 0) {
    throw new Error('Insufficient balance');
  }
  return parseFloat(result.rows[0].balance);
}

/**
 * Credit balance to a user (for cancellation refund or settlement payout).
 * @param {number} userId - User ID
 * @param {number} amount - Amount in dollars
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<number>} New balance
 */
async function creditBalance(userId, amount, client) {
  const result = await client.query(
    `UPDATE users
     SET balance = balance + $2, updated_at = NOW()
     WHERE id = $1
     RETURNING balance`,
    [userId, amount.toFixed(2)]
  );
  return parseFloat(result.rows[0].balance);
}

/**
 * Get current user balance inside a transaction (with row lock).
 * @param {number} userId - User ID
 * @param {import('pg').PoolClient} client - Transaction client (required)
 * @returns {Promise<number>} Current balance
 */
async function getBalanceForUpdate(userId, client) {
  const result = await client.query(
    'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  return parseFloat(result.rows[0].balance);
}

module.exports = {
  insertOrder,
  updateOrderFill,
  cancelOrder,
  cancelAllRoundOrders,
  getOrder,
  getUserOrders,
  getOpenRoundOrders,
  getStoppedRoundOrders,
  activateStopOrder,
  insertTrade,
  getOrderTrades,
  upsertPosition,
  getPosition,
  getAllPositions,
  insertLiquidityProvision,
  getTotalLiquidity,
  deductBalance,
  creditBalance,
  getBalanceForUpdate,
  pool,
};
