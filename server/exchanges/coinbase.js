const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class CoinbaseExchange extends BaseExchange {
  constructor() {
    super('coinbase');
    this.ws = null;
    // Using the public Exchange WebSocket (not Advanced Trade)
    this.url = 'wss://ws-feed.exchange.coinbase.com';
    // Track price for BTC-USD
    this.lastPrice = null;
  }

  connect() {
    this.log('Connecting...');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.resetReconnect();
      this.log('Connected');
      this.emit('connected');

      // Subscribe to ticker for BTC-USD only (BTC-USDC not available on public feed)
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker']
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Handle subscription confirmation
        if (msg.type === 'subscriptions') {
          this.log('Subscribed to channels');
          return;
        }

        // Handle ticker messages
        if (msg.type === 'ticker' && msg.product_id === 'BTC-USD') {
          this.updatePrice(
            msg.price,
            msg.best_bid,
            msg.best_ask
          );
        }

        // Handle errors
        if (msg.type === 'error') {
          this.logError('API error', new Error(msg.message));
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

module.exports = CoinbaseExchange;
