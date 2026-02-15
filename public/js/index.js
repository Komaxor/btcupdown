const priceEl = document.getElementById('price');
const changeEl = document.getElementById('change');
const statusPill = document.getElementById('statusPill');
const statusLabel = document.getElementById('statusLabel');
const sourceCount = document.getElementById('sourceCount');

let lastPrice = null;
let firstPrice = null;

function formatPrice(p) {
  return parseFloat(p).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '/ws');

  ws.onopen = () => {
    statusPill.classList.remove('disconnected');
    statusLabel.textContent = 'Live';
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const price = parseFloat(data.p);

    if (isNaN(price)) return;

    if (firstPrice === null) firstPrice = price;

    const dir = lastPrice !== null ? (price >= lastPrice ? 'up' : 'down') : '';
    priceEl.textContent = '$' + formatPrice(price);
    priceEl.className = 'hero-price' + (dir ? ' ' + dir : '');

    // Show change from session start
    if (firstPrice !== null) {
      const diff = price - firstPrice;
      const pct = ((diff / firstPrice) * 100).toFixed(3);
      const sign = diff >= 0 ? '+' : '';
      const cls = diff >= 0 ? 'up' : 'down';
      changeEl.textContent = sign + '$' + Math.abs(diff).toFixed(2) + ' (' + sign + pct + '%)';
      changeEl.className = 'hero-change ' + cls;
    }

    if (data.sources) {
      sourceCount.textContent = data.sources + ' sources';
    }

    lastPrice = price;
  };

  ws.onclose = () => {
    statusPill.classList.add('disconnected');
    statusLabel.textContent = 'Reconnecting';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

connect();
