const webpush = require('web-push');
const { all, run } = require('./database');

// Chaves VAPID: usa variáveis de ambiente (Railway) ou o fallback gerado.
// Para trocar: defina VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT no Railway.
const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BJrfzp6y4gSUGsYM_J_USRqBKTVuUf5qfuUg-Gfs7rcFSBxrYpmb4-_VSaK4NQX4aH-yNLVoXtkcrjSsKlUVLus';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'mhhORnrUZ1VYgXPN8kcjqH0MFmUgllgdid64-bK4bXo';
const SUBJECT     = process.env.VAPID_SUBJECT     || 'mailto:contato@lcvirtualnet.com.br';

let habilitado = false;
try {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  habilitado = true;
} catch (e) {
  console.error('Web Push desabilitado (VAPID inválido):', e.message);
}

// Envia push para todas as inscrições de um usuário. Remove inscrições inválidas.
async function enviarPush(empresaId, usuarioId, payload) {
  if (!habilitado || !usuarioId) return;
  let subs = [];
  try {
    subs = await all('SELECT * FROM chat_push_subs WHERE empresa_id = ? AND usuario_id = ?', [empresaId, usuarioId]);
  } catch { return; }
  const texto = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub_json), texto);
    } catch (err) {
      // 404/410 = inscrição expirada → remove
      if (err.statusCode === 404 || err.statusCode === 410) {
        try { await run('DELETE FROM chat_push_subs WHERE id = ?', [s.id]); } catch {}
      }
    }
  }
}

module.exports = { PUBLIC_KEY, enviarPush };
