# PontoBsa
Sistema de validação de chamados de ajuste de ponto.

## Banco de dados (PostgreSQL 16)

Hierarquia: `chamado` (TKT-########) → `solicitacao` (cada planilha enviada) → `item` (cada ajuste).

```bash
createdb pontobsa
for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d pontobsa -f "$f"; done
# testes (rodam em transação e fazem ROLLBACK)
psql -v ON_ERROR_STOP=1 -d pontobsa -f db/tests/001_regras.sql
```

Retenção: 90 dias corridos por `data_solicitacao` (fuso America/Sao_Paulo).
Agendar diariamente: `SELECT * FROM expurgar_dados();`
A retenção dos backups do provedor deve ser configurada em no máximo 7 dias.
