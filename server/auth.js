const crypto = require('crypto');

function verifyTelegramAuth(authData, botToken) {
  if (!botToken) {
    return { valid: false, reason: 'Bot token not configured' };
  }

  const { hash, ...data } = authData;

  if (!hash) {
    return { valid: false, reason: 'Missing hash' };
  }

  // Reject if auth_date is older than 24 hours
  const now = Math.floor(Date.now() / 1000);
  if (!data.auth_date || now - data.auth_date > 86400) {
    return { valid: false, reason: 'Auth data expired' };
  }

  // Build data_check_string: sort keys alphabetically, join with \n
  const dataCheckString = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('\n');

  // secret_key = SHA256(bot_token)
  const secretKey = crypto.createHash('sha256').update(botToken).digest();

  // HMAC-SHA256(data_check_string, secret_key)
  const computedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  if (computedHash !== hash) {
    return { valid: false, reason: 'Invalid hash' };
  }

  return { valid: true, userId: data.id };
}

function createSessionToken(userId, authDate, botToken) {
  return crypto.createHmac('sha256', botToken)
    .update(`${userId}:${authDate}`)
    .digest('hex');
}

module.exports = { verifyTelegramAuth, createSessionToken };
