# PontoBsa

Sistema web interno para registrar chamados de escala, conferir o que foi executado e medir a demanda por solicitante. O analista informa o ID do chamado, escolhe o solicitante e envia a planilha do chamado. O sistema converte cada linha da planilha em um item, o analista marca o que não foi realizado e o painel consolida os números dos últimos 90 dias.

> **Estado atual:** banco de dados e leitor da planilha prontos e testados. Telas, autenticação e painel ainda não foram construídos. Veja [Situação do projeto](#situação-do-projeto).

---

## Como o sistema funciona

### Fluxo do analista

1. **Formulário.** O analista informa o ID do chamado (`TKT-` + 8 dígitos), a data da solicitação e o solicitante, escolhido no cadastro por autocomplete. Nome novo exige cadastro explícito.
2. **Envio da planilha.** O servidor lê o arquivo uma única vez e grava uma prévia temporária, válida por 24 horas e vinculada ao analista que enviou.
3. **Prévia.** A tela mostra cada problema com a célula exata (`H2`, `B5`). Erros bloqueiam a confirmação. Avisos exigem conferência.
4. **Confirmação.** O lote é consumido uma única vez, na mesma transação que grava os itens. Clicar duas vezes em "Confirmar" gera um único registro.
5. **Conferência.** Todos os itens entram como `PENDENTE`. O analista marca só as exceções como `NÃO REALIZADO`, com motivo obrigatório.
6. **Conclusão.** "Concluir solicitação" mostra quantos pendentes restam, converte todos em `REALIZADO` numa única transação e registra a operação na auditoria.

Uma solicitação com 76 itens e 2 exceções fecha com 2 marcações e 1 conclusão.

### Hierarquia dos dados

```
chamado (TKT-00001234)          um solicitante por chamado
  └── solicitação               cada planilha enviada, com a própria data
        └── item                cada linha do chamado (ou cada célula da escala)
```

Um chamado pode receber várias solicitações ao longo do tempo. Se o ID já existe, o formulário oferece "Adicionar solicitação" em vez de criar outro chamado.

### Regras de negócio aplicadas pelo banco

| Regra | Como é garantida |
|---|---|
| ID no formato `TKT-` + 8 dígitos | `CHECK (codigo ~ '^TKT-[0-9]{8}$')` e `UNIQUE` |
| Data da solicitação não pode ser futura nem anterior à janela de 90 dias | gatilho na tabela `solicitacao` |
| `NÃO REALIZADO` exige motivo, e só ele aceita motivo | `CHECK` no item |
| Motivo `OUTROS` exige observação | `CHECK` no item |
| Linha sem matrícula só entra como `NÃO REALIZADO` / `SEM_MATRICULA` | `CHECK` no item |
| Turno que termina no dia seguinte exige virada de dia confirmada | `CHECK (hora_fim >= hora_ini OR vira_dia)` |
| A mesma linha (matrícula, data, horário e atividade) não entra duas vezes na solicitação | índice único `item_sem_repeticao` |
| Item só muda enquanto a solicitação está aberta | gatilho `item_estado`, que trava a solicitação e incrementa a versão |
| Conclusão com contagem desatualizada é recusada | `concluir_solicitacao(id, versao)` compara a versão exibida na tela |
| Toda alteração de status, motivo ou observação fica registrada | gatilho `item_auditoria` (quem, quando, antes, depois) |

### Concorrência

Dois analistas na mesma solicitação não sobrescrevem o trabalho um do outro:

- uma baixa enviada enquanto outro analista conclui a solicitação espera o bloqueio e falha ao encontrar o status `CONCLUIDA`;
- uma conclusão feita com a tela desatualizada falha na versão, e a tela recarrega;
- duas confirmações do mesmo lote de importação resultam em um único registro.

### Reconhecimento de solicitantes

O nome passa pela função `f_norm`, que remove acentos, caixa, pontuação e espaços extras: `" D'Ávila  S. "` vira `"d avila s"`.

- **Correspondência automática** só acontece quando há uma correspondência exata e única com um cadastro ou um alias aprovado.
- **Sugestões** usam similaridade por trigramas (`pg_trgm`). O limite inicial de 0,6 deve ser calibrado com nomes reais.
- **Homônimos** são permitidos. Se a busca encontra mais de uma pessoa, o analista escolhe, com apoio do e-mail ou da matrícula.
- Cada variação confirmada pelo analista vira um alias daquela pessoa.

### Retenção de dados

O armazenamento é limitado a **90 dias corridos** contados pela data da solicitação, incluindo o dia atual, no fuso `America/Sao_Paulo`.

- `expurgar_dados()` apaga as solicitações vencidas com seus itens e auditoria, e também os chamados que ficaram sem nenhuma solicitação.
- Prévias de importação são apagadas 24 horas após o envio, porque contêm nomes e matrículas.
- O expurgo registra apenas as contagens em `expurgo_log`, sem dados pessoais.
- Os backups do provedor estendem a retenção real. Com backups de 7 dias, um dado pode ser recuperado por até 97 dias. Configure o provedor com no máximo 7 dias.

Um TKT cujas solicitações foram todas apagadas pode voltar como chamado novo, sem histórico. Isso é coerente com o limite de armazenamento.

---

## Planilha aceita

O sistema lê a primeira aba visível do `.xlsx` e identifica o layout pelo cabeçalho. As colunas são localizadas pelo nome, em qualquer ordem. Acentos, maiúsculas, espaços e pontuação no cabeçalho são ignorados (`QUAL ATIVIDADE A SER LANÇADA :` é aceito). Linhas que só têm formatação são ignoradas.

### Layout de chamado (principal): uma linha por ajuste

O cabeçalho pode estar em qualquer uma das 15 primeiras linhas, abaixo de linhas de título.

| Coluna | Obrigatória | Conteúdo | Vai para |
|---|---|---|---|
| `MATRÍCULA` | sim (valor pode faltar, ver avisos) | somente números | `item.matricula` |
| `CÉLULA` | não | célula operacional / equipe (ex.: `Amil/TC`) | `item.celula` |
| `DATA INICIO ATIVIDADE` | sim | data do Excel, serial, `dd/mm/aaaa` ou `aaaa-mm-dd` | `item.data_ajuste` |
| `HORA INICIO ATIVIDADE` | sim | hora do Excel, fração do dia, `06:00`, `6:00`, `06h00`, `06:00:00` | `item.hora_ini` |
| `HORA FIM ATIVIDADE` | sim | mesmos formatos da hora de início | `item.hora_fim` |
| `QUAL ATIVIDADE A SER LANÇADA :` | sim | texto livre, casado com o catálogo pelo nome normalizado | `item.atividade_id` + `item.atividade_original` |
| `MOTIVO DO AJUSTE` | não | por que o ajuste foi pedido | `item.motivo_ajuste` |
| `NOME` ou `COLABORADOR` | não | nome do colaborador | `item.colaborador` |

`MOTIVO DO AJUSTE` descreve o pedido. O motivo de recusa (`NÃO REALIZADO`) é outra coisa: é a decisão do analista e fica em `item.motivo_codigo`.

A mesma matrícula pode ter várias atividades no mesmo dia. Uma atividade que ainda não existe no catálogo é cadastrada na confirmação da importação.

**Erros (bloqueiam a confirmação):** coluna obrigatória ausente, matrícula com caractere que não seja número, data vazia ou inexistente (ex.: `31/02/2026`), hora vazia ou fora de 00:00 a 23:59, início igual ao fim, atividade vazia, linha repetida (mesma matrícula, data, horário e atividade).

**Avisos (exigem conferência):** linha sem matrícula, atividade que termina no dia seguinte, duração menor que 5 minutos, horários da mesma matrícula que se sobrepõem, motivo do ajuste vazio, coluna fora do modelo (ignorada).

### Layout de escala: matriz colaborador × data

Mantido para as planilhas de escala mensal (`Escala_Nova.xlsx`).

| Coluna | Obrigatória | Conteúdo |
|---|---|---|
| `Operação` ou `Célula` | não | célula operacional, gravada em `item.celula` |
| `Matrícula` | sim | somente números |
| `Nome` | sim | nome do colaborador |
| uma coluna por data | ao menos uma | data do Excel, serial numérico ou texto `dd/mm/aaaa` |

Cada célula de data preenchida vira um item. Valores aceitos:

- **Turno:** `06:00 AS 14:20`, `09:00 ás 17:20`, `09:00 - 17:20`, `13:40 as 22:00`. Aceita `às`, `as`, `a`, `até`, hífen e meia-risca como separador.
- **Rótulos:** `DSR`, `Férias`, `Quebra de escala`. A grafia `Quegra de escala`, presente nas planilhas atuais, é reconhecida e preservada como valor original.

**Erros:** cabeçalho ausente ou desconhecido, data repetida, nenhuma coluna de data, nome vazio, matrícula inválida ou repetida, valor não reconhecido, horário impossível.

**Avisos:** linha sem matrícula, turno que vira o dia, descanso menor que 11 horas entre dois dias seguidos, turno com duração diferente do padrão da planilha, célula vazia.

### Nos dois layouts

- Cada problema é mostrado com a célula exata do Excel (`D4`, `F6`). Essa posição fica gravada em `item.ref_origem`.
- **Matrícula com zero à esquerda:** se a coluna estiver formatada como número, o Excel apaga o zero antes de o sistema receber o arquivo. Formate a coluna como texto na planilha modelo.

---

## Indicadores do painel

| Indicador | Contagem | Visão no banco |
|---|---|---|
| Pedidos por dia | solicitações e IDs distintos por `data_solicitacao`, com dia da semana | `v_pedidos_por_dia` |
| Dias de ponto mais solicitados | itens por `data_ajuste`, todos os status | `v_ajustes_por_data_ponto` |
| Ajuste mais pedido | itens por atividade lançada, todos os status | `v_ranking_atividades` |
| Itens por célula operacional | itens e IDs por célula, com status | `v_ranking_celulas` |
| Turnos mais pedidos (escala) | itens por horário de início e fim | `v_ranking_turnos` |
| Solicitante com mais IDs | chamados distintos, com pedidos e itens em colunas próprias | `v_ranking_solicitantes` |
| Taxa de realização | realizados ÷ (realizados + não realizados); pendentes exibidos ao lado | `v_ranking_solicitantes` |

Os dois gráficos de data indicam qual campo governa o período. Um pedido recebido em 10/11 para a escala de 28/10 conta em 10/11 no gráfico de recebimento e em 28/10 no gráfico de ponto.

---

## Tecnologias

| Camada | Tecnologia | Versão | Papel |
|---|---|---|---|
| Aplicação web | Next.js (App Router + Route Handlers) | 15.5 | interface e API na mesma implantação |
| Linguagem | TypeScript | 5 | tipagem do leitor, das rotas e das telas |
| Interface | React | 19.1 | componentes das telas |
| Estilo | Tailwind CSS | 4 | layout e estilos |
| Banco de dados | PostgreSQL | 16 | dados, regras de integridade, auditoria e visões do painel |
| Extensões do banco | `unaccent`, `pg_trgm` | | normalização de nomes e busca por semelhança |
| Leitura de Excel | exceljs | 4.4.0 | leitura do `.xlsx` no servidor |
| Validação de entrada | Zod | 3.25 | validação do formulário e da API (prevista) |
| Testes | Vitest | 3.2 | testes do leitor da planilha |
| Testes do banco | SQL + psql | | regras de negócio testadas direto no PostgreSQL |

**Por que as regras ficam no banco.** Formato do ID, coerência entre status e motivo, bloqueio por estado e auditoria são garantidos por `CHECK`, gatilhos e funções. Uma requisição que contorne a interface continua sujeita às mesmas regras.

**Por que a planilha é lida só no servidor.** Um único leitor evita divergência entre a prévia mostrada ao analista e o que é gravado.

**Hospedagem prevista:** PostgreSQL gerenciado (Supabase ou Neon) e Next.js em plataforma compatível com Node 20 ou superior.

---

## Estrutura do repositório

```
app/                          páginas e rotas do Next.js (modelo inicial)
lib/importacao/
  index.ts                    lerPlanilha(): identifica o layout e devolve itens e problemas
  chamado.ts                  leitor do layout de chamado (uma linha por ajuste)
  escala.ts                   leitor do layout de escala (matriz colaborador × data)
  comum.ts                    tipos, normalização, leitura de data e hora do Excel
  *.test.ts                   testes com planilhas fictícias geradas em memória
db/
  migrations/
    001_schema.sql            tabelas, regras, auditoria, lote de importação, conclusão
    002_retencao.sql          expurgo de 90 dias e log
    003_painel.sql            visões dos indicadores
  tests/001_regras.sql        testes das regras de negócio
  run-tests.sh                recria banco descartável e roda os testes
```

---

## Como executar

**Requisitos:** Node.js 20 ou superior, PostgreSQL 16 com as extensões `unaccent` e `pg_trgm`.

```bash
npm install

# testes do leitor da planilha
npm test

# testes do banco: recria o banco "pontobsa_test", aplica as migrações e roda as regras
npm run test:db

# servidor de desenvolvimento
npm run dev
```

**Criar o banco de trabalho:**

```bash
createdb pontobsa
for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d pontobsa -f "$f"; done
```

**Agendar o expurgo diário** (pg_cron, cron da plataforma ou agendador externo):

```sql
SELECT * FROM expurgar_dados();
```

A aplicação deve executar `SET LOCAL app.usuario_id = '<id do analista>'` no início de cada transação. A auditoria e a função de conclusão usam esse valor para registrar o autor.

---

## Segurança e dados pessoais

- Acesso restrito a analistas e administradores. Solicitantes não entram no sistema.
- Planilhas reais nunca entram no repositório: `*.xlsx`, `*.xls` e `*.csv` estão no `.gitignore`. Os testes geram planilhas fictícias no mesmo formato.
- Nomes e matrículas são dados pessoais. O prazo de 90 dias e a retenção dos backups devem ser validados por quem responde pela LGPD na empresa.

---

## Situação do projeto

| Parte | Situação |
|---|---|
| Esquema do banco, regras e auditoria | pronto, testado |
| Expurgo de 90 dias | função pronta e testada; agendamento pendente |
| Visões do painel | prontas |
| Leitor da planilha | pronto para os dois layouts; 23 testes com planilhas fictícias; escala validada com arquivo real (76 itens, 0 erros); layout de chamado ainda sem arquivo real |
| Autenticação de analistas | pendente |
| Formulário, upload e prévia | pendente |
| Tela de conferência e conclusão | pendente |
| Histórico por solicitante e busca | pendente |
| Painel com gráficos | pendente |

### Decisões em aberto

1. **A escala continua chegando nos chamados?** Se todo chamado vier no layout de linha por ajuste, o leitor de escala pode ser removido.
2. **Horas obrigatórias.** Hoje toda linha de chamado exige início e fim. Se existir atividade de dia inteiro (ex.: abono), a regra precisa de exceção.
3. **Catálogo de atividades.** Texto livre gera variações ("Treinamento", "Treinamento EAD"). Definir se a lista é fechada ou se o analista aprova atividades novas.
4. **Célula como filtro do painel.** O campo já é gravado em cada item, e a visão `v_ranking_celulas` existe.
