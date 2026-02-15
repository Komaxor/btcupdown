const dbTrading = require('./db-trading');

/**
 * @typedef {object} BookEntry
 * @property {number} id - Order ID
 * @property {number} userId - User ID
 * @property {number} price - YES-scale price (1-99)
 * @property {number} remainingShares - Shares still resting
 * @property {number} costPerShare - Cost per share for this user
 * @property {string} bookSide - 'bid' or 'ask'
 * @property {number} createdAt - Timestamp (ms) for time priority
 */

/**
 * @typedef {object} NormalizedOrder
 * @property {string} bookSide - 'bid' or 'ask'
 * @property {number} bookPrice - YES-scale price (1-99)
 * @property {number} costPerShare - What the user pays per share (cents)
 */

/**
 * @typedef {object} OrderResult
 * @property {object} order - The inserted order row from DB
 * @property {object[]} fills - Array of trade/fill records
 * @property {number} [unfilledShares] - Shares that were not filled (FAK)
 */

class TradingEngine {
  /**
   * Create a new TradingEngine.
   * @param {object} config - Server config object (must have config.trading)
   * @param {Function} sendToUser - Callback: sendToUser(userId, messageObj) to push WS messages
   */
  constructor(config, sendToUser) {
    this.config = config.trading;
    this.sendToUser = sendToUser || (() => {});

    /** @type {Map<number, {bids: BookEntry[], asks: BookEntry[]}>} roundStart → book */
    this.books = new Map();

    /** @type {Map<number, BookEntry[]>} roundStart → pending stop-limit orders */
    this.stops = new Map();
  }

  // ============================================
  // NORMALIZATION
  // ============================================

  /**
   * Normalize user-facing order parameters to internal book coordinates.
   *
   * The book is priced on the YES scale (1-99):
   * - BID side = wants YES shares (pays bookPrice per share)
   * - ASK side = wants NO shares (pays 100-bookPrice per share)
   *
   * | UI Action         | bookSide | bookPrice | costPerShare |
   * |-------------------|----------|-----------|--------------|
   * | Buy YES at P¢     | bid      | P         | P            |
   * | Buy NO at P¢      | ask      | 100-P     | P            |
   * | Sell YES at P¢    | ask      | P         | 100-P        |
   * | Sell NO at P¢     | bid      | 100-P     | 100-P        |
   *
   * @param {string} side - 'buy' or 'sell'
   * @param {string} outcome - 'yes' or 'no'
   * @param {number} price - User-specified price in cents (1-99)
   * @returns {NormalizedOrder}
   */
  normalize(side, outcome, price) {
    if (side === 'buy' && outcome === 'yes') {
      return { bookSide: 'bid', bookPrice: price, costPerShare: price };
    }
    if (side === 'buy' && outcome === 'no') {
      return { bookSide: 'ask', bookPrice: 100 - price, costPerShare: price };
    }
    if (side === 'sell' && outcome === 'yes') {
      return { bookSide: 'ask', bookPrice: price, costPerShare: 100 - price };
    }
    // sell no
    return { bookSide: 'bid', bookPrice: 100 - price, costPerShare: 100 - price };
  }

  // ============================================
  // BOOK MANAGEMENT
  // ============================================

  /**
   * Initialize an empty order book for a new round.
   * Called when a new minute boundary is detected.
   * @param {number} roundStart - Minute start timestamp in milliseconds
   */
  initRound(roundStart) {
    if (!this.books.has(roundStart)) {
      this.books.set(roundStart, { bids: [], asks: [] });
      this.stops.set(roundStart, []);
    }
  }

  /**
   * Get or create the book for a round.
   * @param {number} roundStart
   * @returns {{bids: BookEntry[], asks: BookEntry[]}}
   */
  getBook(roundStart) {
    if (!this.books.has(roundStart)) {
      this.initRound(roundStart);
    }
    return this.books.get(roundStart);
  }

  /**
   * Insert an entry into the bids array, maintaining price DESC + time ASC sort.
   * @param {BookEntry[]} bids
   * @param {BookEntry} entry
   */
  insertBid(bids, entry) {
    let i = 0;
    while (i < bids.length &&
      (bids[i].price > entry.price ||
       (bids[i].price === entry.price && bids[i].createdAt <= entry.createdAt))) {
      i++;
    }
    bids.splice(i, 0, entry);
  }

  /**
   * Insert an entry into the asks array, maintaining price ASC + time ASC sort.
   * @param {BookEntry[]} asks
   * @param {BookEntry} entry
   */
  insertAsk(asks, entry) {
    let i = 0;
    while (i < asks.length &&
      (asks[i].price < entry.price ||
       (asks[i].price === entry.price && asks[i].createdAt <= entry.createdAt))) {
      i++;
    }
    asks.splice(i, 0, entry);
  }

  /**
   * Remove an entry from a book side by order ID.
   * @param {BookEntry[]} arr - bids or asks array
   * @param {number} orderId
   */
  removeFromBook(arr, orderId) {
    const idx = arr.findIndex(e => e.id === orderId);
    if (idx !== -1) arr.splice(idx, 1);
  }

  /**
   * Get the aggregated order book for display.
   * Groups orders by price level and sums shares. No user info exposed.
   * @param {number} roundStart - Round start timestamp
   * @returns {{bids: Array<{price: number, totalShares: number}>, asks: Array<{price: number, totalShares: number}>}}
   */
  getOrderBook(roundStart) {
    const book = this.books.get(roundStart);
    if (!book) return { bids: [], asks: [] };

    const aggregate = (arr) => {
      const levels = new Map();
      for (const e of arr) {
        levels.set(e.price, (levels.get(e.price) || 0) + e.remainingShares);
      }
      return Array.from(levels.entries()).map(([price, totalShares]) => ({ price, totalShares }));
    };

    return { bids: aggregate(book.bids), asks: aggregate(book.asks) };
  }

  // ============================================
  // VALIDATION
  // ============================================

  /**
   * Validate common order parameters.
   * @param {number} userId
   * @param {number} roundStart
   * @param {string} side
   * @param {string} outcome
   * @param {number} shares
   * @param {number} [price]
   * @returns {string|null} Error message, or null if valid
   */
  validateParams(userId, roundStart, side, outcome, shares, price) {
    if (!userId) return 'Not authenticated';
    if (!roundStart) return 'No active round';
    if (!['buy', 'sell'].includes(side)) return 'Invalid side';
    if (!['yes', 'no'].includes(outcome)) return 'Invalid outcome';
    if (!Number.isInteger(shares) || shares <= 0) return 'Shares must be a positive integer';
    if (shares > this.config.maxSharesPerOrder) return `Max ${this.config.maxSharesPerOrder} shares per order`;
    if (price !== undefined) {
      if (!Number.isInteger(price) || price < this.config.minPrice || price > this.config.maxPrice) {
        return `Price must be an integer between ${this.config.minPrice} and ${this.config.maxPrice}`;
      }
    }
    return null;
  }

  // ============================================
  // MATCHING ENGINE
  // ============================================

  /**
   * Match an incoming order against the opposite side of the book.
   *
   * Uses price-time priority:
   * - Incoming BID matches against asks (lowest ask first)
   * - Incoming ASK matches against bids (highest bid first)
   * - Execution price = resting (maker) order's price
   * - Self-trade prevention: skips orders from the same user
   *
   * All database operations happen within the provided transaction.
   *
   * @param {object} incomingOrder - The DB order row for the incoming order
   * @param {BookEntry[]} opposingSide - The opposing side of the book (asks for bid, bids for ask)
   * @param {number} roundStart - Round start timestamp
   * @param {import('pg').PoolClient} client - DB transaction client
   * @returns {Promise<{fills: object[], filledShares: number, removedIds: number[]}>}
   */
  async matchOrder(incomingOrder, opposingSide, roundStart, client) {
    const fills = [];
    let remainingShares = incomingOrder.remaining_shares;
    const removedIds = [];
    const isBid = incomingOrder.book_side === 'bid';

    let i = 0;
    while (remainingShares > 0 && i < opposingSide.length) {
      const resting = opposingSide[i];

      // Self-trade prevention
      if (resting.userId === Number(incomingOrder.user_id)) {
        i++;
        continue;
      }

      // Check crossing condition
      if (isBid) {
        // Incoming bid must be >= resting ask price
        if (incomingOrder.price < resting.price) break; // asks are sorted ASC, no more matches
      } else {
        // Incoming ask must be <= resting bid price
        if (incomingOrder.price > resting.price) break; // bids are sorted DESC, no more matches
      }

      // Determine fill quantity and execution price
      const fillQty = Math.min(remainingShares, resting.remainingShares);
      const execPrice = resting.price; // maker gets their price

      // Determine YES and NO users
      const yesUserId = isBid ? Number(incomingOrder.user_id) : resting.userId;
      const noUserId = isBid ? resting.userId : Number(incomingOrder.user_id);
      const bidOrderId = isBid ? Number(incomingOrder.id) : resting.id;
      const askOrderId = isBid ? resting.id : Number(incomingOrder.id);

      // Calculate cost difference for the incoming taker
      // The taker reserved at their limit price, but may execute at a better (maker) price.
      // If taker is BID: reserved costPerShare = incomingOrder.cost_per_share
      //   actual cost = execPrice (could be lower → refund difference)
      // If taker is ASK: reserved costPerShare = incomingOrder.cost_per_share
      //   actual cost = 100 - execPrice (could be lower → refund difference)
      const takerActualCost = isBid ? execPrice : (100 - execPrice);
      const takerSavingsPerShare = incomingOrder.cost_per_share - takerActualCost;

      if (takerSavingsPerShare > 0) {
        // Refund the price improvement to the taker
        const refundAmount = (takerSavingsPerShare * fillQty) / 100;
        await dbTrading.creditBalance(Number(incomingOrder.user_id), refundAmount, client);
      }

      // Insert trade record
      const trade = await dbTrading.insertTrade({
        roundStart, bidOrderId, askOrderId, yesUserId, noUserId,
        price: execPrice, shares: fillQty
      }, client);

      // Update resting order
      await dbTrading.updateOrderFill(resting.id, fillQty, client);
      resting.remainingShares -= fillQty;

      // Update incoming order
      await dbTrading.updateOrderFill(Number(incomingOrder.id), fillQty, client);
      remainingShares -= fillQty;

      fills.push(trade);

      // Notify resting order owner
      const restingUpdated = await dbTrading.getOrder(resting.id, client);
      this.sendToUser(resting.userId, {
        type: 'order_update',
        orderId: resting.id,
        status: restingUpdated.status,
        filledShares: Number(restingUpdated.filled_shares),
        remainingShares: Number(restingUpdated.remaining_shares)
      });
      this.sendToUser(resting.userId, {
        type: 'trade',
        tradeId: Number(trade.id),
        price: execPrice,
        shares: fillQty,
        yourSide: isBid ? 'ask' : 'bid'
      });

      // Remove fully filled resting orders from book
      if (resting.remainingShares <= 0) {
        removedIds.push(resting.id);
        opposingSide.splice(i, 1);
        // don't increment i
      } else {
        i++;
      }
    }

    return { fills, filledShares: incomingOrder.remaining_shares - remainingShares, removedIds };
  }

  // ============================================
  // ORDER PLACEMENT
  // ============================================

  /**
   * Place a market FAK (Fill and Kill) order.
   *
   * Fills as many shares as possible at the best available prices in the book.
   * Any unfilled remainder is immediately cancelled. The user's balance is
   * reserved for the full order upfront; unfilled shares are refunded.
   *
   * @param {number} userId - Authenticated user ID
   * @param {number} roundStart - Current round start timestamp (ms)
   * @param {string} side - 'buy' or 'sell' (user's intent)
   * @param {string} outcome - 'yes' or 'no' (user's intent)
   * @param {number} shares - Number of shares to trade
   * @returns {Promise<OrderResult>} Order with fills and unfilled count
   * @throws {Error} On validation failure or insufficient balance
   */
  async placeMarketFAK(userId, roundStart, side, outcome, shares) {
    const err = this.validateParams(userId, roundStart, side, outcome, shares);
    if (err) throw new Error(err);

    // For market orders, use worst price (99 for bid, 1 for ask) to sweep the book
    const { bookSide, costPerShare } = this.normalize(side, outcome,
      (side === 'buy' && outcome === 'yes') || (side === 'sell' && outcome === 'no') ? 99 : 1
    );
    const bookPrice = bookSide === 'bid' ? 99 : 1;

    const book = this.getBook(roundStart);
    const client = await dbTrading.pool.connect();

    try {
      await client.query('BEGIN');

      // Reserve balance for worst-case cost
      const totalCost = (costPerShare * shares) / 100;
      await dbTrading.deductBalance(userId, totalCost, client);

      // Insert order
      const order = await dbTrading.insertOrder({
        userId, roundStart, side, outcome, bookSide,
        orderType: 'market_fak', price: bookPrice, stopPrice: null,
        shares, costPerShare, status: 'open'
      }, client);

      // Match against opposite side
      const opposingSide = bookSide === 'bid' ? book.asks : book.bids;
      const { fills, filledShares } = await this.matchOrder(order, opposingSide, roundStart, client);

      // Cancel unfilled remainder
      const unfilledShares = shares - filledShares;
      if (unfilledShares > 0) {
        await client.query(
          `UPDATE orders SET status = CASE WHEN filled_shares > 0 THEN 'partially_filled' ELSE 'cancelled' END,
           remaining_shares = 0, updated_at = NOW() WHERE id = $1`, [order.id]
        );
        // Refund unfilled cost
        const refund = (costPerShare * unfilledShares) / 100;
        await dbTrading.creditBalance(userId, refund, client);
      }

      await client.query('COMMIT');

      // Get final balance
      const user = await dbTrading.getBalanceForUpdate(userId, client).catch(() => null);

      // Notify user
      const finalOrder = await dbTrading.getOrder(Number(order.id));
      this.sendToUser(userId, { type: 'order_accepted', order: this.formatOrder(finalOrder), fills });
      fills.forEach(f => {
        this.sendToUser(userId, {
          type: 'trade', tradeId: Number(f.id), price: f.price,
          shares: Number(f.shares), yourSide: bookSide
        });
      });

      // Check stop orders after trades
      if (fills.length > 0) {
        await this.checkStopOrders(roundStart);
      }

      return { order: finalOrder, fills, unfilledShares };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Place a market FOK (Fill or Kill) order.
   *
   * Checks if the FULL quantity can be filled at available prices before
   * executing. If the full quantity is available, all fills execute atomically.
   * If not, the order is rejected entirely — no partial fill, no balance change.
   *
   * @param {number} userId - Authenticated user ID
   * @param {number} roundStart - Current round start timestamp (ms)
   * @param {string} side - 'buy' or 'sell'
   * @param {string} outcome - 'yes' or 'no'
   * @param {number} shares - Number of shares (must be fully fillable)
   * @returns {Promise<OrderResult>} Order with fills
   * @throws {Error} If not fully fillable, or validation/balance failure
   */
  async placeMarketFOK(userId, roundStart, side, outcome, shares) {
    const err = this.validateParams(userId, roundStart, side, outcome, shares);
    if (err) throw new Error(err);

    const { bookSide, costPerShare } = this.normalize(side, outcome,
      (side === 'buy' && outcome === 'yes') || (side === 'sell' && outcome === 'no') ? 99 : 1
    );
    const bookPrice = bookSide === 'bid' ? 99 : 1;

    const book = this.getBook(roundStart);
    const opposingSide = bookSide === 'bid' ? book.asks : book.bids;

    // Pre-check: can the full quantity be filled?
    let available = 0;
    for (const entry of opposingSide) {
      if (entry.userId === userId) continue; // self-trade prevention
      available += entry.remainingShares;
      if (available >= shares) break;
    }
    if (available < shares) {
      throw new Error(`Insufficient liquidity: ${available} shares available, need ${shares}`);
    }

    const client = await dbTrading.pool.connect();

    try {
      await client.query('BEGIN');

      // Reserve balance
      const totalCost = (costPerShare * shares) / 100;
      await dbTrading.deductBalance(userId, totalCost, client);

      // Insert order
      const order = await dbTrading.insertOrder({
        userId, roundStart, side, outcome, bookSide,
        orderType: 'market_fok', price: bookPrice, stopPrice: null,
        shares, costPerShare, status: 'open'
      }, client);

      // Match — should fill completely given pre-check
      const { fills, filledShares } = await this.matchOrder(order, opposingSide, roundStart, client);

      if (filledShares < shares) {
        // Shouldn't happen given pre-check, but safety rollback
        await client.query('ROLLBACK');
        throw new Error('FOK fill failed unexpectedly');
      }

      await client.query('COMMIT');

      const finalOrder = await dbTrading.getOrder(Number(order.id));
      this.sendToUser(userId, { type: 'order_accepted', order: this.formatOrder(finalOrder), fills });
      fills.forEach(f => {
        this.sendToUser(userId, {
          type: 'trade', tradeId: Number(f.id), price: f.price,
          shares: Number(f.shares), yourSide: bookSide
        });
      });

      if (fills.length > 0) {
        await this.checkStopOrders(roundStart);
      }

      return { order: finalOrder, fills };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Place a limit order at a specific price.
   *
   * If the limit price crosses existing resting orders, those are filled
   * immediately using price-time priority. Any remaining unfilled shares
   * rest in the book until filled by another order, cancelled by the user,
   * or the round ends (settlement).
   *
   * @param {number} userId - Authenticated user ID
   * @param {number} roundStart - Current round start timestamp (ms)
   * @param {string} side - 'buy' or 'sell'
   * @param {string} outcome - 'yes' or 'no'
   * @param {number} shares - Number of shares
   * @param {number} price - Limit price in cents (1-99, user-facing)
   * @returns {Promise<OrderResult>} Order with any immediate fills
   * @throws {Error} On validation failure or insufficient balance
   */
  async placeLimitOrder(userId, roundStart, side, outcome, shares, price) {
    const err = this.validateParams(userId, roundStart, side, outcome, shares, price);
    if (err) throw new Error(err);

    const { bookSide, bookPrice, costPerShare } = this.normalize(side, outcome, price);
    const book = this.getBook(roundStart);
    const client = await dbTrading.pool.connect();

    try {
      await client.query('BEGIN');

      // Reserve balance
      const totalCost = (costPerShare * shares) / 100;
      await dbTrading.deductBalance(userId, totalCost, client);

      // Insert order
      const order = await dbTrading.insertOrder({
        userId, roundStart, side, outcome, bookSide,
        orderType: 'limit', price: bookPrice, stopPrice: null,
        shares, costPerShare, status: 'open'
      }, client);

      // Try to match immediately against opposite side
      const opposingSide = bookSide === 'bid' ? book.asks : book.bids;
      const { fills, filledShares } = await this.matchOrder(order, opposingSide, roundStart, client);

      await client.query('COMMIT');

      // If unfilled shares remain, add to the book as resting order
      const unfilled = shares - filledShares;
      if (unfilled > 0) {
        const entry = {
          id: Number(order.id),
          userId,
          price: bookPrice,
          remainingShares: unfilled,
          costPerShare,
          bookSide,
          createdAt: new Date(order.created_at).getTime()
        };
        if (bookSide === 'bid') {
          this.insertBid(book.bids, entry);
        } else {
          this.insertAsk(book.asks, entry);
        }
      }

      const finalOrder = await dbTrading.getOrder(Number(order.id));
      this.sendToUser(userId, { type: 'order_accepted', order: this.formatOrder(finalOrder), fills });
      fills.forEach(f => {
        this.sendToUser(userId, {
          type: 'trade', tradeId: Number(f.id), price: f.price,
          shares: Number(f.shares), yourSide: bookSide
        });
      });

      if (fills.length > 0) {
        await this.checkStopOrders(roundStart);
      }

      return { order: finalOrder, fills };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Place a stop-limit order.
   *
   * The order stays dormant (status='stopped') until the best opposing
   * share price reaches the stopPrice. When triggered, the order converts
   * to a regular limit order at the specified limit price.
   *
   * Balance is NOT reserved at placement — only when the stop triggers.
   * This means the user might have insufficient balance when triggered,
   * in which case the triggered order is cancelled.
   *
   * Stop trigger logic:
   * - For a BID (wants YES): triggers when best ask price <= stopPrice
   * - For an ASK (wants NO): triggers when best bid price >= stopPrice
   *
   * @param {number} userId - Authenticated user ID
   * @param {number} roundStart - Current round start timestamp (ms)
   * @param {string} side - 'buy' or 'sell'
   * @param {string} outcome - 'yes' or 'no'
   * @param {number} shares - Number of shares
   * @param {number} stopPrice - Trigger price (user-facing cents, 1-99)
   * @param {number} price - Limit price once triggered (user-facing cents, 1-99)
   * @returns {Promise<{order: object}>} The dormant order
   * @throws {Error} On validation failure
   */
  async placeStopLimitOrder(userId, roundStart, side, outcome, shares, stopPrice, price) {
    const err = this.validateParams(userId, roundStart, side, outcome, shares, price);
    if (err) throw new Error(err);

    if (!Number.isInteger(stopPrice) || stopPrice < this.config.minPrice || stopPrice > this.config.maxPrice) {
      throw new Error(`Stop price must be an integer between ${this.config.minPrice} and ${this.config.maxPrice}`);
    }

    const { bookSide, bookPrice, costPerShare } = this.normalize(side, outcome, price);
    const stopNorm = this.normalize(side, outcome, stopPrice);

    // Insert as 'stopped' — no balance reserved yet
    const order = await dbTrading.insertOrder({
      userId, roundStart, side, outcome, bookSide,
      orderType: 'stop_limit', price: bookPrice,
      stopPrice: stopNorm.bookPrice, // normalized to YES-scale
      shares, costPerShare, status: 'stopped'
    });

    // Add to in-memory stop list
    const stops = this.stops.get(roundStart) || [];
    stops.push({
      id: Number(order.id),
      userId,
      bookSide,
      price: bookPrice,
      stopPrice: stopNorm.bookPrice,
      remainingShares: shares,
      costPerShare,
      side, outcome, // keep original for re-dispatch
    });
    this.stops.set(roundStart, stops);

    this.sendToUser(userId, { type: 'order_accepted', order: this.formatOrder(order), fills: [] });

    // Check if stop should trigger immediately
    await this.checkStopOrders(roundStart);

    return { order };
  }

  // ============================================
  // CANCEL
  // ============================================

  /**
   * Cancel an open, partially-filled, or stopped limit/stop-limit order.
   *
   * Removes the order from the in-memory book (or stop list), updates the
   * DB status to 'cancelled', and refunds the reserved balance for any
   * unfilled shares back to the user.
   *
   * Market orders (FAK/FOK) cannot be cancelled because they execute
   * or kill immediately upon placement.
   *
   * @param {number} userId - Must match the order's owner
   * @param {number} orderId - The order to cancel
   * @returns {Promise<{orderId: number, refund: number}>} Confirmation with refund amount
   * @throws {Error} If order not found, not owned, or not cancellable
   */
  async cancelOrder(userId, orderId) {
    const order = await dbTrading.getOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (Number(order.user_id) !== userId) throw new Error('Not your order');
    if (['market_fak', 'market_fok'].includes(order.order_type)) {
      throw new Error('Cannot cancel market orders');
    }
    if (!['open', 'partially_filled', 'stopped'].includes(order.status)) {
      throw new Error(`Cannot cancel order with status '${order.status}'`);
    }

    const client = await dbTrading.pool.connect();
    try {
      await client.query('BEGIN');

      const cancelled = await dbTrading.cancelOrder(orderId, userId, client);
      if (!cancelled) {
        await client.query('ROLLBACK');
        throw new Error('Cancel failed — order may have been filled');
      }

      // Refund reserved balance for unfilled shares
      // For stopped orders, no balance was reserved (so refund = 0)
      let refund = 0;
      if (order.status !== 'stopped') {
        refund = (Number(cancelled.remaining_shares) * Number(cancelled.cost_per_share)) / 100;
        if (refund > 0) {
          await dbTrading.creditBalance(userId, refund, client);
        }
      }

      await client.query('COMMIT');

      // Remove from in-memory book or stop list
      const roundStart = new Date(order.round_start).getTime();
      const book = this.books.get(roundStart);
      if (book) {
        if (order.book_side === 'bid') {
          this.removeFromBook(book.bids, orderId);
        } else {
          this.removeFromBook(book.asks, orderId);
        }
      }

      // Remove from stops if it was a stop-limit
      const stops = this.stops.get(roundStart);
      if (stops) {
        const idx = stops.findIndex(s => s.id === orderId);
        if (idx !== -1) stops.splice(idx, 1);
      }

      this.sendToUser(userId, { type: 'order_cancelled', orderId, refund });

      return { orderId, refund };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ============================================
  // STOP-LIMIT TRIGGER
  // ============================================

  /**
   * Check and trigger any stop-limit orders based on the current book state.
   *
   * Called after every trade execution that might change best bid/ask.
   * For each pending stop order:
   * - BID stops trigger when best ask <= stopPrice (YES shares becoming cheap enough)
   * - ASK stops trigger when best bid >= stopPrice (YES shares becoming expensive enough)
   *
   * When triggered, the stop order reserves balance and enters the book
   * as a regular limit order. If balance is insufficient at trigger time,
   * the order is cancelled.
   *
   * @param {number} roundStart - Round start timestamp
   */
  async checkStopOrders(roundStart) {
    const stops = this.stops.get(roundStart);
    if (!stops || stops.length === 0) return;

    const book = this.getBook(roundStart);
    const bestBid = book.bids.length > 0 ? book.bids[0].price : null;
    const bestAsk = book.asks.length > 0 ? book.asks[0].price : null;

    const triggered = [];
    const remaining = [];

    for (const stop of stops) {
      let shouldTrigger = false;

      if (stop.bookSide === 'bid' && bestAsk !== null) {
        // BID stop: triggers when ask price drops to or below stopPrice
        shouldTrigger = bestAsk <= stop.stopPrice;
      } else if (stop.bookSide === 'ask' && bestBid !== null) {
        // ASK stop: triggers when bid price rises to or at/above stopPrice
        shouldTrigger = bestBid >= stop.stopPrice;
      }

      if (shouldTrigger) {
        triggered.push(stop);
      } else {
        remaining.push(stop);
      }
    }

    this.stops.set(roundStart, remaining);

    // Process triggered orders as limit orders
    for (const stop of triggered) {
      try {
        const client = await dbTrading.pool.connect();
        try {
          await client.query('BEGIN');
          await dbTrading.activateStopOrder(stop.id, client);

          // Reserve balance
          const totalCost = (stop.costPerShare * stop.remainingShares) / 100;
          await dbTrading.deductBalance(stop.userId, totalCost, client);

          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          // Insufficient balance → cancel the stop order
          await dbTrading.cancelOrder(stop.id, stop.userId);
          this.sendToUser(stop.userId, {
            type: 'order_cancelled', orderId: stop.id,
            refund: 0, reason: 'Insufficient balance at trigger'
          });
          client.release();
          continue;
        }
        client.release();

        // Now place it as a limit order (it already exists in DB, just need to match)
        const order = await dbTrading.getOrder(stop.id);
        const opposingSide = stop.bookSide === 'bid' ? book.asks : book.bids;

        const client2 = await dbTrading.pool.connect();
        try {
          await client2.query('BEGIN');
          const { fills, filledShares } = await this.matchOrder(order, opposingSide, roundStart, client2);
          await client2.query('COMMIT');

          // If unfilled, add to resting book
          const unfilled = Number(order.remaining_shares) - filledShares;
          if (unfilled > 0) {
            const entry = {
              id: stop.id, userId: stop.userId, price: stop.price,
              remainingShares: unfilled, costPerShare: stop.costPerShare,
              bookSide: stop.bookSide, createdAt: new Date(order.created_at).getTime()
            };
            if (stop.bookSide === 'bid') {
              this.insertBid(book.bids, entry);
            } else {
              this.insertAsk(book.asks, entry);
            }
          }

          this.sendToUser(stop.userId, {
            type: 'order_update', orderId: stop.id, status: 'triggered',
            filledShares, remainingShares: unfilled
          });
        } catch (e) {
          await client2.query('ROLLBACK');
          console.error('Stop-limit matching error:', e.message);
        } finally {
          client2.release();
        }
      } catch (e) {
        console.error('Stop-limit trigger error:', e.message);
      }
    }
  }

  // ============================================
  // SETTLEMENT
  // ============================================

  /**
   * Settle a completed round.
   *
   * Called at the minute boundary when the outcome (up/down) is determined.
   * Settlement steps:
   * 1. Cancel all remaining open/stopped orders → refund reserved balances
   * 2. Calculate each user's YES and NO share positions from trades
   * 3. Pay out winning positions: $1.00 (100¢) per winning share
   * 4. Clear the in-memory book and stop list for the round
   *
   * The winning outcome maps to shares:
   * - 'up' → YES shares win
   * - 'down' → NO shares win
   *
   * @param {number} roundStart - Round start timestamp (ms)
   * @param {string} winningOutcome - 'up' or 'down'
   * @returns {Promise<Map<number, number>>} Map of userId → payout amount
   */
  async settleRound(roundStart, winningOutcome) {
    const client = await dbTrading.pool.connect();
    const payouts = new Map();

    try {
      await client.query('BEGIN');

      // 1. Cancel all open orders and refund reserved balances
      const cancelledOrders = await dbTrading.cancelAllRoundOrders(roundStart, client);
      for (const order of cancelledOrders) {
        // Only refund orders that had balance reserved (not stopped stop-limit orders)
        if (order.status !== 'stopped') {
          const remaining = Number(order.remaining_shares);
          const costPerShare = Number(order.cost_per_share);
          if (remaining > 0) {
            const refund = (remaining * costPerShare) / 100;
            if (refund > 0) {
              const newBalance = await dbTrading.creditBalance(Number(order.user_id), refund, client);
              this.sendToUser(Number(order.user_id), { type: 'balance_update', balance: newBalance });
            }
          }
        }
      }

      // 2. Get positions per user
      const positions = await dbTrading.getRoundPositions(roundStart, client);

      // 3. Pay out winning shares
      const yesWins = winningOutcome === 'up';

      for (const pos of positions) {
        const winningShares = yesWins ? pos.yesShares : pos.noShares;
        if (winningShares > 0) {
          const payout = winningShares; // $1.00 per share = winningShares dollars
          const newBalance = await dbTrading.creditBalance(pos.userId, payout, client);
          payouts.set(pos.userId, payout);
          this.sendToUser(pos.userId, {
            type: 'settlement',
            roundStart,
            outcome: winningOutcome,
            payout
          });
          this.sendToUser(pos.userId, { type: 'balance_update', balance: newBalance });
        } else {
          // Losing positions pay $0 — notify anyway
          this.sendToUser(pos.userId, {
            type: 'settlement',
            roundStart,
            outcome: winningOutcome,
            payout: 0
          });
        }
      }

      await client.query('COMMIT');

      // 4. Clear in-memory state
      this.books.delete(roundStart);
      this.stops.delete(roundStart);

      return payouts;
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Settlement error:', e.message);
      throw e;
    } finally {
      client.release();
    }
  }

  // ============================================
  // QUERY FUNCTIONS
  // ============================================

  /**
   * Get all orders for a user, optionally filtered by status.
   *
   * @param {number} userId - User ID
   * @param {object} [filters] - Optional filters
   * @param {string} [filters.status] - 'open' (includes partially_filled/stopped), 'filled', 'cancelled', or 'all'
   * @param {string} [filters.roundStart] - Filter by specific round
   * @param {number} [filters.limit] - Max results (default 50, max 200)
   * @returns {Promise<object[]>} Array of formatted order objects
   */
  async getUserOrders(userId, filters = {}) {
    const orders = await dbTrading.getUserOrders(userId, filters);
    return orders.map(o => this.formatOrder(o));
  }

  /**
   * Get full detail for a single order, including all its trade fills.
   *
   * @param {number} orderId - Order ID
   * @param {number} userId - For ownership verification
   * @returns {Promise<{order: object, fills: object[]}|null>} Order detail with fills, or null if not found/not owned
   */
  async getOrderDetail(orderId, userId) {
    const order = await dbTrading.getOrder(orderId);
    if (!order || Number(order.user_id) !== userId) return null;

    const fills = await dbTrading.getOrderTrades(orderId);
    return { order: this.formatOrder(order), fills };
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Format a raw DB order row into a clean object for API responses.
   * Converts BigInt strings to numbers and normalizes field names.
   * @param {object} row - Raw DB row
   * @returns {object} Formatted order
   */
  formatOrder(row) {
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      roundStart: new Date(row.round_start).getTime(),
      side: row.side,
      outcome: row.outcome,
      bookSide: row.book_side,
      orderType: row.order_type,
      price: row.price,
      stopPrice: row.stop_price,
      shares: Number(row.shares),
      filledShares: Number(row.filled_shares),
      remainingShares: Number(row.remaining_shares),
      costPerShare: Number(row.cost_per_share),
      status: row.status,
      createdAt: new Date(row.created_at).getTime(),
    };
  }
}

module.exports = TradingEngine;
