const { v4: uuidv4 } = require('uuid');
const { run } = require('../config/database');

const ROTA_MODULO = {
  '/api/usuarios':               'Equipe',
  '/api/departamentos':          'Equipe',
  '/api/cargos':                 'Equipe',
  '/api/escalas':                'Equipe',
  '/api/pops':                   'Processos e Procedimentos',
  '/api/categorias-pop':         'Processos e Procedimentos',
  '/api/processos':              'Processos e Procedimentos',
  '/api/fluxos':                 'Processos e Procedimentos',
  '/api/checklists':             'Processos e Procedimentos',
  '/api/comunicados':            'Cultura',
  '/api/cultura':                'Cultura',
  '/api/treinamentos':           'Treinamento',
  '/api/onboarding':             'Treinamento',
  '/api/avaliacoes':             'Treinamento',
  '/api/auditorias':             'Auditoria',
  '/api/auditoria-solicitacoes': 'Auditoria',
  '/api/acoes':                  'Gestão',
  '/api/indicadores':            'Gestão',
  '/api/reunioes':               'Gestão',
  '/api/unidades':               'Configurações',
  '/api/redes-sociais':          'Configurações',
  '/api/feriados':               'Configurações',
  '/api/alteracoes':             'Central de Ciência',
};

const ACAO_METHOD = {
  POST:   'Criou',
  PUT:    'Editou',
  PATCH:  'Editou',
  DELETE: 'Excluiu',
};

const IGNORAR_URL = [
  '/api/auth', '/api/dashboard', '/api/upload', '/api/email',
  '/api/ia', '/api/health', '/uploads', '/api/audit-log', '/api/lixeira',
];

const IGNORAR_SUFIXO = [
  '/curtir','/ciente','/confirmar-leitura','/comentarios','/responder',
  '/aceitar','/visualizacoes','/contador','/pendentes','/importar',
  '/bloquear','/senha','/dashboard','/me','/reacoes','/avatar',
  '/restaurar','/ciente','/reordenar','/concluir',
];

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

async function registrar(req, res, statusCode, responseBody) {
  try {
    if (!req.usuario) return;
    const method = req.method.toUpperCase();
    if (!['POST','PUT','PATCH','DELETE'].includes(method)) return;
    if (statusCode < 200 || statusCode >= 300) return;

    const url = req.originalUrl.split('?')[0];

    for (const ig of IGNORAR_URL) {
      if (url.startsWith(ig)) return;
    }
    for (const suf of IGNORAR_SUFIXO) {
      if (url.includes(suf)) return;
    }

    let modulo = null;
    for (const [prefixo, mod] of Object.entries(ROTA_MODULO)) {
      if (url.startsWith(prefixo)) { modulo = mod; break; }
    }
    if (!modulo) return;

    const acao = ACAO_METHOD[method] || 'Modificou';
    const entidadeNome = extrairNome(req.body, responseBody) || `registro em ${modulo}`;
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || null;

    await run(
      `INSERT INTO audit_log (id, empresa_id, usuario_id, usuario_nome, perfil, modulo, acao, entidade_nome, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uuidv4(), req.usuario.empresa_id, req.usuario.id, req.usuario.nome, req.usuario.perfil, modulo, acao, entidadeNome, ip]
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
