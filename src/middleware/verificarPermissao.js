const jwt = require('jsonwebtoken');
const { get } = require('../config/database');
const {
  buscarPermsEfetivas,
  temPermissaoServer,
  resolverPermissao,
  ehRotaPessoal,
  ehLeituraDeApoio,
  ehModuloOptIn,
} = require('../utils/permissoes');

const METODOS_MUTACAO = ['POST', 'PUT', 'PATCH', 'DELETE'];

// Bloqueio de LEITURA (GET) por permissão. Fica desligado até os grupos serem
// revisados: eles foram montados quando só a edição era checada, então "não
// marcado" significava na prática "vê mas não edita". Ligar sem revisar tiraria
// mural, reconhecimento e treinamentos de quase todos os grupos.
// Para ligar: PERM_LEITURA=on no .env do servidor.
const CHECAR_LEITURA = String(process.env.PERM_LEITURA || '').toLowerCase() === 'on';

// Middleware GLOBAL: garante que as regras de permissão sejam aplicadas no
// servidor, independentemente do frontend. Roda em server.js antes das rotas.
//
//   admin                 → libera tudo
//   rota pessoal          → libera (agenda, curtidas/comentários, ciência, etc.)
//   colaborador           → BLOQUEADO em qualquer alteração (somente leitura)
//   líder / gestor        → segue o grupo (editar onde liberado; bloqueado em "visualizar")
//
// LEITURA (GET) também é verificada: módulo que o grupo não libera não pode nem
// ser lido pela API. Esconder só na tela não protege — bastaria chamar o endereço
// da API para ver salário, premiação, feedback, etc.
async function verificarPermissao(req, res, next) {
  try {
    const ehMutacao = METODOS_MUTACAO.includes(req.method);
    // Métodos que não leem nem escrevem (OPTIONS/HEAD) seguem livres
    if (!ehMutacao && req.method !== 'GET') return next();
    if (!ehMutacao && !CHECAR_LEITURA) return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return next(); // sem token → o autenticar da rota devolve 401

    let usuario;
    try { usuario = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return next(); } // token inválido → o autenticar da rota devolve 403

    const path = req.path; // ex.: /api/ferias/123

    if (usuario.perfil === 'admin') return next();
    if (ehRotaPessoal(path)) return next();
    // Listas de apoio: leitura liberada (alimentam seletores de todo o sistema)
    if (!ehMutacao && ehLeituraDeApoio(path)) return next();

    // Colaborador: somente leitura total (a leitura em si ainda segue o grupo, abaixo)
    if (ehMutacao && usuario.perfil === 'colaborador') {
      return res.status(403).json({ erro: 'Colaboradores têm acesso somente de leitura. Esta ação não é permitida.' });
    }

    // Líder / gestor: segue as regras do grupo de permissão
    const chave = resolverPermissao(path);
    if (!chave) return next(); // rota não mapeada → liberado para líder/gestor

    // Gestor sempre tem acesso total ao módulo Treinamento, mesmo sem o grupo
    // ter marcado — espelha a mesma regra do frontend (AuthContext.temPermissao).
    if (usuario.perfil === 'gestor' && chave.startsWith('treinamento')) return next();

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

    // Leitura exige 'visualizar'; alteração exige 'editar'
    if (!ehMutacao) {
      if (temPermissaoServer(perms, chave, 'visualizar')) return next();
      return res.status(403).json({ erro: 'Este módulo não está liberado para o seu grupo.' });
    }

    if (temPermissaoServer(perms, chave, 'editar')) return next();

    return res.status(403).json({ erro: 'Você não tem permissão de edição neste módulo.' });
  } catch (e) {
    // Fail-closed: em erro inesperado, NEGAR a operação (segurança > disponibilidade)
    return res.status(500).json({ erro: 'Erro ao verificar permissão.' });
  }
}

module.exports = verificarPermissao;
