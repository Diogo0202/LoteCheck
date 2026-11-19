/**
 * Ponto de entrada da importação: identifica o layout da planilha e devolve
 * itens + problemas no mesmo formato, prontos para a prévia.
 *
 * Layouts aceitos:
 *   CHAMADO  uma linha por ajuste (MATRÍCULA, CÉLULA, DATA INICIO ATIVIDADE, ...)
 *   ESCALA   matriz colaborador × data
 */
import ExcelJS from "exceljs";
import { acharCabecalhoChamado, COLUNAS_CHAMADO, lerChamado } from "./chamado";
import type { ItemImportado, Problema } from "./comum";
import { lerEscala, pareceEscala } from "./escala";

export type { ItemImportado, Problema } from "./comum";
export type Layout = "CHAMADO" | "ESCALA";

export interface ResultadoLeitura {
  layout: Layout | null;
  itens: ItemImportado[];
  problemas: Problema[];
  resumo: {
    itens: number;
    matriculas: number;
    erros: number;
    avisos: number;
    porAtividade: Record<string, number>;
    periodo: { inicio: string; fim: string } | null;
  };
}

function resumir(layout: Layout | null, itens: ItemImportado[], problemas: Problema[]): ResultadoLeitura {
  const porAtividade: Record<string, number> = {};
  for (const i of itens) porAtividade[i.atividade] = (porAtividade[i.atividade] ?? 0) + 1;
  const datas = itens.map((i) => i.data).sort();
  return {
    layout,
    itens,
    problemas,
    resumo: {
      itens: itens.length,
      matriculas: new Set(itens.map((i) => i.matricula).filter(Boolean)).size,
      erros: problemas.filter((p) => p.nivel === "erro").length,
      avisos: problemas.filter((p) => p.nivel === "aviso").length,
      porAtividade,
      periodo: datas.length ? { inicio: datas[0], fim: datas[datas.length - 1] } : null,
    },
  };
}

export async function lerPlanilha(arquivo: ArrayBuffer | Buffer): Promise<ResultadoLeitura> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(arquivo as ArrayBuffer);
  } catch {
    return resumir(null, [], [
      { nivel: "erro", codigo: "PLANILHA_VAZIA", linha: 1, mensagem: "Arquivo não é um .xlsx válido." },
    ]);
  }
  const ws = wb.worksheets.find((w) => w.state === "visible") ?? wb.worksheets[0];
  if (!ws || ws.actualRowCount === 0) {
    return resumir(null, [], [{ nivel: "erro", codigo: "PLANILHA_VAZIA", linha: 1, mensagem: "A planilha não tem dados." }]);
  }

  const cab = acharCabecalhoChamado(ws);
  if (cab !== null) {
    const r = lerChamado(ws, cab);
    return resumir("CHAMADO", r.itens, r.problemas);
  }
  if (pareceEscala(ws)) {
    const r = lerEscala(ws);
    return resumir("ESCALA", r.itens, r.problemas);
  }
  const esperadas = Object.values(COLUNAS_CHAMADO)
    .filter((c) => c.obrigatoria)
    .map((c) => c.cabecalho)
    .join(", ");
  return resumir(null, [], [
    {
      nivel: "erro",
      codigo: "LAYOUT_DESCONHECIDO",
      linha: 1,
      mensagem: `Cabeçalho não reconhecido. Colunas obrigatórias: ${esperadas}.`,
    },
  ]);
}
