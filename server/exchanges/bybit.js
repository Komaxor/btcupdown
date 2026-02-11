const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');
const config = require('../config');

class BybitExchange extends BaseExchange {
  constructor() {
    super('bybit');
    this.ws = null;
    this.url = 'wss://stream.bybit.com/v5/public/spot';
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

      // Subscribe to both BTCUSDT and BTCUSDC
      this.ws.send(JSON.stringify({
        op: 'subscribe',
        args: ['tickers.BTCUSDT', 'tickers.BTCUSDC']
      }));

      // Ping every 20 seconds to keep alive
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 'ping' }));
        }
      }, config.exchanges.bybit.pingInterval);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Handle pong
        if (msg.op === 'pong') {
          return;
        }

        // Handle subscription confirmation
        if (msg.op === 'subscribe') {
          this.log(`Subscribed: ${msg.success ? 'OK' : 'FAILED'}`);
          return;
        }

        // Handle ticker data
        if (msg.topic && msg.topic.startsWith('tickers.') && msg.data) {
          const symbol = msg.data.symbol;
          const priceData = {
            price: parseFloat(msg.data.lastPrice),
            bid: msg.data.bid1Price ? parseFloat(msg.data.bid1Price) : null,
            ask: msg.data.ask1Price ? parseFloat(msg.data.ask1Price) : null,
            timestamp: Date.now()
          };

          if (symbol === 'BTCUSDT') {
            this.prices.usdt = priceData;
            this.emit('price', {
              exchange: 'bybit_usdt',
              price: priceData.price,
              bid: priceData.bid,
              ask: priceData.ask,
              timestamp: priceData.timestamp
            });
          } else if (symbol === 'BTCUSDC') {
            this.prices.usdc = priceData;
            this.emit('price', {
              exchange: 'bybit_usdc',
              price: priceData.price,
              bid: priceData.bid,
              ask: priceData.ask,
              timestamp: priceData.timestamp
            });
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

module.exports = BybitExchange;
