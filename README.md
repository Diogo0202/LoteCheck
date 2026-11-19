# PontoBsa
Sistema de validação de chamados de escala (Next.js 15 + PostgreSQL 16).

## Modelo
`chamado` (TKT-########) → `solicitacao` (cada planilha enviada) → `item` (cada célula colaborador × data).

## Planilha aceita
Primeira aba visível. Linha 1: `Operação` (opcional) | `Matrícula` | `Nome` | uma coluna por data.
Colunas localizadas pelo nome do cabeçalho, em qualquer ordem. Células de data aceitam:
- turno: `06:00 AS 14:20`, `09:00 ás 17:20`, `09:00 - 17:20`, `13:40 as 22:00`
- rótulos: `DSR`, `Férias`, `Quebra de escala` (inclusive a grafia `Quegra de escala`)

Leitor: `lib/importacao/escala.ts`. Erros bloqueiam a confirmação; avisos exigem conferência.

## Comandos
```bash
npm install
npm test          # leitor da planilha (vitest)
npm run test:db   # migrações + regras no PostgreSQL local (banco descartável)
npm run dev
```

Retenção: 90 dias corridos por `data_solicitacao` (America/Sao_Paulo).
Agendar diariamente `SELECT * FROM expurgar_dados();` e manter backups do provedor em no máximo 7 dias.

Planilhas reais não entram no repositório (`*.xlsx` no `.gitignore`).
