const WebSocket = require('ws');

const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@bookTicker');

let latestPrice = null;

ws.on('message', (data) => {
  const book = JSON.parse(data);
  latestPrice = book.b; // best bid = current price
});

// Output exactly once per second
setInterval(() => {
  if (latestPrice) {
    console.log(`${Date.now()}:${latestPrice}`);
  }
}, 1000);

ws.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
