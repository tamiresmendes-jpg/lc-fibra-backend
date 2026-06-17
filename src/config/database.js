const { Pool, types } = require('pg');

// Faz COUNT(*) retornar number em vez de string
types.setTypeParser(20, val => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Converte ? para $1, $2, ... (compatibilidade com código SQLite)
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
  const result = await pool.query(toPositional(sql), params);
  return { changes: result.rowCount };
}

async function get(sql, params = []) {
  const result = await pool.query(toPositional(sql), params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await pool.query(toPositional(sql), params);
  return result.rows;
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      cnpj TEXT,
      logo TEXT,
      cor_primaria TEXT DEFAULT '#2563eb',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS departamentos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      sigla TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cargos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      nome TEXT NOT NULL,
      funcao TEXT,
      nivel INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      cargo_id TEXT,
      gestor_id TEXT,
      setor_id TEXT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha TEXT NOT NULL,
      perfil TEXT DEFAULT 'colaborador',
      avatar TEXT,
      ativo INTEGER DEFAULT 1,
      bloqueado INTEGER DEFAULT 0,
      funcao TEXT,
      nivel TEXT,
      sort_order INTEGER DEFAULT 0,
      cor TEXT,
      data_nascimento TEXT,
      matricula TEXT,
      cidade TEXT,
      permissoes_modulos TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS setores (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      nome TEXT NOT NULL,
      descricao TEXT,
      responsavel_id TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS categorias_pop (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      cor TEXT DEFAULT '#7B55F1',
      parent_id TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pops (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      categoria_id TEXT,
      titulo TEXT NOT NULL,
      descricao TEXT,
      conteudo TEXT,
      versao TEXT DEFAULT '1.0',
      status TEXT DEFAULT 'rascunho',
      total_visualizacoes INTEGER DEFAULT 0,
      criado_por TEXT,
      aprovado_por TEXT,
      elaborado_por TEXT,
      codigo TEXT,
      objetivo TEXT,
      campo_aplicacao TEXT,
      responsabilidade TEXT,
      procedimento TEXT,
      documentos TEXT,
      kpis TEXT,
      seguranca TEXT,
      penalidade TEXT,
      disposicao_final TEXT,
      data_elaboracao TEXT,
      checklist TEXT,
      fluxograma TEXT,
      tipo_pop TEXT DEFAULT 'hierarquico',
      dono_processo TEXT,
      sipoc_dados TEXT,
      dados_inspecao TEXT,
      criterio_aceite TEXT,
      data_ativacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pop_historico (
      id TEXT PRIMARY KEY,
      pop_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      versao_anterior TEXT,
      versao_nova TEXT NOT NULL,
      campos_alterados TEXT,
      resumo_alteracao TEXT,
      tipo_alteracao TEXT DEFAULT 'criacao',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pop_visualizacoes (
      id TEXT PRIMARY KEY,
      pop_id TEXT NOT NULL,
      usuario_id TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pop_comentarios (
      id TEXT PRIMARY KEY,
      pop_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      texto TEXT NOT NULL,
      tipo TEXT DEFAULT 'comentario',
      trecho TEXT,
      resolvido INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pop_comentario_reacoes (
      id TEXT PRIMARY KEY,
      comentario_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(comentario_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS pop_anexos (
      id TEXT PRIMARY KEY,
      pop_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      tipo TEXT,
      tamanho INTEGER,
      caminho TEXT,
      url_externa TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS processos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      titulo TEXT NOT NULL,
      descricao TEXT,
      fluxo TEXT,
      status TEXT DEFAULT 'ativo',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS auditoria_solicitacoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      pop_id TEXT NOT NULL,
      solicitante_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      status TEXT DEFAULT 'pendente',
      auditoria_id TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS auditorias (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      auditado_id TEXT,
      auditor_id TEXT,
      pop_id TEXT,
      solicitacao_id TEXT,
      score REAL,
      status TEXT DEFAULT 'pendente',
      resultado TEXT,
      pendencias TEXT,
      data_auditoria TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS auditoria_itens (
      id TEXT PRIMARY KEY,
      auditoria_id TEXT NOT NULL,
      pergunta TEXT NOT NULL,
      resposta TEXT,
      peso INTEGER DEFAULT 1,
      conformidade TEXT,
      observacao TEXT
    );

    CREATE TABLE IF NOT EXISTS reunioes_1_1 (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      lider_id TEXT NOT NULL,
      liderado_id TEXT NOT NULL,
      data_reuniao TEXT,
      pauta TEXT,
      anotacoes TEXT,
      proximos_passos TEXT,
      status TEXT DEFAULT 'agendada',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS reunioes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      tipo TEXT DEFAULT 'geral',
      data_reuniao TEXT,
      local TEXT,
      pauta TEXT,
      ata TEXT,
      criado_por TEXT,
      status TEXT DEFAULT 'agendada',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS acoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      what TEXT,
      why TEXT,
      where_field TEXT,
      when_field TEXT,
      who TEXT,
      how TEXT,
      how_much TEXT,
      responsavel_id TEXT,
      prioridade TEXT DEFAULT 'media',
      status TEXT DEFAULT 'aberta',
      data_prazo TEXT,
      data_conclusao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS indicadores (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      nome TEXT NOT NULL,
      descricao TEXT,
      unidade TEXT,
      meta REAL,
      valor_atual REAL,
      frequencia TEXT DEFAULT 'mensal',
      status TEXT DEFAULT 'ativo',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS indicadores_historico (
      id TEXT PRIMARY KEY,
      indicador_id TEXT NOT NULL,
      valor REAL NOT NULL,
      data_registro TEXT NOT NULL,
      observacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS comunicados (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      conteudo TEXT,
      tipo TEXT DEFAULT 'comunicado',
      publicado_por TEXT,
      data_publicacao TEXT,
      ativo INTEGER DEFAULT 1,
      fixado INTEGER DEFAULT 0,
      categoria TEXT DEFAULT 'geral',
      imagem TEXT,
      data_programada TEXT,
      tema TEXT DEFAULT 'padrao',
      data_inicio TEXT,
      data_fim TEXT,
      responsavel TEXT,
      etapa TEXT,
      vagas_limite INTEGER,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS comunicado_leituras (
      id TEXT PRIMARY KEY,
      comunicado_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(comunicado_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS comunicado_reacoes (
      id TEXT PRIMARY KEY,
      comunicado_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      tipo TEXT DEFAULT 'curtida',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(comunicado_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS comunicado_comentarios (
      id TEXT PRIMARY KEY,
      comunicado_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      texto TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS treinamentos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      conteudo TEXT,
      tipo TEXT DEFAULT 'interno',
      carga_horaria INTEGER,
      status TEXT DEFAULT 'ativo',
      departamento_id TEXT,
      responsavel_id TEXT,
      colaborador_id TEXT,
      data_hora TEXT,
      status_agenda TEXT DEFAULT 'agendado',
      observacoes TEXT,
      tipo_trilha TEXT DEFAULT 'onboarding',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS treinamento_participantes (
      id TEXT PRIMARY KEY,
      treinamento_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      data_conclusao TEXT,
      nota REAL,
      UNIQUE(treinamento_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS treinamento_pops (
      id TEXT PRIMARY KEY,
      treinamento_id TEXT NOT NULL,
      pop_id TEXT NOT NULL,
      concluido INTEGER DEFAULT 0,
      ordem INTEGER DEFAULT 0,
      instrutor_id TEXT,
      tempo_estimado INTEGER DEFAULT 0,
      tempo_realizado INTEGER DEFAULT 0,
      topicos TEXT,
      versao_pop TEXT,
      data_prevista TEXT,
      status_pop TEXT DEFAULT 'pendente',
      UNIQUE(treinamento_id, pop_id)
    );

    CREATE TABLE IF NOT EXISTS treinamento_avaliacoes (
      id TEXT PRIMARY KEY,
      treinamento_id TEXT NOT NULL,
      pop_id TEXT,
      titulo TEXT NOT NULL,
      tipo TEXT NOT NULL,
      perguntas TEXT NOT NULL,
      obrigatorio INTEGER DEFAULT 1,
      ordem INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS treinamento_respostas (
      id TEXT PRIMARY KEY,
      avaliacao_id TEXT NOT NULL,
      treinamento_id TEXT NOT NULL,
      colaborador_id TEXT NOT NULL,
      respostas TEXT NOT NULL,
      nota REAL,
      concluido INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(avaliacao_id, colaborador_id)
    );

    CREATE TABLE IF NOT EXISTS treinamento_anotacoes (
      id TEXT PRIMARY KEY,
      treinamento_id TEXT NOT NULL,
      pop_id TEXT,
      usuario_id TEXT NOT NULL,
      tipo TEXT DEFAULT 'observacao',
      texto TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      de_usuario_id TEXT NOT NULL,
      para_usuario_id TEXT NOT NULL,
      tipo TEXT DEFAULT 'positivo',
      conteudo TEXT NOT NULL,
      privado INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS onboarding (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      colaborador_nome TEXT NOT NULL,
      cargo TEXT,
      departamento_id TEXT,
      responsavel_id TEXT,
      data_inicio TEXT,
      status TEXT DEFAULT 'em_andamento',
      estrutura_apoio TEXT,
      acolhimento TEXT,
      treinamento_funcional TEXT,
      observacoes TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_institucional (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      conteudo TEXT,
      versao TEXT DEFAULT '1.0',
      ativo INTEGER DEFAULT 1,
      publicado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_institucional_aceites (
      id TEXT PRIMARY KEY,
      institucional_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(institucional_id, usuario_id)
    );

    CREATE TABLE IF NOT EXISTS cultura_reconhecimentos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      tipo TEXT DEFAULT 'elogio',
      de_usuario_id TEXT NOT NULL,
      para_usuario_id TEXT NOT NULL,
      valor TEXT,
      descricao TEXT NOT NULL,
      publico INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_pdis (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      colaborador_id TEXT NOT NULL,
      gestor_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      objetivo TEXT,
      competencias TEXT,
      acoes TEXT,
      status TEXT DEFAULT 'ativo',
      data_inicio TEXT,
      data_fim TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_pesquisas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      tipo TEXT DEFAULT 'clima',
      descricao TEXT,
      perguntas TEXT,
      anonima INTEGER DEFAULT 1,
      ativa INTEGER DEFAULT 1,
      data_inicio TEXT,
      data_fim TEXT,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_pesquisa_respostas (
      id TEXT PRIMARY KEY,
      pesquisa_id TEXT NOT NULL,
      usuario_id TEXT,
      respostas TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_biblioteca (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT DEFAULT 'documento',
      url TEXT,
      arquivo TEXT,
      tags TEXT,
      publico INTEGER DEFAULT 1,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_pontos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      acao TEXT NOT NULL,
      pontos INTEGER DEFAULT 0,
      descricao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_medalhas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      icone TEXT DEFAULT '🏅',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_rankings (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      periodo TEXT,
      departamento_id TEXT,
      tipo_ranking TEXT,
      tipo_ranking_outro TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cultura_ranking_posicoes (
      id TEXT PRIMARY KEY,
      ranking_id TEXT NOT NULL,
      posicao INTEGER NOT NULL,
      usuario_id TEXT,
      nome_externo TEXT,
      pontuacao TEXT,
      descricao TEXT
    );

    CREATE TABLE IF NOT EXISTS campanhas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      status TEXT DEFAULT 'ativa',
      tipo_publico TEXT DEFAULT 'todos',
      tipo_bonificacao TEXT DEFAULT 'valor_fixo',
      valor_bonificacao REAL DEFAULT 0,
      tipo_ranking TEXT DEFAULT 'individual',
      responsavel_id TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS campanha_metas (
      id TEXT PRIMARY KEY,
      campanha_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      categoria TEXT DEFAULT 'personalizada',
      descricao TEXT,
      valor_meta REAL DEFAULT 0,
      unidade TEXT DEFAULT 'unidades',
      tipo_bonif TEXT DEFAULT 'fixo_ao_atingir',
      valor_bonif REAL DEFAULT 0,
      ordem INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS campanha_publico (
      id TEXT PRIMARY KEY,
      campanha_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      referencia_id TEXT,
      nome_externo TEXT
    );

    CREATE TABLE IF NOT EXISTS campanha_participantes (
      id TEXT PRIMARY KEY,
      campanha_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      confirmou_leitura INTEGER DEFAULT 0,
      data_leitura TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS campanha_resultados (
      id TEXT PRIMARY KEY,
      campanha_id TEXT NOT NULL,
      meta_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      valor_realizado REAL DEFAULT 0,
      observacao TEXT,
      registrado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS alteracoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      modulo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      tipo_acao TEXT NOT NULL,
      nivel TEXT DEFAULT 'informativa',
      descricao TEXT,
      versao_anterior TEXT,
      versao_atual TEXT,
      criado_por TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS alteracao_ciencias (
      id TEXT PRIMARY KEY,
      alteracao_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      ip TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS escalas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      departamento_id TEXT,
      mes INTEGER NOT NULL,
      ano INTEGER NOT NULL,
      titulo TEXT,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(empresa_id, departamento_id, mes, ano)
    );

    CREATE TABLE IF NOT EXISTS escala_dias (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      dia INTEGER NOT NULL,
      tipo TEXT DEFAULT 'trabalho',
      turno TEXT DEFAULT 'dia',
      observacao TEXT,
      UNIQUE(escala_id, usuario_id, dia)
    );
  `);

  // Garante colunas adicionadas após a criação inicial (tabelas já existentes)
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cidade TEXT`);
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  const admin = await get("SELECT id FROM usuarios WHERE email = 'admin@sistema.com'");
  if (!admin) {
    const empresaId = uuidv4();
    await run("INSERT INTO empresas (id, nome, cnpj) VALUES (?, 'LC FIBRA', '00.000.000/0001-00')", [empresaId]);
    const senhaHash = bcrypt.hashSync('admin123', 10);
    await run(
      "INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil) VALUES (?, ?, 'Administrador', 'admin@sistema.com', ?, 'admin')",
      [uuidv4(), empresaId, senhaHash]
    );
    console.log('✅ Acesso padrão criado: admin@sistema.com / admin123');
  }
}

async function conectar() {
  await initSchema();
  await seedAdmin();
  console.log('✅ Banco de dados PostgreSQL conectado');
}

module.exports = { run, get, all, conectar, pool };
