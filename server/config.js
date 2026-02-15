module.exports = {
  // WebSocket server port for frontend
  serverPort: 8080,

  // Public price feed WebSocket port
  priceFeedPort: 8082,

  // Aggregation interval in milliseconds
  aggregateInterval: 1000,

  // Staleness threshold - ignore data older than this (ms)
  staleThreshold: 10000,

  // Exchange weights for weighted average (should sum to 1.0)
  // 11 total sources across 9 exchanges
  weights: {
    binance: 0.20,
    bybit_usdt: 0.12,
    coinbase: 0.12,
    bybit_usdc: 0.08,
    kraken_usdt: 0.08,
    bitfinex: 0.08,
    kucoin: 0.07,
    gemini: 0.07,
    gateio: 0.07,
    cryptocom: 0.07,
    kraken_usdc: 0.04
  },

  // Reconnection settings
  reconnect: {
    maxAttempts: 10,
    initialDelay: 1000,
    maxDelay: 30000
  },

  // Telegram Login
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    authExpiry: 86400 // reject auth_date older than 24h
  },

  // Trading engine
  trading: {
    maxSharesPerOrder: 10000,
    minPrice: 1,   // cents
    maxPrice: 99,  // cents
  },

  // Exchange-specific config
  exchanges: {
    gemini: {
      pollInterval: 3000 // 3 seconds (safe for 120 req/min limit)
    },
    bybit: {
      pingInterval: 20000 // 20 seconds
    },
    kucoin: {
      pingInterval: 30000 // 30 seconds
    },
    gateio: {
      pingInterval: 30000 // 30 seconds
    }
  }
};
