require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { conectar } = require('./config/database');

// Segredo do JWT é obrigatório — sem ele o controle de acesso é inseguro
if (!process.env.JWT_SECRET) {
  console.error('FATAL: variável de ambiente JWT_SECRET não definida. Encerrando.');
  process.exit(1);
}

const app = express();

// Atrás do proxy da Railway — necessário para IP real (auditoria) e rate limit corretos
app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// Limite alto: o sistema faz polling frequente (fila, novas demandas, notificações).
// 200 era baixo demais e derrubava usuários ativos com 429 (parecia "senha incorreta").
// IMPORTANTE: as rotas de autenticação (/api/auth) NUNCA entram no limite global,
// então login/sessão jamais é bloqueado. (O login tem seu próprio limitador só p/ senha errada.)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/auth') || req.path.startsWith('/auth'),
}));

// autoNotificacao desativado — Central de Ciência é alimentada manualmente
// app.use(require('./middleware/autoNotificacao'));
app.use(require('./middleware/auditLog'));
// Garante as regras de permissão no servidor (colaborador = somente leitura,
// líder/gestor seguem o grupo). Roda antes das rotas em todas as mutações.
app.use(require('./middleware/verificarPermissao'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/departamentos', require('./routes/departamentos'));
app.use('/api/cargos', require('./routes/cargos'));
app.use('/api/pops', require('./routes/pops'));
app.use('/api/pops', require('./routes/pop_anexos'));
app.use('/api/categorias-pop', require('./routes/categorias-pop'));
app.use('/api/auditoria-solicitacoes', require('./routes/auditoria-solicitacoes'));
app.use('/api/auditorias', require('./routes/auditorias'));
app.use('/api/acoes', require('./routes/acoes'));
app.use('/api/indicadores', require('./routes/indicadores'));
app.use('/api/comunicados', require('./routes/comunicados'));
app.use('/api/reunioes', require('./routes/reunioes'));
app.use('/api/treinamentos', require('./routes/treinamentos'));
app.use('/api/alteracoes', require('./routes/alteracoes'));
app.use('/api/campanhas', require('./routes/campanhas'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/email', require('./routes/email-teste'));
app.use('/api/ia', require('./routes/ia'));
app.use('/api/pop-comentarios', require('./routes/pop-comentarios'));
app.use('/api/setores', require('./routes/setores'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/cultura', require('./routes/cultura'));
app.use('/api/processos', require('./routes/processos'));
app.use('/api/fluxos', require('./routes/fluxos'));
app.use('/api/checklists', require('./routes/checklists'));
app.use('/api/escalas', require('./routes/escalas'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/ceps', require('./routes/ceps'));
app.use('/api/unidades', require('./routes/unidades'));
app.use('/api/redes-sociais', require('./routes/redes-sociais'));
app.use('/api/feriados', require('./routes/feriados'));
app.use('/api/coffee-breaks', require('./routes/coffee-breaks'));
app.use('/api/interacoes', require('./routes/interacoes'));
app.use('/api/empresa', require('./routes/empresa'));
app.use('/api/audit-log', require('./routes/audit-log'));
app.use('/api/lixeira', require('./routes/lixeira'));
app.use('/api/grupos-permissao', require('./routes/grupos-permissao'));
app.use('/api/feedbacks', require('./routes/feedbacks'));
app.use('/api/ferias', require('./routes/ferias'));
app.use('/api/agenda', require('./routes/agenda'));
app.use('/api/calendario', require('./routes/calendario'));
app.use('/api/anotacoes', require('./routes/anotacoes'));
app.use('/api/beneficios', require('./routes/beneficios'));
app.use('/api/sugestoes', require('./routes/sugestoes'));
app.use('/api/tarefas', require('./routes/tarefas'));
app.use('/api/cultura', require('./routes/cultura-extra'));
app.use('/api/empresa', require('./routes/empresa-extra'));
app.use('/api/processos', require('./routes/processos-extra'));
app.use('/api/treinamentos', require('./routes/treinamentos-extra'));
app.use('/api/gestao', require('./routes/gestao-extra'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/auditoria-extra', require('./routes/auditoria-extra'));
app.use('/uploads', express.static(require('path').join(__dirname, '../uploads')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }));

app.use((err, req, res, next) => {
  console.error('[ERRO]', err.message);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err.message));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

const PORT = process.env.PORT || 3001;

conectar()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
    require('./jobs/chatAceite').iniciarJob();
  })
  .catch((err) => {
    console.error('Falha ao conectar ao banco:', err.message);
    process.exit(1);
  });

module.exports = app;
