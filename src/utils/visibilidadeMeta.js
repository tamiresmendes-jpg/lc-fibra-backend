// Quem pode ver TODOS os colaboradores de uma meta (por departamento), em vez
// de só a própria linha. Regra (ajustada 10/08/2026 — antes líder via TUDO em
// qualquer setor, então um líder do Call Center enxergava a Meta de Cobrança
// inteira; agora líder só vê tudo no(s) setor(es) que ele próprio lidera):
// - admin e gestor sempre veem TODOS os setores.
// - líder só vê tudo no departamento em que ele está cadastrado (usuarios.departamento_id).
// - qualquer outro e-mail pode ser liberado por departamento em meta_visibilidade_extra
//   (ex.: um usuário administrativo que precisa acompanhar sem ser líder/gestor).
// - todo mundo que não se encaixa nisso só vê a PRÓPRIA linha, casada pelo e-mail
//   (cada setor/pessoa vê só o seu).
const { get } = require('../config/database');

// Nome do departamento (usuarios/departamentos.nome) → chave usada nas metas
// (DEPARTAMENTOS_META em gestao-extra.js). Normaliza maiúsculas/acentos antes de comparar.
const MAPA_CHAVE_DEPARTAMENTO = {
  'CALL CENTER': 'callcenter',
  'COBRANCA': 'cobranca',
  'COMERCIAL': 'comercial',
  'FINANCEIRO': 'financeiro',
};
function normalizar(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

async function podeVerTudoNaMeta(usuario, departamento) {
  if (['admin', 'gestor'].includes(usuario.perfil)) return true;
  if (usuario.perfil === 'lider') {
    const row = await get(`
      SELECT d.nome AS departamento_nome FROM usuarios u
      LEFT JOIN departamentos d ON d.id = u.departamento_id
      WHERE u.id = $1
    `, [usuario.id]);
    if (MAPA_CHAVE_DEPARTAMENTO[normalizar(row?.departamento_nome)] === departamento) return true;
  }
  if (!usuario.email) return false;
  const row = await get(
    'SELECT 1 FROM meta_visibilidade_extra WHERE empresa_id=$1 AND departamento=$2 AND LOWER(email)=LOWER($3)',
    [usuario.empresa_id, departamento, usuario.email]
  );
  return !!row;
}

// Compara e-mails de forma tolerante (maiúscula/minúscula, espaço nas pontas).
function mesmoEmail(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

module.exports = { podeVerTudoNaMeta, mesmoEmail };
