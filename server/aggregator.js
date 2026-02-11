const EventEmitter = require('events');
const config = require('./config');

// Format timestamp as HH:MM:SS.mmm
function formatTime(timestamp) {
  const d = new Date(timestamp);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

// Extract pair type from exchange name (e.g., "bybit_usdt" -> "USDT")
function getPairType(exchangeName) {
  if (exchangeName.includes('_usdt')) return 'USDT';
  if (exchangeName.includes('_usdc')) return 'USDC';
  if (exchangeName.includes('_usd') || exchangeName === 'coinbase') return 'USD';
  // Default pair types for single-pair exchanges
  if (exchangeName === 'binance' || exchangeName === 'kucoin') return 'USDT';
  if (exchangeName === 'gemini') return 'USD';
  return '';
}

// Get clean exchange name (e.g., "bybit_usdt" -> "Bybit")
function getExchangeName(exchangeName) {
  const base = exchangeName.split('_')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

class PriceAggregator extends EventEmitter {
  constructor(exchanges) {
    super();
    this.exchanges = exchanges;
    this.prices = new Map(); // exchange name -> price data
    this.aggregateInterval = null;
  }

  start() {
    console.log('Starting price aggregator...');
    console.log('');
    console.log('Price updates will display as: TIME | PRICE | EXCHANGE | PAIR');
    console.log('-'.repeat(60));

    // Listen to all exchanges
    for (const exchange of this.exchanges) {
      exchange.on('price', (data) => {
        this.prices.set(data.exchange, data);

        // Log incoming price
        const time = formatTime(data.timestamp);
        const price = data.price.toFixed(2).padStart(10);
        const exch = getExchangeName(data.exchange).padEnd(10);
        const pair = getPairType(data.exchange);
        console.log(`${time} | $${price} | ${exch} | ${pair}`);
      });

      exchange.on('connected', () => {
        console.log(`[connected] ${exchange.name}`);
      });

      exchange.on('disconnected', () => {
        console.log(`[disconnected] ${exchange.name}`);
      });

      exchange.on('error', (err) => {
        console.error(`[error] ${exchange.name}: ${err.message}`);
      });

      // Start connection
      exchange.connect();
    }

    // Calculate aggregate every second
    this.aggregateInterval = setInterval(() => {
      this.calculateAggregate();
    }, config.aggregateInterval);

    console.log(`Aggregating every ${config.aggregateInterval}ms`);
    console.log('');
  }

  calculateAggregate() {
    const now = Date.now();
    let totalWeight = 0;
    let weightedSum = 0;
    const sources = [];

    // Always include all sources with most recent value (no staleness filtering)
    for (const [exchangeName, data] of this.prices) {
      const weight = config.weights[exchangeName] || 0.05;
      weightedSum += data.price * weight;
      totalWeight += weight;

      sources.push({
        exchange: exchangeName,
        price: data.price,
        weight: weight,
        age: now - data.timestamp
      });
    }

    if (totalWeight === 0) {
      this.emit('aggregate', {
        price: null,
        sources: [],
        timestamp: now,
        error: 'No valid price sources'
      });
      return;
    }

    // Normalize weighted average
    const aggregatePrice = weightedSum / totalWeight;

    // Log average price with timestamp
    const time = formatTime(now);
    console.log(`${time} | $${aggregatePrice.toFixed(2).padStart(10)} | >>> AVG <<< | ${sources.length} sources`);

    this.emit('aggregate', {
      price: aggregatePrice,
      sources: sources,
      timestamp: now,
      sourceCount: sources.length
    });
  }

  getStatus() {
    const now = Date.now();
    const status = {};

    for (const exchange of this.exchanges) {
      const data = this.prices.get(exchange.name);
      status[exchange.name] = {
        connected: exchange.connected,
        price: data?.price || null,
        lastUpdate: data?.timestamp || null,
        age: data ? now - data.timestamp : null,
        stale: data ? (now - data.timestamp > config.staleThreshold) : true
      };
    }

    return status;
  }

  stop() {
    console.log('Stopping price aggregator...');

    if (this.aggregateInterval) {
      clearInterval(this.aggregateInterval);
      this.aggregateInterval = null;
    }

    for (const exchange of this.exchanges) {
      exchange.disconnect();
    }
  }
}

module.exports = PriceAggregator;
