const WebSocket = require('ws');
const BaseExchange = require('./base-exchange');
const config = require('../config');

class KuCoinExchange extends BaseExchange {
  constructor() {
    super('kucoin');
    this.ws = null;
    this.token = null;
    this.pingInterval = null;
    this.connectId = null;
  }

  async connect() {
    try {
      this.log('Getting connection token...');

      // Step 1: Get public token via REST API
      const tokenResponse = await fetch('https://api.kucoin.com/api/v1/bullet-public', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.code !== '200000') {
        throw new Error(`Failed to get token: ${tokenData.msg || tokenData.code}`);
      }

      this.token = tokenData.data.token;
      const instanceServer = tokenData.data.instanceServers[0];
      const endpoint = instanceServer.endpoint;
      const pingIntervalMs = instanceServer.pingInterval || config.exchanges.kucoin.pingInterval;

      this.connectId = Date.now();
      const wsUrl = `${endpoint}?token=${this.token}&connectId=${this.connectId}`;

      this.log('Connecting to WebSocket...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.connected = true;
        this.resetReconnect();
        this.log('Connected');
        this.emit('connected');

        // Subscribe to BTC-USDT ticker
        this.ws.send(JSON.stringify({
          id: Date.now(),
          type: 'subscribe',
          topic: '/market/ticker:BTC-USDT',
          response: true
        }));

        // Ping to keep connection alive
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              id: Date.now(),
              type: 'ping'
            }));
          }
        }, pingIntervalMs);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          // Handle welcome message
          if (msg.type === 'welcome') {
            this.log('Welcome received');
            return;
          }

          // Handle pong
          if (msg.type === 'pong') {
            return;
          }

          // Handle subscription ack
          if (msg.type === 'ack') {
            this.log('Subscription acknowledged');
            return;
          }

          // Handle ticker message
          if (msg.type === 'message' && msg.topic === '/market/ticker:BTC-USDT' && msg.data) {
            this.updatePrice(
              msg.data.price,
              msg.data.bestBid,
              msg.data.bestAsk
            );
          }
        } catch (err) {
          this.logError('Parse error', err);
        }
      });

      this.ws.on('close', () => {
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.logError('WebSocket error', err);
        this.emit('error', err);
        if (this.ws) {
          this.ws.close();
        }
      });

    } catch (err) {
      this.logError('Connection failed', err);
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.connected = false;
    this.log('Disconnected');
    this.emit('disconnected');
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = KuCoinExchange;
