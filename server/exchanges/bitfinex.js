const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class BitfinexExchange extends BaseExchange {
  constructor() {
    super('bitfinex');
    this.ws = null;
    this.url = 'wss://api-pub.bitfinex.com/ws/2';
    this.channelId = null;
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
        event: 'subscribe',
        channel: 'ticker',
        symbol: 'tBTCUSD'
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // Control messages (objects)
        if (msg.event) {
          if (msg.event === 'subscribed' && msg.channel === 'ticker') {
            this.channelId = msg.chanId;
            this.log('Subscribed to ticker channel ' + msg.chanId);
          }
          if (msg.event === 'error') {
            this.logError('API error: ' + msg.msg);
          }
          return;
        }

        // Data messages (arrays)
        if (!Array.isArray(msg) || msg[0] !== this.channelId) return;

        // Ignore heartbeats
        if (msg[1] === 'hb') return;

        const ticker = msg[1];
        if (!Array.isArray(ticker) || ticker.length < 10) return;

        // [BID, BID_SIZE, ASK, ASK_SIZE, DAILY_CHANGE, DAILY_CHANGE_PERC, LAST_PRICE, VOLUME, HIGH, LOW]
        const lastPrice = ticker[6];
        const bid = ticker[0];
        const ask = ticker[2];

        this.updatePrice(lastPrice, bid, ask);
      } catch (err) {
        this.logError('Parse error', err);
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.channelId = null;
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
    this.channelId = null;
    this.connected = false;
  }
}

module.exports = BitfinexExchange;
