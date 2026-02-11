const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class KrakenExchange extends BaseExchange {
  constructor() {
    super('kraken');
    this.ws = null;
    this.url = 'wss://ws.kraken.com/v2';
    this.pingInterval = null;
    // Track prices for both pairs
    this.prices = {
      usdt: { price: null, bid: null, ask: null, timestamp: null },
      usdc: { price: null, bid: null, ask: null, timestamp: null }
    };
  }

  connect() {
    this.log('Connecting...');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.resetReconnect();
      this.log('Connected');
      this.emit('connected');

      // Subscribe to ticker for BTC/USDT and BTC/USDC
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'ticker',
          symbol: ['BTC/USDT', 'BTC/USDC']
        }
      }));

      // Send ping every 30 seconds to keep connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Handle pong
        if (msg.method === 'pong') {
          return;
        }

        // Handle subscription response
        if (msg.method === 'subscribe') {
          this.log(`Subscribe ${msg.success ? 'OK' : 'FAILED'}: ${msg.result?.symbol || ''}`);
          return;
        }

        // Handle ticker channel data
        if (msg.channel === 'ticker' && msg.data && Array.isArray(msg.data)) {
          for (const ticker of msg.data) {
            const symbol = ticker.symbol;
            const priceData = {
              price: parseFloat(ticker.last),
              bid: ticker.bid ? parseFloat(ticker.bid) : null,
              ask: ticker.ask ? parseFloat(ticker.ask) : null,
              timestamp: Date.now()
            };

            if (symbol === 'BTC/USDT') {
              this.prices.usdt = priceData;
              this.emit('price', {
                exchange: 'kraken_usdt',
                price: priceData.price,
                bid: priceData.bid,
                ask: priceData.ask,
                timestamp: priceData.timestamp
              });
            } else if (symbol === 'BTC/USDC') {
              this.prices.usdc = priceData;
              this.emit('price', {
                exchange: 'kraken_usdc',
                price: priceData.price,
                bid: priceData.bid,
                ask: priceData.ask,
                timestamp: priceData.timestamp
              });
            }
          }
        }
      } catch (err) {
        this.logError('Parse error', err);
      }
    });

    this.ws.on('close', () => {
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logError('WebSocket error', err);
      this.emit('error', err);
      if (this.ws) {
        this.ws.close();
      }
    });
  }

  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.connected = false;
    this.log('Disconnected');
    this.emit('disconnected');
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = KrakenExchange;
