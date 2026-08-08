// PDF da trilha de treinamento completa: módulos, sub-módulos (POPs), checklist
// do instrutor, quem é o treinador/treinando e data/hora — pra imprimir ou
// arquivar depois de montada.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fmtDataHora(s) {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  if (isNaN(d)) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function parseLista(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
}
const emissao = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
// Texto puro (sem HTML) de um campo de POP — usado no modo completo, que
// mostra o conteúdo inteiro de cada POP dentro do PDF da trilha.
function textoSimples(html) {
  return String(html || '').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
}
function secaoCompleta(titulo, conteudo) {
  const texto = textoSimples(conteudo);
  if (!texto) return '';
  return `<div class="pop-secao"><b>${esc(titulo)}:</b><div class="pop-secao-corpo">${texto.split('\n').map(l => esc(l.trim())).filter(Boolean).map(l => `<p>${l}</p>`).join('')}</div></div>`;
}

function montarHtmlTrilha(dados, completo = false) {
  const modulos = dados.modulos?.length ? dados.modulos : [{ nome: null, pops: dados.popsSemModulo || dados.pops || [] }];

  const blocosModulo = modulos.map((m, mi) => {
    const linhasPop = (m.pops || []).map((p, pi) => {
      const topicos = parseLista(p.topicos);
      return `
        <div class="pop-item">
          <div class="pop-item-topo">
            <span class="pop-num">${mi + 1}.${pi + 1}</span>
            <span class="pop-titulo">${esc(p.codigo ? `[${p.codigo}] ` : '')}${esc(p.titulo)}</span>
            <span class="pop-status ${p.concluido ? 'ok' : ''}">${p.concluido ? 'Concluído' : 'Pendente'}</span>
          </div>
          <div class="pop-meta">
            ${!p.pop_id ? `<span><b>Sem POP</b> — tópico só em texto</span>` : ''}
            ${p.instrutor_nome ? `<span><b>Instrutor:</b> ${esc(p.instrutor_nome)}</span>` : ''}
            ${p.data_prevista ? `<span><b>Previsto:</b> ${fmtDataHora(p.data_prevista)}</span>` : ''}
            ${p.tempo_realizado ? `<span><b>Tempo realizado:</b> ${p.tempo_realizado} min</span>` : ''}
          </div>
          ${p.descricao ? `<p class="pop-descricao">${esc(p.descricao)}</p>` : ''}
          ${topicos.length ? `<ul class="checklist">${topicos.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
          ${completo ? `<div class="pop-completo">
            ${secaoCompleta('Objetivo', p.objetivo)}
            ${secaoCompleta('Campo de Aplicação', p.campo_aplicacao)}
            ${secaoCompleta('Procedimento Detalhado', p.procedimento)}
            ${secaoCompleta('Documentos e Ferramentas', p.documentos)}
            ${secaoCompleta('Segurança e Conduta', p.seguranca)}
            ${secaoCompleta('Penalidades', p.penalidade)}
          </div>` : ''}
        </div>`;
    }).join('');
    return `
      <div class="modulo">
        ${m.nome ? `<div class="modulo-header">
          <span class="modulo-nome">Módulo ${mi + 1} — ${esc(m.nome)}</span>
          ${m.colaborador_nome ? `<span class="modulo-colab">Responsável: ${esc(m.colaborador_nome)}</span>` : ''}
        </div>` : ''}
        ${linhasPop || '<p class="vazio">Nenhum sub-módulo cadastrado.</p>'}
      </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:11px}
    .cabecalho{background:#7B55F1;color:#fff;padding:18px 22px;margin-bottom:16px}
    .cabecalho h1{font-size:19px;margin-bottom:4px}
    .cabecalho .sub{font-size:11px;opacity:.9}
    .info{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:11px}
    .info b{color:#0b2b6b}
    .modulo{margin-bottom:18px;page-break-inside:avoid}
    .modulo-header{background:#eef2ff;border-radius:6px;padding:7px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
    .modulo-nome{font-weight:800;color:#0b2b6b;font-size:12.5px}
    .modulo-colab{font-size:10.5px;color:#64748b}
    .pop-item{border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;margin-bottom:8px;margin-left:8px}
    .pop-item-topo{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .pop-num{background:#7B55F1;color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}
    .pop-titulo{font-weight:700;flex:1}
    .pop-status{font-size:9.5px;font-weight:700;padding:2px 8px;border-radius:10px;background:#f1f5f9;color:#64748b}
    .pop-status.ok{background:#dcfce7;color:#166534}
    .pop-meta{display:flex;gap:16px;font-size:10px;color:#475569;margin-bottom:4px}
    .pop-descricao{font-size:10.5px;color:#334155;line-height:1.5;margin:4px 0}
    .checklist{margin:4px 0 0 34px;font-size:10.5px;color:#334155}
    .checklist li{margin-bottom:2px}
    .vazio{color:#94a3b8;font-style:italic;margin-left:8px}
    .pop-completo{margin-top:8px;padding-top:8px;border-top:1px dashed #e2e8f0}
    .pop-secao{margin-bottom:6px}
    .pop-secao b{color:#0b2b6b;font-size:10px}
    .pop-secao-corpo p{font-size:10px;color:#334155;line-height:1.5;margin:2px 0}
    .rodape{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:8px;font-size:9px;color:#94a3b8;text-align:center}
  </style></head><body>
    <div class="cabecalho">
      <h1>🎓 ${esc(dados.titulo)}</h1>
      <div class="sub">Trilha de treinamento ${completo ? '· Versão completa (com o conteúdo de cada POP)' : '· Resumo (módulos e checklists)'} · Emitido em ${emissao()}</div>
    </div>
    <div class="info">
      <div><b>Colaborador (treinando):</b> ${esc(dados.colaborador_nome) || '—'}</div>
      <div><b>Responsável pelo treinamento:</b> ${esc(dados.responsavel_nome) || '—'}</div>
      <div><b>Departamento:</b> ${esc(dados.departamento_nome) || '—'}</div>
      <div><b>Data e hora de início:</b> ${fmtDataHora(dados.data_hora)}</div>
      <div><b>Modo de repasse:</b> ${dados.modo_repasse === 'dividido' ? 'Dividido por módulo (uma pessoa por módulo)' : 'Uma pessoa treina a trilha toda'}</div>
      <div><b>Progresso:</b> ${dados.pops_concluidos ?? 0}/${dados.total_pops ?? 0} sub-módulos concluídos</div>
    </div>
    ${blocosModulo}
    <div class="rodape">Kronos — Trilha de treinamento — Gerado em ${emissao()}</div>
  </body></html>`;
}

async function gerarPDFTrilha(dados, completo = false) {
  return htmlParaPdf(montarHtmlTrilha(dados, completo));
}

module.exports = { gerarPDFTrilha, montarHtmlTrilha };
