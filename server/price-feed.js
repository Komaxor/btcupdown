const { WebSocketServer } = require('ws');

class PriceFeed {
  constructor(port = 8082) {
    this.port = port;
    this.wss = null;
    this.clients = new Set();
    this.lastPrice = null;
  }

  start(aggregator) {
    this.wss = new WebSocketServer({ port: this.port, path: '/api/v1/midprice/btc' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      if (this.lastPrice !== null) {
        ws.send(this.lastPrice);
      }

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    aggregator.on('aggregate', (data) => {
      if (data.price === null) return;
      this.lastPrice = data.price.toFixed(2);
      for (const client of this.clients) {
        if (client.readyState === 1) {
          client.send(this.lastPrice);
        }
      }
    });

    console.log(`Price feed WebSocket listening on ws://localhost:${this.port}/api/v1/midprice/btc`);
  }

  stop() {
    if (this.wss) {
      for (const client of this.clients) client.close();
      this.clients.clear();
      this.wss.close();
    }
  }
}

module.exports = PriceFeed;
