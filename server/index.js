require('dotenv').config();
const config = require('./config');
const PriceAggregator = require('./aggregator');
const PriceWebSocketServer = require('./websocket-server');
const PriceFeed = require('./price-feed');
const db = require('./db');

// Import all exchange adapters
const BinanceExchange = require('./exchanges/binance');
const GeminiExchange = require('./exchanges/gemini');
const KuCoinExchange = require('./exchanges/kucoin');
const CoinbaseExchange = require('./exchanges/coinbase');
const KrakenExchange = require('./exchanges/kraken');
const BybitExchange = require('./exchanges/bybit');
const BitfinexExchange = require('./exchanges/bitfinex');
const GateIOExchange = require('./exchanges/gateio');
const CryptoComExchange = require('./exchanges/cryptocom');

console.log('='.repeat(50));
console.log('BTC Price Aggregator');
console.log('='.repeat(50));
console.log('');

// Create exchange instances
const exchanges = [
  new BinanceExchange(),   // BTC/USDT
  new GeminiExchange(),    // BTC/USD (REST polling)
  new KuCoinExchange(),    // BTC/USDT (token-based)
  new CoinbaseExchange(),  // BTC/USD
  new KrakenExchange(),    // BTC/USDT + BTC/USDC
  new BybitExchange(),     // BTC/USDT + BTC/USDC
  new BitfinexExchange(),  // BTC/USD
  new GateIOExchange(),    // BTC/USDT
  new CryptoComExchange()  // BTC/USD-PERP
];

console.log('Exchanges configured:');
console.log('  - Binance (WebSocket, BTC/USDT)');
console.log('  - Gemini (REST polling 3s, BTC/USD)');
console.log('  - KuCoin (WebSocket + token, BTC/USDT)');
console.log('  - Coinbase (WebSocket, BTC/USD)');
console.log('  - Kraken (WebSocket v2, BTC/USDT + BTC/USDC)');
console.log('  - Bybit (WebSocket, BTC/USDT + BTC/USDC)');
console.log('  - Bitfinex (WebSocket, BTC/USD)');
console.log('  - Gate.io (WebSocket, BTC/USDT)');
console.log('  - Crypto.com (WebSocket, BTC/USD-PERP)');
console.log('');
console.log('Total price sources: 11');
console.log('');

if (!config.telegram.botToken) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN not set. Telegram auth will not work.');
  console.warn('  Set it with: TELEGRAM_BOT_TOKEN=your_token npm start');
  console.warn('');
}

// Create aggregator
const aggregator = new PriceAggregator(exchanges);

// Create WebSocket server for frontend
const wsServer = new PriceWebSocketServer(config.serverPort);

// Create public price feed
const priceFeed = new PriceFeed(config.priceFeedPort);

// Start everything
console.log('Starting services...');
console.log('');

db.init()
  .then(() => {
    aggregator.start();
    wsServer.start(aggregator);
    priceFeed.start(aggregator);

    console.log('');
    console.log('Ready! Frontend can connect to ws://localhost:' + config.serverPort);
    console.log('Press Ctrl+C to stop');
    console.log('');
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n');
  console.log('Shutting down...');
  aggregator.stop();
  wsServer.stop();
  priceFeed.stop();
  db.close().then(() => {
    console.log('Goodbye!');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n');
  console.log('Shutting down...');
  aggregator.stop();
  wsServer.stop();
  priceFeed.stop();
  db.close().then(() => process.exit(0));
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
