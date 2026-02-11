const EventEmitter = require('events');
const config = require('../config');

class BaseExchange extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.price = null;
    this.bid = null;
    this.ask = null;
    this.lastUpdate = null;
    this.connected = false;
    this.reconnectAttempts = 0;
  }

  // Must be implemented by subclasses
  connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  // Update price and emit event
  updatePrice(price, bid = null, ask = null) {
    this.price = parseFloat(price);
    this.bid = bid ? parseFloat(bid) : null;
    this.ask = ask ? parseFloat(ask) : null;
    this.lastUpdate = Date.now();

    this.emit('price', {
      exchange: this.name,
      price: this.price,
      bid: this.bid,
      ask: this.ask,
      timestamp: this.lastUpdate
    });
  }

  // Check if data is stale
  isStale(thresholdMs = config.staleThreshold) {
    return !this.lastUpdate || (Date.now() - this.lastUpdate) > thresholdMs;
  }

  // Reconnection logic with exponential backoff
  scheduleReconnect() {
    if (this.reconnectAttempts >= config.reconnect.maxAttempts) {
      console.error(`[${this.name}] Max reconnect attempts (${config.reconnect.maxAttempts}) reached`);
      this.emit('maxReconnectReached');
      return;
    }

    const delay = Math.min(
      config.reconnect.initialDelay * Math.pow(2, this.reconnectAttempts),
      config.reconnect.maxDelay
    );

    this.reconnectAttempts++;
    console.log(`[${this.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  resetReconnect() {
    this.reconnectAttempts = 0;
  }

  log(message) {
    console.log(`[${this.name}] ${message}`);
  }

  logError(message, err = null) {
    console.error(`[${this.name}] ${message}`, err ? err.message : '');
  }
}

module.exports = BaseExchange;
