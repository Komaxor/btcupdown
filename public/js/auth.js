// Shared Telegram auth state + functions
// Used by both index.html and updown.html

let currentUser = null;
let authToken = null;

function getUserBalance() {
  return currentUser ? parseFloat(currentUser.balance) : 0;
}

function loadSession() {
  const saved = localStorage.getItem('tg_session');
  if (saved) {
    try {
      const session = JSON.parse(saved);
      currentUser = session.user;
      authToken = session.token;
      updateAuthUI();
      return true;
    } catch (e) {
      localStorage.removeItem('tg_session');
    }
  }
  return false;
}

// Called by Telegram Login Widget
function onTelegramAuth(user) {
  fetch(location.origin + '/api/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user)
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      console.error('Auth failed:', data.error);
      return;
    }
    currentUser = data.user;
    authToken = data.token;

    localStorage.setItem('tg_session', JSON.stringify({
      user: data.user,
      token: data.token,
      userId: user.id,
      authDate: user.auth_date
    }));

    updateAuthUI();
    if (typeof authenticateWebSocket === 'function') {
      authenticateWebSocket();
    }
  })
  .catch(err => console.error('Auth request failed:', err));
}

function updateAuthUI() {
  const loginBtn = document.getElementById('telegramLoginBtn');
  const userInfo = document.getElementById('userInfo');
  const avatar = document.getElementById('userAvatar');

  if (currentUser) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userInfo) userInfo.style.display = 'flex';
    const nameEl = document.getElementById('userName');
    const balEl = document.getElementById('userBalanceDisplay');
    if (nameEl) nameEl.textContent = currentUser.first_name;
    if (balEl) balEl.textContent = '$' + parseFloat(currentUser.balance).toFixed(2);
    if (avatar) {
      if (currentUser.photo_url) {
        avatar.src = currentUser.photo_url;
        avatar.style.display = '';
      } else {
        avatar.style.display = 'none';
      }
    }
  } else {
    if (loginBtn) loginBtn.style.display = '';
    if (userInfo) userInfo.style.display = 'none';
  }

  // Update trade button on updown page
  const tradeButton = document.getElementById('tradeBtn');
  if (tradeButton) {
    if (currentUser) {
      tradeButton.textContent = 'Trade';
      tradeButton.classList.remove('connect-mode');
    } else {
      tradeButton.textContent = 'Connect Telegram';
      tradeButton.classList.add('connect-mode');
    }
  }
}

function logout() {
  currentUser = null;
  authToken = null;
  localStorage.removeItem('tg_session');
  updateAuthUI();
}

// Auto-init
loadSession();
document.addEventListener('DOMContentLoaded', () => {
  const userInfo = document.getElementById('userInfo');
  const trigger = document.getElementById('userInfoTrigger');
  const logoutBtn = document.getElementById('logoutBtn');

  // Toggle dropdown on trigger click
  if (trigger) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      userInfo.classList.toggle('dropdown-open');
    });
  }

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    if (userInfo) userInfo.classList.remove('dropdown-open');
  });

  // Prevent dropdown content clicks from closing (except logout)
  const dropdown = document.getElementById('userDropdown');
  if (dropdown) {
    dropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      userInfo.classList.remove('dropdown-open');
      logout();
    });
  }
});
