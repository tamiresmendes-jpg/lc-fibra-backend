require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

// Inicializa banco de dados (funciona tanto local quanto no Vercel cold start)
const { conectar } = require('./config/database');
const dbReady = conectar().catch(err => {
  console.error('[DB] Falha ao conectar:', err.message);
});

// Aguarda DB antes de processar qualquer requisição
app.use(async (req, res, next) => {
  await dbReady;
  next();
});

// Middleware automático de notificações — deve vir ANTES das rotas
app.use(require('./middleware/autoNotificacao'));

// Rotas
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
const UPLOADS_PATH = process.env.VERCEL ? '/tmp/uploads' : require('path').join(__dirname, '../uploads');
app.use('/uploads', express.static(UPLOADS_PATH));

app.get('/api/health', (req, res) => res.json({ status: 'ok', versao: '1.0.0' }));

// Middleware global de erros
app.use((err, req, res, next) => {
  console.error('[ERRO ROTA]', err.message);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// Proteção global contra crashes
process.on('uncaughtException', (err) => {
  console.error('[CRASH EVITADO - uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH EVITADO - unhandledRejection]', reason);
});

// Só inicia servidor HTTP quando não estiver no Vercel
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

// Exporta app para o Vercel (serverless)
module.exports = app;
