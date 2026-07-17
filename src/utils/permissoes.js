const { get, all } = require('../config/database');

// ─────────────────────────────────────────────────────────────
// Mescla de permissões (usuário + grupos). Regra: A MAIS RESTRITIVA VENCE.
// Se QUALQUER fonte (grupo direto, grupo do departamento ou o próprio
// usuário) bloquear um item, ele fica bloqueado. Assim, remover a permissão
// em um grupo realmente esconde o item para a pessoa ("ser fiel").
// editar > visualizar > bloqueado. Fonte sem restrição (null) = "não opina"
// (não libera nem bloqueia). Se NENHUMA fonte tem restrição → acesso total.
// ─────────────────────────────────────────────────────────────

// Nível → rank (quanto maior, mais acesso). 3=editar, 2=visualizar, 0=bloqueado.
function _rank(v) {
  if (v === true || v === 'editar') return 3;
  if (v === 'visualizar') return 2;
  return 0; // false, null, undefined
}
function _nivelDeRank(r) {
  if (r >= 3) return 'editar';
  if (r === 2) return 'visualizar';
  return false;
}
function _moduloBloqueado(v) {
  return v === false || v == null || (typeof v === 'object' && v.enabled === false);
}
function _scalarRank(v) {
  if (v === true || v === 'editar') return 3;
  if (v === 'visualizar') return 2;
  return null; // é objeto (permissões por item)
}
// Rank de um item específico dentro de um valor de módulo.
// Item não listado num objeto = bloqueado (consistente com temPermissaoServer).
function _itemRank(v, item) {
  const s = _scalarRank(v);
  if (s !== null) return s; // módulo escalar libera todos os itens no mesmo nível
  return _rank(v?.itens?.[item]);
}

// Interseção (mais restritiva) entre dois valores de módulo já definidos.
function _interseccaoModulo(va, vb) {
  if (_moduloBloqueado(va) || _moduloBloqueado(vb)) return false;
  const ra = _scalarRank(va), rb = _scalarRank(vb);
  if (ra !== null && rb !== null) return _nivelDeRank(Math.min(ra, rb));
  // Ao menos um é objeto por item → resultado por item.
  const chaves = new Set([
    ...(typeof va === 'object' ? Object.keys(va.itens || {}) : []),
    ...(typeof vb === 'object' ? Object.keys(vb.itens || {}) : []),
  ]);
  const itens = {};
  for (const it of chaves) {
    itens[it] = _nivelDeRank(Math.min(_itemRank(va, it), _itemRank(vb, it)));
  }
  return { enabled: true, itens };
}

function _interseccaoPerms(a, b) {
  const res = {};
  const modulos = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const m of modulos) {
    const va = a[m], vb = b[m];
    // Se só uma fonte define o módulo, a outra "não opina" → usa a que definiu.
    if (va === undefined) { res[m] = vb; continue; }
    if (vb === undefined) { res[m] = va; continue; }
    res[m] = _interseccaoModulo(va, vb);
  }
  return res;
}

function mesclarPermissoes(userPerms, grupoPermsList) {
  const fontes = [userPerms, ...(grupoPermsList || [])];
  // Fontes sem restrição (null) não opinam. Só interessam as com restrição.
  const comRestricao = fontes.filter(p => p && typeof p === 'object');
  if (comRestricao.length === 0) return null; // ninguém restringe → acesso total
  let base = JSON.parse(JSON.stringify(comRestricao[0]));
  for (let i = 1; i < comRestricao.length; i++) {
    base = _interseccaoPerms(base, comRestricao[i]);
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
    const grupos = [...gruposDiretos, ...gruposDept];
    // REGRA: se o usuário pertence a algum grupo, o GRUPO é a fonte da verdade
    // (as permissões individuais antigas são ignoradas). Assim, mudar/remover no
    // grupo reflete de verdade. Sem grupo → usa as permissões individuais.
    if (grupos.length === 0) return permModulos;
    const todasPerms = grupos
      .map(g => { try { return g.permissoes_modulos ? JSON.parse(g.permissoes_modulos) : null; } catch { return null; } });
    return mesclarPermissoes(null, todasPerms);
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
  ['/api/empresa-extra/telefones',     'empresa.telefones'],
  ['/api/empresa-extra/contatos',      'empresa.contatos'],
  ['/api/empresa-extra/horarios',      'empresa.horarios'],
  ['/api/empresa-extra/localizacoes',  'empresa.filiais'],
  ['/api/empresa-extra',               'empresa.filiais'],
  ['/api/unidades',                    'empresa.filiais'],
  ['/api/redes-sociais',               'empresa.redes-sociais'],
  ['/api/feriados',                    'empresa.feriados'],
  ['/api/ceps',                        'empresa.consulta-cep'],
  // Gestão extra
  ['/api/gestao-extra/metas',          'gestao.metas'],
  ['/api/gestao-extra/okrs',           'gestao.okrs'],
  ['/api/gestao-extra',                'gestao.indicadores'],
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
  // Recursos PESSOAIS do próprio usuário (as rotas já validam o dono):
  /^\/api\/tarefas(\/|$)/,                                       // kanban de tarefas pessoal
  /^\/api\/anotacoes(\/|$)/,                                     // anotações pessoais
  /^\/api\/chat(\/|$)/,                                          // Kronos Chat (tickets) — todos usam; rota valida dono/responsável
  /^\/api\/sugestoes\/?$/,                                       // enviar sugestão
  /^\/api\/cultura\/pesquisas\/[^/]+\/responder\/?$/,           // responder pesquisa de clima
  /^\/api\/cultura\/enquetes\/[^/]+\/votar\/?$/,                // votar em enquete
  /^\/api\/alteracoes\/[^/]+\/ciente\/?$/,                       // dar ciência
  /^\/api\/alteracoes\/[^/]+\/curtir\/?$/,                       // curtir aviso
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
