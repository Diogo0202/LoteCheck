/**
 * Leitor da planilha de chamado: uma linha por ajuste.
 *
 * Cabeçalho (qualquer ordem, localizado nas 15 primeiras linhas):
 *   MATRÍCULA | CÉLULA | DATA INICIO ATIVIDADE | HORA INICIO ATIVIDADE |
 *   HORA FIM ATIVIDADE | QUAL ATIVIDADE A SER LANÇADA : | MOTIVO DO AJUSTE
 */
import type ExcelJS from "exceljs";
import {
  type ItemImportado,
  type Problema,
  MATRICULA,
  colunaLetra,
  hhmm,
  lerData,
  lerHora,
  normalizar,
  normalizarCabecalho,
  ordenarProblemas,
  texto,
} from "./comum";

export const COLUNAS_CHAMADO = {
  matricula: { cabecalho: "MATRÍCULA", chaves: ["matricula"], obrigatoria: true },
  celula: { cabecalho: "CÉLULA", chaves: ["celula"], obrigatoria: false },
  data: { cabecalho: "DATA INICIO ATIVIDADE", chaves: ["data inicio atividade"], obrigatoria: true },
  horaIni: { cabecalho: "HORA INICIO ATIVIDADE", chaves: ["hora inicio atividade"], obrigatoria: true },
  horaFim: { cabecalho: "HORA FIM ATIVIDADE", chaves: ["hora fim atividade"], obrigatoria: true },
  atividade: { cabecalho: "QUAL ATIVIDADE A SER LANÇADA", chaves: ["qual atividade a ser lancada"], obrigatoria: true },
  motivo: { cabecalho: "MOTIVO DO AJUSTE", chaves: ["motivo do ajuste"], obrigatoria: false },
  colaborador: { cabecalho: "NOME", chaves: ["nome", "colaborador", "nome do colaborador"], obrigatoria: false },
} as const;

type Coluna = keyof typeof COLUNAS_CHAMADO;

const MIN_DURACAO = 5; // minutos

/** Procura a linha de cabeçalho: precisa ter MATRÍCULA e QUAL ATIVIDADE A SER LANÇADA. */
export function acharCabecalhoChamado(ws: ExcelJS.Worksheet): number | null {
  const limite = Math.min(ws.rowCount, 15);
  for (let r = 1; r <= limite; r++) {
    const vals: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
      vals.push(normalizarCabecalho(texto(c.value)));
    });
    if (vals.includes("matricula") && vals.includes("qual atividade a ser lancada")) return r;
  }
  return null;
}

export function lerChamado(ws: ExcelJS.Worksheet, linhaCab: number): { itens: ItemImportado[]; problemas: Problema[] } {
  const itens: ItemImportado[] = [];
  const problemas: Problema[] = [];
  const erro = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "erro", ...p });
  const aviso = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "aviso", ...p });

  // --- cabeçalho
  const col: Partial<Record<Coluna, number>> = {};
  ws.getRow(linhaCab).eachCell({ includeEmpty: false }, (cell, c) => {
    const n = normalizarCabecalho(texto(cell.value));
    if (!n) return;
    const chave = (Object.keys(COLUNAS_CHAMADO) as Coluna[]).find((k) =>
      (COLUNAS_CHAMADO[k].chaves as readonly string[]).includes(n),
    );
    if (chave) col[chave] = c;
    else
      aviso({
        codigo: "CABECALHO_DESCONHECIDO",
        linha: linhaCab,
        celula: `${colunaLetra(c)}${linhaCab}`,
        mensagem: `Coluna "${texto(cell.value).trim()}" não faz parte do modelo e será ignorada.`,
      });
  });
  for (const k of Object.keys(COLUNAS_CHAMADO) as Coluna[]) {
    if (COLUNAS_CHAMADO[k].obrigatoria && !col[k]) {
      erro({ codigo: "CABECALHO_AUSENTE", linha: linhaCab, mensagem: `Coluna "${COLUNAS_CHAMADO[k].cabecalho}" não encontrada.` });
    }
  }
  if (problemas.some((p) => p.nivel === "erro")) return { itens, problemas };

  const ref = (k: Coluna, r: number) => `${colunaLetra(col[k]!)}${r}`;
  const cel = (row: ExcelJS.Row, k: Coluna) => (col[k] ? row.getCell(col[k]!).value : null);
  const txt = (row: ExcelJS.Row, k: Coluna) => texto(cel(row, k)).trim();

  // intervalos absolutos (minutos desde 1970) por matrícula, para repetição e sobreposição
  const intervalos = new Map<string, { ini: number; fim: number; linha: number; chave: string }[]>();

  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r <= linhaCab) return;
    const usadas = (Object.keys(col) as Coluna[]).map((k) => txt(row, k));
    if (usadas.every((v) => v === "")) return; // linha só com formatação

    let ok = true;

    // matrícula
    let matricula: string | null = txt(row, "matricula") || null;
    if (matricula === null) {
      aviso({
        codigo: "SEM_MATRICULA",
        linha: r,
        celula: ref("matricula", r),
        mensagem: "Linha sem matrícula: entra como NÃO REALIZADO (SEM_MATRICULA) se você confirmar.",
      });
    } else if (!MATRICULA.test(matricula)) {
      erro({ codigo: "MATRICULA_INVALIDA", linha: r, celula: ref("matricula", r), mensagem: `Matrícula "${matricula}" deve conter só números.` });
      matricula = null;
      ok = false;
    }

    // data
    const data = lerData(cel(row, "data"));
    if (!txt(row, "data")) {
      erro({ codigo: "DATA_AUSENTE", linha: r, celula: ref("data", r), mensagem: "Data de início da atividade vazia." });
      ok = false;
    } else if (!data) {
      erro({ codigo: "DATA_INVALIDA", linha: r, celula: ref("data", r), mensagem: `Data "${txt(row, "data")}" inválida. Use dd/mm/aaaa.` });
      ok = false;
    }

    // horas
    const horas: Record<"horaIni" | "horaFim", number | null> = { horaIni: null, horaFim: null };
    for (const k of ["horaIni", "horaFim"] as const) {
      const rotulo = k === "horaIni" ? "início" : "fim";
      if (!txt(row, k)) {
        erro({ codigo: "HORA_AUSENTE", linha: r, celula: ref(k, r), mensagem: `Hora de ${rotulo} vazia.` });
        ok = false;
        continue;
      }
      horas[k] = lerHora(cel(row, k));
      if (horas[k] === null) {
        erro({ codigo: "HORA_INVALIDA", linha: r, celula: ref(k, r), mensagem: `Hora de ${rotulo} "${txt(row, k)}" inválida. Use hh:mm.` });
        ok = false;
      }
    }
    const ini = horas.horaIni, fimDia = horas.horaFim;
    let viraDia = false;
    let duracao = 0;
    if (ini !== null && fimDia !== null) {
      if (ini === fimDia) {
        erro({ codigo: "HORA_INVALIDA", linha: r, celula: ref("horaFim", r), mensagem: `Início e fim iguais (${hhmm(ini)}).` });
        ok = false;
      } else {
        viraDia = fimDia < ini;
        duracao = fimDia - ini + (viraDia ? 1440 : 0);
        if (viraDia) {
          aviso({
            codigo: "VIRA_DIA",
            linha: r,
            celula: ref("horaFim", r),
            mensagem: `${hhmm(ini)} até ${hhmm(fimDia)} termina no dia seguinte. Confirme a virada de dia.`,
          });
        }
        if (duracao < MIN_DURACAO) {
          aviso({ codigo: "DURACAO_CURTA", linha: r, celula: ref("horaFim", r), mensagem: `Atividade de ${duracao} min. Confira os horários.` });
        }
      }
    }

    // atividade e motivo
    const atividadeOriginal = txt(row, "atividade");
    if (!atividadeOriginal) {
      erro({ codigo: "ATIVIDADE_AUSENTE", linha: r, celula: ref("atividade", r), mensagem: "Atividade a ser lançada vazia." });
      ok = false;
    }
    const motivo = txt(row, "motivo") || null;
    if (!motivo) {
      aviso({
        codigo: "MOTIVO_AUSENTE",
        linha: r,
        celula: col.motivo ? ref("motivo", r) : undefined,
        mensagem: "Motivo do ajuste não informado.",
      });
    }

    if (!ok || !data || ini === null || fimDia === null) return;

    // repetição e sobreposição (mesma matrícula)
    if (matricula) {
      const base = Date.parse(data + "T00:00:00Z") / 60000;
      const atual = { ini: base + ini, fim: base + ini + duracao, linha: r, chave: `${data}|${ini}|${fimDia}|${normalizar(atividadeOriginal)}` };
      const lista = intervalos.get(matricula) ?? [];
      const repetida = lista.find((o) => o.chave === atual.chave);
      if (repetida) {
        erro({
          codigo: "LINHA_REPETIDA",
          linha: r,
          celula: ref("atividade", r),
          mensagem: `Mesma matrícula, data, horário e atividade da linha ${repetida.linha}.`,
        });
        return;
      }
      const conflito = lista.find((o) => atual.ini < o.fim && o.ini < atual.fim);
      if (conflito) {
        aviso({
          codigo: "SOBREPOSICAO",
          linha: r,
          celula: ref("horaIni", r),
          mensagem: `Matrícula ${matricula}: horário se sobrepõe ao da linha ${conflito.linha}.`,
        });
      }
      lista.push(atual);
      intervalos.set(matricula, lista);
    }

    itens.push({
      linha: r,
      ref: ref("atividade", r),
      celula: txt(row, "celula") || null,
      matricula,
      colaborador: txt(row, "colaborador") || null,
      data,
      horaIni: hhmm(ini),
      horaFim: hhmm(fimDia),
      viraDia,
      atividade: atividadeOriginal.replace(/\s+/g, " "),
      atividadeOriginal,
      motivoAjuste: motivo,
    });
  });

  return { itens, problemas: ordenarProblemas(problemas) };
}
