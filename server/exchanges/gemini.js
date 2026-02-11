const BaseExchange = require('./base-exchange');
const config = require('../config');

class GeminiExchange extends BaseExchange {
  constructor() {
    super('gemini');
    this.url = 'https://api.gemini.com/v2/ticker/BTCUSD';
    this.pollInterval = null;
    this.pollRate = config.exchanges.gemini.pollInterval;
  }

  async connect() {
    this.log('Starting REST polling...');
    this.connected = true;
    this.resetReconnect();
    this.emit('connected');

    // Initial fetch
    await this.fetchPrice();

    // Start polling
    this.pollInterval = setInterval(() => this.fetchPrice(), this.pollRate);
    this.log(`Polling every ${this.pollRate}ms`);
  }

  async fetchPrice() {
    try {
      const response = await fetch(this.url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      // Response: { symbol, open, high, low, close, changes[], bid, ask }
      this.updatePrice(data.close, data.bid, data.ask);
    } catch (err) {
      this.logError('Fetch error', err);
      this.emit('error', err);
      // Don't disconnect on transient errors, just skip this update
    }
  }

  disconnect() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
    this.log('Stopped polling');
  }
}

module.exports = GeminiExchange;
