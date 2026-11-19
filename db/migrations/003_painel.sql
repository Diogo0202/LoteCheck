-- Visões do painel. Todas cobrem a janela inteira armazenada (90 dias).
-- Definições:
--   pedido      = solicitação (cada planilha enviada)
--   ID          = chamado distinto (TKT)
--   item        = linha/ajuste

BEGIN;

-- Pedidos por data de solicitação e por dia da semana (0 = domingo).
CREATE VIEW v_pedidos_por_dia AS
SELECT s.data_solicitacao                      AS dia,
       extract(dow FROM s.data_solicitacao)::int AS dia_semana,
       count(*)                                AS pedidos,
       count(DISTINCT s.chamado_id)            AS ids,
       sum((SELECT count(*) FROM item i WHERE i.solicitacao_id = s.id))::int AS itens
  FROM solicitacao s
 GROUP BY s.data_solicitacao;

-- Dias de ponto mais ajustados (data do ajuste, não da solicitação).
CREATE VIEW v_ajustes_por_data_ponto AS
SELECT data_ajuste AS dia, count(*) AS itens
  FROM item WHERE data_ajuste IS NOT NULL
 GROUP BY data_ajuste;

-- Ajuste mais pedido: conta todos os itens, inclusive pendentes e não realizados.
CREATE VIEW v_ranking_atividades AS
SELECT a.id, a.nome,
       count(*)                                         AS itens,
       count(*) FILTER (WHERE i.status = 'REALIZADO')     AS realizados,
       count(*) FILTER (WHERE i.status = 'NAO_REALIZADO') AS nao_realizados,
       count(*) FILTER (WHERE i.status = 'PENDENTE')      AS pendentes
  FROM item i JOIN atividade a ON a.id = i.atividade_id
 GROUP BY a.id, a.nome;

-- Detalhe dos turnos pedidos (06:00-14:20, 13:40-22:00...).
CREATE VIEW v_ranking_turnos AS
SELECT i.hora_ini, i.hora_fim, i.vira_dia, count(*) AS itens
  FROM item i JOIN atividade a ON a.id = i.atividade_id
 WHERE a.codigo = 'TURNO'
 GROUP BY i.hora_ini, i.hora_fim, i.vira_dia;

-- Solicitante com mais IDs.
CREATE VIEW v_ranking_solicitantes AS
SELECT so.id, so.nome_exibicao,
       count(DISTINCT c.id)  AS ids,
       count(DISTINCT s.id)  AS pedidos,
       count(i.id)           AS itens,
       count(i.id) FILTER (WHERE i.status = 'REALIZADO')     AS realizados,
       count(i.id) FILTER (WHERE i.status = 'NAO_REALIZADO') AS nao_realizados,
       count(i.id) FILTER (WHERE i.status = 'PENDENTE')      AS pendentes,
       round(100.0 * count(i.id) FILTER (WHERE i.status = 'REALIZADO')
             / nullif(count(i.id) FILTER (WHERE i.status <> 'PENDENTE'), 0), 1) AS taxa_realizacao
  FROM solicitante so
  JOIN chamado c      ON c.solicitante_id = so.id
  JOIN solicitacao s  ON s.chamado_id = c.id
  LEFT JOIN item i    ON i.solicitacao_id = s.id
 GROUP BY so.id, so.nome_exibicao;

COMMIT;
