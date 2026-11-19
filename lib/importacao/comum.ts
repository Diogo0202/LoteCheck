/** Tipos e utilitários compartilhados pelos leitores de planilha. */
import type ExcelJS from "exceljs";

/** Item pronto para a prévia e para a gravação. Mesmo formato para os dois layouts. */
export interface ItemImportado {
  linha: number;
  ref: string; // posição no Excel que origina o item ("F5", "H2")
  celula: string | null; // célula operacional / equipe
  matricula: string | null;
  colaborador: string | null;
  data: string; // YYYY-MM-DD
  horaIni: string | null; // HH:MM
  horaFim: string | null;
  viraDia: boolean;
  atividade: string; // nome da atividade, casado com o catálogo por nome normalizado
  atividadeOriginal: string; // texto como veio
  motivoAjuste: string | null;
}

export type CodigoProblema =
  | "PLANILHA_VAZIA"
  | "CABECALHO_AUSENTE"
  | "CABECALHO_DESCONHECIDO"
  | "LAYOUT_DESCONHECIDO"
  | "DATA_DUPLICADA"
  | "SEM_COLUNA_DATA"
  | "NOME_AUSENTE"
  | "SEM_MATRICULA"
  | "MATRICULA_INVALIDA"
  | "MATRICULA_DUPLICADA"
  | "DATA_AUSENTE"
  | "DATA_INVALIDA"
  | "HORA_AUSENTE"
  | "HORA_INVALIDA"
  | "ATIVIDADE_AUSENTE"
  | "VALOR_DESCONHECIDO"
  | "HORARIO_INVALIDO"
  | "VIRA_DIA"
  | "DURACAO_CURTA"
  | "DURACAO_ATIPICA"
  | "INTERJORNADA"
  | "SOBREPOSICAO"
  | "LINHA_REPETIDA"
  | "MOTIVO_AUSENTE"
  | "CELULA_VAZIA";

export interface Problema {
  nivel: "erro" | "aviso";
  codigo: CodigoProblema;
  linha: number;
  celula?: string; // referência no Excel
  mensagem: string;
}

/** Sem acento, minúsculas, traço tipográfico vira hífen, espaços colapsados. */
export function normalizar(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Para cabeçalhos: além de normalizar, pontuação vira espaço ("LANÇADA :" -> "lancada"). */
export function normalizarCabecalho(s: string): string {
  return normalizar(s).replace(/[^a-z0-9]+/g, " ").trim();
}

export function colunaLetra(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function texto(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return texto(v.result as ExcelJS.CellValue);
    if ("text" in v) return String(v.text);
  }
  return String(v);
}

/** Valor efetivo da célula (resolve fórmulas). */
export function valor(v: ExcelJS.CellValue): ExcelJS.CellValue {
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v) return v.result as ExcelJS.CellValue;
  return v;
}

const SERIAL_EPOCH = Date.UTC(1899, 11, 30);

/** Data: Date do Excel (exceljs entrega em UTC), serial numérico, dd/mm/aaaa ou aaaa-mm-dd. */
export function lerData(bruto: ExcelJS.CellValue): string | null {
  const v = valor(bruto);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return new Date(SERIAL_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const t = texto(v).trim();
  let iso: string | null = null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) iso = t;
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : null;
}

/**
 * Hora em minutos desde 00:00. Aceita célula de hora do Excel (Date em 1899-12-30 UTC
 * ou fração do dia), data+hora, e texto "06:00", "6:00", "06h00", "06:00:00".
 */
export function lerHora(bruto: ExcelJS.CellValue): number | null {
  const v = valor(bruto);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const total = Math.round((v.getTime() - Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) / 60000);
    return total % 1440;
  }
  if (typeof v === "number" && v >= 0) {
    return Math.round((v % 1) * 1440) % 1440;
  }
  const m = /^(\d{1,2})[:h](\d{2})(?::(\d{2}))?$/i.exec(texto(v).trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export const MATRICULA = /^[0-9]+$/;

export function ordenarProblemas(p: Problema[]): Problema[] {
  const col = (ref?: string) => (ref ? (/^[A-Z]+/.exec(ref)?.[0] ?? "") : "");
  return p.sort(
    (a, b) =>
      a.linha - b.linha ||
      col(a.celula).length - col(b.celula).length ||
      col(a.celula).localeCompare(col(b.celula)),
  );
}
