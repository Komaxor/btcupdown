const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const { verifyTelegramAuth, createSessionToken } = require('./auth');

const STATIC_DIR = path.join(__dirname, '..', 'public');
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class PriceWebSocketServer {
  constructor(port = config.serverPort) {
    this.port = port;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.authenticatedClients = new Map(); // ws -> user data
    this.userSockets = new Map(); // userId -> Set<ws> (reverse map for push messages)
    this.tradingEngine = null;
    this.lastPrice = null;
    this.priceToBeat = null;
    this.currentMinuteStart = null;
    this.minuteCheckInterval = null;
  }

  /**
   * Send a message to all WebSocket connections for a specific user.
   * Used by TradingEngine to push order_update, trade, balance_update messages.
   * @param {number} userId - Target user ID
   * @param {object} message - Message object to send
   */
  sendToUser(userId, message) {
    const sockets = this.userSockets.get(Number(userId));
    if (!sockets) return;
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  start(aggregator, tradingEngine) {
    this.tradingEngine = tradingEngine;
    // Create HTTP server that serves the history API + auth endpoint
    this.httpServer = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/history')) {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10), 500);

        db.getRecentPrices(limit)
          .then(rows => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rows));
          })
          .catch(err => {
            console.error('History API error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/outcomes')) {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '5', 10), 50);

        db.getRecentOutcomes(limit)
          .then(rows => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(rows));
          })
          .catch(err => {
            console.error('Outcomes API error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        return;
      }

      // Telegram auth endpoint
      if (req.method === 'POST' && req.url === '/api/auth/telegram') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const authData = JSON.parse(body);
            const verification = verifyTelegramAuth(authData, config.telegram.botToken);
            if (!verification.valid) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: verification.reason }));
              return;
            }

            const user = await db.upsertUser(authData);
            const token = createSessionToken(user.id, authData.auth_date, config.telegram.botToken);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              user: { ...user, balance: parseFloat(user.balance) },
              token
            }));
          } catch (err) {
            console.error('Auth error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      // Static file serving
      let filePath = req.url.split('?')[0];
      if (filePath === '/') filePath = '/index.html';
      const fullPath = path.join(STATIC_DIR, filePath);

      // Prevent directory traversal
      if (!fullPath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const ext = path.extname(fullPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      fs.readFile(fullPath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });

    // Attach WebSocket server to the HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`Client connected from ${clientIp}`);
      this.clients.add(ws);

      // Send last known price immediately if available
      if (this.lastPrice !== null) {
        ws.send(JSON.stringify({
          p: this.lastPrice.toFixed(2),
          sources: 0,
          timestamp: Date.now()
        }));
      }

      // Send current price to beat
      if (this.priceToBeat !== null) {
        ws.send(JSON.stringify({
          type: 'price_to_beat',
          priceToBeat: this.priceToBeat.toFixed(2),
          minuteStart: this.currentMinuteStart
        }));
      }

      ws.on('close', () => {
        this.clients.delete(ws);
        const userData = this.authenticatedClients.get(ws);
        if (userData) {
          const uid = Number(userData.id);
          const sockets = this.userSockets.get(uid);
          if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) this.userSockets.delete(uid);
          }
        }
        this.authenticatedClients.delete(ws);
        console.log(`Client disconnected (${this.clients.size} remaining)`);
      });

      ws.on('error', (err) => {
        console.error('Client WebSocket error:', err.message);
        this.clients.delete(ws);
        const userData = this.authenticatedClients.get(ws);
        if (userData) {
          const uid = Number(userData.id);
          const sockets = this.userSockets.get(uid);
          if (sockets) {
            sockets.delete(ws);
            if (sockets.size === 0) this.userSockets.delete(uid);
          }
        }
        this.authenticatedClients.delete(ws);
      });

      // Handle client messages
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'auth') {
            const expectedToken = createSessionToken(msg.userId, msg.authDate, config.telegram.botToken);
            if (expectedToken === msg.token) {
              db.getUser(msg.userId).then(user => {
                if (user) {
                  this.authenticatedClients.set(ws, user);
                  // Track userId → ws for push messages
                  const uid = Number(user.id);
                  if (!this.userSockets.has(uid)) {
                    this.userSockets.set(uid, new Set());
                  }
                  this.userSockets.get(uid).add(ws);
                  ws.send(JSON.stringify({
                    type: 'auth_success',
                    user: { ...user, balance: parseFloat(user.balance) }
                  }));
                } else {
                  ws.send(JSON.stringify({ type: 'auth_error', error: 'User not found' }));
                }
              });
            } else {
              ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
            }
          }

          else if (msg.type === 'place_order') {
            this.handlePlaceOrder(ws, msg);
          }

          else if (msg.type === 'cancel_order') {
            this.handleCancelOrder(ws, msg);
          }

          else if (msg.type === 'get_orderbook') {
            this.handleGetOrderBook(ws);
          }

          else if (msg.type === 'get_my_orders') {
            this.handleGetMyOrders(ws, msg);
          }

          else if (msg.type === 'get_order') {
            this.handleGetOrder(ws, msg);
          }

          else if (msg.type === 'status') {
            ws.send(JSON.stringify({
              type: 'status',
              data: aggregator.getStatus()
            }));
          }
        } catch (err) {
          // Ignore invalid messages
        }
      });
    });

    // Listen to aggregator and broadcast + store
    aggregator.on('aggregate', (data) => {
      if (data.price === null) {
        return;
      }

      this.lastPrice = data.price;

      // Store in database
      db.insertPrice(data.price, data.sourceCount, data.timestamp)
        .catch(err => console.error('DB insert error:', err.message));

      // Broadcast to WebSocket clients
      const message = JSON.stringify({
        p: data.price.toFixed(2),
        sources: data.sourceCount,
        timestamp: data.timestamp
      });

      for (const client of this.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    });

    // Check for minute boundaries every 500ms
    this.minuteCheckInterval = setInterval(() => {
      this.checkMinuteBoundary();
    }, 500);

    this.httpServer.listen(this.port, () => {
      console.log(`HTTP + WebSocket server listening on port ${this.port}`);
      console.log(`  WebSocket: ws://localhost:${this.port}`);
      console.log(`  History API: http://localhost:${this.port}/api/history`);
      console.log(`  Auth API: http://localhost:${this.port}/api/auth/telegram`);
    });
  }

  checkMinuteBoundary() {
    if (this.lastPrice === null) return;

    const now = new Date();
    const minuteStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                                  now.getHours(), now.getMinutes(), 0, 0);
    const minuteStartMs = minuteStart.getTime();

    // First run: initialize without recording an outcome
    if (this.currentMinuteStart === null) {
      this.currentMinuteStart = minuteStartMs;
      this.priceToBeat = this.lastPrice;
      if (this.tradingEngine) {
        this.tradingEngine.initRound(minuteStartMs);
      }
      db.insertMinuteStart(minuteStartMs, this.priceToBeat)
        .catch(err => console.error('DB insertMinuteStart error:', err.message));
      this.broadcastPriceToBeat();
      return;
    }

    // New minute detected
    if (minuteStartMs > this.currentMinuteStart) {
      const finalPrice = this.lastPrice;
      const previousMinuteStart = this.currentMinuteStart;

      // Complete the previous minute's outcome
      const outcome = finalPrice >= this.priceToBeat ? 'up' : 'down';
      db.completeMinuteOutcome(previousMinuteStart, finalPrice)
        .then(() => {
          // Settle the trading round
          if (this.tradingEngine) {
            return this.tradingEngine.settleRound(previousMinuteStart, outcome);
          }
        })
        .catch(err => console.error('Settlement error:', err.message));

      // Start new minute
      this.currentMinuteStart = minuteStartMs;
      this.priceToBeat = finalPrice;

      // Initialize new trading round
      if (this.tradingEngine) {
        this.tradingEngine.initRound(minuteStartMs);
      }

      db.insertMinuteStart(minuteStartMs, this.priceToBeat)
        .catch(err => console.error('DB insertMinuteStart error:', err.message));

      this.broadcastPriceToBeat();
    }
  }

  broadcastPriceToBeat() {
    if (this.priceToBeat === null) return;

    const message = JSON.stringify({
      type: 'price_to_beat',
      priceToBeat: this.priceToBeat.toFixed(2),
      minuteStart: this.currentMinuteStart
    });

    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(message);
      }
    }
  }

  // ============================================
  // TRADING MESSAGE HANDLERS
  // ============================================

  /**
   * Handle place_order message.
   * Dispatches to the appropriate TradingEngine method based on orderType.
   *
   * Expected message format:
   *   { type: 'place_order', orderType: 'market_fak'|'market_fok'|'limit'|'stop_limit',
   *     side: 'buy'|'sell', outcome: 'yes'|'no', shares: number,
   *     price?: number, stopPrice?: number }
   *
   * @param {WebSocket} ws - Client WebSocket
   * @param {object} msg - Parsed message
   */
  async handlePlaceOrder(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }
    if (!this.tradingEngine || this.currentMinuteStart === null) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'No active round' }));
      return;
    }

    const userId = Number(userData.id);
    const roundStart = this.currentMinuteStart;
    const { orderType, side, outcome, shares, price, stopPrice } = msg;

    try {
      switch (orderType) {
        case 'market_fak':
          await this.tradingEngine.placeMarketFAK(userId, roundStart, side, outcome, shares);
          break;
        case 'market_fok':
          await this.tradingEngine.placeMarketFOK(userId, roundStart, side, outcome, shares);
          break;
        case 'limit':
          await this.tradingEngine.placeLimitOrder(userId, roundStart, side, outcome, shares, price);
          break;
        case 'stop_limit':
          await this.tradingEngine.placeStopLimitOrder(userId, roundStart, side, outcome, shares, stopPrice, price);
          break;
        default:
          ws.send(JSON.stringify({ type: 'order_rejected', error: 'Invalid orderType' }));
          return;
      }

      // Send updated balance
      const user = await db.getUser(userId);
      if (user) {
        this.sendToUser(userId, { type: 'balance_update', balance: parseFloat(user.balance) });
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  /**
   * Handle cancel_order message.
   *
   * Expected message format:
   *   { type: 'cancel_order', orderId: number }
   *
   * @param {WebSocket} ws - Client WebSocket
   * @param {object} msg - Parsed message
   */
  async handleCancelOrder(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    try {
      const userId = Number(userData.id);
      await this.tradingEngine.cancelOrder(userId, msg.orderId);

      // Send updated balance
      const user = await db.getUser(userId);
      if (user) {
        this.sendToUser(userId, { type: 'balance_update', balance: parseFloat(user.balance) });
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  /**
   * Handle get_orderbook message.
   * Returns aggregated price levels for the current round's order book.
   *
   * Expected message format:
   *   { type: 'get_orderbook' }
   *
   * @param {WebSocket} ws - Client WebSocket
   */
  handleGetOrderBook(ws) {
    if (!this.tradingEngine || this.currentMinuteStart === null) {
      ws.send(JSON.stringify({ type: 'orderbook', bids: [], asks: [] }));
      return;
    }

    const book = this.tradingEngine.getOrderBook(this.currentMinuteStart);
    ws.send(JSON.stringify({ type: 'orderbook', ...book }));
  }

  /**
   * Handle get_my_orders message.
   * Returns the authenticated user's orders, optionally filtered by status.
   *
   * Expected message format:
   *   { type: 'get_my_orders', status?: 'open'|'all' }
   *
   * @param {WebSocket} ws - Client WebSocket
   * @param {object} msg - Parsed message
   */
  async handleGetMyOrders(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    try {
      const orders = await this.tradingEngine.getUserOrders(Number(userData.id), {
        status: msg.status || 'all'
      });
      ws.send(JSON.stringify({ type: 'my_orders', orders }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  /**
   * Handle get_order message.
   * Returns full detail for a single order including its trade fills.
   *
   * Expected message format:
   *   { type: 'get_order', orderId: number }
   *
   * @param {WebSocket} ws - Client WebSocket
   * @param {object} msg - Parsed message
   */
  async handleGetOrder(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    try {
      const detail = await this.tradingEngine.getOrderDetail(msg.orderId, Number(userData.id));
      if (!detail) {
        ws.send(JSON.stringify({ type: 'order_rejected', error: 'Order not found' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'order_detail', ...detail }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  stop() {
    if (this.minuteCheckInterval) {
      clearInterval(this.minuteCheckInterval);
      this.minuteCheckInterval = null;
    }
    if (this.wss) {
      for (const client of this.clients) {
        client.close();
      }
      this.clients.clear();
      this.authenticatedClients.clear();
      this.userSockets.clear();
      this.wss.close();
    }
    if (this.httpServer) {
      this.httpServer.close();
      console.log('HTTP + WebSocket server stopped');
    }
  }

  getClientCount() {
    return this.clients.size;
  }
}

module.exports = PriceWebSocketServer;
