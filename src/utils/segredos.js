// Criptografia de credenciais de integração guardadas no banco (senhas de painéis externos).
// AES-256-GCM com chave derivada do JWT_SECRET — quem tiver só o dump do banco não lê a senha.
//
// Formato guardado: "enc:v1:<iv b64>:<tag b64>:<cifrado b64>"
// Valores antigos (texto puro, sem o prefixo "enc:") continuam sendo lidos, para não quebrar
// integrações já configuradas; ao salvar de novo, passam a ficar criptografados.
const crypto = require('crypto');

const PREFIXO = 'enc:v1:';

function chave() {
  const base = process.env.JWT_SECRET || '';
  if (!base) throw new Error('JWT_SECRET não configurado — necessário para proteger credenciais');
  return crypto.createHash('sha256').update('kronos-segredos:' + base).digest(); // 32 bytes
}

function cifrar(texto) {
  if (texto == null || texto === '') return texto;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return PREFIXO + [iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(valor) {
  if (!valor) return valor;
  const s = String(valor);
  if (!s.startsWith(PREFIXO)) return s; // legado: gravado antes da criptografia
  try {
    const [ivB64, tagB64, dadosB64] = s.slice(PREFIXO.length).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dadosB64, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // chave trocada ou dado corrompido: melhor falhar do que devolver lixo
  }
}

module.exports = { cifrar, decifrar };
