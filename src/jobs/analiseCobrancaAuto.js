// Disparo automático mensal da Análise da Cobrança no Discord: assim que o mês
// fecha, manda a imagem (cards + painéis) referente ao mês que acabou de
// fechar. Dispara no dia 1 do mês seguinte, no horário configurado em
// Configuração Discord (evento "analise_cobranca"), uma vez por empresa/mês —
// mesmo padrão de dedup dos outros disparos automáticos (meta_auto_envio).
const { all, get, run } = require('../config/database');
const { getConfig, resolverWebhook, postWebhookImagem, registrarEnvio } = require('../utils/discord');
const { gerarImagemAnaliseCobrancaPng } = require('../utils/gerarImagemAnaliseCobranca');

function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function diaDoMesSP() { return agoraSP().getDate(); }
function minutosSP() {
  const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10) % 24;
  const m = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }), 10) || 0;
  return h * 60 + m;
}

// Mês que acabou de fechar (mês anterior ao atual), no formato AAAA-MM.
function mesFechado() {
  const hoje = agoraSP();
  const ant = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  return `${ant.getFullYear()}-${String(ant.getMonth() + 1).padStart(2, '0')}`;
}
function intervaloDoMes(mesRef) {
  const [ano, mes] = mesRef.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { dataInicio: iso(1), dataFim: iso(ultimoDia) };
}

async function disparoAutomaticoAnaliseCobranca() {
  try {
    // Só roda no dia 1 do mês (é quando o mês anterior fechou de fato).
    if (diaDoMesSP() !== 1) return;

    await run(`CREATE TABLE IF NOT EXISTS analise_cobranca_auto_envio (
      empresa_id TEXT NOT NULL, mes TEXT NOT NULL, PRIMARY KEY (empresa_id, mes))`);

    const mesRef = mesFechado();
    const empresas = await all(`SELECT empresa_id, notif_cfg FROM integracao_discord WHERE ativo = 1 AND ev_analise_cobranca = 1`);
    if (!empresas.length) return;

    for (const emp of empresas) {
      const empresa_id = emp.empresa_id;
      let ncfg = {}; try { ncfg = emp.notif_cfg ? JSON.parse(emp.notif_cfg) : {}; } catch { /* */ }
      const c = ncfg.analise_cobranca || {};
      const horaAlvo = (c.hora !== undefined && c.hora !== null && c.hora !== '') ? (+c.hora * 60 + (+c.minuto || 0)) : 8 * 60;
      if (minutosSP() < horaAlvo) continue;

      const ja = await get('SELECT 1 FROM analise_cobranca_auto_envio WHERE empresa_id=$1 AND mes=$2', [empresa_id, mesRef]);
      if (ja) continue;
      // Marca ANTES de enviar — se o envio falhar, não fica retentando a cada
      // ciclo e mandando duplicado depois que o problema (ex.: Discord fora
      // do ar) se resolver sozinho.
      await run(`INSERT INTO analise_cobranca_auto_envio (empresa_id, mes) VALUES ($1,$2) ON CONFLICT (empresa_id, mes) DO NOTHING`, [empresa_id, mesRef]);

      try {
        const cfg = await getConfig(empresa_id);
        const url = await resolverWebhook(empresa_id, cfg, 'analise_cobranca');
        if (!url) { console.log(`[analiseCobrancaAuto] empresa ${empresa_id} sem canal configurado, pulou`); continue; }

        const { dataInicio, dataFim } = intervaloDoMes(mesRef);
        const { montarAnaliseCobranca } = require('./metaCobranca');
        const dados = await montarAnaliseCobranca({ dataInicio, dataFim });

        const [ano, mes] = mesRef.split('-');
        const nomeMes = new Date(Number(ano), Number(mes) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        const png = await gerarImagemAnaliseCobrancaPng(dados, mesRef);
        const ok = await postWebhookImagem(url, png, `analise-cobranca-${mesRef}.png`, `📊 **Análise da Cobrança — ${nomeMes}**`);
        registrarEnvio(empresa_id, 'analise_cobranca', `Análise da Cobrança (${nomeMes})`, ok, ok ? null : 'Falha no envio');
        console.log(`[analiseCobrancaAuto] ${mesRef} (empresa ${empresa_id}): ${ok ? 'enviado' : 'falhou'}`);
      } catch (e) {
        console.error(`[analiseCobrancaAuto] falha ao enviar (empresa ${empresa_id}):`, e.message);
      }
    }
  } catch (e) { console.error('[analiseCobrancaAuto]', e.message); }
}

function iniciar() {
  setTimeout(disparoAutomaticoAnaliseCobranca, 90 * 1000);
  setInterval(disparoAutomaticoAnaliseCobranca, 15 * 60 * 1000);
  console.log('[analiseCobrancaAuto] iniciado (dia 1 do mês, no horário configurado)');
}

module.exports = { iniciar, disparoAutomaticoAnaliseCobranca };
