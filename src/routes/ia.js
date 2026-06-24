const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada no .env');
  return new Anthropic({ apiKey: key });
}

const CAMPOS_DESC = {
  objetivo: 'Objetivo do POP (o que este procedimento visa alcançar)',
  escopo: 'Escopo de aplicação (onde e a quem se aplica)',
  responsabilidades: 'Responsabilidades (quem executa, quem aprova, quem supervisiona)',
  materiais_equipamentos: 'Materiais e equipamentos necessários',
  descricao: 'Descrição detalhada do procedimento (passo a passo)',
  referencias: 'Referências normativas ou documentos relacionados',
  disposicao_final: 'Disposição final e registros gerados',
  riscos_medidas: 'Riscos identificados e medidas de controle',
  historico_revisoes: 'Histórico de revisões',
};

// POST /ia/gerar — gera conteúdo para um campo do POP
// ── Sistema de instrução especialista em Gestão de Qualidade ────────────────
const SYSTEM_POP = `Você é um especialista em Gestão de Qualidade e Processos com ampla experiência em ISO 9001 e ABNT.
Sua tarefa é gerar conteúdo profissional para Procedimentos Operacionais Padrão (POP).

REGRAS DE OURO (nunca viole):
- Sempre use verbos no imperativo (Faça, Verifique, Confirme, Execute, Registre)
- Linguagem técnica e acessível — o colaborador que executa deve entender sem dúvidas
- Seja direto e objetivo — sem introduções, sem "claro que", sem rodeios
- Português brasileiro formal e correto

ESTRUTURAS OBRIGATÓRIAS POR TIPO:

[SIPOC - Mapeamento de Processo]
- Foco: Visão macro e fluxo de valor do processo
- Identifique: Fornecedores (S), Entradas (I), Macroetapas (P), Saídas (O), Clientes (C)
- Macroetapas (P): de 5 a 7 grandes atividades que formam o fluxo principal
- Indicadores: como medir o sucesso de cada etapa do fluxo

[FLUXOGRAMA - Decisão]
- Foco: Lógica de decisão e caminhos alternativos
- Gatilho: evento que inicia o fluxo
- Blocos de Ação: tarefas executadas em sequência
- Pontos de Decisão: perguntas Sim/Não que mudam o caminho
- Conectores: para onde o fluxo vai após cada decisão
- Fim/Resultado: os diferentes desfechos possíveis

[CHECKLIST - Conferência e Auditoria]
- Foco: Inspeção e verificação sistemática
- Dados da Inspeção: Data, Local, Inspetor
- Itens de Verificação: perguntas ou pontos a observar
- Status de Conformidade: [ ] Conforme  [ ] Não Conforme  [ ] N/A
- Critério de Aceite: o que define se o item está "OK"
- Ações Corretivas Imediatas: o que fazer ao encontrar não conformidade

[HIERARQUIA - Detalhamento Técnico]
- Foco: Rigor técnico com subetapas detalhadas
- Macroetapa: título da fase principal (1. Macroetapa A)
- Subetapas (1.1, 1.2): detalhamento do "como fazer" com precisão técnica
- Notas Técnicas: avisos de precisão ou segurança específicos por etapa
- Referências: manuais ou normas (ISO, ABNT) que baseiam a instrução
- Ações Corretivas: o que fazer se o padrão não for atingido

RODAPÉ (sempre ao final do procedimento gerado):
Elaborado por: _________________ | Cargo: _________________
Revisado por:  _________________ | Cargo: _________________
Aprovado por:  _________________ | Cargo: _________________`;

// Templates de estrutura por tipo (usados como guia no prompt)
const TEMPLATES = {
  pop: `
ESTRUTURA A SEGUIR (POP — Procedimento Operacional Padrão):
Objetivo: [O que é feito e por que é feito]
Responsabilidades: [Quem executa e quem aprova]
Passo a Passo:
  1. [Ação imperativa — seja específico]
  2. [Próximo passo]
  ...
Ferramentas / Sistemas: [sistemas, softwares ou insumos necessários]
Resultados Esperados: [métricas ou indicadores de qualidade — ex: tempo de entrega, padrão do produto final]
Ações Corretivas: [o que fazer se o resultado não for atingido]`,

  sipoc: `
ESTRUTURA A SEGUIR (SIPOC — Mapeamento do Processo):
Dono do Processo: [Gestor responsável pelo processo]
S — Fornecedores: [quem entrega as entradas — liste de 2 a 5]
I — Entradas: [o que inicia o trabalho — liste de 2 a 5]
P — Macroetapas (5 a 7 grandes atividades):
  1. [Macroetapa A]
  2. [Macroetapa B]
  ...
O — Saídas: [produto ou serviço final gerado]
C — Clientes: [quem recebe o resultado]
Indicadores: [como medir o sucesso de cada etapa]`,

  fluxograma: `
ESTRUTURA A SEGUIR (Fluxograma — Lógica de Decisão):
GATILHO/INÍCIO: [evento que dispara o fluxo]
→ AÇÃO: [Bloco de ação 1]
→ DECISÃO: [Condição?]
  SE SIM → [próxima ação ou resultado]
  SE NÃO → [ação corretiva ou desvio]
→ AÇÃO: [Bloco de ação 2]
→ DECISÃO: [Outra condição?]
  SE SIM → [continua]
  SE NÃO → [desvio ou encerramento alternativo]
→ FIM/RESULTADO: [desfecho possível 1]
→ FIM/RESULTADO: [desfecho possível 2 — se houver]`,

  checklist: `
ESTRUTURA A SEGUIR (Checklist — Conferência e Auditoria):
Dados da Inspeção: Data: ___/___/___  Local: ___________  Inspetor: ___________

ITENS DE VERIFICAÇÃO:
[ ] Conforme  [ ] Não Conforme  [ ] N/A  |  Item 1: [descrição do ponto a verificar]
[ ] Conforme  [ ] Não Conforme  [ ] N/A  |  Item 2: [descrição]
...

Critério de Aceite: [o que define se o item está "OK"]
Ações Corretivas Imediatas: [o que fazer ao encontrar não conformidade]
Visto do Inspetor: _________________`,

  hierarquia: `
ESTRUTURA A SEGUIR (Hierarquia — Detalhamento Técnico):
1. Macroetapa A
  1.1 Subetapa — Como fazer com precisão técnica
  1.2 Subetapa — Critério de aceitação ou nota de segurança
  ⚠️ Nota Técnica: [aviso de precisão ou risco específico]
2. Macroetapa B
  2.1 Subetapa técnica
  2.2 Subetapa
Ações Corretivas: [o que fazer se o padrão não for atingido]
Referências: [normas ISO/ABNT, manuais que baseiam a instrução]`,

  // aliases retrocompatíveis
  hierarquico: `
ESTRUTURA A SEGUIR (Hierarquia — Detalhamento Técnico):
1. Macroetapa A
  1.1 Subetapa técnica — como fazer e por quê
  1.2 Critério de aceitação ou nota de segurança
2. Macroetapa B
  2.1 Subetapa técnica
Ações Corretivas: [o que fazer se o padrão não for atingido]
Referências: [normas ISO/ABNT aplicáveis]`,

  padrao: `
ESTRUTURA A SEGUIR (Hierárquico Completo):
Objetivo e Escopo
Responsabilidades
Procedimento com macroetapas e subetapas numeradas
Ações Corretivas
Referências`,
};

function descFormato(tipo_pop) {
  const formatos = {
    pop:         'POP — objetivo, responsabilidades, passo a passo numerado, ferramentas/sistemas e resultados esperados',
    sipoc:       'SIPOC — mapeamento macro: Fornecedores → Entradas → Macroetapas → Saídas → Clientes',
    fluxograma:  'FLUXOGRAMA — gatilho, blocos de ação, pontos de decisão Sim/Não, conectores, fim/resultado',
    checklist:   'CHECKLIST — dados de inspeção, itens com [ ] Conforme [ ] Não Conforme [ ] N/A, critério de aceite',
    hierarquia:  'HIERARQUIA — macroetapas com subetapas (1, 1.1, 1.2), notas técnicas e referências normativas',
    hierarquico: 'HIERARQUIA — macroetapas com subetapas (1, 1.1, 1.2) e notas técnicas',
    padrao:      'PADRÃO — hierárquico completo com todas as seções',
  };
  return formatos[tipo_pop] || formatos.pop;
}

function gerarConteudoTemplate(campo, titulo, tipo_pop, departamento) {
  const t = titulo || 'este procedimento';
  const dep = departamento ? ` no ${departamento}` : '';

  const templates = {
    objetivo: {
      pop:        `Padronizar e orientar a execução de ${t}, garantindo que as etapas sejam realizadas de forma correta, segura e consistente por todos os colaboradores envolvidos${dep}.`,
      sipoc:      `Mapear o processo de ${t}, identificando fornecedores, entradas, macroetapas, saídas e clientes, para garantir visibilidade e controle do fluxo de valor.`,
      fluxograma: `Descrever a lógica de decisão e o fluxo de atividades de ${t}, permitindo identificar pontos de controle, aprovações e caminhos alternativos.`,
      checklist:  `Verificar sistematicamente a conformidade das etapas de ${t}, assegurando que todos os requisitos obrigatórios sejam atendidos antes da conclusão.`,
      hierarquia: `Detalhar tecnicamente o passo a passo de ${t}, com macroetapas e subetapas numeradas, garantindo rastreabilidade e conformidade com as normas aplicáveis.`,
    },
    campo_aplicacao: {
      _: `Este procedimento aplica-se a todos os colaboradores${dep} responsáveis pela execução de ${t}. Inclui também gestores, supervisores e demais envolvidos no processo.`,
    },
    procedimento: {
      pop: `1. Acesse o sistema ou área designada para iniciar o processo.\n2. Verifique se todos os recursos necessários estão disponíveis.\n3. Execute a atividade conforme orientações específicas de ${t}.\n4. Registre as informações no sistema ou formulário adequado.\n5. Confirme a conclusão com o responsável direto.\n6. Arquive a documentação gerada.`,
      fluxograma: `GATILHO: Solicitação ou evento que inicia ${t}\n\n→ AÇÃO: Receber e validar a demanda\n→ DECISÃO: A demanda está completa?\n  SE SIM → Prosseguir para execução\n  SE NÃO → Solicitar informações faltantes ao solicitante\n→ AÇÃO: Executar ${t}\n→ DECISÃO: O resultado está dentro do padrão?\n  SE SIM → Registrar e finalizar\n  SE NÃO → Acionar responsável para revisão\n→ FIM: Conclusão com registro no sistema`,
      checklist: `[ ] Conforme  [ ] Não Conforme  [ ] N/A  | Verificar se todos os documentos necessários estão presentes\n[ ] Conforme  [ ] Não Conforme  [ ] N/A  | Confirmar que os responsáveis estão cientes do processo\n[ ] Conforme  [ ] Não Conforme  [ ] N/A  | Validar que o ambiente/sistema está pronto para execução\n[ ] Conforme  [ ] Não Conforme  [ ] N/A  | Executar as etapas na ordem correta\n[ ] Conforme  [ ] Não Conforme  [ ] N/A  | Registrar o resultado no sistema`,
      hierarquia: `1. PREPARAÇÃO\n   1.1. Verifique a disponibilidade de todos os recursos necessários.\n   1.2. Confirme que o ambiente está pronto para execução.\n   1.3. Notifique os envolvidos sobre o início do processo.\n\n2. EXECUÇÃO\n   2.1. Inicie ${t} conforme cronograma ou demanda.\n   2.2. Siga as subetapas específicas desta atividade.\n   2.3. Monitore os resultados durante a execução.\n\n3. ENCERRAMENTO\n   3.1. Confirme que todos os requisitos foram atendidos.\n   3.2. Registre o resultado no sistema.\n   3.3. Comunique a conclusão ao responsável.`,
      sipoc: `1. Receber e validar entradas do fornecedor\n2. Planejar e distribuir as tarefas\n3. Executar o processo principal\n4. Verificar qualidade e conformidade\n5. Entregar saída ao cliente`,
      _: `1. Inicie o processo verificando os pré-requisitos necessários.\n2. Execute as atividades de ${t} conforme este POP.\n3. Registre as informações no sistema adequado.\n4. Confirme a conclusão com o responsável.\n5. Arquive a documentação gerada.`,
    },
    documentos: {
      _: `• Manual de procedimentos internos\n• Formulário de registro de atividades\n• Política da empresa (versão vigente)\n• Normas e regulamentos aplicáveis ao processo\n• Evidências e registros gerados por este procedimento`,
    },
    kpis: {
      _: `• Tempo médio de execução: ≤ [X] minutos/horas\n• Taxa de conformidade: ≥ 95%\n• Índice de retrabalho: ≤ 5%\n• Satisfação dos envolvidos: ≥ 4/5\n• Número de não conformidades por período: 0`,
    },
    seguranca: {
      _: `• Certifique-se de que apenas colaboradores autorizados executem este procedimento.\n• Mantenha os sistemas e acessos protegidos durante a execução.\n• Em caso de erro ou inconsistência, interrompa o processo e acione o responsável.\n• Não compartilhe informações sensíveis fora dos canais autorizados.\n• Registre qualquer ocorrência fora do padrão no sistema de não conformidades.`,
    },
    penalidade: {
      _: `1ª ocorrência: Orientação verbal e registro em prontuário.\n2ª ocorrência: Advertência formal por escrito.\n3ª ocorrência: Suspensão temporária de acesso à função.\n4ª ocorrência ou caso grave: Medidas disciplinares conforme Regulamento Interno e legislação trabalhista vigente.\n\nObservação: Situações que causem prejuízo material ou comprometam a segurança podem resultar em medidas imediatas, independente do histórico.`,
    },
    responsabilidades: {
      _: `• Executor: Realiza as atividades conforme este POP.\n• Supervisor: Monitora a execução e valida os resultados.\n• Gestor: Aprova alterações e garante os recursos necessários.\n• Qualidade: Audita a conformidade com este procedimento.`,
    },
  };

  const mapa = templates[campo];
  if (!mapa) return `Preencha o conteúdo de "${campo}" para ${t}.`;
  return (mapa[tipo_pop] || mapa._) || (mapa._ || Object.values(mapa)[0]);
}

router.post('/gerar', (req, res) => {
  const { campo, titulo, departamento, tipo_pop } = req.body;
  if (!campo || !titulo) return res.status(400).json({ erro: 'campo e titulo são obrigatórios' });
  const conteudo = gerarConteudoTemplate(campo, titulo, tipo_pop, departamento);
  res.json({ conteudo });
});

// POST /ia/melhorar — formata e padroniza texto existente
router.post('/melhorar', (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ erro: 'texto é obrigatório' });

  let conteudo = texto.trim();

  // Capitaliza início de frases
  conteudo = conteudo.replace(/(^|[.!?]\s+)([a-záéíóúàâêôãõüç])/g, (m, p1, p2) => p1 + p2.toUpperCase());

  // Garante que listas numeradas tenham ponto após número
  conteudo = conteudo.replace(/^(\d+)[\)]\s/gm, '$1. ');

  // Remove espaços duplos
  conteudo = conteudo.replace(/  +/g, ' ');

  // Capitaliza primeira letra do texto
  conteudo = conteudo.charAt(0).toUpperCase() + conteudo.slice(1);

  res.json({ conteudo });
});

// POST /ia/checklist — gera itens do checklist a partir do procedimento
router.post('/checklist', (req, res) => {
  const { titulo, procedimento } = req.body;
  if (!titulo) return res.status(400).json({ erro: 'titulo é obrigatório' });

  let itens = [];

  // Tenta extrair passos do procedimento
  if (procedimento) {
    const texto = procedimento.replace(/<[^>]*>/g, '\n');
    const linhas = texto.split(/\n/).map(l => l.trim()).filter(l => l.length > 8);
    itens = linhas.slice(0, 12).map((l, i) => ({
      id: Date.now() + i,
      texto: l.replace(/^[\d\.\)\-\•\*]\s*/, '').substring(0, 120),
      obrigatorio: i < 5,
    }));
  }

  // Fallback: itens genéricos baseados no título
  if (itens.length < 4) {
    itens = [
      { id: Date.now()+1, texto: `Verificar se todos os pré-requisitos para ${titulo} estão atendidos`, obrigatorio: true },
      { id: Date.now()+2, texto: 'Confirmar que os responsáveis estão cientes e disponíveis', obrigatorio: true },
      { id: Date.now()+3, texto: 'Assegurar que os sistemas e ferramentas necessárias estão funcionando', obrigatorio: true },
      { id: Date.now()+4, texto: 'Executar as etapas na ordem correta conforme o procedimento', obrigatorio: true },
      { id: Date.now()+5, texto: 'Registrar o resultado e qualquer ocorrência observada', obrigatorio: true },
      { id: Date.now()+6, texto: 'Confirmar conclusão com o supervisor ou responsável', obrigatorio: false },
      { id: Date.now()+7, texto: 'Arquivar a documentação gerada no local adequado', obrigatorio: false },
    ];
  }

  res.json({ itens });
});

// POST /ia/fluxograma — gera etapas do fluxograma a partir do procedimento
router.post('/fluxograma', (req, res) => {
  const { titulo, procedimento } = req.body;
  if (!titulo) return res.status(400).json({ erro: 'titulo é obrigatório' });

  const etapas = [{ id: Date.now(), tipo: 'inicio', texto: titulo.substring(0, 60), sim: '', nao: '' }];

  if (procedimento) {
    const texto = procedimento.replace(/<[^>]*>/g, '\n');
    const linhas = texto.split(/\n/).map(l => l.trim().replace(/^[\d\.\)\-\•\*]\s*/, '')).filter(l => l.length > 5);
    linhas.slice(0, 8).forEach((l, i) => {
      const ehDecisao = /\?$|confirme|verifique|confere|aprovar|aprovar|autorizado|válido/i.test(l);
      etapas.push({
        id: Date.now() + i + 1,
        tipo: ehDecisao ? 'decisao' : 'acao',
        texto: l.substring(0, 80),
        sim: ehDecisao ? 'Prosseguir' : '',
        nao: ehDecisao ? 'Corrigir e repetir' : '',
      });
    });
  } else {
    etapas.push(
      { id: Date.now()+1, tipo: 'acao',    texto: 'Receber solicitação ou demanda', sim: '', nao: '' },
      { id: Date.now()+2, tipo: 'decisao', texto: 'Demanda está completa?', sim: 'Prosseguir', nao: 'Solicitar informações' },
      { id: Date.now()+3, tipo: 'acao',    texto: `Executar ${titulo.substring(0, 50)}`, sim: '', nao: '' },
      { id: Date.now()+4, tipo: 'decisao', texto: 'Resultado está conforme?', sim: 'Registrar e finalizar', nao: 'Revisar e corrigir' },
      { id: Date.now()+5, tipo: 'acao',    texto: 'Registrar no sistema', sim: '', nao: '' },
    );
  }

  etapas.push({ id: Date.now()+99, tipo: 'fim', texto: 'Fim do processo', sim: '', nao: '' });
  res.json({ etapas });
});

// POST /ia/documento-para-fluxograma — extrai passos do documento e gera Mermaid
router.post('/documento-para-fluxograma', (req, res) => {
  const { texto, titulo } = req.body;
  if (!texto?.trim()) return res.status(400).json({ erro: 'texto é obrigatório' });

  const nomeProcesso = (titulo || 'Processo').substring(0, 50).replace(/"/g, "'");
  const linhas = texto
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 8 && l.length < 200);

  // Extrai etapas: linhas numeradas ou com marcador
  const etapas = linhas.filter(l => /^(\d+[\.\)]\s|[-•*]\s)/.test(l))
    .map(l => l.replace(/^[\d\.\)\-\•\*]\s*/, '').trim())
    .filter(l => l.length > 5)
    .slice(0, 20);

  // Se não há linhas numeradas, pega frases longas que parecem passos
  if (etapas.length < 3) {
    linhas.filter(l => l.length > 30 && /[Vv]erificar|[Ee]xecutar|[Cc]onfirmar|[Rr]ealizar|[Ee]nviar|[Rr]egistrar|[Aa]cessar|[Ss]elecionar|[Aa]provar|[Cc]oncluir/.test(l))
      .slice(0, 10).forEach(l => etapas.push(l.substring(0, 80)));
  }

  const letras = 'BCDEFGHIJKLMNOPQRSTUVWXY';
  const linhasMermaid = [`graph TD`, `  A([▶ Início — ${nomeProcesso}])`];

  if (etapas.length === 0) {
    linhasMermaid.push(`  A --> Z([■ Fim])`);
  } else {
    etapas.forEach((etapa, i) => {
      const id = letras[i] || `N${i}`;
      const proximo = i < etapas.length - 1 ? (letras[i + 1] || `N${i+1}`) : 'Z';
      const prev = i === 0 ? 'A' : (letras[i - 1] || `N${i-1}`);
      const texto50 = etapa.substring(0, 60).replace(/"/g, "'");
      const ehDecisao = /\?$|confirme|verific|aprovar|autorizado|válido|confere/i.test(etapa);

      if (ehDecisao) {
        linhasMermaid.push(`  ${id}{${texto50}?}`);
        linhasMermaid.push(`  ${prev} --> ${id}`);
        linhasMermaid.push(`  ${id} -->|Sim| ${proximo}`);
        linhasMermaid.push(`  ${id} -->|Não| ${id}R[Corrigir e reprocessar]`);
        linhasMermaid.push(`  ${id}R --> ${id}`);
      } else {
        linhasMermaid.push(`  ${id}[${texto50}]`);
        linhasMermaid.push(`  ${prev} --> ${id}`);
      }
    });
    const ultimo = letras[etapas.length - 1] || `N${etapas.length - 1}`;
    linhasMermaid.push(`  ${ultimo} --> Z`);
    linhasMermaid.push(`  Z([■ Fim])`);
  }

  res.json({ mermaid: linhasMermaid.join('\n') });
});

// POST /ia/extrair-documento — extrai texto do PDF/TXT/Excel e preenche todos os campos do POP via IA
const multer    = require('multer');
const fs        = require('fs');
const PDFParser = require('pdf2json');
const XLSX      = require('xlsx');
const uploadTemp = multer({ dest: require('os').tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });

function extrairTextoExcel(buffer) {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const linhas = [];
    for (const nomePlanilha of wb.SheetNames) {
      const sheet = wb.Sheets[nomePlanilha];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) linhas.push(`=== Planilha: ${nomePlanilha} ===\n${csv}`);
    }
    return linhas.join('\n\n');
  } catch { return ''; }
}

function extrairTextoPDF(buffer) {
  return new Promise((resolve, reject) => {
    let done = false;
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataReady', () => {
      if (done) return; done = true;
      try { resolve(parser.getRawTextContent() || ''); } catch { resolve(''); }
    });
    parser.on('pdfParser_dataError', err => {
      if (done) return; done = true;
      reject(err?.parserError ? new Error(String(err.parserError)) : (err instanceof Error ? err : new Error(String(err))));
    });
    try {
      const result = parser.parseBuffer(buffer);
      // pdf2json v4 returns a Promise from parseBuffer
      if (result && typeof result.then === 'function') {
        result.then(() => {
          if (!done) { done = true; try { resolve(parser.getRawTextContent() || ''); } catch { resolve(''); } }
        }).catch(err => { if (!done) { done = true; reject(err); } });
      }
    } catch (e) { if (!done) { done = true; reject(e); } }
  });
}

// Extração via IA — análise semântica completa para estruturar o POP
async function extrairComIA(texto, nomeArquivo) {
  const client = getClient();
  // Usa até 8000 caracteres para ter contexto suficiente
  const textoTruncado = texto.substring(0, 8000);

  const prompt = `Você é um especialista sênior em Gestão de Processos e Qualidade, com vasta experiência em estruturar POPs (Procedimentos Operacionais Padrão) para empresas de telecomunicações e serviços.

Analise o documento abaixo com profundidade semântica. Mesmo que o documento não esteja estruturado como POP, interprete o conteúdo operacional e extraia ou infira inteligentemente cada seção.

DOCUMENTO:
---
${textoTruncado}
---

INSTRUÇÕES DE ANÁLISE SEMÂNTICA:

1. **titulo**: Identifique o título principal. Se não explícito, crie um título descritivo baseado no processo.

2. **descricao**: Resuma em 1-2 frases o que este procedimento realiza.

3. **departamento_nome**: Identifique o setor responsável. Analise sistemas citados (ex: HubSoft → Comercial/Atendimento), funções citadas (ex: técnico → Técnico/Operações) e contexto geral.

4. **objetivo**: Identifique ou INFIRA o objetivo. Responda: "O que este processo visa garantir ou alcançar?" Pode ser implícito no texto.

5. **campo_aplicacao**: Identifique onde e para quem se aplica. Analise o contexto operacional (ex: instalação → campo técnico, atendimento → central de vendas).

6. **procedimento**: Preserve os passos em HTML <ol><li>. Se não houver numeração, organize os passos em sequência lógica operacional. Cada etapa deve ser uma instrução clara e acionável.

7. **documentos**: Identifique TODOS os sistemas, ferramentas, aplicativos e documentos mencionados ou implícitos. Exemplos: HubSoft, Zabbix, Excel, WhatsApp, planilhas, formulários, contratos.

8. **seguranca**: Identifique riscos operacionais, cuidados, requisitos de acesso, validações obrigatórias, pontos de atenção. Se não explícito, infira baseado no tipo de processo (financeiro → conferência de dados; técnico → segurança de campo; atendimento → verificação de identidade).

9. **penalidade**: Identifique ou infira consequências de não cumprimento. Pode incluir impacto no cliente, retrabalho, perdas financeiras ou sanções internas.

10. **responsabilidade**: Array de objetos com quem executa cada parte. Analise pronomes, verbos (quem faz o quê) e contexto para identificar os responsáveis mesmo que não listados explicitamente.

11. **disposicao_final**: Array com destinação de documentos, encerramento do processo, arquivamento, próximos passos após conclusão.

12. **checklist**: Gere 6-10 itens de verificação PRÁTICOS e ESPECÍFICOS para este processo. Não genéricos — devem ser verificações reais do procedimento descrito.

Retorne APENAS um JSON válido com esta estrutura exata:
{
  "titulo": "string",
  "descricao": "string",
  "departamento_nome": "string",
  "versao": "1.0",
  "objetivo": "string com 2-4 frases descrevendo o objetivo operacional",
  "campo_aplicacao": "string descrevendo onde e para quem se aplica",
  "procedimento": "HTML com <ol><li> para cada etapa operacional",
  "documentos": "string listando sistemas, ferramentas e documentos identificados",
  "kpis": "",
  "seguranca": "string com cuidados, riscos e pontos de atenção",
  "penalidade": "string com consequências do não cumprimento",
  "responsabilidade": [{"cargo_nome": "string", "responsabilidade": "string"}],
  "disposicao_final": [{"item": "string", "destino": "string", "responsavel": "string"}],
  "checklist": [{"texto": "string com verificação específica e prática", "obrigatorio": true}]
}

Regras absolutas:
- NUNCA retorne campos vazios quando for possível inferir do contexto
- Use sempre Português brasileiro formal e objetivo
- Retorne APENAS o JSON, sem texto antes ou depois
- Se o documento for muito curto ou informal, ainda assim estruture o máximo possível`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const resposta = msg.content[0].text.trim();
  const jsonStr = resposta.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonStr) throw new Error('IA não retornou JSON válido');
  return JSON.parse(jsonStr);
}

// Extração inteligente sem IA — conhece a estrutura completa de um POP
function extrairSemIA(texto, nomeArquivo) {
  // Normaliza o texto: remove caracteres estranhos do pdf2json, preserva quebras de linha
  texto = texto
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')   // múltiplos espaços → 1 espaço
    .replace(/\n{4,}/g, '\n\n'); // mais de 3 quebras → 2

  const linhas = texto.split(/\n/).map(l => l.trim()).filter(Boolean);

  // ── MAPA COMPLETO DA ESTRUTURA DE UM POP ────────────────────────────────
  // Cada campo tem: títulos (como o documento pode chamar a seção),
  // palavrasChave (conteúdo típico desse campo para classificação automática)
  const MAPA_POP = [
    {
      campo: 'objetivo',
      titulos: ['objetivo','finalidade','prop[oó]sito','para que serve','meta do procedimento','1[\\s\\.\\)]\\s*objetivo'],
      palavrasChave: ['visa ','garantir','assegurar','estabelecer','definir','padronizar','orientar','tem como objetivo','tem por objetivo','busca '],
    },
    {
      campo: 'descricao',
      titulos: ['descri[çc][aã]o','resumo','sum[aá]rio','introdu[çc][aã]o','apresenta[çc][aã]o','contexto','sobre este','defini[çc][aã]o'],
      palavrasChave: ['este documento','este procedimento','este pop','trata-se','refere-se','consiste em','é um processo'],
    },
    {
      campo: 'campo_aplicacao',
      titulos: ['campo de aplica','escopo','aplica[çc][aã]o','abrang[eê]ncia','[aá]mbito','a quem se aplica','[aá]rea de aplica'],
      palavrasChave: ['aplica-se a','todos os colaboradores','setor de','departamento de','equipe de','[aá]rea de','abrange'],
    },
    {
      campo: 'responsabilidade_txt',
      titulos: ['responsabilidade','respons[aá]vel','atribui[çc][õo]es','compet[eê]ncia','quem executa','executor','fun[çc][õo]es'],
      palavrasChave: ['respons[aá]vel por','compete ao','cabe ao','incumbe ao','gestor','supervisor','l[ií]der','coordenador','analista'],
    },
    {
      campo: 'procedimento',
      titulos: ['procedimento','passo a passo','execu[çc][aã]o','atividades','etapas','como fazer','desenvolvimento','instru[çc][õo]es','m[eé]todo','fluxo','roteiro'],
      palavrasChave: ['primeiro passo','passo 1','etapa 1','iniciar','acessar o sistema','abrir','clicar','selecionar','preencher','confirmar','finalizar','concluir'],
    },
    {
      campo: 'documentos',
      titulos: ['documentos','refer[eê]ncias','normas','legisla[çc][aã]o','base legal','documentos relacionados','fontes','anexos'],
      palavrasChave: ['nbr ','iso ','lei n[º°]','decreto','resolu[çc][aã]o','portaria','norma ','instrução normativa','formulário','manual'],
    },
    {
      campo: 'kpis',
      titulos: ['kpi','indicador','meta','desempenho','m[eé]trica','indicadores de desempenho','controle','monitoramento'],
      palavrasChave: ['%','meta de','prazo de','quantidade de','n[uú]mero de','taxa de','[ií]ndice de','satisfa[çc][aã]o','tempo m[eé]dio'],
    },
    {
      campo: 'seguranca',
      titulos: ['seguran[çc]a','risco','epi','equipamento de prote','perigo','cuidado','preven[çc][aã]o','sa[uú]de','higiene'],
      palavrasChave: ['luvas','[oó]culos','capacete','colete','cinto','risco de','cuidado com','aten[çc][aã]o','proibido','n[aã]o operar'],
    },
    {
      campo: 'penalidade',
      titulos: ['penalidade','san[çc][aã]o','consequ[eê]ncia','n[aã]o conformidade','puni[çc][aã]o','advert[eê]ncia','descumprimento','viola[çc][aã]o'],
      palavrasChave: ['advert[eê]ncia','suspens[aã]o','demiss[aã]o','multa','desconto','ocorr[eê]ncia','medida disciplinar','responsabilizado'],
    },
    {
      campo: 'disposicao_final_txt',
      titulos: ['disposi[çc][aã]o final','registro','arquivo','guarda','armazenamento','destino dos documentos','descarte','controle de registros'],
      palavrasChave: ['arquivado','guardado em','descartado','manter por','conservar por','digitalizado','pasta','drive','sistema'],
    },
  ];

  const todosOsTitulos = MAPA_POP.flatMap(s => s.titulos);
  const delimitador = todosOsTitulos.join('|');

  // Extrai conteúdo de uma seção pelo título — para tudo no próximo título conhecido
  function extrairSecao(titulos) {
    for (const t of titulos) {
      const re = new RegExp(
        '(?:^|\\n)[ \\t]*(?:\\d+[\\s\\.\\)\\-]{0,3})?(?:' + t + ')[ \\t]*[:\\-]?[ \\t]*\\n?([\\s\\S]{5,3000}?)' +
        '(?=\\n[ \\t]*(?:\\d+[\\s\\.\\)\\-]{0,3})?(?:' + delimitador + ')[ \\t]*[:\\-]|$)',
        'i'
      );
      const m = texto.match(re);
      if (m) {
        const c = m[1].replace(/[ \t]+/g, ' ').trim();
        if (c.length > 8) return c;
      }
    }
    return '';
  }

  // Pontua quanto um bloco de texto se encaixa em um campo
  function pontuar(bloco, campo) {
    const b = bloco.toLowerCase();
    let pts = 0;
    for (const kw of campo.palavrasChave) {
      if (new RegExp(kw, 'i').test(b)) pts += 2;
    }
    // Bonus se o próprio título aparecer no bloco
    for (const t of campo.titulos) {
      if (new RegExp(t, 'i').test(b)) pts += 3;
    }
    return pts;
  }

  // ── 1. Metadados básicos ──────────────────────────────────────────────────
  // Palavras genéricas que NÃO são o título real (cabeçalhos de template)
  const linhasGenericas = /^(procedimento operacional|pop|pr[oó]cedimento|instru[çc][aã]o de trabalho|it[- ]?\d|pop[- ]?\d|pr[- ]?\d|lc fibra|vivo|empresa|manual|n[oó]rma|descri[çc][aã]o|elabora[çc][aã]o|emiss[aã]o|revis[aã]o|aprovado|folha \d|p[aá]g|page|\d{2}\/\d{2}\/\d{4})$/i;

  const titulo = linhas.find(l =>
    l.length > 8 && l.length < 120 &&
    !/^\d+[\.\)]\s/.test(l) &&
    !/^[-\•\*]\s/.test(l) &&
    !/^\d+$/.test(l) &&
    !/^(vers[aã]o|data|departamento|elaborad|aprovad|p[aá]gina|pg\.|cod[ií]go|status)/i.test(l) &&
    !linhasGenericas.test(l.trim())
  ) || nomeArquivo.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').replace(/^pop[\s-]?\d+[\s-]?/i, '').trim();

  const versaoMatch = texto.match(/vers[aã]o[\s:]*([0-9]+(?:\.[0-9]+)*)/i);
  const deptoMatch  = texto.match(/(?:departamento|[aá]rea|setor)[\s:]+([^\n]{3,60})/i);

  // ── 2. Detecta passos numerados → procedimento ───────────────────────────
  const passos = linhas.filter(l => /^(\d+[\.\)]\s{1,3}\S|\-\s\S|\•\s\S|\*\s\S)/.test(l));

  // ── 3. Primeira passagem: extração por títulos ───────────────────────────
  const resultado = {};
  for (const campo of MAPA_POP) {
    resultado[campo.campo] = extrairSecao(campo.titulos);
  }

  // Detecta se o documento é do tipo "só procedimento" (maioria das linhas são itens numerados)
  const percentualPassos = linhas.length > 0 ? passos.length / linhas.length : 0;
  const isSoProcedimento = percentualPassos > 0.3 || (passos.length >= 5 && !Object.values(resultado).some(v => v.length > 20));

  // Passos numerados → procedimento
  if (passos.length >= 2) {
    const html = '<ol>' + passos.map(p => `<li>${p.replace(/^[\d\.\)\-\•\*]\s*/, '')}</li>`).join('') + '</ol>';
    if (!resultado.procedimento || resultado.procedimento.length < 20) {
      resultado.procedimento = html;
    }
  }

  // Documento tipo "só procedimento": primeira linha é o título real, passos vão pro procedimento
  // Os parágrafos de texto corrido (não numerados) vão para objetivo/descricao/campo_aplicacao
  if (isSoProcedimento) {
    const textoCorrido = linhas
      .filter(l => !/^(\d+[\.\)]\s|\-\s|\•\s|\*\s)/.test(l) && l.length > 20)
      .join(' ');
    if (textoCorrido.length > 30 && !resultado.objetivo) {
      // Pega até 400 chars de texto corrido como descrição/objetivo
      resultado.descricao = textoCorrido.substring(0, 400);
      resultado.objetivo  = textoCorrido.substring(0, 300);
    }
  }

  // ── 4. Segunda passagem: blocos de texto → pontuar → encaixar ───────────
  const blocos = texto
    .split(/\n{2,}/)
    .map(b => b.replace(/[ \t]+/g, ' ').trim())
    .filter(b => b.length > 25);

  const blocosUsados = new Set();

  // Marca blocos já capturados pelos títulos
  blocos.forEach((b, i) => {
    for (const v of Object.values(resultado)) {
      if (v && v.length > 20 && b.includes(v.substring(0, 40))) blocosUsados.add(i);
    }
  });

  // Para cada campo ainda vazio, encontra o bloco com maior pontuação
  for (const campo of MAPA_POP) {
    if (resultado[campo.campo] && resultado[campo.campo].length > 10) continue;
    let melhor = 0, melhorBloco = '', melhorIdx = -1;
    blocos.forEach((b, i) => {
      if (blocosUsados.has(i)) return;
      const pts = pontuar(b, campo);
      if (pts > melhor) { melhor = pts; melhorBloco = b; melhorIdx = i; }
    });
    if (melhor > 0) {
      resultado[campo.campo] = melhorBloco;
      blocosUsados.add(melhorIdx);
    }
  }

  // ── 5. Terceira passagem: campos ainda vazios → blocos restantes em ordem ─
  // Limita cada bloco a 800 chars para não jogar o documento inteiro num campo
  const restantes = blocos
    .filter((_, i) => !blocosUsados.has(i))
    .filter(b => b.length > 30)
    .map(b => b.length > 800 ? b.substring(0, 800) + '...' : b);

  let ri = 0;
  for (const campo of ['descricao','objetivo','campo_aplicacao','seguranca','kpis','documentos','penalidade','disposicao_final_txt']) {
    if ((!resultado[campo] || resultado[campo].length < 10) && restantes[ri]) {
      resultado[campo] = restantes[ri++];
    }
  }

  // Procedimento: se ainda vazio e temos passos numerados no documento inteiro, usa eles
  if (!resultado.procedimento || resultado.procedimento.length < 10) {
    const todosPassos = linhas.filter(l => /^(\d+[\.\)]\s{1,3}\S)/.test(l));
    if (todosPassos.length >= 2) {
      resultado.procedimento = '<ol>' + todosPassos.map(p => `<li>${p.replace(/^[\d\.\)\-\•\*]\s*/, '')}</li>`).join('') + '</ol>';
    } else if (restantes[ri]) {
      resultado.procedimento = restantes[ri++];
    }
  }

  // ── 6. Formata procedimento como HTML com lista ordenada ─────────────────
  if (resultado.procedimento && !resultado.procedimento.includes('<')) {
    const itens = resultado.procedimento
      .split(/\n|(?<=\.)\s+(?=[A-Z0-9])/)
      .map(s => s.trim())
      .filter(s => s.length > 8);
    if (itens.length > 1) {
      resultado.procedimento = '<ol>' + itens.map(i => `<li>${i.replace(/^[\d\.\)\-\•\*]\s*/, '')}</li>`).join('') + '</ol>';
    }
  }

  // ── 7. Responsabilidades → formato de tabela ─────────────────────────────
  const respTexto = resultado.responsabilidade_txt || '';
  let responsabilidade = [];
  if (respTexto) {
    // Tenta detectar linhas no formato "Cargo: responsabilidade" ou "- Cargo - ação"
    const linhasResp = respTexto.split(/\n|;/).map(l => l.trim()).filter(l => l.length > 5);
    responsabilidade = linhasResp.slice(0, 8).map(l => {
      const partes = l.split(/[:–\-|]/).map(p => p.trim()).filter(Boolean);
      return {
        cargo_nome:       partes[0]?.substring(0, 80) || l.substring(0, 80),
        responsabilidade: partes[1]?.substring(0, 120) || '',
      };
    });
  }
  if (responsabilidade.length === 0) responsabilidade = [{ cargo_nome: '', responsabilidade: '' }];

  // ── 8. Disposição final → formato de tabela ──────────────────────────────
  const dispTexto = resultado.disposicao_final_txt || '';
  let disposicao_final = [];
  if (dispTexto) {
    const linhasDisp = dispTexto.split(/\n|;/).map(l => l.trim()).filter(l => l.length > 5);
    disposicao_final = linhasDisp.slice(0, 6).map(l => {
      const partes = l.split(/[:–\-|]/).map(p => p.trim()).filter(Boolean);
      return {
        item:        partes[0]?.substring(0, 80) || l.substring(0, 80),
        destino:     partes[1]?.substring(0, 80) || '',
        responsavel: partes[2]?.substring(0, 60) || '',
      };
    });
  }
  if (disposicao_final.length === 0) disposicao_final = [{ item: '', destino: '', responsavel: '' }];

  // ── 9. Checklist ─────────────────────────────────────────────────────────
  let checklist = [];
  if (passos.length >= 2) {
    checklist = passos.slice(0, 12).map(p => ({
      texto: p.replace(/^[\d\.\)\-\•\*]\s*/, '').substring(0, 120),
      obrigatorio: true,
    }));
  } else if (resultado.procedimento) {
    checklist = resultado.procedimento
      .replace(/<[^>]*>/g, '\n').split(/\n/)
      .map(s => s.trim()).filter(s => s.length > 10).slice(0, 10)
      .map(f => ({ texto: f.substring(0, 120), obrigatorio: true }));
  }

  const dados = {
    titulo,
    descricao:         resultado.descricao         || '',
    departamento_nome: deptoMatch ? deptoMatch[1].trim() : '',
    versao:            versaoMatch ? versaoMatch[1] : '1.0',
    objetivo:          resultado.objetivo          || '',
    campo_aplicacao:   resultado.campo_aplicacao   || '',
    procedimento:      resultado.procedimento      || '',
    documentos:        resultado.documentos        || '',
    kpis:              resultado.kpis              || '',
    seguranca:         resultado.seguranca         || '',
    penalidade:        resultado.penalidade        || '',
    responsabilidade,
    disposicao_final,
    checklist,
  };

  console.log('[extrair] preenchidos:', Object.entries(dados)
    .filter(([k,v]) => typeof v === 'string' ? v.length > 0 : (Array.isArray(v) && v.some(r => Object.values(r).some(x => x))))
    .map(([k]) => k).join(', '));

  return dados;
}

router.post('/extrair-documento', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      uploadTemp.single('arquivo')(req, res, err => err ? reject(err) : resolve());
    });
  } catch (err) {
    return res.status(400).json({ erro: 'Erro no upload: ' + err.message });
  }
  if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' });

  const filePath = req.file.path;
  const mime     = req.file.mimetype;
  const nome     = req.file.originalname;

  try {
    const buffer = fs.readFileSync(filePath);
    let texto = '';

    const EXCEL_MIMES = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream',
    ];
    const nomeExt = nome.toLowerCase();

    if (mime === 'application/pdf') {
      try { texto = await extrairTextoPDF(buffer); } catch (e) {
        return res.status(422).json({ erro: 'Não foi possível ler o PDF. Tente converter para TXT.' });
      }
    } else if (EXCEL_MIMES.includes(mime) || nomeExt.endsWith('.xlsx') || nomeExt.endsWith('.xls') || nomeExt.endsWith('.ods')) {
      texto = extrairTextoExcel(buffer);
      if (!texto) return res.status(422).json({ erro: 'Não foi possível ler a planilha. Verifique se o arquivo não está protegido.' });
    } else {
      texto = buffer.toString('utf-8');
    }

    if (!texto || texto.trim().length < 20)
      return res.status(422).json({ erro: 'O arquivo parece estar vazio ou protegido.' });

    // Retorna o texto bruto do arquivo direto no campo procedimento,
    // sem IA — preserva a estrutura original do documento.
    const nomeBase = nome.replace(/\.[^.]+$/, '');
    const dados = { titulo: nomeBase, procedimento: texto };

    res.json(dados);
  } catch (e) {
    console.error('Erro extrair-documento:', e.message);
    res.status(500).json({ erro: e.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
});

module.exports = router;
