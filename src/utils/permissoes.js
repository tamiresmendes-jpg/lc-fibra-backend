const { get, all } = require('../config/database');

// ─────────────────────────────────────────────────────────────
// Mescla de permissões (usuário + grupos). Nível mais alto vence:
// editar > visualizar > false. Grupo/usuário sem restrição = acesso total.
// ─────────────────────────────────────────────────────────────
function mesclarPermissoes(userPerms, grupoPermsList) {
  if (!grupoPermsList || grupoPermsList.length === 0) return userPerms;
  if (!userPerms && grupoPermsList.every(g => !g)) return null; // todos nulos = sem restrição
  const base = userPerms ? JSON.parse(JSON.stringify(userPerms)) : {};
  for (const gPerms of grupoPermsList) {
    if (!gPerms) return null; // grupo sem restrição → acesso total
    for (const [modulo, valor] of Object.entries(gPerms)) {
      if (!base[modulo] || base[modulo] === false) {
        base[modulo] = valor;
      } else if (valor && valor !== false) {
        if (base[modulo] === true || base[modulo] === 'editar') continue; // já no máximo
        if (valor === true || valor === 'editar') { base[modulo] = valor; continue; }
        if (typeof base[modulo] === 'object' && typeof valor === 'object') {
          base[modulo] = { enabled: true, itens: { ...(base[modulo].itens || {}) } };
          for (const [item, nivelGrupo] of Object.entries(valor.itens || {})) {
            const nivelAtual = base[modulo].itens[item];
            if (!nivelAtual || nivelAtual === false) base[modulo].itens[item] = nivelGrupo;
            else if (nivelAtual === 'visualizar' && (nivelGrupo === 'editar' || nivelGrupo === true)) base[modulo].itens[item] = nivelGrupo;
          }
        }
      }
    }
  }
  return base;
}

// Retorna as permissões efetivas do usuário (próprias + grupos diretos + grupos por departamento)
async function buscarPermsEfetivas(usuarioId, empresaId, permModulos) {
  try {
    const gruposDiretos = await all(
      'SELECT g.permissoes_modulos FROM grupos_permissao g JOIN grupo_membros gm ON gm.grupo_id = g.id WHERE gm.usuario_id = ? AND g.empresa_id = ?',
      [usuarioId, empresaId]
    );
    const usuario = await get('SELECT departamento_id FROM usuarios WHERE id = ?', [usuarioId]);
    let gruposDept = [];
    if (usuario?.departamento_id) {
      gruposDept = await all(
        'SELECT g.permissoes_modulos FROM grupos_permissao g JOIN grupo_departamentos gd ON gd.grupo_id = g.id WHERE gd.departamento_id = ? AND g.empresa_id = ?',
        [usuario.departamento_id, empresaId]
      );
    }
    const todasPerms = [...gruposDiretos, ...gruposDept]
      .map(g => { try { return g.permissoes_modulos ? JSON.parse(g.permissoes_modulos) : null; } catch { return null; } });
    return mesclarPermissoes(permModulos, todasPerms);
  } catch { return permModulos; }
}

// Verifica permissão a partir de um objeto de perms já resolvido.
// chave: 'pop' | 'pop.dashboard' | 'equipe.ferias' ...   nivel: 'visualizar' | 'editar'
function temPermissaoServer(perms, chave, nivel = 'visualizar') {
  if (!perms) return true; // sem restrição → acesso total
  const [modulo, item] = chave.split('.');
  const permModulo = perms[modulo];
  if (!permModulo) return false;
  if (!item) {
    return permModulo === true || permModulo === 'editar' || permModulo === 'visualizar'
      || (typeof permModulo === 'object' && permModulo.enabled !== false);
  }
  if (permModulo === true || permModulo === 'editar') return true;
  if (typeof permModulo === 'object') {
    if (permModulo.enabled === false) return false;
    if (!permModulo.itens) return true;
    const nivelItem = permModulo.itens[item];
    if (!nivelItem || nivelItem === false) return false;
    if (nivelItem === true || nivelItem === 'editar') return true;
    if (nivelItem === 'visualizar') return nivel === 'visualizar';
    return false;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Mapeamento de rota de API → chave de permissão (para líder/gestor).
// Regras avaliadas por prefixo, da mais específica para a mais genérica.
// Rotas não mapeadas → líder/gestor liberados (apenas colaborador é bloqueado).
// ─────────────────────────────────────────────────────────────
const MAPA_PERMISSAO = [
  // Cultura (router compartilhado /api/cultura)
  ['/api/cultura/eventos',             'cultura.eventos'],
  ['/api/cultura/enquetes',            'cultura.enquetes'],
  ['/api/cultura/mural',               'cultura.mural'],
  ['/api/cultura/campanhas-internas',  'cultura.campanhas-internas'],
  ['/api/cultura/comunicados',         'cultura.comunicacao'],
  ['/api/cultura/rankings',            'cultura.reconhecimento'],
  ['/api/cultura/reconhecimentos',     'cultura.reconhecimento'],
  ['/api/cultura/pdis',                'cultura.feedbacks'],
  ['/api/cultura/pesquisas',           'cultura.clima'],
  ['/api/cultura/biblioteca',          'cultura.biblioteca'],
  ['/api/cultura/institucional',       'cultura.institucional'],
  ['/api/cultura',                     'cultura.dashboard'],
  ['/api/feedbacks',                   'cultura.feedbacks'],
  ['/api/comunicados',                 'cultura.comunicacao'],
  // Pessoas
  ['/api/usuarios',                    'equipe.usuarios'],
  ['/api/grupos-permissao',            'equipe.usuarios'],
  ['/api/departamentos',               'equipe.departamentos'],
  ['/api/cargos',                      'equipe.cargos'],
  ['/api/escalas',                     'equipe.escala'],
  ['/api/ferias',                      'equipe.ferias'],
  ['/api/coffee-breaks',               'equipe.coffee-break'],
  // Processos / POP
  ['/api/categorias-pop',              'pop.categorias'],
  ['/api/pops',                        'pop.pops'],
  ['/api/processos',                   'pop.processos'],
  ['/api/fluxos',                      'pop.fluxos'],
  ['/api/checklists',                  'pop.checklists'],
  // Treinamentos
  ['/api/treinamentos',                'treinamento.treinamentos'],
  ['/api/onboarding',                  'treinamento.onboarding'],
  // Gestão
  ['/api/acoes',                       'gestao.acoes'],
  ['/api/indicadores',                 'gestao.indicadores'],
  ['/api/campanhas',                   'gestao.campanhas'],
  // Auditoria
  ['/api/auditoria-solicitacoes',      'auditoria.solicitacoes'],
  ['/api/auditorias',                  'auditoria.auditorias'],
  ['/api/auditoria-extra',             'auditoria.auditorias'],
  // Empresa
  ['/api/unidades',                    'empresa.filiais'],
  ['/api/redes-sociais',               'empresa.redes-sociais'],
  ['/api/feriados',                    'empresa.feriados'],
  ['/api/ceps',                        'empresa.consulta-cep'],
];

function resolverPermissao(path) {
  for (const [prefixo, chave] of MAPA_PERMISSAO) {
    if (path === prefixo || path.startsWith(prefixo + '/')) return chave;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Ações PESSOAIS — liberadas a qualquer perfil (inclusive colaborador).
// ─────────────────────────────────────────────────────────────
const ROTAS_PESSOAIS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/agenda(\/|$)/,
  /^\/api\/interacoes(\/|$)/,
  /^\/api\/upload(\/|$)/,
  /^\/api\/alteracoes\/[^/]+\/ciente\/?$/,                       // dar ciência
  /^\/api\/treinamentos\/[^/]+\/pops\/[^/]+\/concluir\/?$/,      // concluir treinamento próprio
  // POP — comentar, curtir/reagir e excluir o próprio comentário (resolver continua bloqueado)
  /^\/api\/pop-comentarios\/?$/,                                 // criar comentário
  /^\/api\/pop-comentarios\/[^/]+\/reagir\/?$/,                  // curtir/reagir
  /^\/api\/pop-comentarios\/[^/]+\/?$/,                          // excluir o próprio comentário (DELETE valida dono)
];

function ehRotaPessoal(path) {
  return ROTAS_PESSOAIS.some(re => re.test(path));
}

module.exports = {
  mesclarPermissoes,
  buscarPermsEfetivas,
  temPermissaoServer,
  resolverPermissao,
  ehRotaPessoal,
};
