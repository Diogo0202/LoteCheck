# PontoBsa

Sistema web interno para registrar chamados de escala, conferir o que foi executado e medir a demanda por solicitante. O analista informa o ID do chamado, escolhe o solicitante e envia a planilha de escala. O sistema converte cada célula da planilha em um item, o analista marca o que não foi realizado e o painel consolida os números dos últimos 90 dias.

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

Um chamado com 76 células e 2 exceções fecha com 2 marcações e 1 conclusão.

### Hierarquia dos dados

```
chamado (TKT-00001234)          um solicitante por chamado
  └── solicitação               cada planilha enviada, com a própria data
        └── item                cada célula da escala (colaborador × data)
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
| Mesma pessoa no mesmo dia, uma vez por solicitação | índice único parcial `(solicitacao_id, matricula, data_ajuste)` |
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

Primeira aba visível do arquivo `.xlsx`.

| Coluna | Obrigatória | Conteúdo |
|---|---|---|
| `Operação` | não | operação ou cliente (ex.: `Amil/TC`) |
| `Matrícula` | sim | somente números |
| `Nome` | sim | nome do colaborador |
| uma coluna por data | ao menos uma | data do Excel, serial numérico ou texto `dd/mm/aaaa` |

As colunas são localizadas pelo nome do cabeçalho, em qualquer ordem. Linhas que só têm formatação são ignoradas.

**Valores aceitos nas células de data:**

- **Turno:** `06:00 AS 14:20`, `09:00 ás 17:20`, `09:00 - 17:20`, `13:40 as 22:00`. Aceita `às`, `as`, `a`, `até`, hífen e meia-risca como separador.
- **Rótulos:** `DSR`, `Férias`, `Quebra de escala`. A grafia `Quegra de escala`, presente nas planilhas atuais, é reconhecida e preservada como valor original.

**Erros (bloqueiam a confirmação):** planilha vazia, cabeçalho ausente ou desconhecido, data repetida, nenhuma coluna de data, nome vazio, matrícula inválida ou repetida, valor não reconhecido, horário impossível.

**Avisos (exigem conferência):** linha sem matrícula, turno que vira o dia, descanso menor que 11 horas entre dois dias seguidos, turno com duração diferente do padrão da planilha, célula vazia.

> **Matrícula com zero à esquerda:** se a coluna estiver formatada como número, o Excel apaga o zero antes de o sistema receber o arquivo. Formate a coluna como texto na planilha modelo.

---

## Indicadores do painel

| Indicador | Contagem | Visão no banco |
|---|---|---|
| Pedidos por dia | solicitações e IDs distintos por `data_solicitacao`, com dia da semana | `v_pedidos_por_dia` |
| Dias de ponto mais solicitados | itens por `data_ajuste`, todos os status | `v_ajustes_por_data_ponto` |
| Ajuste mais pedido | itens por tipo (Turno, DSR, Férias, Quebra de escala), todos os status | `v_ranking_atividades` |
| Turnos mais pedidos | itens por horário de início e fim | `v_ranking_turnos` |
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
  escala.ts                   leitor da planilha de escala
  escala.test.ts              testes do leitor com planilhas fictícias
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
| Leitor da planilha | pronto, testado com planilha fictícia e validado com uma planilha real (76 células, 0 erros) |
| Autenticação de analistas | pendente |
| Formulário, upload e prévia | pendente |
| Tela de conferência e conclusão | pendente |
| Histórico por solicitante e busca | pendente |
| Painel com gráficos | pendente |

### Decisões em aberto

1. **O que conta como ajuste pedido:** toda célula da escala ou só as que mudaram. Com toda célula, o ranking de ajustes descreve a escala, e não a demanda. O sistema guarda todas as células, o que mantém as duas opções abertas.
2. **Outros rótulos possíveis** além de DSR, Férias e Quebra de escala (ex.: Folga, Atestado). Hoje, um rótulo desconhecido bloqueia a importação de propósito.
3. **Operação como filtro do painel.** O campo já é gravado em cada item.
