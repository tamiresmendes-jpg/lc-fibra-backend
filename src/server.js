require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { conectar } = require('./config/database');

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));

app.use(require('./middleware/autoNotificacao'));

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
  })
  .catch((err) => {
    console.error('Falha ao conectar ao banco:', err.message);
    process.exit(1);
  });

module.exports = app;
