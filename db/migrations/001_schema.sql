-- PontoBsa: esquema inicial
-- Hierarquia: chamado (TKT) 1:N solicitacao (cada planilha enviada) 1:N item (cada ajuste)
-- Retenção: 90 dias corridos por data_solicitacao, fuso America/Sao_Paulo (ver 002_retencao.sql)

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() não é IMMUTABLE; o wrapper com dicionário explícito permite uso em colunas geradas e índices.
CREATE OR REPLACE FUNCTION f_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  -- sem acento, minúsculas, pontuação vira espaço, espaços colapsados: " D'Ávila  S. " -> "d avila s"
  SELECT btrim(regexp_replace(
           regexp_replace(lower(public.unaccent('public.unaccent'::regdictionary, t)), '[^a-z0-9]+', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION hoje_sp() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date $$;

-- Usuários do sistema: apenas analistas e admins. Solicitantes não acessam.
CREATE TABLE usuario (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  nome       text NOT NULL,
  papel      text NOT NULL CHECK (papel IN ('ANALISTA', 'ADMIN')),
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

-- Cadastro de referência (sem login).
CREATE TABLE solicitante (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome_exibicao  text NOT NULL CHECK (btrim(nome_exibicao) <> ''),
  nome_norm      text GENERATED ALWAYS AS (f_norm(nome_exibicao)) STORED,
  email          text UNIQUE,
  matricula      text UNIQUE,
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  criado_por     bigint REFERENCES usuario(id)
);
CREATE INDEX solicitante_nome_trgm ON solicitante USING gin (nome_norm gin_trgm_ops);

-- Variações de grafia aprovadas por um analista.
CREATE TABLE solicitante_alias (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitante_id  bigint NOT NULL REFERENCES solicitante(id) ON DELETE CASCADE,
  alias           text NOT NULL,
  alias_norm      text GENERATED ALWAYS AS (f_norm(alias)) STORED,
  aprovado_por    bigint NOT NULL REFERENCES usuario(id),
  aprovado_em     timestamptz NOT NULL DEFAULT now(),
  -- Sem UNIQUE global: homônimos legítimos podem compartilhar o mesmo alias.
  -- Mais de um resultado na busca = correspondência ambígua, o analista escolhe.
  UNIQUE (solicitante_id, alias_norm)
);
CREATE INDEX solicitante_alias_norm ON solicitante_alias (alias_norm);
CREATE INDEX solicitante_alias_trgm ON solicitante_alias USING gin (alias_norm gin_trgm_ops);

-- Catálogo de tipos de ajuste.
CREATE TABLE atividade (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome       text NOT NULL,
  nome_norm  text GENERATED ALWAYS AS (f_norm(nome)) STORED UNIQUE,
  ativo      boolean NOT NULL DEFAULT true
);

-- Motivos de NÃO REALIZADO.
CREATE TABLE motivo (
  codigo             text PRIMARY KEY CHECK (codigo ~ '^[A-Z_]+$'),
  descricao          text NOT NULL,
  exige_observacao   boolean NOT NULL DEFAULT false,
  ativo              boolean NOT NULL DEFAULT true
);
INSERT INTO motivo (codigo, descricao, exige_observacao) VALUES
  ('SEM_MATRICULA', 'Sem matrícula', false),
  ('OUTROS',        'Outros',        true);

CREATE TABLE chamado (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo          text NOT NULL UNIQUE
                  CONSTRAINT codigo_formato CHECK (codigo ~ '^TKT-[0-9]{8}$'),
  solicitante_id  bigint NOT NULL REFERENCES solicitante(id),
  criado_em       timestamptz NOT NULL DEFAULT now(),
  criado_por      bigint NOT NULL REFERENCES usuario(id)
);
CREATE INDEX chamado_solicitante ON chamado (solicitante_id);

-- Cada envio de planilha para um chamado.
CREATE TABLE solicitacao (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chamado_id        bigint NOT NULL REFERENCES chamado(id) ON DELETE CASCADE,
  data_solicitacao  date NOT NULL,
  importado_em      timestamptz NOT NULL DEFAULT now(),
  importado_por     bigint NOT NULL REFERENCES usuario(id),
  arquivo_nome      text,
  status            text NOT NULL DEFAULT 'ABERTA' CHECK (status IN ('ABERTA', 'CONCLUIDA')),
  concluida_em      timestamptz,
  concluida_por     bigint REFERENCES usuario(id),
  versao            int NOT NULL DEFAULT 1,
  CHECK ((status = 'CONCLUIDA') = (concluida_em IS NOT NULL AND concluida_por IS NOT NULL))
);
CREATE INDEX solicitacao_data    ON solicitacao (data_solicitacao);
CREATE INDEX solicitacao_chamado ON solicitacao (chamado_id, data_solicitacao);

-- Rejeita datas futuras e datas que já estariam fora da janela de retenção.
CREATE OR REPLACE FUNCTION trg_solicitacao_data() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data_solicitacao > hoje_sp() THEN
    RAISE EXCEPTION 'data_solicitacao % está no futuro', NEW.data_solicitacao USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.data_solicitacao < hoje_sp() - 89 THEN
    RAISE EXCEPTION 'data_solicitacao % está fora da janela de 90 dias', NEW.data_solicitacao USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER solicitacao_data BEFORE INSERT OR UPDATE OF data_solicitacao ON solicitacao
  FOR EACH ROW EXECUTE FUNCTION trg_solicitacao_data();

CREATE TABLE item (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitacao_id      bigint NOT NULL REFERENCES solicitacao(id) ON DELETE CASCADE,
  linha_origem        int NOT NULL CHECK (linha_origem > 0),
  matricula           text CHECK (matricula IS NULL OR btrim(matricula) <> ''),
  colaborador         text,
  data_ajuste         date,
  hora_ini            time,
  hora_fim            time,
  vira_dia            boolean NOT NULL DEFAULT false,
  atividade_id        bigint NOT NULL REFERENCES atividade(id),
  atividade_original  text NOT NULL,
  motivo_ajuste_original text,          -- motivo escrito na planilha (descreve o pedido, não a decisão)
  status              text NOT NULL DEFAULT 'PENDENTE'
                      CHECK (status IN ('PENDENTE', 'REALIZADO', 'NAO_REALIZADO')),
  motivo_codigo       text REFERENCES motivo(codigo),
  observacao          text,
  avaliado_em         timestamptz,
  avaliado_por        bigint REFERENCES usuario(id),
  versao              int NOT NULL DEFAULT 1,
  UNIQUE (solicitacao_id, linha_origem),
  -- motivo existe se, e somente se, NÃO REALIZADO
  CHECK ((status = 'NAO_REALIZADO') = (motivo_codigo IS NOT NULL)),
  -- OUTROS exige observação
  CHECK (motivo_codigo IS DISTINCT FROM 'OUTROS' OR btrim(coalesce(observacao, '')) <> ''),
  -- linha sem matrícula só entra como NÃO REALIZADO / SEM_MATRICULA
  -- (coalesce: sem ele, motivo NULL torna a expressão NULL e o CHECK passa)
  CHECK (matricula IS NOT NULL OR coalesce(motivo_codigo = 'SEM_MATRICULA', false)),
  -- horário final menor que o inicial só com virada de dia confirmada
  CHECK (hora_ini IS NULL OR hora_fim IS NULL OR hora_fim >= hora_ini OR vira_dia),
  CHECK ((status = 'PENDENTE') = (avaliado_em IS NULL))
);
CREATE INDEX item_solicitacao ON item (solicitacao_id);
CREATE INDEX item_atividade   ON item (atividade_id);
CREATE INDEX item_data_ajuste ON item (data_ajuste);

-- Trilha de alterações. chamado_id permite expurgar junto com o chamado.
CREATE TABLE auditoria (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chamado_id   bigint REFERENCES chamado(id) ON DELETE CASCADE,
  entidade     text NOT NULL,
  entidade_id  bigint NOT NULL,
  acao         text NOT NULL,
  usuario_id   bigint REFERENCES usuario(id),
  em           timestamptz NOT NULL DEFAULT now(),
  antes        jsonb,
  depois       jsonb
);
CREATE INDEX auditoria_chamado ON auditoria (chamado_id);

-- A aplicação executa SET LOCAL app.usuario_id = '<id>' em cada transação.
CREATE OR REPLACE FUNCTION usuario_atual() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.usuario_id', true), '')::bigint $$;

CREATE OR REPLACE FUNCTION trg_item_auditoria() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_chamado bigint;
BEGIN
  SELECT chamado_id INTO v_chamado FROM solicitacao WHERE id = NEW.solicitacao_id;
  NEW.versao := OLD.versao + 1;
  INSERT INTO auditoria (chamado_id, entidade, entidade_id, acao, usuario_id, antes, depois)
  VALUES (v_chamado, 'item', NEW.id, 'UPDATE', usuario_atual(),
          jsonb_build_object('status', OLD.status, 'motivo', OLD.motivo_codigo, 'observacao', OLD.observacao),
          jsonb_build_object('status', NEW.status, 'motivo', NEW.motivo_codigo, 'observacao', NEW.observacao));
  RETURN NEW;
END $$;
CREATE TRIGGER item_auditoria BEFORE UPDATE OF status, motivo_codigo, observacao ON item
  FOR EACH ROW WHEN (ROW(OLD.status, OLD.motivo_codigo, OLD.observacao)
              IS DISTINCT FROM ROW(NEW.status, NEW.motivo_codigo, NEW.observacao))
  EXECUTE FUNCTION trg_item_auditoria();

-- Item só muda enquanto a solicitação está ABERTA. O UPDATE abaixo trava a linha da
-- solicitação e incrementa sua versão: uma baixa concorrente com "Concluir" espera o
-- lock e falha ao ver CONCLUIDA; uma conclusão com contagem desatualizada falha na versão.
-- DELETE fica de fora para não bloquear o expurgo em cascata.
CREATE OR REPLACE FUNCTION trg_item_estado() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE solicitacao SET versao = versao + 1
   WHERE id = NEW.solicitacao_id AND status = 'ABERTA';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solicitação % não está aberta', NEW.solicitacao_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_estado BEFORE INSERT OR UPDATE ON item
  FOR EACH ROW EXECUTE FUNCTION trg_item_estado();

-- Prévia da importação. O lote pertence ao analista que enviou o arquivo,
-- expira em 24 h e só pode ser consumido uma vez.
CREATE TABLE importacao_lote (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_por        bigint NOT NULL REFERENCES usuario(id),
  chamado_codigo    text NOT NULL CHECK (chamado_codigo ~ '^TKT-[0-9]{8}$'),
  solicitante_id    bigint NOT NULL REFERENCES solicitante(id),
  data_solicitacao  date NOT NULL,
  arquivo_nome      text,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  expira_em         timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumido_em      timestamptz,
  solicitacao_id    bigint UNIQUE REFERENCES solicitacao(id) ON DELETE SET NULL
);

CREATE TABLE importacao_staging (
  lote_id  uuid NOT NULL REFERENCES importacao_lote(id) ON DELETE CASCADE,
  linha    int NOT NULL,
  dados    jsonb NOT NULL,
  erros    jsonb NOT NULL DEFAULT '[]',
  avisos   jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (lote_id, linha)
);

-- Marca o lote como consumido. Chamar no início da transação que grava
-- chamado/solicitação/itens; uma segunda confirmação espera o lock e falha.
CREATE OR REPLACE FUNCTION consumir_lote(p_lote uuid) RETURNS importacao_lote
LANGUAGE plpgsql AS $$
DECLARE v importacao_lote;
BEGIN
  UPDATE importacao_lote SET consumido_em = now()
   WHERE id = p_lote AND criado_por = usuario_atual()
     AND consumido_em IS NULL AND expira_em > now()
  RETURNING * INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote % inexistente, de outro analista, expirado ou já confirmado', p_lote
      USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN v;
END $$;

-- "Concluir solicitação": pendentes restantes viram REALIZADO numa transação.
CREATE OR REPLACE FUNCTION concluir_solicitacao(p_solicitacao bigint, p_versao int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_usuario bigint := usuario_atual(); v_qtd int;
BEGIN
  IF v_usuario IS NULL THEN RAISE EXCEPTION 'app.usuario_id não definido'; END IF;
  -- p_versao é a versão lida quando a tela mostrou "N pendentes serão marcados".
  PERFORM 1 FROM solicitacao
   WHERE id = p_solicitacao AND versao = p_versao AND status = 'ABERTA'
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflito: solicitação % alterada ou já concluída', p_solicitacao USING ERRCODE = 'serialization_failure';
  END IF;
  UPDATE item SET status = 'REALIZADO', avaliado_em = now(), avaliado_por = v_usuario
   WHERE solicitacao_id = p_solicitacao AND status = 'PENDENTE';
  GET DIAGNOSTICS v_qtd = ROW_COUNT;
  UPDATE solicitacao
     SET status = 'CONCLUIDA', concluida_em = now(), concluida_por = v_usuario, versao = versao + 1
   WHERE id = p_solicitacao;
  INSERT INTO auditoria (chamado_id, entidade, entidade_id, acao, usuario_id, depois)
  SELECT chamado_id, 'solicitacao', id, 'CONCLUIR', v_usuario, jsonb_build_object('pendentes_realizados', v_qtd)
    FROM solicitacao WHERE id = p_solicitacao;
  RETURN v_qtd;
END $$;

COMMIT;
