const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const ESTRUTURA_PADRAO = [
  { id: 1, item: 'Computador / notebook configurado', concluido: false, responsavel: 'TI' },
  { id: 2, item: 'Crachá de identificação emitido', concluido: false, responsavel: 'RH' },
  { id: 3, item: 'Acesso ao e-mail corporativo criado', concluido: false, responsavel: 'TI' },
  { id: 4, item: 'Acesso aos sistemas internos liberado', concluido: false, responsavel: 'TI' },
  { id: 5, item: 'Mesa e espaço de trabalho preparados', concluido: false, responsavel: 'Gestor' },
  { id: 6, item: 'Ramal telefônico / WhatsApp corporativo configurado', concluido: false, responsavel: 'TI' },
];

const ACOLHIMENTO_PADRAO = [
  { id: 1, item: 'Apresentação à equipe e ao gestor direto', concluido: false, responsavel: 'Gestor' },
  { id: 2, item: 'Tour pelas instalações da empresa', concluido: false, responsavel: 'RH' },
  { id: 3, item: 'Apresentação da missão, visão e valores da LC FIBRA', concluido: false, responsavel: 'RH' },
  { id: 4, item: 'Entrega e leitura do manual do colaborador', concluido: false, responsavel: 'RH' },
  { id: 5, item: 'Explicação sobre cultura, normas e conduta interna', concluido: false, responsavel: 'RH' },
  { id: 6, item: 'Apresentação das políticas de benefícios e frequência', concluido: false, responsavel: 'RH' },
];

const TREINAMENTO_PADRAO = [
  { id: 1, titulo: 'Sistemas e ferramentas de trabalho', descricao: 'Capacitação nos sistemas utilizados no dia a dia (CRM, ERP, sistemas internos)', concluido: false, responsavel: 'TI / Gestor' },
  { id: 2, titulo: 'Rotinas e processos do cargo', descricao: 'Treinamento nas atividades, fluxos e responsabilidades específicas da função', concluido: false, responsavel: 'Gestor' },
  { id: 3, titulo: 'POPs e procedimentos operacionais', descricao: 'Leitura e assinatura dos POPs relacionados ao cargo', concluido: false, responsavel: 'Gestor' },
  { id: 4, titulo: 'Atendimento ao cliente (se aplicável)', descricao: 'Treinamento no padrão de atendimento e comunicação com o cliente', concluido: false, responsavel: 'Supervisor' },
  { id: 5, titulo: 'Segurança e conduta no trabalho', descricao: 'Normas de segurança, EPIs e regras de conduta no ambiente de trabalho', concluido: false, responsavel: 'RH' },
];

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT o.*, d.nome as departamento_nome, u.nome as responsavel_nome
      FROM onboarding o
      LEFT JOIN departamentos d ON d.id = o.departamento_id
      LEFT JOIN usuarios u ON u.id = o.responsavel_id
      WHERE o.empresa_id = $1
      ORDER BY o.created_at DESC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { colaborador_nome, cargo, departamento_id, responsavel_id, data_inicio, observacoes } = req.body;
    if (!colaborador_nome) return res.status(400).json({ erro: 'Nome do colaborador obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO onboarding (id, empresa_id, colaborador_nome, cargo, departamento_id, responsavel_id, data_inicio, estrutura_apoio, acolhimento, treinamento_funcional, observacoes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      id, req.usuario.empresa_id, colaborador_nome, cargo || null,
      departamento_id || null, responsavel_id || null, data_inicio || null,
      JSON.stringify(ESTRUTURA_PADRAO),
      JSON.stringify(ACOLHIMENTO_PADRAO),
      JSON.stringify(TREINAMENTO_PADRAO),
      observacoes || null
    ]);
    res.status(201).json({ id, colaborador_nome });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await get(`
      SELECT o.*, d.nome as departamento_nome, u.nome as responsavel_nome
      FROM onboarding o
      LEFT JOIN departamentos d ON d.id = o.departamento_id
      LEFT JOIN usuarios u ON u.id = o.responsavel_id
      WHERE o.id = $1 AND o.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(item);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { colaborador_nome, cargo, departamento_id, responsavel_id, data_inicio, status, estrutura_apoio, acolhimento, treinamento_funcional, observacoes } = req.body;
    await run(`
      UPDATE onboarding SET
        colaborador_nome=$1, cargo=$2, departamento_id=$3, responsavel_id=$4, data_inicio=$5,
        status=$6, estrutura_apoio=$7, acolhimento=$8, treinamento_funcional=$9, observacoes=$10,
        updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id=$11 AND empresa_id=$12
    `, [
      colaborador_nome, cargo || null, departamento_id || null, responsavel_id || null,
      data_inicio || null, status || 'em_andamento',
      estrutura_apoio ? JSON.stringify(estrutura_apoio) : null,
      acolhimento ? JSON.stringify(acolhimento) : null,
      treinamento_funcional ? JSON.stringify(treinamento_funcional) : null,
      observacoes || null,
      req.params.id, req.usuario.empresa_id
    ]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM onboarding WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
