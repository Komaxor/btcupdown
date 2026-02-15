// ============================================
// CONFIGURATION
// ============================================
const CHART_POINTS = 30;
const SAMPLE_INTERVAL = 1000;
const DOT_POSITION = 0.75;
const CHART_MARGIN = 0.10;

// ============================================
// STATE
// ============================================
const chartData = [];
let currentPrice = null;
let lastSampleTime = null;
let wsConnected = false;
let lastWsTime = 0;
let wigglePhase = 0;
let priceToBeat = null;
let lastMinuteFlash = -1;
let hoverX = null;
const outcomes = []; // { priceToBeat, outcome, isUp }

// Bet state
let betSide = 'buy'; // 'buy' or 'sell'
let betOutcome = 'yes'; // 'yes' or 'no'
let orderType = 'market'; // 'market' or 'limit'
let limitPrice = 50; // cents
let shares = 0;
let expiryEnabled = false;
// ============================================
// AUTH (WS-specific — shared auth in auth.js)
// ============================================
let wsConnection = null;

function authenticateWebSocket() {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
  if (!authToken || !currentUser) return;

  const session = JSON.parse(localStorage.getItem('tg_session'));
  wsConnection.send(JSON.stringify({
    type: 'auth',
    token: authToken,
    userId: session.userId,
    authDate: session.authDate
  }));
}

// ============================================
// DOM ELEMENTS
// ============================================
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const priceEl = document.getElementById('price');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const timeAxis = document.getElementById('timeAxis');
const dataFeed = document.getElementById('dataFeed');
const maxPriceEl = document.getElementById('maxPrice');
const minPriceEl = document.getElementById('minPrice');
const currentPriceLabel = document.getElementById('currentPriceLabel');
const wsStatusEl = document.getElementById('wsStatus');
const priceToBeatEl = document.getElementById('priceToBeat');
const priceDiffEl = document.getElementById('priceDiff');
const chartContainer = document.getElementById('chartContainer');
const outcomesList = document.getElementById('outcomesList');
const eventTimeEl = document.getElementById('eventTime');
const countdownMinsEl = document.getElementById('countdownMins');
const countdownSecsEl = document.getElementById('countdownSecs');

// Bet elements
const tabBuy = document.getElementById('tabBuy');
const tabSell = document.getElementById('tabSell');
const orderTypeBtn = document.getElementById('orderTypeBtn');
const orderTypeLabel = document.getElementById('orderTypeLabel');
const orderDropdown = document.getElementById('orderDropdown');
const btnYes = document.getElementById('btnYes');
const btnNo = document.getElementById('btnNo');
const yesPrice = document.getElementById('yesPrice');
const noPrice = document.getElementById('noPrice');
const limitSection = document.getElementById('limitSection');
const limitMinus = document.getElementById('limitMinus');
const limitPlus = document.getElementById('limitPlus');
const limitValueEl = document.getElementById('limitValue');
const sharesInput = document.getElementById('sharesInput');
const limitQuickBtns = document.getElementById('limitQuickBtns');
const marketQuickBtns = document.getElementById('marketQuickBtns');
const expirySection = document.getElementById('expirySection');
const expiryToggle = document.getElementById('expiryToggle');
const totalValue = document.getElementById('totalValue');
const toWinValue = document.getElementById('toWinValue');
const tradeBtn = document.getElementById('tradeBtn');

// ============================================
// PRICE FONT-SIZE SCALER
// ============================================
const headerEl = document.querySelector('.header');
new ResizeObserver(([entry]) => {
  const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
  const size = Math.min(Math.max(w / 18, 14), window.innerWidth < 768 ? 24 : 32);
  priceToBeatEl.style.fontSize = size + 'px';
  priceEl.style.fontSize = size + 'px';
}).observe(headerEl);

// ============================================
// BET PANEL HANDLERS
// ============================================
function updateBetUI() {
  // Update tabs
  tabBuy.classList.toggle('active', betSide === 'buy');
  tabSell.classList.toggle('active', betSide === 'sell');

  // Update outcome buttons
  btnYes.classList.toggle('selected', betOutcome === 'yes');
  btnNo.classList.toggle('selected', betOutcome === 'no');

  // Update order type display
  orderTypeLabel.textContent = orderType === 'market' ? 'Market' : 'Limit';

  // Show/hide limit sections
  const showLimit = orderType === 'limit';
  document.querySelectorAll('.limit-section').forEach(el => {
    el.classList.toggle('show', showLimit);
  });
  document.querySelectorAll('.market-section').forEach(el => {
    el.classList.toggle('show', !showLimit);
  });

  // Update limit value
  limitValueEl.textContent = limitPrice;

  // Update expiry toggle
  expiryToggle.classList.toggle('active', expiryEnabled);

  // Calculate prices (mock: Yes + No = 100¢)
  const yesP = 50; // In real app, this comes from market
  const noP = 100 - yesP;
  yesPrice.textContent = yesP + '¢';
  noPrice.textContent = noP + '¢';

  // Calculate total and potential win
  const pricePerShare = orderType === 'limit' ? limitPrice : (betOutcome === 'yes' ? yesP : noP);
  const total = (shares * pricePerShare / 100).toFixed(2);
  const potentialWin = (shares * (100 - pricePerShare) / 100).toFixed(2);

  totalValue.textContent = '$' + total;
  toWinValue.textContent = '$' + potentialWin;
}

// Tab handlers
tabBuy.addEventListener('click', () => { betSide = 'buy'; updateBetUI(); });
tabSell.addEventListener('click', () => { betSide = 'sell'; updateBetUI(); });

// Outcome handlers
btnYes.addEventListener('click', () => { betOutcome = 'yes'; updateBetUI(); });
btnNo.addEventListener('click', () => { betOutcome = 'no'; updateBetUI(); });

// Order type dropdown
orderTypeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  orderDropdown.classList.toggle('show');
});

document.addEventListener('click', () => {
  orderDropdown.classList.remove('show');
});

orderDropdown.querySelectorAll('.order-option').forEach(opt => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();
    orderType = opt.dataset.type;
    orderDropdown.querySelectorAll('.order-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    orderDropdown.classList.remove('show');
    updateBetUI();
  });
});

// Limit price controls
limitMinus.addEventListener('click', () => {
  limitPrice = Math.max(1, limitPrice - 1);
  updateBetUI();
});

limitPlus.addEventListener('click', () => {
  limitPrice = Math.min(99, limitPrice + 1);
  updateBetUI();
});

// Shares input
sharesInput.addEventListener('input', (e) => {
  shares = parseInt(e.target.value) || 0;
  updateBetUI();
});

// Quick buttons for limit
limitQuickBtns.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const delta = parseInt(btn.dataset.delta);
    shares = Math.max(0, shares + delta);
    sharesInput.value = shares || '';
    updateBetUI();
  });
});

// Quick buttons for market (percentage of balance)
marketQuickBtns.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pct = parseInt(btn.dataset.pct);
    const pricePerShare = betOutcome === 'yes' ? 50 : 50; // Mock price
    const maxShares = Math.floor((getUserBalance() * 100) / pricePerShare);
    shares = Math.floor(maxShares * pct / 100);
    sharesInput.value = shares || '';
    updateBetUI();
  });
});

// Expiry toggle
expiryToggle.addEventListener('click', () => {
  expiryEnabled = !expiryEnabled;
  updateBetUI();
});

// Trade button
tradeBtn.addEventListener('click', () => {
  if (!currentUser) {
    // Trigger Telegram login widget click
    const tgIframe = document.querySelector('#telegramLoginBtn iframe');
    if (tgIframe) {
      tgIframe.contentWindow.postMessage({ event: 'auth_user' }, '*');
    }
    // Fallback: show the login widget area
    const loginBtn = document.getElementById('telegramLoginBtn');
    if (loginBtn) loginBtn.style.display = '';
    return;
  }

  if (shares <= 0) return;
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;

  wsConnection.send(JSON.stringify({
    type: 'place_bet',
    direction: betOutcome,
    amount: shares,
    side: betSide
  }));
});

// Initialize bet UI
updateBetUI();

// ============================================
// UTILITIES
// ============================================
function resize() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = window.innerWidth < 768 ? 220 : 280;
}
resize();
window.addEventListener('resize', resize);

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatPrice(p) {
  return parseFloat(p).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// ============================================
// PRICE DIFFERENCE DISPLAY
// ============================================
function updatePriceDiff() {
  if (priceToBeat === null || currentPrice === null) {
    priceDiffEl.textContent = '';
    priceEl.className = 'price-value current';
    return;
  }

  const diff = currentPrice - priceToBeat;
  const isUp = diff >= 0;
  const arrow = isUp ? '▲' : '▼';
  const sign = isUp ? '+' : '-';

  priceDiffEl.innerHTML = `${arrow} ${sign}$${Math.abs(diff).toFixed(2)}`;
  priceDiffEl.className = 'price-diff-small ' + (isUp ? 'up' : 'down');
  priceEl.className = 'price-value current ' + (isUp ? 'up' : '');
}

function updateCountdown() {
  const now = new Date();
  const secsToNextMin = 60 - now.getSeconds();
  const secsDisplay = secsToNextMin === 60 ? 0 : secsToNextMin;

  // Show 00:XX countdown to next minute (when price to beat updates)
  countdownMinsEl.textContent = '00';
  countdownSecsEl.textContent = String(secsDisplay).padStart(2, '0');
}

function updateEventTime() {
  const now = new Date();
  const mins = now.getMinutes();
  const startMin = mins;
  const endMin = mins + 1;

  const month = now.toLocaleString('en-US', { month: 'long' });
  const day = now.getDate();
  const hour = now.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;

  const startStr = `${h12}:${String(startMin).padStart(2, '0')}`;
  const endH12 = endMin === 60 ? ((h12 % 12) + 1) : h12;
  const endMinStr = endMin === 60 ? '00' : String(endMin).padStart(2, '0');
  const endAmpm = (endMin === 60 && hour % 12 === 11) ? (ampm === 'AM' ? 'PM' : 'AM') : ampm;
  const endStr = `${endH12}:${endMinStr}`;

  eventTimeEl.textContent = `${month} ${day}, ${startStr}-${endStr}${endAmpm} ET`;
}

// ============================================
// OUTCOMES DISPLAY
// ============================================
function addOutcome(beatPrice, outcomePrice) {
  const isUp = outcomePrice >= beatPrice;
  outcomes.push({
    priceToBeat: beatPrice,
    outcome: outcomePrice,
    isUp: isUp
  });

  // Keep max 60 outcomes
  while (outcomes.length > 60) {
    outcomes.shift();
  }

  renderOutcomes();
}

function renderOutcomes() {
  outcomesList.innerHTML = outcomes.map((o, i) => {
    const emoji = o.isUp ? '📈' : '📉';
    const diff = o.outcome - o.priceToBeat;
    const sign = diff >= 0 ? '+' : '-';
    const resultClass = o.isUp ? 'up' : 'down';
    return `
      <div class="outcome-item">
        ${emoji}
        <div class="outcome-tooltip">
          <div>Price to beat: <span class="otl-beat">$${formatPrice(o.priceToBeat)}</span></div>
          <div>Finish price: <span class="otl-finish">$${formatPrice(o.outcome)}</span></div>
          <div class="otl-result ${resultClass}">Difference: ${sign}$${Math.abs(diff).toFixed(2)}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// MINUTE FLASH & PRICE TO BEAT
// ============================================
function checkMinuteFlash() {
  const now = new Date();
  const currentMinute = now.getMinutes();
  const currentSecond = now.getSeconds();

  // Update countdown every call
  updateCountdown();

  if (currentSecond === 0 && currentMinute !== lastMinuteFlash) {
    lastMinuteFlash = currentMinute;

    // Record outcome if we had a previous price to beat
    if (priceToBeat !== null && currentPrice !== null) {
      addOutcome(priceToBeat, currentPrice);
    }

    // priceToBeat is now set by the server via 'price_to_beat' WebSocket message

    // Update event time display
    updateEventTime();

    // Flash effect
    chartContainer.classList.add('flash');
    setTimeout(() => chartContainer.classList.remove('flash'), 500);
  }
}

// ============================================
// SAMPLING
// ============================================
function samplePrice() {
  if (currentPrice === null) return;

  const now = Date.now();
  const prevPrice = chartData.length > 0 ? chartData[chartData.length - 1].price : null;

  chartData.push({ time: now, price: currentPrice });

  while (chartData.length > CHART_POINTS) {
    chartData.shift();
  }

  lastSampleTime = now;
  addDataRow(now, currentPrice, prevPrice);
}

function startSampling() {
  const now = Date.now();
  const msToNextSecond = 1000 - (now % 1000);

  setTimeout(() => {
    samplePrice();
    setInterval(samplePrice, SAMPLE_INTERVAL);
  }, msToNextSecond);
}

// ============================================
// DATA FEED
// ============================================
function addDataRow(time, price, prevPrice) {
  const row = document.createElement('div');
  row.className = 'data-row';

  const change = prevPrice ? price - prevPrice : 0;
  const changeClass = change >= 0 ? 'up' : 'down';
  const changeSign = change >= 0 ? '+' : '';

  row.innerHTML = `
    <span class="data-time">${formatTime(time)}</span>
    <span class="data-price ${changeClass}">$${formatPrice(price)}</span>
    <span class="data-change ${changeClass}">${changeSign}${change.toFixed(2)}</span>
  `;

  const header = dataFeed.querySelector('.data-feed-header');
  header.after(row);

  const rows = dataFeed.querySelectorAll('.data-row');
  if (rows.length > 60) {
    rows[rows.length - 1].remove();
  }
}

// ============================================
// TIME AXIS
// ============================================
function updateTimeAxis(now) {
  const w = canvas.width;
  const padding = 20;
  const chartWidth = w - padding * 2;
  const dotX = padding + chartWidth * DOT_POSITION;
  const pxPerMs = chartWidth / (CHART_POINTS * SAMPLE_INTERVAL);

  const windowMs = CHART_POINTS * SAMPLE_INTERVAL;
  const windowStart = now - windowMs * DOT_POSITION;
  const windowEnd = now + windowMs * (1 - DOT_POSITION);

  const firstMark = Math.ceil(windowStart / 15000) * 15000;
  let html = '';

  for (let t = firstMark; t <= windowEnd; t += 15000) {
    const x = dotX - (now - t) * pxPerMs;
    if (x >= 0 && x <= w) {
      const opacity = t > now ? 0.3 : 0.8;
      html += `<span class="time-mark" style="left:${x}px;opacity:${opacity}">${formatTime(t)}</span>`;
    }
  }

  timeAxis.innerHTML = html;
}

// ============================================
// CHART RENDERING
// ============================================
function draw(now) {
  const w = canvas.width;
  const h = canvas.height;
  const padding = 20;
  const chartWidth = w - padding * 2;
  const chartHeight = h - padding * 2;

  ctx.clearRect(0, 0, w, h);

  if (chartData.length < 2 || currentPrice === null) return;

  const dotX = padding + chartWidth * DOT_POSITION;
  const pxPerMs = chartWidth / (CHART_POINTS * SAMPLE_INTERVAL);

  // Include currentPrice in min/max calculation (exactly last 30 values + current)
  const allPrices = [...chartData.map(d => d.price), currentPrice];
  const dataMin = Math.min(...allPrices);
  const dataMax = Math.max(...allPrices);
  const dataRange = dataMax - dataMin;

  // Calculate margin: always 10% of data range
  // If all prices identical (range=0), use tiny % of price to show the line
  const margin = dataRange > 0 ? dataRange * 0.1 : currentPrice * 0.0001;

  let chartMax = Math.round(dataMax + margin);
  let chartMin = Math.round(dataMin - margin);
  let chartRange = chartMax - chartMin;

  // Handle edge case where rounding collapses the range
  if (chartRange < 1) {
    chartMax = Math.ceil(dataMax + margin);
    chartMin = Math.floor(dataMin - margin);
    chartRange = Math.max(chartMax - chartMin, 1);
  }

  // Update Y-axis labels (whole numbers)
  maxPriceEl.textContent = '$' + chartMax.toLocaleString();
  minPriceEl.textContent = '$' + chartMin.toLocaleString();

  // Hide the current price label from Y-axis (we'll draw it on canvas)
  currentPriceLabel.style.display = 'none';

  const priceToY = (p) => {
    const normalized = (p - chartMin) / chartRange;
    return (h - padding) - normalized * chartHeight;
  };

  const points = chartData.map(d => ({
    x: dotX - (now - d.time) * pxPerMs,
    y: priceToY(d.price),
    price: d.price,
    time: d.time
  }));

  // Smoother wiggle
  wigglePhase += 0.08;
  const wiggle = Math.sin(wigglePhase) * 1.2;
  points.push({
    x: dotX,
    y: priceToY(currentPrice) + wiggle,
    price: currentPrice,
    time: now,
    isCurrent: true
  });

  const prevPrice = chartData.length > 0 ? chartData[chartData.length - 1].price : currentPrice;
  const isUp = currentPrice >= prevPrice;
  const mainColor = isUp ? '#00ff88' : '#ff4466';
  const glowColor = isUp ? 'rgba(0,255,136,' : 'rgba(255,68,102,';

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = padding + chartHeight * (i / 4);
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(w - padding, y);
    ctx.stroke();
  }

  // 75% vertical line
  ctx.beginPath();
  ctx.moveTo(dotX, padding);
  ctx.lineTo(dotX, h - padding);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();

  // Horizontal target line (price to beat)
  if (priceToBeat !== null) {
    const targetY = priceToY(priceToBeat);
    const inRange = targetY >= padding && targetY <= h - padding;
    const clampedY = Math.max(padding, Math.min(h - padding, targetY));
    const aboveChart = targetY < padding;
    const belowChart = targetY > h - padding;

    // Always draw the line (clamped to chart bounds)
    ctx.beginPath();
    ctx.setLineDash([8, 4]);
    ctx.moveTo(padding, clampedY);
    ctx.lineTo(w - padding, clampedY);
    ctx.strokeStyle = 'rgba(255, 204, 0, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    // Label with arrow if out of range
    ctx.font = '11px Segoe UI, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 204, 0, 0.7)';
    ctx.textAlign = 'left';
    if (aboveChart) {
      ctx.textBaseline = 'top';
      ctx.fillText('▲ Price to Beat  $' + formatPrice(priceToBeat), padding + 8, clampedY + 4);
    } else if (belowChart) {
      ctx.textBaseline = 'bottom';
      ctx.fillText('▼ Price to Beat  $' + formatPrice(priceToBeat), padding + 8, clampedY - 4);
    } else {
      ctx.textBaseline = 'bottom';
      ctx.fillText('Price to Beat', padding + 8, clampedY - 4);
    }
  }

  const visible = points.filter(p => p.x >= padding - 20 && p.x <= w - padding + 20);
  if (visible.length < 2) return;

  // Catmull-Rom spline with more segments for smoother curve
  function catmullRomSpline(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }

  const curvePoints = [];
  const segments = 20; // More segments = smoother

  for (let i = 0; i < visible.length - 1; i++) {
    const p0 = visible[Math.max(0, i - 1)];
    const p1 = visible[i];
    const p2 = visible[i + 1];
    const p3 = visible[Math.min(visible.length - 1, i + 2)];

    for (let j = 0; j < segments; j++) {
      const t = j / segments;
      curvePoints.push(catmullRomSpline(p0, p1, p2, p3, t));
    }
  }
  curvePoints.push(visible[visible.length - 1]);

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, padding, 0, h - padding);
  gradient.addColorStop(0, glowColor + '0.4)');
  gradient.addColorStop(0.5, glowColor + '0.1)');
  gradient.addColorStop(1, glowColor + '0)');

  ctx.beginPath();
  ctx.moveTo(curvePoints[0].x, h - padding);
  ctx.lineTo(curvePoints[0].x, curvePoints[0].y);
  for (let i = 1; i < curvePoints.length; i++) {
    ctx.lineTo(curvePoints[i].x, curvePoints[i].y);
  }
  ctx.lineTo(curvePoints[curvePoints.length - 1].x, h - padding);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Draw line with glow
  ctx.beginPath();
  ctx.moveTo(curvePoints[0].x, curvePoints[0].y);
  for (let i = 1; i < curvePoints.length; i++) {
    ctx.lineTo(curvePoints[i].x, curvePoints[i].y);
  }

  ctx.shadowColor = mainColor;
  ctx.shadowBlur = 20;
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Draw node dots
  for (let i = 0; i < visible.length; i++) {
    const p = visible[i];
    if (p.isCurrent) continue;

    const curveIdx = i * segments;
    const curveP = curvePoints[Math.min(curveIdx, curvePoints.length - 1)];

    ctx.beginPath();
    ctx.arc(curveP.x, curveP.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
  }

  // Draw current dot
  const currPoint = curvePoints[curvePoints.length - 1];
  if (currPoint) {
    ctx.beginPath();
    ctx.arc(currPoint.x, currPoint.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = glowColor + '0.3)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(currPoint.x, currPoint.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = mainColor;
    ctx.shadowColor = mainColor;
    ctx.shadowBlur = 25;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(currPoint.x, currPoint.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;

    // Draw current price label to the right of the dot
    ctx.font = 'bold 12px Segoe UI, system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText('$' + formatPrice(currentPrice), currPoint.x + 18, currPoint.y);
    ctx.shadowBlur = 0;
  }

  // Hover line
  if (hoverX !== null) {
    ctx.beginPath();
    ctx.moveTo(hoverX, padding);
    ctx.lineTo(hoverX, h - padding);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  canvas._points = visible;
  canvas._curvePoints = curvePoints;
  canvas._segments = segments;
  canvas._chartBounds = { padding, chartHeight, chartMin, chartRange, pxPerMs, dotX, now };
}

// ============================================
// HOVER
// ============================================
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  hoverX = x;

  if (!canvas._curvePoints || canvas._curvePoints.length < 2) return;
  if (!canvas._chartBounds) return;

  const { padding, chartHeight, chartMin, chartRange, pxPerMs, dotX, now } = canvas._chartBounds;

  // Find the curve point closest to this x
  let closestCurve = null;
  let minDist = Infinity;
  for (const p of canvas._curvePoints) {
    const dist = Math.abs(p.x - x);
    if (dist < minDist) {
      minDist = dist;
      closestCurve = p;
    }
  }

  if (closestCurve && x >= padding && x <= canvas.width - padding) {
    // Calculate price from y position
    const normalized = (canvas.height - padding - closestCurve.y) / chartHeight;
    const price = chartMin + normalized * chartRange;

    // Calculate time from x position
    const msFromNow = (dotX - x) / pxPerMs;
    const time = now - msFromNow;

    tooltip.innerHTML = `<div>$${formatPrice(price)}</div><div style="font-size:0.7rem;color:#888">${formatTime(time)}</div>`;
    tooltip.classList.add('visible');
    tooltip.style.left = (closestCurve.x + 20) + 'px';
    tooltip.style.top = (closestCurve.y - 20) + 'px';
  } else {
    tooltip.classList.remove('visible');
  }
});

canvas.addEventListener('mouseleave', () => {
  tooltip.classList.remove('visible');
  hoverX = null;
});

// ============================================
// CONTINUOUS ANIMATION (works in background)
// ============================================
let lastFrameTime = 0;
const targetFPS = 60;
const frameInterval = 1000 / targetFPS;

function animate() {
  const now = Date.now();

  // Always draw regardless of tab visibility
  draw(now);
  updateTimeAxis(now);
  checkMinuteFlash();
  updatePriceDiff();

  if (lastWsTime > 0) {
    const ago = ((now - lastWsTime) / 1000).toFixed(1);
    wsStatusEl.textContent = `${ago}s ago`;
    wsStatusEl.classList.toggle('stale', now - lastWsTime > 3000);
  }

  requestAnimationFrame(animate);
}

// Also use setInterval as backup for when tab is inactive
setInterval(() => {
  const now = Date.now();
  checkMinuteFlash();
  updatePriceDiff();
}, 100);

// ============================================
// WEBSOCKET
// ============================================
function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(wsProto + '//' + location.host + '/ws');
  wsConnection = ws;

  ws.onopen = () => {
    wsConnected = true;
    statusDot.classList.add('connected');
    statusText.textContent = 'LIVE';
    authenticateWebSocket();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Handle auth responses
    if (data.type === 'auth_success') {
      currentUser = data.user;
      updateAuthUI();
      return;
    }
    if (data.type === 'auth_error') {
      console.error('WS auth failed:', data.error);
      logout();
      return;
    }
    if (data.type === 'balance_update') {
      if (currentUser) {
        currentUser.balance = data.balance;
        updateAuthUI();
      }
      return;
    }
    if (data.type === 'bet_received' || data.type === 'bet_error') {
      console.log('Bet response:', data);
      return;
    }
    if (data.type === 'price_to_beat') {
      priceToBeat = parseFloat(data.priceToBeat);
      priceToBeatEl.textContent = '$' + formatPrice(priceToBeat);
      return;
    }

    // Price data
    const price = parseFloat(data.p);
    if (!isNaN(price)) {
      const now = Date.now();
      lastWsTime = now;
      currentPrice = price;
      priceEl.textContent = '$' + formatPrice(price);
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    wsConnection = null;
    statusDot.classList.remove('connected');
    statusText.textContent = 'Reconnecting...';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

// ============================================
// LOAD HISTORY FROM DB
// ============================================
async function loadHistory() {
  try {
    const resp = await fetch(location.origin + '/api/history?limit=' + CHART_POINTS);
    if (!resp.ok) return;
    const rows = await resp.json();
    if (rows.length === 0) return;

    for (const row of rows) {
      chartData.push({ time: row.timestamp, price: row.price });
    }

    // Keep only CHART_POINTS entries
    while (chartData.length > CHART_POINTS) {
      chartData.shift();
    }

    // Set current price from last historical point
    const last = rows[rows.length - 1];
    currentPrice = last.price;
    priceEl.textContent = '$' + formatPrice(currentPrice);
    lastWsTime = last.timestamp;

    console.log('Loaded ' + rows.length + ' historical prices from DB');
  } catch (err) {
    console.log('No historical data available, starting fresh');
  }
}

// ============================================
// LOAD PREVIOUS OUTCOMES FROM DB
// ============================================
async function loadOutcomes() {
  try {
    const resp = await fetch(location.origin + '/api/outcomes?limit=5');
    if (!resp.ok) return;
    const rows = await resp.json();
    for (const row of rows) {
      outcomes.push({
        priceToBeat: row.priceToBeat,
        outcome: row.finalPrice,
        isUp: row.outcome === 'up'
      });
    }
    if (outcomes.length > 0) renderOutcomes();
  } catch (err) {
    console.log('No previous outcomes available');
  }
}

// ============================================
// INIT
// ============================================
updateEventTime();
updateCountdown();
Promise.all([loadHistory(), loadOutcomes()]).then(() => {
  connect();
  startSampling();
  animate();
});
