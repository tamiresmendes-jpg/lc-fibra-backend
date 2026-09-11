// Cria a avaliação "TESTE AVALIATIVO — TRILHA CALL CENTER" como treinamento
// avulso (sem colaborador definido ainda — a usuária escolhe o destino depois
// em Avaliações), com 17 sub-avaliações (uma objetiva + uma prática por
// PARTE do documento, exceto a Parte 9 que é só prática) somando 100 pontos.
require('dotenv').config();
const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const unica = (texto, opcoes, corretaIdx, pontos) => ({
  texto, midia: null, opcoes, resposta_correta: opcoes[corretaIdx], pontos,
});
const aberta = (texto, pontos, criterio) => ({
  texto, midia: null, pontos, ...(criterio ? { criterio } : {}),
});

const AVALIACOES = [
  // PARTE 1 — total 10
  { titulo: 'PARTE 1 — Conhecendo a Empresa e Serviços (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('Qual é a principal finalidade de conhecer as informações comerciais e regras de contratação?',
      ['Apenas realizar vendas.', 'Orientar corretamente o cliente e evitar informações incorretas sobre produtos, serviços e contratos.', 'Realizar procedimentos técnicos.', 'Fazer alterações financeiras sem autorização.'], 1, 3),
    unica('Um cliente solicita ajuda para utilizar um benefício/plataforma disponibilizado pela empresa. Qual deve ser a postura do atendente?',
      ['Informar que o suporte é somente para problemas de internet.', 'Orientar o cliente conforme o procedimento e a plataforma correspondente.', 'Encaminhar diretamente para o setor financeiro.', 'Solicitar que o cliente procure a internet para descobrir como utilizar.'], 1, 3),
  ]},
  { titulo: 'PARTE 1 — Conhecendo a Empresa e Serviços (Prática)', tipo: 'pratica', perguntas: [
    aberta('Cite três plataformas ou serviços que fazem parte da trilha de integração da LC Virtual Net.', 4),
  ]},

  // PARTE 2 — total 15
  { titulo: 'PARTE 2 — Atendimento ao Cliente (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('No atendimento humanizado, o comportamento mais adequado é:',
      ['Interromper o cliente para agilizar o atendimento.', 'Utilizar linguagem técnica independentemente do conhecimento do cliente.', 'Demonstrar empatia, ouvir o cliente e conduzir a situação com clareza.', 'Encerrar rapidamente o atendimento.'], 2, 3),
    unica('Em relação ao script de atendimento:',
      ['Deve ser ignorado quando o atendente já possui experiência.', 'Serve como orientação para manter um padrão de atendimento.', 'Só deve ser utilizado em reclamações.', 'Deve ser utilizado apenas pelo supervisor.'], 1, 3),
    unica('O que deve ser considerado antes de encerrar um atendimento por inatividade?',
      ['Apenas o tempo desde a última mensagem.', 'Se o cliente respondeu ou não e as regras estabelecidas para encerramento.', 'Se o atendente está próximo do fim do expediente.', 'Se existem outros clientes aguardando.'], 1, 3),
  ]},
  { titulo: 'PARTE 2 — Atendimento ao Cliente (Prática)', tipo: 'pratica', perguntas: [
    aberta('O cliente iniciou um atendimento, informou que está sem internet e, durante o diagnóstico, deixou de responder. Como você conduziria a situação antes de finalizar o atendimento?', 6),
  ]},

  // PARTE 3 — total 15
  { titulo: 'PARTE 3 — Fundamentos Técnicos (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('O que significa FTTH?',
      ['Fiber To The Home.', 'Fast Transmission To Hub.', 'Fiber Technology Transmission Hub.', 'Fast Telecom Through Home.'], 0, 3),
    unica('Qual equipamento é responsável pela disponibilização da conexão óptica na estrutura de acesso da rede?',
      ['Roteador do cliente.', 'OLT.', 'Computador.', 'Celular.'], 1, 3),
    unica('Qual é a função da ONU/ONT na rede do cliente?',
      ['Distribuir energia elétrica para a residência.', 'Realizar a conversão e comunicação entre a rede óptica e os equipamentos do cliente.', 'Gerenciar as faturas.', 'Monitorar o atendimento.'], 1, 3),
    unica('Qual alternativa apresenta corretamente uma diferença entre IP público e IP privado?',
      ['IP privado é sempre utilizado diretamente na internet pública.', 'IP público pode ser utilizado para comunicação externa, enquanto IP privado é utilizado em redes internas.', 'Não existe diferença entre eles.', 'IP privado é utilizado somente em servidores.'], 1, 3),
  ]},
  { titulo: 'PARTE 3 — Fundamentos Técnicos (Prática)', tipo: 'pratica', perguntas: [
    aberta('O que é CGNAT?', 3, 'O colaborador deve demonstrar que entende que o CGNAT permite compartilhar um endereço IP público entre vários clientes/conexões, utilizando endereçamento privado na rede do provedor.'),
  ]},

  // PARTE 4 — total 10
  { titulo: 'PARTE 4 — Ferramentas de Trabalho (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('Qual ferramenta está relacionada ao monitoramento de informações e indicadores da rede?',
      ['Microsip', 'Grafana', 'Chatmix', 'Discord'], 1, 3),
  ]},
  { titulo: 'PARTE 4 — Ferramentas de Trabalho (Prática)', tipo: 'pratica', perguntas: [
    aberta('Relacione as ferramentas às suas finalidades: HubSoft, Chatmix, Discord e Grafana.', 3),
    aberta('Cite duas ferramentas utilizadas no atendimento e explique resumidamente sua finalidade.', 4),
  ]},

  // PARTE 5 — total 10
  { titulo: 'PARTE 5 — Sistemas Técnicos (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('O HubSoft pode ser utilizado para:',
      ['Apenas realizar chamadas telefônicas.', 'Consultar informações do cliente e executar diferentes processos relacionados ao cadastro e atendimento.', 'Somente monitorar o sinal óptico.', 'Apenas realizar testes de velocidade.'], 1, 3),
    unica('Na trilha de sistemas técnicos, a consulta de localização do cliente está relacionada a:',
      ['Mapeamento no HubSoft.', 'Microsip.', 'Chatmix.', 'HBO Max.'], 0, 3),
  ]},
  { titulo: 'PARTE 5 — Sistemas Técnicos (Prática)', tipo: 'pratica', perguntas: [
    aberta('Cite dois sistemas/equipamentos utilizados para consulta ou análise de sinal óptico.', 4),
  ]},

  // PARTE 6 — total 20
  { titulo: 'PARTE 6 — Suporte Técnico (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('Um cliente informa que está totalmente sem conexão. Qual deve ser uma das primeiras ações?',
      ['Alterar imediatamente a senha Wi-Fi.', 'Identificar o cenário e realizar o diagnóstico de conexão.', 'Solicitar cancelamento.', 'Alterar o plano.'], 1, 3),
    unica('O que deve ser observado ao analisar os LEDs de uma ONT ZTE?',
      ['Apenas a cor do equipamento.', 'O status dos LEDs para identificar possíveis condições de conexão ou falha.', 'Somente o nome da rede Wi-Fi.', 'O valor da mensalidade.'], 1, 3),
    unica('Para realizar um teste de velocidade corretamente, é importante:',
      ['Fazer qualquer teste sem considerar o dispositivo utilizado.', 'Realizar o procedimento adequado e analisar o resultado considerando as condições do teste.', 'Testar apenas pelo celular conectado ao Wi-Fi.', 'Considerar somente o valor apresentado pelo cliente.'], 1, 3),
  ]},
  { titulo: 'PARTE 6 — Suporte Técnico (Prática)', tipo: 'pratica', perguntas: [
    aberta('O que representam, de maneira geral, dBm e dB em uma análise de rede óptica?', 4),
    aberta('O cliente informa: "Minha internet está muito lenta." Descreva uma sequência básica de diagnóstico que você faria antes de encaminhar o caso para outro setor.', 4, 'Investigar o cenário, equipamento/dispositivo, conexão Wi-Fi ou cabeada, realizar teste adequado, verificar condições da conexão e utilizar os sistemas disponíveis antes de encaminhar.'),
    aberta('O cliente informa que o celular conecta ao Wi-Fi, mas a internet não funciona. Quais informações e testes você verificaria?', 3),
  ]},

  // PARTE 7 — total 5
  { titulo: 'PARTE 7 — Atendimento Financeiro (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('Qual das opções abaixo faz parte da trilha de atendimento financeiro?',
      ['Envio de boletos.', 'Configuração de TV Box.', 'Alteração de senha Wi-Fi.', 'Diagnóstico de sinal óptico.'], 0, 1),
    unica('Um cliente solicita uma segunda via da cobrança. Qual procedimento está relacionado a essa necessidade?',
      ['Emissão/envio de boleto ou documento de pagamento conforme o procedimento disponível.', 'Alteração do PPPoE.', 'Reset da ONU.', 'Teste de velocidade.'], 0, 1),
  ]},
  { titulo: 'PARTE 7 — Atendimento Financeiro (Prática)', tipo: 'pratica', perguntas: [
    aberta('Cite dois procedimentos relacionados a descontos ou geração de valores previstos na trilha financeira.', 3),
  ]},

  // PARTE 8 — total 5
  { titulo: 'PARTE 8 — Retenção (Objetivas)', tipo: 'unica_escolha', perguntas: [
    unica('Um cliente solicita cancelamento porque está com dificuldade financeira. Qual área de conhecimento deve ser aplicada?',
      ['Retenção por dificuldade financeira.', 'Diagnóstico de Wi-Fi.', 'Configuração de OLT.', 'Monitoramento pelo Grafana.'], 0, 1),
    unica('Um cliente deseja cancelar porque está insatisfeito com o serviço. Antes de simplesmente concluir o cancelamento, o atendente deve:',
      ['Encerrar imediatamente.', 'Identificar o motivo da insatisfação e aplicar a tratativa de retenção prevista.', 'Alterar o plano sem autorização.', 'Transferir automaticamente para o suporte técnico.'], 1, 1),
  ]},
  { titulo: 'PARTE 8 — Retenção (Prática)', tipo: 'pratica', perguntas: [
    aberta('O cliente diz: "Quero cancelar minha internet porque estou insatisfeito com o serviço." Como você conduziria esse atendimento?', 3),
  ]},

  // PARTE 9 — total 10 (só prática)
  { titulo: 'PARTE 9 — Casos Integrados', tipo: 'pratica', perguntas: [
    aberta('Um cliente entra em contato informando: "Estou sem internet. Já reiniciei o roteador e não resolveu." Ao consultar o cadastro, você identifica o cliente no sistema. Descreva passo a passo como conduziria o atendimento, desde a identificação do cliente até a conclusão ou encaminhamento.', 2, 'Identificar o cliente → verificar situação no sistema → entender o cenário → realizar diagnóstico → verificar equipamentos/sinal conforme o caso → executar procedimento permitido → registrar → solucionar ou encaminhar corretamente.'),
    aberta('Durante um atendimento, você identifica que a situação precisa ser tratada por outro setor. O que deve ser considerado antes de transferir o atendimento?', 2),
    aberta('Você identifica uma possível falha que pode estar afetando mais de um cliente. Como você deve proceder na comunicação interna com o NOC?', 2),
    aberta('Um possível cliente deseja contratar um plano, mas possui dúvidas sobre cadastro e contratação. Quais informações você deve levantar e quais cuidados deve ter antes de concluir o processo?', 2),
    aberta('Um cliente informa que seu serviço foi bloqueado e afirma que já realizou o pagamento. Como você conduziria a situação?', 2),
  ]},
];

async function main() {
  const empresa = await pool.query("SELECT id FROM usuarios WHERE nome='LC Virtual Net' LIMIT 1");
  const empresaId = empresa.rows[0]?.id;
  if (!empresaId) throw new Error('Empresa LC Virtual Net não encontrada');

  const somaTotal = AVALIACOES.reduce((s, av) => s + av.perguntas.reduce((s2, p) => s2 + (p.pontos || 1), 0), 0);
  console.log('Soma total de pontos das 35 perguntas:', somaTotal);
  if (somaTotal !== 100) throw new Error('A soma dos pontos não fechou em 100 — abortando antes de gravar nada.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const treinamentoId = randomUUID();
    await client.query(
      `INSERT INTO treinamentos (id, empresa_id, titulo, tipo_trilha, colaborador_id, status_agenda, eh_modelo)
       VALUES ($1,$2,$3,'avulso',NULL,'agendado',0)`,
      [treinamentoId, empresaId, 'TESTE AVALIATIVO — TRILHA CALL CENTER']
    );
    for (const [i, av] of AVALIACOES.entries()) {
      await client.query(
        `INSERT INTO treinamento_avaliacoes (id, treinamento_id, titulo, tipo, perguntas, obrigatorio, ordem)
         VALUES ($1,$2,$3,$4,$5,1,$6)`,
        [randomUUID(), treinamentoId, av.titulo, av.tipo, JSON.stringify(av.perguntas), i]
      );
    }
    await client.query('COMMIT');
    console.log('OK — treinamento avulso criado:', treinamentoId, 'com', AVALIACOES.length, 'sub-avaliações.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ERRO, rollback:', e.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

main();
