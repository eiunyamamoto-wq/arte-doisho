const nodemailer = require('nodemailer');
const crypto = require('crypto');

const ALLOWED_ORIGINS = ['https://artedoisho.vercel.app'];

// リクエスト上限: 5MB（base64 PDF込み）
const MAX_BODY_SIZE = 5 * 1024 * 1024;

// IPレート制限: 1時間に30件まで（サロンWiFi共有を考慮）
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// HMACトークンを検証（5分ウィンドウ、前後1ウィンドウ許容）
function validateToken(token) {
  const secret = process.env.API_SECRET;
  if (!secret || !token || token.length !== 64) return false;
  const now = Math.floor(Date.now() / (5 * 60 * 1000));
  for (const w of [now, now - 1]) {
    const expected = crypto.createHmac('sha256', secret).update(String(w)).digest('hex');
    try {
      if (crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(expected, 'hex'))) {
        return true;
      }
    } catch (_) {}
  }
  return false;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('リクエストサイズが上限（5MB）を超えています'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // IPレート制限
  const ip = getClientIP(req);
  if (!checkRateLimit(ip)) {
    console.warn('[send-email] rate limit exceeded:', ip);
    return res.status(429).json({ error: 'しばらく時間をおいてから再度お試しください' });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error('[send-email] body parse error:', e.message);
    return res.status(400).json({ error: 'リクエスト解析エラー: ' + e.message });
  }

  const { customerEmail, customerName, visitDate, pdfBase64, health, token } = body;

  // トークン検証
  if (!validateToken(token)) {
    console.warn('[send-email] invalid token from:', ip);
    return res.status(403).json({ error: '不正なリクエストです。ページを再読み込みしてお試しください。' });
  }

  if (!pdfBase64) {
    return res.status(400).json({ error: 'PDFデータがありません' });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.error('[send-email] env vars missing');
    return res.status(500).json({ error: 'メール設定が未完了です（環境変数なし）' });
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
  });

  try {
    await transporter.verify();
  } catch (e) {
    console.error('[send-email] SMTP verify failed:', e.message);
    return res.status(500).json({ error: 'Gmailへの接続に失敗: ' + e.message });
  }

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const safeDate = (visitDate || '').replace(/年|月/g, '-').replace('日', '');
  const fileName = `施術同意書_${customerName || 'お客様'}_${safeDate}.pdf`;

  const errors = [];

  if (customerEmail) {
    try {
      await transporter.sendMail({
        from: `Nail Arte <${gmailUser}>`,
        to: customerEmail,
        subject: `${customerName}様：arte同意書を送付いたします`,
        text: [
          `${customerName}様`,
          '',
          '本日はNail arteをご利用いただき誠に有難うございます。',
          '',
          '施術同意書を送付いたします。',
          '',
          '同意書は大切に保管してくださいませ。',
          '',
          '今後ともarteをどうぞよろしくお願い申し上げます。',
          '',
          'Nail Arte　山本佑美子',
        ].join('\n'),
        attachments: [{ filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }],
      });
      console.log('[send-email] customer email sent');
    } catch (e) {
      console.error('[send-email] customer email error:', e.message);
      errors.push('お客様へのメール送信エラー: ' + e.message);
    }
  }

  try {
    await transporter.sendMail({
      from: `Nail Arte <${gmailUser}>`,
      to: 'krmt1231@gmail.com',
      subject: `【控え】${customerName}様の施術同意書（${visitDate}）`,
      text: [
        `${customerName}様の施術同意書（控え）です。`,
        '',
        `来店日：${visitDate}`,
        `健康状態：${health || '未回答'}`,
        `お客様メール：${customerEmail || '未入力'}`,
        '',
        '同意書PDFを添付しています。',
      ].join('\n'),
      attachments: [{ filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }],
    });
    console.log('[send-email] owner email sent');
  } catch (e) {
    console.error('[send-email] owner email error:', e.message);
    errors.push('オーナーへのメール送信エラー: ' + e.message);
  }

  if (errors.length > 0) {
    return res.status(500).json({ error: errors.join(' / ') });
  }

  return res.status(200).json({ success: true });
};
