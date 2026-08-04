// Rankings automáticos por setor, gerados no 1º dia útil do mês com os dados do mês anterior,
// salvos em Cultura → Reconhecimento (aparecem no mural) e avisados no Discord.
//
// Critérios definidos pela usuária:
//   Comercial / PAP / Escritório → vendas do mês (Meta do Comercial)
//   Call Center / Financeiro     → satisfação + taxa de resposta (Chatmix)
const { all, get, run } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { notificar: notificarDiscord, COR } = require('../utils/discord');

function hojeSP() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }

// É o primeiro dia ÚTIL do mês? (sábado/domingo não contam)
function ehPrimeiroDiaUtil(ymd) {
  const d = new Date(ymd + 'T12:00');
  if (d.getDay() === 0 || d.getDay() === 6) return false; // fim de semana nunca é
  const primeiro = new Date(d.getFullYear(), d.getMonth(), 1, 12);
  while (primeiro.getDay() === 0 || primeiro.getDay() === 6) primeiro.setDate(primeiro.getDate() + 1);
  return primeiro.getDate() === d.getDate();
}

function mesAnteriorDe(ymd) {
  const d = new Date(ymd + 'T12:00');
  const a = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}`;
}
function mesExtenso(mesRef) {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

// Setor a partir da filial cadastrada no vendedor
function setorDaFilial(filial) {
  const f = (filial || '').toLowerCase();
  if (f.includes('pap')) return 'PAP';
  if (f.includes('escrit')) return 'Escritório';
  if (f.includes('comercial')) return 'Comercial';
  return null; // sem setor reconhecido: fica fora dos rankings automáticos
}

// Cria o ranking + posições e avisa no Discord
async function criarRanking(empresa_id, titulo, descricao, linhas) {
  if (!linhas.length) return null;
  const id = uuidv4();
  await run(
    `INSERT INTO cultura_rankings (id,empresa_id,titulo,descricao,periodo,tipo_ranking,ativo)
     VALUES ($1,$2,$3,$4,$5,'automatico',1)`,
    [id, empresa_id, titulo, descricao, descricao]
  );
  for (const l of linhas) {
    await run(
      `INSERT INTO cultura_ranking_posicoes (id,ranking_id,posicao,usuario_id,nome_externo,pontuacao,descricao)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), id, l.posicao, l.usuario_id || null, l.usuario_id ? null : l.nome, l.pontuacao || null, l.detalhe || null]
    );
  }
  const texto = linhas.map(l => {
    const medalha = l.posicao === 1 ? '🥇' : l.posicao === 2 ? '🥈' : l.posicao === 3 ? '🥉' : `${l.posicao}º`;
    return `${medalha} **${l.nome}**${l.pontuacao ? ` — ${l.pontuacao}` : ''}`;
  }).join('\n');
  await notificarDiscord(empresa_id, 'ranking_mes', {
    title: `🏆 ${titulo}`,
    description: `${descricao}\n\n${texto}`,
    color: COR.laranja,
    linkPath: '/cultura/reconhecimento',
    footer: { text: 'Kronos — Ranking do mês (automático)' },
    timestamp: new Date().toISOString(),
  }).catch(() => {});
  return id;
}

// Ordena por valor (maior primeiro) e aplica posição com EMPATE (mesma nota = mesma posição)
function posicionar(itens, chaveValor) {
  const ordenado = [...itens].sort((a, b) => b[chaveValor] - a[chaveValor]);
  let pos = 0, anterior = null;
  return ordenado.map((it, i) => {
    if (anterior === null || it[chaveValor] !== anterior) { pos = i + 1; anterior = it[chaveValor]; }
    return { ...it, posicao: pos };
  });
}

async function gerarRankingsDoMes(empresa_id, mesRef) {
  const rotulo = mesExtenso(mesRef);
  const gestao = require('../routes/gestao-extra');
  const criados = [];

  // ── Comercial / PAP / Escritório: por VENDAS do mês ────────────────────────
  if (typeof gestao.montarMetaComercial === 'function') {
    const dados = await gestao.montarMetaComercial(empresa_id, mesRef, 'admin').catch(() => null);
    const porSetor = {};
    for (const i of (dados?.itens || [])) {
      const setor = setorDaFilial(i.filial);
      if (!setor || !i.qtd_vendas) continue;
      (porSetor[setor] = porSetor[setor] || []).push({
        nome: i.nome, usuario_id: i.usuario_id || null, valor: i.qtd_vendas,
        pontuacao: `${i.qtd_vendas} vendas`, detalhe: i.filial || null,
      });
    }
    for (const [setor, lista] of Object.entries(porSetor)) {
      const linhas = posicionar(lista, 'valor').slice(0, 10);
      const id = await criarRanking(empresa_id, `Ranking ${setor} — ${rotulo}`,
        `Por vendas do mês (${rotulo})`, linhas);
      if (id) criados.push(`${setor} (vendas)`);
    }
  }

  // ── Call Center / Financeiro: SATISFAÇÃO + TAXA DE RESPOSTA ────────────────
  try {
    const chatmix = require('../routes/chatmix');
    if (typeof chatmix.calcularMeta === 'function') {
      const [a, m] = mesRef.split('-').map(Number);
      const ultimoDia = new Date(a, m, 0).getDate();
      const di = `${mesRef}-01`, df = `${mesRef}-${String(ultimoDia).padStart(2, '0')}`;
      const meta = await chatmix.calcularMeta(empresa_id, di, df, 90, 55).catch(() => null);
      const porDept = {};
      for (const i of (meta?.itens || [])) {
        if (i.perc_satisfacao == null) continue;
        const dept = i.departamento === 'Call Center' ? 'Call Center' : i.departamento;
        if (!['Call Center', 'Financeiro'].includes(dept)) continue;
        // Nota combinada: satisfação e taxa de resposta com o mesmo peso
        const valor = Math.round(((i.perc_satisfacao + i.taxa_resposta) / 2) * 10) / 10;
        (porDept[dept] = porDept[dept] || []).push({
          nome: i.atendente, usuario_id: null, valor,
          pontuacao: `${i.perc_satisfacao.toFixed(1)}% satisf. · ${i.taxa_resposta.toFixed(1)}% resp.`,
          detalhe: `${i.satisfeitas} satisfeitos de ${i.total} atendimentos`,
        });
      }
      for (const [dept, lista] of Object.entries(porDept)) {
        const linhas = posicionar(lista, 'valor').slice(0, 10);
        const id = await criarRanking(empresa_id, `Ranking ${dept} — ${rotulo}`,
          `Por satisfação + taxa de resposta (${rotulo})`, linhas);
        if (id) criados.push(`${dept} (satisfação)`);
      }
    }
  } catch (e) { console.error('[rankingMensal] chatmix:', e.message); }

  return criados;
}

async function tick(forcar = false) {
  try {
    const hoje = hojeSP();
    if (!forcar && !ehPrimeiroDiaUtil(hoje)) return;
    await run(`CREATE TABLE IF NOT EXISTS ranking_mensal_status (
      empresa_id TEXT NOT NULL, mes TEXT NOT NULL, gerado_em TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (empresa_id, mes)
    )`);
    const mesRef = mesAnteriorDe(hoje);
    const empresas = await all('SELECT DISTINCT empresa_id FROM meta_comercial_vendedor');
    for (const { empresa_id } of empresas) {
      const ja = await get('SELECT 1 AS x FROM ranking_mensal_status WHERE empresa_id=$1 AND mes=$2', [empresa_id, mesRef]);
      if (ja && !forcar) continue; // já gerou este mês
      await run(`INSERT INTO ranking_mensal_status (empresa_id, mes) VALUES ($1,$2)
                 ON CONFLICT (empresa_id, mes) DO UPDATE SET gerado_em=NOW()`, [empresa_id, mesRef]);
      const criados = await gerarRankingsDoMes(empresa_id, mesRef);
      console.log(`[rankingMensal] ${empresa_id}: ${criados.length} ranking(s) de ${mesRef} — ${criados.join(', ') || 'nenhum'}`);
    }
  } catch (e) { console.error('[rankingMensal]', e.message); }
}

function iniciar() {
  setTimeout(() => tick(), 60 * 1000);      // confere logo após subir
  setInterval(() => tick(), 60 * 60 * 1000); // e de hora em hora
  console.log('[rankingMensal] iniciado (1º dia útil do mês)');
}

module.exports = { iniciar, tick, gerarRankingsDoMes };
