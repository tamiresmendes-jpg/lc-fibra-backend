// GET /api/erp/rota-tecnica — sequência de O.S. de um técnico num dia (mapa +
// distância estimada). Ver src/services/rotaTecnica.js para a lógica e as
// ressalvas sobre a distância ser em linha reta, não rota de rua real.
//
// Permissão: coberta pelo middleware global (verificarPermissao.js), que
// resolve '/api/erp/rota-tecnica' para 'erp.rota-tecnica' via MAPA_PERMISSAO
// (utils/permissoes.js) — módulo opt-in por já começar com 'erp.'.
const express = require('express');
const { autenticar } = require('../middleware/auth');
const { buscarOSDoDia, listarTecnicosDoDia, montarRotaTecnico } = require('../services/rotaTecnica');
const { buscarHistoricoReservaOS } = require('../services/hubsoft');

const router = express.Router();
router.use(autenticar);

function dataOuHoje(query) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(query || '')) return query;
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

router.get('/tecnicos', async (req, res) => {
  try {
    const data = dataOuHoje(req.query.data);
    const ordens = await buscarOSDoDia({ data });
    res.json({ data, tecnicos: listarTecnicosDoDia(ordens) });
  } catch (e) {
    console.error('Erro /erp/rota-tecnica/tecnicos:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar técnicos do dia: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

router.get('/', async (req, res) => {
  try {
    const data = dataOuHoje(req.query.data);
    if (!req.query.tecnico) return res.status(400).json({ erro: 'Informe o técnico.' });
    const ordens = await buscarOSDoDia({ data });
    const rota = montarRotaTecnico(ordens, req.query.tecnico);
    res.json({ data, ...rota });
  } catch (e) {
    console.error('Erro /erp/rota-tecnica:', e.message);
    res.status(500).json({ erro: 'Erro ao montar a rota técnica: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

// Histórico de reserva/execução de UMA O.S. — carregado sob demanda (só
// quando a linha é expandida na tela), porque exige login de painel (mais
// lento que a API de integração) e a maioria das O.S. do dia nunca é aberta.
router.get('/os/:id/historico', async (req, res) => {
  try {
    const eventos = await buscarHistoricoReservaOS(req.params.id, req.usuario.empresa_id);
    res.json({ eventos });
  } catch (e) {
    console.error('Erro /erp/rota-tecnica/os/:id/historico:', e.message);
    res.status(500).json({ erro: 'Erro ao buscar histórico da O.S.: ' + e.message.replace('HUBSOFT', 'HubSoft') });
  }
});

module.exports = router;
