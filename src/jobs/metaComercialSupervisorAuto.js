// Disparo automático do relatório do Comercial no Discord: o supervisor recebe o
// GERAL (todos os vendedores, sem lista de clientes) e cada vendedor recebe a
// PRÓPRIA análise individual (com os próprios clientes) — nunca o geral do setor.
// Agenda fixa: segunda a sexta às 12h e 18h, sábado só às 12h (sem domingo).
// Mesmo padrão de dedup por dia dos outros jobs (meta_auto_envio).
const { all, get, run } = require('../config/database');

function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
// 0=domingo ... 6=sábado
function diaSemanaSP() { return agoraSP().getDay(); }
function horaSP() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10) % 24;
}
function minutosSP() {
  const m = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }), 10) || 0;
  return horaSP() * 60 + m;
}
function diaChaveSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// Horários do dia (em minutos desde 0h) que valem para o dia da semana de hoje.
function horariosDeHoje() {
  const dow = diaSemanaSP();
  if (dow === 0) return []; // domingo: não dispara
  if (dow === 6) return [12 * 60]; // sábado: só 12h
  return [12 * 60, 18 * 60]; // segunda a sexta: 12h e 18h
}

async function disparoAutomaticoSupervisor() {
  try {
    await run(`CREATE TABLE IF NOT EXISTS meta_comercial_supervisor_auto_envio (
      empresa_id TEXT NOT NULL, dia TEXT NOT NULL, slot INTEGER NOT NULL,
      PRIMARY KEY (empresa_id, dia, slot))`);
    // Dedup separado do supervisor: é um disparo diferente (individual x geral),
    // não pode compartilhar a mesma trava ou um bloquearia o outro no mesmo horário.
    await run(`CREATE TABLE IF NOT EXISTS meta_comercial_vendedores_auto_envio (
      empresa_id TEXT NOT NULL, dia TEXT NOT NULL, slot INTEGER NOT NULL,
      PRIMARY KEY (empresa_id, dia, slot))`);

    const horarios = horariosDeHoje();
    if (!horarios.length) return;
    const agoraMin = minutosSP();
    const dia = diaChaveSP();

    // require lazy: evita ciclo entre rotas e jobs (mesmo padrão de montarMetaComercial)
    const gestao = require('../routes/gestao-extra');

    // 1) Supervisor — relatório GERAL (sem lista de clientes)
    if (typeof gestao.enviarRelatorioGeralSupervisor === 'function') {
      const comSupervisor = await all(
        `SELECT empresa_id FROM meta_comercial_supervisor WHERE discord_id IS NOT NULL AND discord_id <> ''`);
      for (const emp of comSupervisor) {
        for (const slot of horarios) {
          if (agoraMin < slot) continue;
          const ja = await get(
            `SELECT 1 FROM meta_comercial_supervisor_auto_envio WHERE empresa_id=$1 AND dia=$2 AND slot=$3`,
            [emp.empresa_id, dia, slot]);
          if (ja) continue;
          // Marca ANTES de enviar: se o envio falhar (ex.: Discord fora do ar), não
          // fica tentando de novo a cada ciclo e mandando duplicado quando voltar.
          await run(
            `INSERT INTO meta_comercial_supervisor_auto_envio (empresa_id, dia, slot) VALUES ($1,$2,$3)
             ON CONFLICT (empresa_id, dia, slot) DO NOTHING`,
            [emp.empresa_id, dia, slot]);
          try {
            await gestao.enviarRelatorioGeralSupervisor(emp.empresa_id, {});
            console.log(`[metaComercialSupervisorAuto] relatório geral enviado ao supervisor (empresa ${emp.empresa_id}, ${dia} ${Math.floor(slot / 60)}h)`);
          } catch (e) {
            console.error(`[metaComercialSupervisorAuto] falha ao enviar ao supervisor (empresa ${emp.empresa_id}):`, e.message);
          }
        }
      }
    }

    // 2) Vendedores — análise INDIVIDUAL de cada um (nunca o geral do setor)
    if (typeof gestao.enviarAnalisesIndividuaisVendedores === 'function') {
      const comVendedores = await all(
        `SELECT DISTINCT empresa_id FROM meta_comercial_vendedor WHERE ativo = true AND discord_id IS NOT NULL AND discord_id <> ''`);
      for (const emp of comVendedores) {
        for (const slot of horarios) {
          if (agoraMin < slot) continue;
          const ja = await get(
            `SELECT 1 FROM meta_comercial_vendedores_auto_envio WHERE empresa_id=$1 AND dia=$2 AND slot=$3`,
            [emp.empresa_id, dia, slot]);
          if (ja) continue;
          await run(
            `INSERT INTO meta_comercial_vendedores_auto_envio (empresa_id, dia, slot) VALUES ($1,$2,$3)
             ON CONFLICT (empresa_id, dia, slot) DO NOTHING`,
            [emp.empresa_id, dia, slot]);
          try {
            const r = await gestao.enviarAnalisesIndividuaisVendedores(emp.empresa_id, {});
            console.log(`[metaComercialSupervisorAuto] análises individuais enviadas (empresa ${emp.empresa_id}, ${dia} ${Math.floor(slot / 60)}h): ${r.enviados.length} enviada(s), ${r.sem_discord.length} sem Discord, ${r.erros.length} erro(s)`);
          } catch (e) {
            console.error(`[metaComercialSupervisorAuto] falha ao enviar individuais (empresa ${emp.empresa_id}):`, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('[metaComercialSupervisorAuto]', e.message);
  }
}

function iniciar() {
  setTimeout(disparoAutomaticoSupervisor, 60 * 1000);
  setInterval(disparoAutomaticoSupervisor, 10 * 60 * 1000);
  console.log('[metaComercialSupervisorAuto] iniciado (seg-sex 12h/18h, sáb 12h)');
}

module.exports = { iniciar, disparoAutomaticoSupervisor };
