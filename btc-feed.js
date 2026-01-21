const WebSocket = require('ws');

const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@miniTicker');

ws.on('open', () => {
  console.error('Connected to Binance WebSocket');
});

ws.on('message', (data) => {
  const ticker = JSON.parse(data);
  console.log(ticker.c); // c = close price (current price)
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error.message);
});

ws.on('close', () => {
  console.error('WebSocket closed');
  process.exit(1);
});
