const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class CryptoComExchange extends BaseExchange {
  constructor() {
    super('cryptocom');
    this.ws = null;
    this.url = 'wss://stream.crypto.com/exchange/v1/market';
  }

  connect() {
    this.log('Connecting...');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.resetReconnect();
      this.log('Connected');
      this.emit('connected');

      this.ws.send(JSON.stringify({
        id: 1,
        method: 'subscribe',
        params: {
          channels: ['ticker.BTCUSD-PERP']
        },
        nonce: Date.now()
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Respond to server heartbeats to keep connection alive
        if (msg.method === 'public/heartbeat') {
          this.ws.send(JSON.stringify({
            id: msg.id,
            method: 'public/respond-heartbeat'
          }));
          return;
        }

        // Ignore subscription confirmations
        if (msg.method === 'subscribe') return;

        // Ticker data
        if (msg.result && msg.result.channel && msg.result.channel.startsWith('ticker.')) {
          const items = msg.result.data;
          if (items && items.length > 0) {
            const ticker = items[0];
            // a = last trade price, b = best bid, k = best ask
            const lastPrice = ticker.a;
            const bid = ticker.b;
            const ask = ticker.k;

            if (lastPrice) {
              this.updatePrice(lastPrice, bid, ask);
            }
          }
        }
      } catch (err) {
        this.logError('Parse error', err);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.log('Disconnected');
      this.emit('disconnected');
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

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = CryptoComExchange;
