const { Pool, types } = require('pg');

// Faz COUNT(*) retornar number em vez de string
types.setTypeParser(20, val => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS unidades (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      tipo TEXT DEFAULT 'filial',
      cep TEXT,
      logradouro TEXT,
      numero TEXT,
      complemento TEXT,
      bairro TEXT,
      cidade TEXT,
      estado TEXT DEFAULT 'PA',
      cnpj TEXT,
      telefone TEXT,
      responsavel TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS cnpj TEXT`);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS whatsapp TEXT`);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS instagram TEXT`);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS facebook TEXT`);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS site TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS redes_sociais (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      plataforma TEXT NOT NULL,
      nome TEXT,
      url TEXT,
      descricao TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ceps (
      id SERIAL PRIMARY KEY,
      cep TEXT NOT NULL,
      log TEXT NOT NULL,
      tipo TEXT DEFAULT '',
      bairro TEXT DEFAULT '',
      cidade TEXT DEFAULT 'Mãe do Rio',
      empresa_id TEXT,
      UNIQUE(cep, bairro, log)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ceps_cidade ON ceps(cidade)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feriados (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      data TEXT NOT NULL,
      tipo TEXT DEFAULT 'nacional',
      recorrente INTEGER DEFAULT 1,
      observacao TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Coffee Break (datas por unidade — Matriz e Filiais)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coffee_breaks (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      unidade TEXT NOT NULL,
      data TEXT NOT NULL,
      horario TEXT,
      titulo TEXT,
      observacao TEXT,
      ativo INTEGER DEFAULT 1,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Interações genéricas (curtidas e comentários) — reutilizável por mural, eventos, campanhas, coffee, aniversário...
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interacao_curtidas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(tipo, ref_id, usuario_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interacao_comentarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      tipo TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      usuario_id TEXT,
      texto TEXT NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Auditoria do sistema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      perfil TEXT,
      modulo TEXT,
      acao TEXT,
      entidade_nome TEXT,
      ip TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_empresa ON audit_log(empresa_id, created_at DESC)`);

  await pool.query(`ALTER TABLE feriados ADD COLUMN IF NOT EXISTS validacao TEXT DEFAULT 'confirmado'`);
  // Tipos que precisam de validação entram como pendente
  await pool.query(`
    UPDATE feriados SET validacao = 'pendente'
    WHERE validacao = 'confirmado'
      AND tipo NOT IN ('nacional','estadual')
      AND validacao IS NOT NULL
  `).catch(() => {});

  // Grupos de permissão
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupos_permissao (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      permissoes_modulos TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupo_membros (
      grupo_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      PRIMARY KEY (grupo_id, usuario_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupo_departamentos (
      grupo_id TEXT NOT NULL,
      departamento_id TEXT NOT NULL,
      PRIMARY KEY (grupo_id, departamento_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grupo_historico (
      id TEXT PRIMARY KEY,
      grupo_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_grupo_hist ON grupo_historico(grupo_id)`);

  // Férias e folgas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ferias (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      data_inicio TEXT NOT NULL,
      data_fim TEXT NOT NULL,
      dias INTEGER,
      tipo TEXT DEFAULT 'ferias',
      status TEXT DEFAULT 'solicitado',
      aprovado_por TEXT,
      observacoes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Cultura extra: Eventos, Enquetes, Mural
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cultura_eventos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      local TEXT,
      tipo TEXT DEFAULT 'evento',
      publico INTEGER DEFAULT 1,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS cultura_enquetes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      opcoes TEXT,
      data_fim TEXT,
      anonima INTEGER DEFAULT 0,
      ativa INTEGER DEFAULT 1,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS cultura_enquete_respostas (
      id TEXT PRIMARY KEY,
      enquete_id TEXT NOT NULL,
      usuario_id TEXT,
      opcao_index INTEGER NOT NULL,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(enquete_id, usuario_id)
    );
    CREATE TABLE IF NOT EXISTS cultura_mural (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      tipo TEXT DEFAULT 'aviso',
      fixado INTEGER DEFAULT 0,
      data_expiracao TEXT,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS cultura_campanhas_internas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      objetivo TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      status TEXT DEFAULT 'ativa',
      imagem TEXT,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Empresa extra: Telefones, Contatos, Horários
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empresa_telefones (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      descricao TEXT NOT NULL,
      numero TEXT NOT NULL,
      ramal TEXT,
      whatsapp INTEGER DEFAULT 0,
      departamento TEXT,
      observacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS empresa_contatos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      cargo TEXT,
      email TEXT,
      telefone TEXT,
      whatsapp TEXT,
      departamento TEXT,
      observacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS empresa_horarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      unidade TEXT DEFAULT 'Sede',
      dia_semana INTEGER NOT NULL,
      hora_abertura TEXT,
      hora_fechamento TEXT,
      fechado INTEGER DEFAULT 0,
      observacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Treinamentos extra: trilhas, vídeos, cursos externos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trilhas_aprendizagem (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      nivel TEXT DEFAULT 'iniciante',
      departamento_id TEXT,
      carga_horaria INTEGER,
      status TEXT DEFAULT 'ativa',
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS treinamento_videos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      url TEXT NOT NULL,
      duracao TEXT,
      categoria TEXT DEFAULT 'geral',
      tags TEXT,
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS cursos_externos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      colaborador_id TEXT,
      titulo TEXT NOT NULL,
      instituicao TEXT,
      carga_horaria INTEGER,
      data_inicio TEXT,
      data_conclusao TEXT,
      certificado INTEGER DEFAULT 0,
      status TEXT DEFAULT 'em_andamento',
      valor REAL,
      observacoes TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Gestão extra: metas, okrs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      valor_meta REAL DEFAULT 0,
      valor_atual REAL DEFAULT 0,
      unidade TEXT DEFAULT '%',
      departamento_id TEXT,
      responsavel_id TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      status TEXT DEFAULT 'ativa',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS okrs (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      objetivo TEXT NOT NULL,
      resultados_chave TEXT,
      responsavel_id TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      ciclo TEXT,
      status TEXT DEFAULT 'ativo',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Auditoria extra: não conformidades, evidências
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auditoria_nao_conformidades (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      auditoria_id TEXT,
      responsavel_id TEXT,
      prazo TEXT,
      gravidade TEXT DEFAULT 'media',
      status TEXT DEFAULT 'aberta',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE TABLE IF NOT EXISTS auditoria_evidencias (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      auditoria_id TEXT,
      tipo TEXT DEFAULT 'documento',
      url TEXT,
      usuario_id TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Fluxos / Fluxogramas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fluxos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      setor TEXT,
      etapas TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  await pool.query(`ALTER TABLE empresa_contatos ADD COLUMN IF NOT EXISTS foto TEXT`);
  await pool.query(`ALTER TABLE empresa_contatos ADD COLUMN IF NOT EXISTS fixo INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE unidades ADD COLUMN IF NOT EXISTS maps_url TEXT`);
  await pool.query(`ALTER TABLE empresa_horarios ADD COLUMN IF NOT EXISTS periodo TEXT`);
  await pool.query(`ALTER TABLE empresa_horarios ADD COLUMN IF NOT EXISTS tipo_atendimento TEXT DEFAULT 'presencial'`);
  await pool.query(`ALTER TABLE empresa_horarios ADD COLUMN IF NOT EXISTS hora_abertura2 TEXT`);
  await pool.query(`ALTER TABLE empresa_horarios ADD COLUMN IF NOT EXISTS hora_fechamento2 TEXT`);
  await pool.query(`ALTER TABLE empresa_horarios ADD COLUMN IF NOT EXISTS fechado2 INTEGER DEFAULT 0`);

  // Imagem em conteúdos sociais (mural, eventos, coffee break)
  await pool.query(`ALTER TABLE cultura_mural ADD COLUMN IF NOT EXISTS imagem TEXT`);
  await pool.query(`ALTER TABLE cultura_eventos ADD COLUMN IF NOT EXISTS imagem TEXT`);
  await pool.query(`ALTER TABLE coffee_breaks ADD COLUMN IF NOT EXISTS imagem TEXT`);
  await pool.query(`ALTER TABLE coffee_breaks ADD COLUMN IF NOT EXISTS cidade TEXT`);

  // Agenda pessoal de compromissos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agenda_itens (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      data_hora TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Soft delete — colunas adicionadas às tabelas principais
  const tabelasSoftDelete = ['departamentos','cargos','processos','treinamentos','reunioes','acoes','pops'];
  for (const t of tabelasSoftDelete) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMP`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS excluido_por TEXT`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS excluido_por_nome TEXT`);
  }

  // Chave de proteção do sistema (acesso exclusivo do dono)
  await pool.query(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS chave_sistema TEXT`);

  // Tipo de usuário: 'colaborador' (padrão, entra em RH/escalas/contagens) ou
  // 'administrativo' (sócios, diretores, consultores, auditores, parceiros, etc.
  // — têm acesso e permissões próprias, mas NÃO contam como colaboradores).
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_usuario TEXT DEFAULT 'colaborador'`);
  await pool.query(`UPDATE usuarios SET tipo_usuario = 'colaborador' WHERE tipo_usuario IS NULL`).catch(() => {});

  // Protege colaboradores específicos de inativação automática via importação de planilha
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS protegido_inativacao INTEGER DEFAULT 0`);

  // Nova estrutura de escala (substitui escala_dias)
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS colaboradores TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escala_slots (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      secao TEXT NOT NULL,
      dia INTEGER NOT NULL,
      turno TEXT,
      posicao TEXT NOT NULL,
      usuario_id TEXT
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_escala_slots_uniq
    ON escala_slots(escala_id, secao, dia, COALESCE(turno,''), posicao)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escala_feriados_def (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      dia INTEGER NOT NULL,
      nome TEXT NOT NULL
    )
  `);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS turnos_almoco TEXT`);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS turnos_sabado TEXT`);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS publicada INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS observacao TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS escala_historico (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'plantao'`);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS nome TEXT`);
  await pool.query(`ALTER TABLE escalas ADD COLUMN IF NOT EXISTS subtipo TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sobreaviso_entradas (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      data TEXT NOT NULL,
      feriado_nome TEXT,
      tecnico1_id TEXT,
      tecnico2_id TEXT,
      observacao TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hora_extra (
      id TEXT PRIMARY KEY,
      escala_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      data TEXT NOT NULL,
      tecnicos TEXT,
      cidade TEXT,
      horario_saida_previsto TEXT,
      horario_saida_real TEXT,
      motivo TEXT,
      observacao TEXT,
      criado_por TEXT,
      criado_por_nome TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Anotações pessoais (privadas por usuário)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anotacoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      conteudo TEXT,
      cor TEXT DEFAULT '#fef9c3',
      fixada INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Benefícios da empresa
  await pool.query(`
    CREATE TABLE IF NOT EXISTS beneficios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      icone TEXT,
      imagem TEXT,
      ativo INTEGER DEFAULT 1,
      ordem INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Primeiro acesso: colaborador cria a própria senha
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS primeiro_acesso INTEGER DEFAULT 0`);
  // E-mail de contato (pessoal) — usado para enviar os dados de acesso ao colaborador
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_contato TEXT`);

  // Mural: agendamento de publicação futura
  await pool.query(`ALTER TABLE cultura_mural ADD COLUMN IF NOT EXISTS data_agendamento TEXT`);

  // Sugestões anônimas — sem usuario_id (identidade não é registrada)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sugestoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      categoria TEXT DEFAULT 'geral',
      texto TEXT NOT NULL,
      status TEXT DEFAULT 'nova',
      resposta TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  // Anexo de imagem (base64) na sugestão
  await pool.query(`ALTER TABLE sugestoes ADD COLUMN IF NOT EXISTS imagem TEXT`);

  // ── Kronos Chat — solicitações (tickets), mensagens e histórico ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_solicitacoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT DEFAULT 'geral',
      departamento_id TEXT,
      prioridade TEXT DEFAULT 'media',
      status TEXT DEFAULT 'nova',
      criado_por TEXT,
      criado_por_nome TEXT,
      responsavel_id TEXT,
      responsavel_nome TEXT,
      concluido_em TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_sol_empresa ON chat_solicitacoes(empresa_id, status)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_mensagens (
      id TEXT PRIMARY KEY,
      solicitacao_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      texto TEXT,
      anexo TEXT,
      anexo_nome TEXT,
      anexo_tipo TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_msg_sol ON chat_mensagens(solicitacao_id)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_historico (
      id TEXT PRIMARY KEY,
      solicitacao_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      acao TEXT,
      detalhe TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_hist_sol ON chat_historico(solicitacao_id)`);
  // Status do colaborador no chat (para distribuição automática)
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS chat_status TEXT DEFAULT 'disponivel'`);

  // ── Grupos do chat (criados pelo admin, específicos do chat) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_grupos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      cor TEXT DEFAULT '#7B55F1',
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_grupo_membros (
      grupo_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      adicionado_em TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (grupo_id, usuario_id)
    )
  `);

  // ── Módulo de Tarefas (Kanban / Delegação) ──
  // status: a_fazer | em_execucao | aguardando_aprovacao | concluido
  // origem: pessoal | corporativa   |   responsavel_id = a quem pertence o card
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarefas (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      status TEXT DEFAULT 'a_fazer',
      prioridade TEXT DEFAULT 'media',
      prazo TEXT,
      origem TEXT DEFAULT 'pessoal',
      criado_por TEXT NOT NULL,
      responsavel_id TEXT,
      atividade_id TEXT,
      etapa_id TEXT,
      concluido_em TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tarefas_empresa ON tarefas(empresa_id)`);

  // Extensões da tarefa para etapas / aprovação / aceite / checklist
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS ordem INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS depende_de TEXT`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS projeto TEXT`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS aprovacao_obrigatoria INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS aprovado_por TEXT`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS motivo_reprovacao TEXT`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS aceito INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE tarefas ADD COLUMN IF NOT EXISTS checklist TEXT`);

  // Atividades corporativas (container de etapas; cada etapa é uma tarefa com atividade_id)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS atividades (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descricao TEXT,
      objetivo TEXT,
      prioridade TEXT DEFAULT 'media',
      criticidade TEXT DEFAULT 'media',
      departamento_id TEXT,
      projeto TEXT,
      prazo TEXT,
      status TEXT DEFAULT 'em_andamento',
      criado_por TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_atividades_empresa ON atividades(empresa_id)`);

  // Anexos / evidências de tarefa
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarefa_anexos (
      id TEXT PRIMARY KEY,
      tarefa_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      nome TEXT NOT NULL,
      tipo TEXT,
      url TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Comentários de tarefa (privado = só gestores/criador)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarefa_comentarios (
      id TEXT PRIMARY KEY,
      tarefa_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      texto TEXT NOT NULL,
      privado INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Histórico imutável de tarefa
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarefa_historico (
      id TEXT PRIMARY KEY,
      tarefa_id TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT,
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      detalhe TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);

  // Notificações por usuário (genérica)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notificacoes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      tipo TEXT DEFAULT 'tarefa',
      titulo TEXT NOT NULL,
      texto TEXT,
      link TEXT,
      lida INTEGER DEFAULT 0,
      created_at TEXT DEFAULT TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario ON notificacoes(usuario_id, lida)`);

  // Tabela de controle de migrações one-time
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migracoes_executadas (
      nome TEXT PRIMARY KEY,
      executado_em TEXT
    )
  `);

  // Força primeiro_acesso para colaboradores e administrativos (executa uma única vez)
  const jaFezReset = await get(`SELECT 1 FROM migracoes_executadas WHERE nome = 'reset_primeiro_acesso_v1'`);
  if (!jaFezReset) {
    await pool.query(`UPDATE usuarios SET senha = '', primeiro_acesso = 1 WHERE perfil != 'admin'`);
    await run(`INSERT INTO migracoes_executadas (nome, executado_em) VALUES ('reset_primeiro_acesso_v1', TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))`);
    console.log('✅ Migração reset_primeiro_acesso_v1 executada');
  }

  // Libera criação de senha para contas admin específicas (executa uma única vez)
  const jaFezResetAdmin = await get(`SELECT 1 FROM migracoes_executadas WHERE nome = 'reset_senha_admins_v1'`);
  if (!jaFezResetAdmin) {
    await pool.query(`UPDATE usuarios SET senha = '', primeiro_acesso = 1 WHERE email IN ('tamires.mendes@lcvirtualnet.com.br', 'admin@sistema.com')`);
    await run(`INSERT INTO migracoes_executadas (nome, executado_em) VALUES ('reset_senha_admins_v1', TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))`);
    console.log('✅ Migração reset_senha_admins_v1 executada');
  }

  // Garante acesso ao novo e-mail do admin (executa uma única vez)
  const jaFezResetAdmin2 = await get(`SELECT 1 FROM migracoes_executadas WHERE nome = 'reset_senha_admins_v2'`);
  if (!jaFezResetAdmin2) {
    await pool.query(`UPDATE usuarios SET email = 'contato@lcvirtualnet.com.br', senha = '', primeiro_acesso = 1 WHERE email = 'admin@sistema.com' AND perfil = 'admin'`);
    await run(`INSERT INTO migracoes_executadas (nome, executado_em) VALUES ('reset_senha_admins_v2', TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))`);
    console.log('✅ Migração reset_senha_admins_v2 executada');
  }
}

async function seedAdmin() {
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');

  const admin = await get("SELECT id FROM usuarios WHERE email = 'admin@sistema.com'");
  if (!admin) {
    const empresaId = uuidv4();
    await run("INSERT INTO empresas (id, nome, cnpj) VALUES (?, 'Venux', '00.000.000/0001-00')", [empresaId]);
    const seedPass = process.env.ADMIN_SEED_PASSWORD;
    if (seedPass) {
      const senhaHash = bcrypt.hashSync(seedPass, 10);
      await run(
        "INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil) VALUES (?, ?, 'Administrador', 'admin@sistema.com', ?, 'admin')",
        [uuidv4(), empresaId, senhaHash]
      );
    } else {
      // Sem ADMIN_SEED_PASSWORD: cria sem senha, definida no primeiro acesso (evita senha fixa/fraca)
      await run(
        "INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil, primeiro_acesso) VALUES (?, ?, 'Administrador', 'admin@sistema.com', '', 'admin', 1)",
        [uuidv4(), empresaId]
      );
    }
    console.log('✅ Acesso admin inicial criado (admin@sistema.com). A senha é definida no primeiro acesso.');
  }
}

async function conectar() {
  await initSchema();
  await seedAdmin();
  console.log('✅ Banco de dados PostgreSQL conectado');
}

module.exports = { run, get, all, conectar, pool };
