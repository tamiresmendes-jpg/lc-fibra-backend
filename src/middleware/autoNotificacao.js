const { v4: uuidv4 } = require('uuid');
const { run } = require('../config/database');

// Mapeamento de rota → módulo
const ROTA_MODULO = {
  '/api/usuarios':              { modulo: 'Equipe',                    entidade: 'Usuário' },
  '/api/departamentos':         { modulo: 'Equipe',                    entidade: 'Departamento' },
  '/api/cargos':                { modulo: 'Equipe',                    entidade: 'Cargo' },
  '/api/escalas':               { modulo: 'Equipe',                    entidade: 'Escala' },
  '/api/pops':                  { modulo: 'Processos e Procedimentos', entidade: 'POP' },
  '/api/categorias-pop':        { modulo: 'Processos e Procedimentos', entidade: 'Categoria POP' },
  '/api/processos':             { modulo: 'Processos e Procedimentos', entidade: 'Processo' },
  '/api/fluxos':                { modulo: 'Processos e Procedimentos', entidade: 'Fluxo' },
  '/api/checklists':            { modulo: 'Processos e Procedimentos', entidade: 'Checklist' },
  '/api/comunicados':           { modulo: 'Cultura',                   entidade: 'Comunicado' },
  '/api/cultura':               { modulo: 'Cultura',                   entidade: 'Cultura' },
  '/api/treinamentos':          { modulo: 'Treinamento',               entidade: 'Treinamento' },
  '/api/onboarding':            { modulo: 'Treinamento',               entidade: 'Onboarding' },
  '/api/avaliacoes':            { modulo: 'Treinamento',               entidade: 'Avaliação' },
  '/api/auditorias':            { modulo: 'Auditoria',                 entidade: 'Auditoria' },
  '/api/auditoria-solicitacoes':{ modulo: 'Auditoria',                 entidade: 'Solicitação de Auditoria' },
  '/api/acoes':                 { modulo: 'Gestão',                    entidade: 'Ação' },
  '/api/indicadores':           { modulo: 'Gestão',                    entidade: 'Indicador' },
  '/api/reunioes':              { modulo: 'Gestão',                    entidade: 'Reunião' },
};

const TIPO_ACAO = {
  POST:   'Inclusão',
  PUT:    'Alteração',
  PATCH:  'Alteração',
  DELETE: 'Exclusão',
};

// Rotas a ignorar (não geram notificação)
const IGNORAR = [
  '/api/alteracoes',
  '/api/auth',
  '/api/dashboard',
  '/api/upload',
  '/api/email',
  '/api/ia',
  '/api/health',
  '/uploads',
];

// Extrair nome/título do body ou da URL
function extrairTitulo(method, path, body, responseBody) {
  // Tenta pegar do response
  if (responseBody) {
    try {
      const r = JSON.parse(responseBody);
      if (r.titulo) return r.titulo;
      if (r.nome)   return r.nome;
    } catch {}
  }
  // Tenta pegar do body da requisição
  if (body) {
    if (body.titulo) return body.titulo;
    if (body.nome)   return body.nome;
    if (body.email)  return body.email;
  }
  return null;
}

async function gerarNotificacao(req, res, statusCode, responseBody) {
  try {
    if (!req.usuario) return; // não autenticado
    const method = req.method.toUpperCase();
    if (!['POST','PUT','PATCH','DELETE'].includes(method)) return;
    if (statusCode < 200 || statusCode >= 300) return; // só sucesso

    const path = req.path;
    const url  = req.originalUrl.split('?')[0];

    // Verifica se deve ignorar
    for (const ig of IGNORAR) {
      if (url.startsWith(ig)) return;
    }

    // Ignora sub-rotas de cultura que não são alterações de dados principais
    if (url.includes('/curtir') || url.includes('/ciente') || url.includes('/confirmar-leitura') ||
        url.includes('/comentarios') || url.includes('/responder') || url.includes('/aceitar') ||
        url.includes('/visualizacoes') || url.includes('/contador') || url.includes('/pendentes') ||
        url.includes('/importar') || url.includes('/bloquear') || url.includes('/senha') ||
        url.includes('/dashboard') || url.includes('/me') || url.includes('/reacoes')) return;

    // Encontra o módulo pelo prefixo da rota
    let cfg = null;
    for (const [prefixo, dados] of Object.entries(ROTA_MODULO)) {
      if (url.startsWith(prefixo)) { cfg = dados; break; }
    }
    if (!cfg) return;

    const tipoAcao = TIPO_ACAO[method] || 'Alteração';
    const titulo = extrairTitulo(method, url, req.body, responseBody)
      || `${tipoAcao} em ${cfg.entidade}`;

    const empresaId = req.usuario.empresa_id;

    // Determina nível: DELETE ou PUT em usuários = importante, resto = informativa
    let nivel = 'informativa';
    if (method === 'DELETE') nivel = 'importante';
    if (url.startsWith('/api/usuarios') && method !== 'POST') nivel = 'importante';
    if (url.startsWith('/api/pops') && method === 'POST') nivel = 'informativa';

    await run(`
      INSERT INTO alteracoes (id, empresa_id, modulo, titulo, tipo_acao, nivel, descricao, criado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      uuidv4(),
      empresaId,
      cfg.modulo,
      `${tipoAcao}: ${titulo}`,
      tipoAcao,
      nivel,
      `Ação realizada por ${req.usuario.nome || req.usuario.email} via ${cfg.entidade}`,
      req.usuario.id
    ]);
  } catch(e) {
    // Silencioso — não deve quebrar a requisição
    console.error('[AutoNotif]', e.message);
  }
}

// Middleware que intercepta respostas
function middlewareAutoNotificacao(req, res, next) {
  const metodoOriginal = res.json.bind(res);
  let bodyCapturado = null;

  res.json = function(data) {
    bodyCapturado = JSON.stringify(data);
    return metodoOriginal(data);
  };

  res.on('finish', () => {
    gerarNotificacao(req, res, res.statusCode, bodyCapturado).catch(e => console.error('[AutoNotif]', e.message));
  });

  next();
}

module.exports = middlewareAutoNotificacao;
