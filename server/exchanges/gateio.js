const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class GateIOExchange extends BaseExchange {
  constructor() {
    super('gateio');
    this.ws = null;
    this.url = 'wss://api.gateio.ws/ws/v4/';
    this.pingInterval = null;
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
        time: Math.floor(Date.now() / 1000),
        channel: 'spot.tickers',
        event: 'subscribe',
        payload: ['BTC_USDT']
      }));

      // Application-level ping every 30s
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            channel: 'spot.ping'
          }));
        }
      }, 30000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Ignore pong and subscription confirmations
        if (msg.channel === 'spot.pong') return;
        if (msg.event === 'subscribe') return;

        // Ticker update
        if (msg.channel === 'spot.tickers' && msg.event === 'update' && msg.result) {
          const ticker = msg.result;
          const lastPrice = ticker.last;
          const bid = ticker.highest_bid;
          const ask = ticker.lowest_ask;

          if (lastPrice) {
            this.updatePrice(lastPrice, bid, ask);
          }
        }
      } catch (err) {
        this.logError('Parse error', err);
      }
    });

    this.ws.on('close', () => {
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = null;
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
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

module.exports = GateIOExchange;
