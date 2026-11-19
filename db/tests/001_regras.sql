-- Testes das regras de negócio. Rodar em banco descartável após as migrações:
--   psql -v ON_ERROR_STOP=1 -f db/tests/001_regras.sql
-- Falha = exceção. Sucesso = "OK: todos os testes passaram".

BEGIN;

CREATE FUNCTION pg_temp.deve_falhar(p_sql text, p_rotulo text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN others THEN RETURN; END;
  RAISE EXCEPTION 'FALHOU (deveria ter sido recusado): %', p_rotulo;
END $$;

CREATE FUNCTION pg_temp.igual(p_obtido anyelement, p_esperado anyelement, p_rotulo text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION 'FALHOU %: esperado %, obtido %', p_rotulo, p_esperado, p_obtido;
  END IF;
END $$;

INSERT INTO usuario (email, nome, papel) VALUES ('analista@teste', 'Analista', 'ANALISTA');
SET LOCAL app.usuario_id = '1';

INSERT INTO solicitante (nome_exibicao) VALUES ('Ana Souza'), ('João da Silva');
INSERT INTO atividade (nome) VALUES ('Inclusão de marcação'), ('Exclusão de marcação'), ('Abono');

-- 1. Normalização de nome
SELECT pg_temp.igual(f_norm('  JOÃO   da  Sílva '), 'joao da silva', 'f_norm');
SELECT pg_temp.igual((SELECT id FROM solicitante WHERE nome_norm = f_norm('joao DA silva')), 2::bigint, 'busca normalizada');
SELECT pg_temp.igual((SELECT id FROM solicitante WHERE similarity(nome_norm, f_norm('Joao Silva')) > 0.6), 2::bigint, 'sugestão trigram');

-- 2. Formato do TKT
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT-1234567', 1, 1)$$,  '7 dígitos');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT-123456789', 1, 1)$$,'9 dígitos');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('tkt-12345678', 1, 1)$$, 'minúsculas');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT–12345678', 1, 1)$$, 'meia-risca');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT-1234567A', 1, 1)$$, 'letra no número');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES (' TKT-12345678', 1, 1)$$,'espaço');
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT-١٢٣٤٥٦٧٨', 1, 1)$$, 'dígitos árabes');

-- ids explícitos: inserts recusados acima consomem a sequência
INSERT INTO chamado (id, codigo, solicitante_id, criado_por) OVERRIDING SYSTEM VALUE VALUES
  (1, 'TKT-00000001', 1, 1), (2, 'TKT-00000002', 1, 1), (3, 'TKT-00000003', 2, 1);
SELECT pg_temp.deve_falhar($$INSERT INTO chamado (codigo, solicitante_id, criado_por) VALUES ('TKT-00000001', 2, 1)$$, 'TKT duplicado');

-- 3. Data da solicitação
SELECT pg_temp.deve_falhar($$INSERT INTO solicitacao (chamado_id, data_solicitacao, importado_por) VALUES (1, hoje_sp() + 1, 1)$$,  'data futura');
SELECT pg_temp.deve_falhar($$INSERT INTO solicitacao (chamado_id, data_solicitacao, importado_por) VALUES (1, hoje_sp() - 90, 1)$$, 'fora da janela');

-- Chamado 1 recebe DUAS solicitações (dias diferentes); chamado 2 uma.
INSERT INTO solicitacao (id, chamado_id, data_solicitacao, importado_por) OVERRIDING SYSTEM VALUE VALUES
  (1, 1, hoje_sp() - 2, 1),
  (2, 1, hoje_sp() - 1, 1),
  (3, 2, hoje_sp() - 1, 1),
  (4, 3, hoje_sp(),     1);

-- Ana: 12 itens em 2 IDs (5 + 3 na TKT-01, 4 na TKT-02)
INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original)
SELECT s, l, '000' || l, 1 + (l % 3), 'orig' FROM
  (VALUES (1,1),(1,2),(1,3),(1,4),(1,5),(2,1),(2,2),(2,3),(3,1),(3,2),(3,3),(3,4)) v(s,l);

-- 4. Regras de item
SELECT pg_temp.deve_falhar($$INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original) VALUES (4, 1, NULL, 1, 'x')$$, 'sem matrícula pendente');
INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original, status, motivo_codigo, avaliado_em, avaliado_por)
VALUES (4, 1, NULL, 1, 'x', 'NAO_REALIZADO', 'SEM_MATRICULA', now(), 1);
SELECT pg_temp.deve_falhar($$UPDATE item SET status='NAO_REALIZADO', avaliado_em=now(), avaliado_por=1 WHERE id=1$$, 'não realizado sem motivo');
SELECT pg_temp.deve_falhar($$UPDATE item SET status='NAO_REALIZADO', motivo_codigo='OUTROS', avaliado_em=now(), avaliado_por=1 WHERE id=1$$, 'OUTROS sem observação');
SELECT pg_temp.deve_falhar($$INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original, hora_ini, hora_fim) VALUES (4, 2, '1', 1, 'x', '22:00', '02:00')$$, 'virada sem confirmação');
INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original, hora_ini, hora_fim, vira_dia)
VALUES (4, 2, '1', 1, 'x', '22:00', '02:00', true);

-- Ana: 2 exceções e conclusão. Solicitação 3 fica com 1 realizado e 3 pendentes.
UPDATE item SET status='NAO_REALIZADO', motivo_codigo='OUTROS', observacao='colaborador desligado', avaliado_em=now(), avaliado_por=1 WHERE id = 1;
UPDATE item SET status='NAO_REALIZADO', motivo_codigo='SEM_MATRICULA', avaliado_em=now(), avaliado_por=1 WHERE id = 6;
SELECT pg_temp.igual(concluir_solicitacao(1, (SELECT versao FROM solicitacao WHERE id = 1)), 4, 'concluir solicitação 1');
SELECT pg_temp.igual(concluir_solicitacao(2, (SELECT versao FROM solicitacao WHERE id = 2)), 2, 'concluir solicitação 2');
SELECT pg_temp.deve_falhar($$SELECT concluir_solicitacao(1, (SELECT versao FROM solicitacao WHERE id = 1))$$, 'concluir duas vezes');

-- 5. Estado e concorrência
SELECT pg_temp.deve_falhar($$UPDATE item SET observacao='x' WHERE id = 2$$, 'editar item de solicitação concluída');
SELECT pg_temp.deve_falhar($$INSERT INTO item (solicitacao_id, linha_origem, matricula, atividade_id, atividade_original) VALUES (1, 99, '1', 1, 'x')$$, 'acrescentar linha em solicitação concluída');
CREATE TEMP TABLE v AS SELECT versao FROM solicitacao WHERE id = 3;   -- tela mostra "4 pendentes"
UPDATE item SET status='REALIZADO', avaliado_em=now(), avaliado_por=1 WHERE id = 9;  -- outro analista dá baixa
SELECT pg_temp.deve_falhar($$SELECT concluir_solicitacao(3, (SELECT versao FROM v))$$, 'concluir com contagem desatualizada');

-- 6. Lote de importação: dono único e consumo único
INSERT INTO usuario (email, nome, papel) VALUES ('outro@teste', 'Outro', 'ANALISTA');
INSERT INTO importacao_lote (id, criado_por, chamado_codigo, solicitante_id, data_solicitacao)
VALUES ('00000000-0000-0000-0000-000000000001', 1, 'TKT-00000009', 1, hoje_sp());
SET LOCAL app.usuario_id = '2';
SELECT pg_temp.deve_falhar($$SELECT consumir_lote('00000000-0000-0000-0000-000000000001')$$, 'lote de outro analista');
SET LOCAL app.usuario_id = '1';
SELECT pg_temp.igual((consumir_lote('00000000-0000-0000-0000-000000000001')).chamado_codigo, 'TKT-00000009', 'consumir lote');
SELECT pg_temp.deve_falhar($$SELECT consumir_lote('00000000-0000-0000-0000-000000000001')$$, 'confirmar lote duas vezes');

-- 7. Homônimos: mesmo alias para duas pessoas = ambíguo
INSERT INTO solicitante (nome_exibicao, email) VALUES ('Ana Souza', 'ana.souza2@empresa');
INSERT INTO solicitante_alias (solicitante_id, alias, aprovado_por) VALUES (1, 'Ana S.', 1), ((SELECT id FROM solicitante WHERE email = 'ana.souza2@empresa'), 'ana s', 1);
SELECT pg_temp.igual((SELECT count(DISTINCT solicitante_id) FROM solicitante_alias WHERE alias_norm = f_norm('ANA S.')), 2::bigint, 'alias ambíguo');
SELECT pg_temp.igual((SELECT count(*) FROM solicitante WHERE nome_norm = f_norm('ana souza')), 2::bigint, 'nome homônimo');
SELECT pg_temp.deve_falhar($$INSERT INTO solicitante_alias (solicitante_id, alias, aprovado_por) VALUES (1, 'ANA S.', 1)$$, 'alias repetido na mesma pessoa');

-- 8. Painel (exemplo do parecer: 2 IDs, 12 itens, 7 realizados, 2 não realizados, 3 pendentes = 77,8%)
SELECT pg_temp.igual(
  (SELECT row(ids, pedidos, itens, realizados, nao_realizados, pendentes, taxa_realizacao)::text
     FROM v_ranking_solicitantes WHERE id = 1),
  '(2,3,12,7,2,3,77.8)', 'ranking Ana');
SELECT pg_temp.igual((SELECT row(pedidos, ids)::text FROM v_pedidos_por_dia WHERE dia = hoje_sp() - 1), '(2,2)', 'pedidos ontem');
-- 2 exceções + 6 conclusões automáticas + 2 registros de CONCLUIR
SELECT pg_temp.igual((SELECT count(*) FROM auditoria WHERE chamado_id = 1), 10::bigint, 'auditoria TKT-01');

-- 9. Expurgo: simular a passagem do tempo
SELECT pg_temp.igual((expurgar_dados(hoje_sp() + 88)).solicitacoes, 1, 'expurgo dia +88');  -- sai só a de hoje-2
SELECT pg_temp.igual((SELECT count(*) FROM chamado), 3::bigint, 'chamados após +88');
SELECT pg_temp.igual((SELECT count(*) FROM auditoria WHERE chamado_id = 1), 4::bigint, 'auditoria após +88');
SELECT pg_temp.igual((expurgar_dados(hoje_sp() + 89)).chamados, 2, 'expurgo dia +89');      -- TKT-01 e TKT-02 somem
SELECT pg_temp.igual((SELECT codigo FROM chamado), 'TKT-00000003', 'sobra TKT-03');

ROLLBACK;
\echo 'OK: todos os testes passaram'
