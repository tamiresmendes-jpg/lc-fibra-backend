// Quem pode ver TODOS os colaboradores de uma meta (por departamento), em vez
// de só a própria linha. Regra (confirmada 09/08/2026):
// - admin, gestor e líder sempre veem TODOS os setores.
// - qualquer outro e-mail pode ser liberado por departamento em meta_visibilidade_extra
//   (ex.: um usuário administrativo que precisa acompanhar sem ser líder/gestor).
// - todo mundo que não se encaixa nisso só vê a PRÓPRIA linha, casada pelo e-mail
//   (cada setor/pessoa vê só o seu).
const { get } = require('../config/database');

async function podeVerTudoNaMeta(usuario, departamento) {
  if (['admin', 'gestor', 'lider'].includes(usuario.perfil)) return true;
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
