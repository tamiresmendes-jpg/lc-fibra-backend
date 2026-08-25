// Envio de DM (mensagem privada) via bot do Discord — diferente de src/utils/discord.js,
// que só posta em canal via webhook (webhook nunca consegue abrir DM). Usado pra mandar a
// análise individual de meta pra cada vendedor, direto na conversa dele, sem virar aviso em grupo.
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API = 'https://discord.com/api/v10';

async function abrirCanalDM(discordId) {
  const resp = await fetch(`${API}/users/@me/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
    body: JSON.stringify({ recipient_id: discordId }),
  });
  if (!resp.ok) throw new Error(`Não foi possível abrir DM (${resp.status})`);
  const canal = await resp.json();
  return canal.id;
}

// embed: { title, description, fields, color, footer } — mesmo formato usado em discord.js
// arquivo (opcional): { nome, buffer, mime } — quando informado, manda como anexo real na
// DM (multipart), não só texto. Usado pra entregar o PDF da análise individual.
async function enviarDM(discordId, { content, embed, arquivo } = {}) {
  if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN não configurado no servidor.');
  if (!discordId) throw new Error('Vendedor sem ID do Discord cadastrado.');
  const canalId = await abrirCanalDM(discordId);
  const payload = { content: content || undefined, embeds: embed ? [embed] : undefined };

  let resp;
  if (arquivo) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', new Blob([arquivo.buffer], { type: arquivo.mime || 'application/pdf' }), arquivo.nome);
    resp = await fetch(`${API}/channels/${canalId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${TOKEN}` },
      body: form,
    });
  } else {
    resp = await fetch(`${API}/channels/${canalId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
      body: JSON.stringify(payload),
    });
  }
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => '');
    throw new Error(`Falha ao enviar DM (${resp.status}): ${corpo.slice(0, 200)}`);
  }
  return true;
}

module.exports = { enviarDM };
