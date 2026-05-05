const crypto = require('crypto');

const ALLOWED_ORIGINS = ['https://artedoisho.vercel.app'];

module.exports = function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const secret = process.env.API_SECRET;
  if (!secret) {
    console.error('[get-token] API_SECRET が設定されていません');
    return res.status(500).json({ error: 'サーバー設定エラー' });
  }

  // 5分単位のウィンドウでトークンを生成（送信側・受信側で最大2ウィンドウ許容）
  const window = Math.floor(Date.now() / (5 * 60 * 1000));
  const token = crypto.createHmac('sha256', secret).update(String(window)).digest('hex');

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token });
};
