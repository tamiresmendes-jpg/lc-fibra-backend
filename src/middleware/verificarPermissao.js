const jwt = require('jsonwebtoken');
const { get } = require('../config/database');
const {
  buscarPermsEfetivas,
  temPermissaoServer,
  resolverPermissao,
  ehRotaPessoal,
  ehModuloOptIn,
} = require('../utils/permissoes');

const METODOS_MUTACAO = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Middleware GLOBAL: garante que as regras de permissão sejam aplicadas no
// servidor, independentemente do frontend. Roda em server.js antes das rotas.
//
//   admin                 → libera tudo
//   rota pessoal          → libera (agenda, curtidas/comentários, ciência, etc.)
//   colaborador           → BLOQUEADO em qualquer alteração (somente leitura)
//   líder / gestor        → segue o grupo (editar onde liberado; bloqueado em "visualizar")
//
async function verificarPermissao(req, res, next) {
  try {
    // Apenas operações que alteram dados
    if (!METODOS_MUTACAO.includes(req.method)) return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return next(); // sem token → o autenticar da rota devolve 401

    let usuario;
    try { usuario = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return next(); } // token inválido → o autenticar da rota devolve 403

    const path = req.path; // ex.: /api/ferias/123

    if (usuario.perfil === 'admin') return next();
    if (ehRotaPessoal(path)) return next();

    // Colaborador: somente leitura total
    if (usuario.perfil === 'colaborador') {
      return res.status(403).json({ erro: 'Colaboradores têm acesso somente de leitura. Esta ação não é permitida.' });
    }

    // Líder / gestor: segue as regras do grupo de permissão
    const chave = resolverPermissao(path);
    if (!chave) return next(); // rota não mapeada → liberado para líder/gestor

    let ownPerms = null;
    try {
      const u = await get('SELECT permissoes_modulos FROM usuarios WHERE id = ?', [usuario.id]);
      if (u?.permissoes_modulos) ownPerms = JSON.parse(u.permissoes_modulos);
    } catch { ownPerms = null; }

    const perms = await buscarPermsEfetivas(usuario.id, usuario.empresa_id, ownPerms);

    // Módulos opt-in (ex.: ERP): exigem liberação EXPLÍCITA do grupo, mesmo
    // quando o usuário tem "acesso total" (sem restrição configurada).
    if (ehModuloOptIn(chave)) {
      const mod = chave.split('.')[0];
      const v = perms && perms[mod];
      const liberado = v === true || v === 'editar' || v === 'visualizar'
        || (v && typeof v === 'object' && v.enabled !== false);
      if (!liberado) return res.status(403).json({ erro: 'Este módulo não está liberado para o seu grupo.' });
      return next();
    }

    if (!perms) return next(); // sem restrição configurada → acesso total

    if (temPermissaoServer(perms, chave, 'editar')) return next();

    return res.status(403).json({ erro: 'Você não tem permissão de edição neste módulo.' });
  } catch (e) {
    // Fail-closed: em erro inesperado, NEGAR a operação (segurança > disponibilidade)
    return res.status(500).json({ erro: 'Erro ao verificar permissão.' });
  }
}

module.exports = verificarPermissao;
