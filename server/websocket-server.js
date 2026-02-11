const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const { verifyTelegramAuth, createSessionToken } = require('./auth');

class PriceWebSocketServer {
  constructor(port = config.serverPort) {
    this.port = port;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this.authenticatedClients = new Map(); // ws -> user data
    this.lastPrice = null;
    this.priceToBeat = null;
    this.currentMinuteStart = null;
    this.minuteCheckInterval = null;
  }

  start(aggregator) {
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

      res.writeHead(404);
      res.end();
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
        this.authenticatedClients.delete(ws);
        console.log(`Client disconnected (${this.clients.size} remaining)`);
      });

      ws.on('error', (err) => {
        console.error('Client WebSocket error:', err.message);
        this.clients.delete(ws);
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

          else if (msg.type === 'place_bet') {
            const userData = this.authenticatedClients.get(ws);
            if (!userData) {
              ws.send(JSON.stringify({ type: 'bet_error', error: 'Not authenticated' }));
              return;
            }
            // Acknowledge bet (full bet logic is a follow-up)
            ws.send(JSON.stringify({ type: 'bet_received', betId: Date.now() }));
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
      db.insertMinuteStart(minuteStartMs, this.priceToBeat)
        .catch(err => console.error('DB insertMinuteStart error:', err.message));
      this.broadcastPriceToBeat();
      return;
    }

    // New minute detected
    if (minuteStartMs > this.currentMinuteStart) {
      const finalPrice = this.lastPrice;

      // Complete the previous minute's outcome
      db.completeMinuteOutcome(this.currentMinuteStart, finalPrice)
        .catch(err => console.error('DB completeMinuteOutcome error:', err.message));

      // Start new minute
      this.currentMinuteStart = minuteStartMs;
      this.priceToBeat = finalPrice;

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
