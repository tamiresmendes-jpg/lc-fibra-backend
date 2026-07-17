const { v4: uuidv4 } = require('uuid');
const { run } = require('../config/database');

// Colunas extras para auditoria detalhada (o que mudou / método / rota)
;(async () => {
  try { await run('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS detalhes TEXT'); } catch {}
  try { await run('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS metodo TEXT'); } catch {}
  try { await run('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS rota TEXT'); } catch {}
})();

// Campos que nunca devem ser gravados no log (sensíveis/pesados)
const CAMPOS_OCULTOS = new Set([
  'senha', 'senha_atual', 'nova_senha', 'password', 'token', 'refresh_token',
  'imagem', 'foto', 'anexo', 'anexos', 'arquivo', 'base64', 'avatar', 'blocos',
  'conteudo', 'assinatura', 'webhook_url',
]);

// Sanitiza o corpo da requisição: oculta sensíveis, corta strings enormes
// (base64/HTML) e limita profundidade para o log ficar legível.
function sanitizar(valor, profundidade = 0) {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'string') {
    if (valor.startsWith('data:')) return '[arquivo]';
    return valor.length > 300 ? valor.slice(0, 300) + '…' : valor;
  }
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (profundidade >= 4) return '…';
  if (Array.isArray(valor)) {
    if (valor.length > 20) return `[${valor.length} itens]`;
    return valor.map(v => sanitizar(v, profundidade + 1));
  }
  if (typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (CAMPOS_OCULTOS.has(k.toLowerCase())) { out[k] = '[oculto]'; continue; }
      out[k] = sanitizar(v, profundidade + 1);
    }
    return out;
  }
  return String(valor);
}

function montarDetalhes(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const limpo = sanitizar(body);
    const chaves = Object.keys(limpo);
    if (!chaves.length) return null;
    const json = JSON.stringify(limpo);
    return json.length > 4000 ? json.slice(0, 4000) + '…' : json;
  } catch { return null; }
}

// Mapa de prefixo de rota → módulo legível. Rotas não mapeadas usam fallback
// derivado do caminho (nada é silenciosamente descartado).
const ROTA_MODULO = {
  '/api/usuarios':               'Colaboradores',
  '/api/departamentos':          'Departamentos',
  '/api/cargos':                 'Cargos',
  '/api/setores':                'Setores',
  '/api/escalas':                'Escalas',
  '/api/grupos-permissao':       'Grupos de Permissão',
  '/api/pops':                   'POPs',
  '/api/pop-comentarios':        'POPs',
  '/api/categorias-pop':         'Categorias de POP',
  '/api/processos':              'Processos',
  '/api/fluxos':                 'Fluxos',
  '/api/checklists':             'Checklists',
  '/api/comunicados':            'Comunicados',
  '/api/cultura':                'Cultura',
  '/api/treinamentos':           'Treinamentos',
  '/api/onboarding':             'Onboarding',
  '/api/auditorias':             'Auditorias',
  '/api/auditoria-solicitacoes': 'Auditorias',
  '/api/auditoria-extra':        'Auditorias',
  '/api/acoes':                  'Plano de Ação',
  '/api/indicadores':            'Indicadores',
  '/api/reunioes':               'Reuniões',
  '/api/campanhas':              'Campanhas',
  '/api/gestao':                 'Gestão (Metas/OKRs)',
  '/api/unidades':               'Unidades',
  '/api/redes-sociais':          'Redes Sociais',
  '/api/feriados':               'Calendário Corporativo',
  '/api/empresa':                'Empresa',
  '/api/ceps':                   'CEPs',
  '/api/email':                  'Configuração de E-mail',
  '/api/feedbacks':              'Feedbacks',
  '/api/sugestoes':              'Fórum',
  '/api/beneficios':             'Benefícios',
  '/api/ferias':                 'Férias',
  '/api/coffee-breaks':          'Coffee Break',
  '/api/tarefas':                'Tarefas',
  '/api/anotacoes':              'Anotações',
  '/api/agenda':                 'Agenda',
  '/api/calendario':             'Calendário',
  '/api/interacoes':             'Interações',
  '/api/chat':                   'Kronos Chat',
  '/api/alteracoes':             'Central de Ciência',
};

// Ações específicas pelo sufixo da URL (verbo no fim do caminho)
const ACAO_SUFIXO = {
  'bloquear':                    'Bloqueou/desbloqueou acesso',
  'senha':                       'Redefiniu senha',
  'aprovar':                     'Aprovou',
  'rejeitar':                    'Rejeitou',
  'reprovar':                    'Reprovou',
  'aceitar':                     'Aceitou',
  'concluir':                    'Concluiu',
  'restaurar':                   'Restaurou',
  'curtir':                      'Curtiu',
  'ciente':                      'Deu ciência',
  'confirmar-leitura':           'Confirmou leitura',
  'responder':                   'Respondeu',
  'resolver':                    'Resolveu',
  'reordenar':                   'Reordenou',
  'importar':                    'Importou',
  'importar-por-nome':           'Importou',
  'gerar-acessos-corporativos':  'Gerou acessos',
  'membros':                     'Alterou membros',
  'departamentos':               'Alterou departamentos',
  'organograma':                 'Alterou organograma',
  'iniciar':                     'Iniciou',
  'publicar':                    'Publicou',
  'reagir':                      'Reagiu',
  'responsabilidades':           'Editou responsabilidades',
};

const ACAO_METHOD = { POST: 'Criou', PUT: 'Editou', PATCH: 'Editou', DELETE: 'Excluiu' };

// Fora do log: pré-login, leituras, contadores, geração de IA, estáticos e o próprio log.
const IGNORAR_URL = [
  '/api/auth', '/api/dashboard', '/api/health', '/uploads',
  '/api/audit-log', '/api/ia', '/api/upload',
];
const IGNORAR_SUFIXO = ['/visualizacoes', '/contador', '/pendentes', '/me', '/mensagens', '/meu-status'];

function extrairNome(body, responseBody) {
  if (responseBody) {
    try {
      const r = JSON.parse(responseBody);
      if (r.titulo) return r.titulo;
      if (r.nome) return r.nome;
    } catch {}
  }
  if (body) {
    if (body.titulo) return body.titulo;
    if (body.nome) return body.nome;
    if (body.email) return body.email;
  }
  return null;
}

function resolverModulo(url) {
  for (const [prefixo, mod] of Object.entries(ROTA_MODULO)) {
    if (url.startsWith(prefixo)) return mod;
  }
  // Fallback: deriva do 2º segmento do caminho (/api/<seg>/...)
  const seg = url.split('/').filter(Boolean)[1];
  if (!seg) return 'Sistema';
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');
}

function resolverAcao(url, method) {
  const segs = url.split('?')[0].split('/').filter(Boolean);
  const ultimo = segs[segs.length - 1];
  if (ACAO_SUFIXO[ultimo]) return ACAO_SUFIXO[ultimo];
  return ACAO_METHOD[method] || 'Modificou';
}

async function registrar(req, res, statusCode, responseBody) {
  try {
    if (!req.usuario) return;
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    if (statusCode < 200 || statusCode >= 300) return;

    const url = req.originalUrl.split('?')[0];

    for (const ig of IGNORAR_URL) if (url.startsWith(ig)) return;
    for (const suf of IGNORAR_SUFIXO) if (url.endsWith(suf)) return;

    const modulo = resolverModulo(url);
    const acao = resolverAcao(url, method);
    const entidadeNome = extrairNome(req.body, responseBody) || `registro em ${modulo}`;
    const ip = req.ip
      || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || null;

    const detalhes = method === 'DELETE' ? null : montarDetalhes(req.body);

    await run(
      `INSERT INTO audit_log (id, empresa_id, usuario_id, usuario_nome, perfil, modulo, acao, entidade_nome, ip, metodo, rota, detalhes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [uuidv4(), req.usuario.empresa_id, req.usuario.id, req.usuario.nome || null, req.usuario.perfil, modulo, acao, entidadeNome, ip, method, url, detalhes]
    );
  } catch (e) {
    console.error('[AuditLog]', e.message);
  }
}

function middlewareAuditLog(req, res, next) {
  const jsonOriginal = res.json.bind(res);
  let bodyCapturado = null;

  res.json = function (data) {
    bodyCapturado = JSON.stringify(data);
    return jsonOriginal(data);
  };

  res.on('finish', () => {
    registrar(req, res, res.statusCode, bodyCapturado).catch(() => {});
  });

  next();
}

module.exports = middlewareAuditLog;
