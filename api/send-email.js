const nodemailer = require('nodemailer');

// Vercel serverless: body を手動パース（大きなJSONに対応）
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  // CORS ヘッダー
  const ALLOWED_ORIGINS = [
    'https://artedoisho.vercel.app',
  ];
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    console.error('[send-email] body parse error:', e.message);
    return res.status(400).json({ error: 'リクエスト解析エラー: ' + e.message });
  }

  const { customerEmail, customerName, visitDate, pdfBase64, health } = body;

  if (!pdfBase64) {
    return res.status(400).json({ error: 'PDFデータがありません' });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    console.error('[send-email] env vars missing');
    return res.status(500).json({ error: 'メール設定が未完了です（環境変数なし）' });
  }

  // Gmail SMTP（ポート465 / SSL）で接続
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
  });

  // 接続テスト
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

  // お客様へのメール
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
      console.log('[send-email] customer email sent to', customerEmail);
    } catch (e) {
      console.error('[send-email] customer email error:', e.message);
      errors.push('お客様へのメール送信エラー: ' + e.message);
    }
  }

  // オーナーへの控えメール
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
