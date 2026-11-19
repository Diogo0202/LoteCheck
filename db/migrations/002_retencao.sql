-- Retenção de 90 dias corridos (dia atual incluído), fuso America/Sao_Paulo.
-- Executar 1x por dia (pg_cron ou cron da aplicação): SELECT * FROM expurgar_dados();

BEGIN;

-- Registro do expurgo: apenas contagens, sem dado pessoal.
CREATE TABLE expurgo_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  executado_em  timestamptz NOT NULL DEFAULT now(),
  corte         date NOT NULL,
  solicitacoes  int NOT NULL,
  itens         int NOT NULL,
  chamados      int NOT NULL
);

CREATE OR REPLACE FUNCTION expurgar_dados(p_hoje date DEFAULT hoje_sp())
RETURNS expurgo_log LANGUAGE plpgsql AS $$
DECLARE
  v_corte date := p_hoje - 89;   -- mantém [hoje-89, hoje] = 90 dias
  v_itens int; v_solic int; v_cham int; v_log expurgo_log;
BEGIN
  SELECT count(*) INTO v_itens
    FROM item i JOIN solicitacao s ON s.id = i.solicitacao_id
   WHERE s.data_solicitacao < v_corte;

  DELETE FROM solicitacao WHERE data_solicitacao < v_corte;   -- itens em cascata
  GET DIAGNOSTICS v_solic = ROW_COUNT;

  -- Chamado sem nenhuma solicitação remanescente sai junto (auditoria em cascata).
  DELETE FROM chamado c WHERE NOT EXISTS (SELECT 1 FROM solicitacao s WHERE s.chamado_id = c.id);
  GET DIAGNOSTICS v_cham = ROW_COUNT;

  -- Auditoria de solicitações removidas de chamados que continuam ativos.
  DELETE FROM auditoria a
   WHERE a.entidade = 'item' AND NOT EXISTS (SELECT 1 FROM item i WHERE i.id = a.entidade_id);

  DELETE FROM importacao_staging WHERE expira_em < now();

  INSERT INTO expurgo_log (corte, solicitacoes, itens, chamados)
  VALUES (v_corte, v_solic, v_itens, v_cham) RETURNING * INTO v_log;
  RETURN v_log;
END $$;

COMMIT;
