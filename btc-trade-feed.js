const WebSocket = require('ws');

const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

ws.on('message', (data) => {
  const trade = JSON.parse(data);
  console.log(`${trade.T}:${trade.p}`);
});

ws.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
