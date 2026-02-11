module.exports = {
  // WebSocket server port for frontend
  serverPort: 8080,

  // Aggregation interval in milliseconds
  aggregateInterval: 1000,

  // Staleness threshold - ignore data older than this (ms)
  staleThreshold: 10000,

  // Exchange weights for weighted average (should sum to 1.0)
  // 8 total sources after removing coinbase_usdc
  weights: {
    binance: 0.25,
    bybit_usdt: 0.15,
    bybit_usdc: 0.10,
    coinbase: 0.15,
    kraken_usdt: 0.10,
    kraken_usdc: 0.05,
    kucoin: 0.10,
    gemini: 0.10
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
    }
  }
};
