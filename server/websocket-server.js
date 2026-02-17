const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const dbTrading = require('./db-trading');
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

const PROVISION_LEAD_MS = 300000; // 5 minutes

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
    this.currentMinuteStart = null;
    this.minuteCheckInterval = null;
    this._obBroadcastTimer = null;
    this._boundaryInProgress = false;

    /** @type {Map<number, {slug: string, phase: string, priceToBeat: number|null, minuteStart: number}>} */
    this.markets = new Map(); // minuteStartMs → market metadata
  }

  // ============================================
  // SLUG & PHASE HELPERS
  // ============================================

  generateSlug(minuteStartMs) {
    const d = new Date(minuteStartMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `btc-${yyyy}${mm}${dd}-${hh}${min}`;
  }

  getMarketPhase(minuteStartMs) {
    const now = Date.now();
    if (now < minuteStartMs) return 'provision';
    if (now < minuteStartMs + 60000) return 'active';
    return 'closed';
  }

  resolveRoundStart(slug) {
    for (const [ms, market] of this.markets) {
      if (market.slug === slug) return ms;
    }
    return null;
  }

  getActiveMarketRoundStart() {
    for (const [ms, market] of this.markets) {
      if (market.phase === 'active') return ms;
    }
    return null;
  }

  getMarketListPayload() {
    const list = [];
    for (const [ms, market] of this.markets) {
      list.push({
        slug: market.slug,
        minuteStart: ms,
        phase: market.phase,
        priceToBeat: market.priceToBeat,
        finalPrice: market.finalPrice || null,
        outcome: market.outcome || null
      });
    }
    list.sort((a, b) => a.minuteStart - b.minuteStart);
    return list;
  }

  // ============================================
  // MESSAGING HELPERS
  // ============================================

  sendToUser(userId, message) {
    const sockets = this.userSockets.get(Number(userId));
    if (!sockets) return;
    const data = JSON.stringify(message);
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(data);
    }
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  broadcastMarketList() {
    this.broadcast({ type: 'market_list', markets: this.getMarketListPayload() });
  }

  broadcastOrderBook(roundStart) {
    if (!this.tradingEngine) return;
    const rs = roundStart || this.getActiveMarketRoundStart();
    if (!rs) return;
    const market = this.markets.get(rs);
    const book = this.tradingEngine.getOrderBook(rs);
    this.broadcast({ type: 'orderbook', slug: market ? market.slug : null, ...book });
  }

  scheduleBroadcastOrderBook() {
    if (this._obBroadcastTimer) return;
    this._obBroadcastTimer = setTimeout(() => {
      this._obBroadcastTimer = null;
      this.broadcastOrderBook();
    }, 50);
  }

  // ============================================
  // MARKET LIFECYCLE
  // ============================================

  async createMarket(minuteStartMs) {
    if (this.markets.has(minuteStartMs)) return;
    const slug = this.generateSlug(minuteStartMs);
    const phase = this.getMarketPhase(minuteStartMs);
    this.markets.set(minuteStartMs, {
      slug,
      phase,
      priceToBeat: null,
      minuteStart: minuteStartMs
    });
    await db.insertMarket(minuteStartMs, slug)
      .catch(err => console.error('DB insertMarket error:', err.message));
    console.log(`  Market created: ${slug} (${phase}) — resolves at ${new Date(minuteStartMs + 60000).toISOString()}`);
  }

  async activateMarket(minuteStartMs, priceToBeat) {
    const market = this.markets.get(minuteStartMs);
    if (!market) return;
    market.phase = 'active';
    market.priceToBeat = priceToBeat;
    if (this.tradingEngine) {
      this.tradingEngine.initRound(minuteStartMs);
      this.tradingEngine.setPhase(minuteStartMs, 'active');
    }
    await db.updatePriceToBeat(minuteStartMs, priceToBeat)
      .catch(err => console.error('DB updatePriceToBeat error:', err.message));
    console.log(`  Market activated: ${market.slug} — price to beat: $${priceToBeat.toFixed(2)}`);
    this.broadcast({
      type: 'price_to_beat',
      slug: market.slug,
      priceToBeat: priceToBeat.toFixed(2),
      minuteStart: minuteStartMs
    });
    this.broadcast({ type: 'market_phase_change', slug: market.slug, phase: 'active', priceToBeat: priceToBeat.toFixed(2) });
  }

  async settleMarket(minuteStartMs) {
    const market = this.markets.get(minuteStartMs);
    if (!market || market.phase === 'closed') return;
    if (!market.priceToBeat) return; // never activated

    const finalPrice = this.lastPrice;
    const outcome = finalPrice >= market.priceToBeat ? 'up' : 'down';
    market.phase = 'closed';
    market.finalPrice = finalPrice;
    market.outcome = outcome;

    await db.completeMinuteOutcome(minuteStartMs, finalPrice)
      .catch(err => console.error('Settlement DB error:', err.message));

    if (this.tradingEngine) {
      this.tradingEngine.setPhase(minuteStartMs, 'closed');
      await this.tradingEngine.settleRound(minuteStartMs, outcome)
        .catch(err => console.error('Settlement engine error:', err.message));
    }

    console.log(`  Market settled: ${market.slug} — ${outcome} (beat: $${market.priceToBeat.toFixed(2)}, final: $${finalPrice.toFixed(2)})`);
    this.broadcast({ type: 'market_phase_change', slug: market.slug, phase: 'closed', outcome, finalPrice });
  }

  cleanupOldMarkets() {
    const cutoff = Date.now() - 600000; // 10 min ago
    for (const [ms, market] of this.markets) {
      if (market.phase === 'closed' && ms + 60000 < cutoff) {
        this.markets.delete(ms);
      }
    }
  }

  async initMarkets() {
    const now = new Date();
    const currentMinuteMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      now.getHours(), now.getMinutes(), 0, 0).getTime();

    console.log('Creating initial markets...');

    // Create current minute market (will be activated once first price arrives)
    await this.createMarket(currentMinuteMs);

    // Create future provision markets (next 5 minutes)
    for (let i = 1; i <= 5; i++) {
      await this.createMarket(currentMinuteMs + i * 60000);
    }

    this.currentMinuteStart = currentMinuteMs;
    this.broadcastMarketList();
    console.log(`Init complete: ${this.markets.size} markets created (awaiting first price for activation)`);
  }

  async checkMinuteBoundary() {
    if (this.lastPrice === null) return;
    if (this._boundaryInProgress) return;
    this._boundaryInProgress = true;

    try {
      const now = new Date();
      const minuteStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        now.getHours(), now.getMinutes(), 0, 0).getTime();

      // First price arrived — activate current minute's market if not yet active
      // Re-align currentMinuteStart in case we crossed a minute boundary since initMarkets
      if (minuteStartMs > this.currentMinuteStart) {
        // Minute(s) passed since initMarkets — update tracking and create any missing markets
        this.currentMinuteStart = minuteStartMs;
        if (!this.markets.has(minuteStartMs)) {
          await this.createMarket(minuteStartMs);
        }
        // Create future provision markets if needed
        for (let i = 1; i <= 5; i++) {
          const futureMs = minuteStartMs + i * 60000;
          if (!this.markets.has(futureMs)) {
            await this.createMarket(futureMs);
          }
        }
      }

      const currentMarket = this.markets.get(this.currentMinuteStart);
      if (currentMarket && currentMarket.phase !== 'active' && currentMarket.phase !== 'closed') {
        await this.activateMarket(this.currentMinuteStart, this.lastPrice);
        this.broadcastMarketList();
        this.broadcastOrderBook(this.currentMinuteStart);
        return;
      }

      // New minute detected
      if (minuteStartMs > this.currentMinuteStart) {
        const T = minuteStartMs;
        const previousMinuteStart = this.currentMinuteStart;
        this.currentMinuteStart = T;

        console.log(`\nMinute boundary: ${new Date(T).toISOString()}`);

        // 1. SETTLE previous market (T - 60000) — must complete before activation
        await this.settleMarket(previousMinuteStart);

        // 2. ACTIVATE current market (T)
        if (this.markets.has(T)) {
          await this.activateMarket(T, this.lastPrice);
        }

        // 3. CREATE future market (T + 300000)
        await this.createMarket(T + PROVISION_LEAD_MS);

        // 4. CLEANUP old markets
        this.cleanupOldMarkets();

        // Broadcast updated state
        this.broadcastMarketList();
        this.broadcastOrderBook(T);
      }
    } finally {
      this._boundaryInProgress = false;
    }
  }

  // ============================================
  // HTTP SERVER
  // ============================================

  start(aggregator, tradingEngine) {
    this.tradingEngine = tradingEngine;

    this.httpServer = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${this.port}`);
      const pathname = url.pathname;

      // API: price history
      if (req.method === 'GET' && pathname === '/api/history') {
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

      // API: outcomes
      if (req.method === 'GET' && pathname === '/api/outcomes') {
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

      // API: list all markets
      if (req.method === 'GET' && pathname === '/api/markets') {
        const markets = this.getMarketListPayload();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(markets));
        return;
      }

      // API: single market detail
      const marketMatch = pathname.match(/^\/api\/market\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && marketMatch) {
        const slug = marketMatch[1];
        const roundStart = this.resolveRoundStart(slug);
        if (!roundStart) {
          // Try DB fallback for closed markets
          db.getMarketBySlug(slug)
            .then(market => {
              if (!market) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Market not found' }));
                return;
              }
              const phase = this.getMarketPhase(market.minuteStart);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...market, phase }));
            })
            .catch(err => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
            });
          return;
        }
        const market = this.markets.get(roundStart);
        dbTrading.getTotalLiquidity(roundStart)
          .then(totalLiquidity => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              slug: market.slug,
              minuteStart: roundStart,
              phase: market.phase,
              priceToBeat: market.priceToBeat,
              totalLiquidity
            }));
          })
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        return;
      }

      // Telegram auth endpoint
      if (req.method === 'POST' && pathname === '/api/auth/telegram') {
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

      // SPA route: /market/ or /market/:slug → serve updown.html
      if (req.method === 'GET' && /^\/market(\/[a-z0-9-]*)?$/.test(pathname)) {
        const htmlPath = path.join(STATIC_DIR, 'updown.html');
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
        return;
      }

      // Static file serving
      let filePath = pathname;
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

      // Send current active market's price to beat
      const activeRound = this.getActiveMarketRoundStart();
      if (activeRound) {
        const activeMarket = this.markets.get(activeRound);
        if (activeMarket && activeMarket.priceToBeat !== null) {
          ws.send(JSON.stringify({
            type: 'price_to_beat',
            slug: activeMarket.slug,
            priceToBeat: activeMarket.priceToBeat.toFixed(2),
            minuteStart: activeRound
          }));
        }
      }

      // Send market list
      ws.send(JSON.stringify({ type: 'market_list', markets: this.getMarketListPayload() }));

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
            this.handleGetOrderBook(ws, msg);
          }

          else if (msg.type === 'get_my_orders') {
            this.handleGetMyOrders(ws, msg);
          }

          else if (msg.type === 'get_order') {
            this.handleGetOrder(ws, msg);
          }

          else if (msg.type === 'add_liquidity') {
            this.handleAddLiquidity(ws, msg);
          }

          else if (msg.type === 'get_market') {
            this.handleGetMarket(ws, msg);
          }

          else if (msg.type === 'get_markets') {
            ws.send(JSON.stringify({ type: 'market_list', markets: this.getMarketListPayload() }));
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
      if (data.price === null) return;

      this.lastPrice = data.price;

      db.insertPrice(data.price, data.sourceCount, data.timestamp)
        .catch(err => console.error('DB insert error:', err.message));

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

    // Create markets immediately (activation happens when first price arrives)
    this.initMarkets().catch(err => console.error('initMarkets error:', err.message));

    this.httpServer.listen(this.port, () => {
      console.log(`HTTP + WebSocket server listening on port ${this.port}`);
      console.log(`  WebSocket: ws://localhost:${this.port}`);
      console.log(`  History API: http://localhost:${this.port}/api/history`);
      console.log(`  Markets API: http://localhost:${this.port}/api/markets`);
      console.log(`  Auth API: http://localhost:${this.port}/api/auth/telegram`);
    });
  }

  // ============================================
  // TRADING MESSAGE HANDLERS
  // ============================================

  async handlePlaceOrder(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    // Resolve market from slug or fall back to active market
    let roundStart;
    if (msg.slug) {
      roundStart = this.resolveRoundStart(msg.slug);
      if (!roundStart) {
        ws.send(JSON.stringify({ type: 'order_rejected', error: 'Market not found' }));
        return;
      }
    } else {
      roundStart = this.getActiveMarketRoundStart();
    }

    if (!this.tradingEngine || !roundStart) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'No active round' }));
      return;
    }

    const market = this.markets.get(roundStart);
    if (!market || market.phase !== 'active') {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Market not in trading phase' }));
      return;
    }

    const userId = Number(userData.id);
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

      const user = await db.getUser(userId);
      if (user) {
        this.sendToUser(userId, { type: 'balance_update', balance: parseFloat(user.balance) });
      }

      this.scheduleBroadcastOrderBook();
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  async handleCancelOrder(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    try {
      const userId = Number(userData.id);
      await this.tradingEngine.cancelOrder(userId, msg.orderId);

      const user = await db.getUser(userId);
      if (user) {
        this.sendToUser(userId, { type: 'balance_update', balance: parseFloat(user.balance) });
      }

      this.scheduleBroadcastOrderBook();
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

  handleGetOrderBook(ws, msg) {
    if (!this.tradingEngine) {
      ws.send(JSON.stringify({ type: 'orderbook', bids: [], asks: [] }));
      return;
    }

    let roundStart;
    if (msg && msg.slug) {
      roundStart = this.resolveRoundStart(msg.slug);
    }
    if (!roundStart) {
      roundStart = this.getActiveMarketRoundStart();
    }
    if (!roundStart) {
      ws.send(JSON.stringify({ type: 'orderbook', bids: [], asks: [] }));
      return;
    }

    const market = this.markets.get(roundStart);
    const book = this.tradingEngine.getOrderBook(roundStart);
    ws.send(JSON.stringify({ type: 'orderbook', slug: market ? market.slug : null, ...book }));
  }

  async handleGetMyOrders(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    try {
      const filters = { status: msg.status || 'all' };
      if (msg.slug) {
        const roundStart = this.resolveRoundStart(msg.slug);
        if (roundStart) filters.roundStart = roundStart;
      }
      const orders = await this.tradingEngine.getUserOrders(Number(userData.id), filters);
      ws.send(JSON.stringify({ type: 'my_orders', orders }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    }
  }

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

  // ============================================
  // LIQUIDITY PROVISION HANDLER
  // ============================================

  async handleAddLiquidity(ws, msg) {
    const userData = this.authenticatedClients.get(ws);
    if (!userData) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Not authenticated' }));
      return;
    }

    const { slug, amount } = msg;
    if (!slug || !amount) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Missing slug or amount' }));
      return;
    }

    const roundStart = this.resolveRoundStart(slug);
    if (!roundStart) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Market not found' }));
      return;
    }

    const market = this.markets.get(roundStart);
    if (!market || market.phase !== 'provision') {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Market not in provision phase' }));
      return;
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Amount must be a positive whole number' }));
      return;
    }

    const userId = Number(userData.id);
    const client = await dbTrading.pool.connect();

    try {
      await client.query('BEGIN');

      // Deduct balance ($amount = amount dollars)
      await dbTrading.deductBalance(userId, amount, client);

      // Record provision
      await dbTrading.insertLiquidityProvision(userId, roundStart, amount, client);

      // Mint position: +amount YES shares, +amount NO shares
      const position = await dbTrading.upsertPosition(userId, roundStart, amount, amount, client);

      await client.query('COMMIT');

      // Get updated balance
      const user = await db.getUser(userId);
      const balance = user ? parseFloat(user.balance) : null;

      ws.send(JSON.stringify({
        type: 'liquidity_added',
        slug,
        amount,
        position: { yes: position.yesShares, no: position.noShares }
      }));

      if (balance !== null) {
        this.sendToUser(userId, { type: 'balance_update', balance });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      ws.send(JSON.stringify({ type: 'order_rejected', error: err.message }));
    } finally {
      client.release();
    }
  }

  // ============================================
  // MARKET INFO HANDLERS
  // ============================================

  async handleGetMarket(ws, msg) {
    const { slug } = msg;
    if (!slug) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Missing slug' }));
      return;
    }

    const roundStart = this.resolveRoundStart(slug);
    if (roundStart) {
      const market = this.markets.get(roundStart);
      const totalLiquidity = await dbTrading.getTotalLiquidity(roundStart).catch(() => 0);
      ws.send(JSON.stringify({
        type: 'market_info',
        market: {
          slug: market.slug,
          minuteStart: roundStart,
          phase: market.phase,
          priceToBeat: market.priceToBeat,
          totalLiquidity
        }
      }));
      return;
    }

    // Fallback to DB for older markets
    const market = await db.getMarketBySlug(slug);
    if (!market) {
      ws.send(JSON.stringify({ type: 'order_rejected', error: 'Market not found' }));
      return;
    }
    const totalLiquidity = await dbTrading.getTotalLiquidity(market.minuteStart).catch(() => 0);
    ws.send(JSON.stringify({
      type: 'market_info',
      market: {
        ...market,
        phase: this.getMarketPhase(market.minuteStart),
        totalLiquidity
      }
    }));
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  stop() {
    if (this.minuteCheckInterval) {
      clearInterval(this.minuteCheckInterval);
      this.minuteCheckInterval = null;
    }
    if (this._obBroadcastTimer) {
      clearTimeout(this._obBroadcastTimer);
      this._obBroadcastTimer = null;
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
