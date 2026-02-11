const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');

class BinanceExchange extends BaseExchange {
  constructor() {
    super('binance');
    this.ws = null;
    this.url = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';
  }

  connect() {
    this.log('Connecting...');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.connected = true;
      this.resetReconnect();
      this.log('Connected');
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      try {
        const ticker = JSON.parse(data);
        // bookTicker: b = best bid price, a = best ask price
        const midPrice = (parseFloat(ticker.b) + parseFloat(ticker.a)) / 2;
        this.updatePrice(midPrice, ticker.b, ticker.a);
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

module.exports = BinanceExchange;
