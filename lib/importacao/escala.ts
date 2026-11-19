/**
 * Leitor da planilha de escala (formato "Escala_Nova.xlsx").
 *
 * Layout esperado na primeira aba:
 *   linha 1: Operação | Matrícula | Nome | <data> | <data> | ...
 *   demais:  uma linha por colaborador; cada célula de data contém um turno
 *            ("06:00 AS 14:20", "09:00 - 17:20", "13:40 às 22:00") ou um rótulo
 *            (DSR, Férias, Quebra de escala).
 *
 * Cada célula de data preenchida vira um item. Nada é gravado aqui: o resultado
 * alimenta a prévia, e erros bloqueiam a confirmação.
 */
import ExcelJS from "exceljs";

export type Tipo = "TURNO" | "DSR" | "FERIAS" | "QUEBRA_ESCALA";

export interface ItemEscala {
  linha: number;
  celula: string;
  operacao: string | null;
  matricula: string | null;
  colaborador: string;
  data: string; // YYYY-MM-DD
  tipo: Tipo;
  horaIni: string | null; // HH:MM
  horaFim: string | null;
  viraDia: boolean;
  valorOriginal: string;
}

export type CodigoProblema =
  | "PLANILHA_VAZIA"
  | "CABECALHO_AUSENTE"
  | "CABECALHO_DESCONHECIDO"
  | "DATA_DUPLICADA"
  | "SEM_COLUNA_DATA"
  | "NOME_AUSENTE"
  | "SEM_MATRICULA"
  | "MATRICULA_INVALIDA"
  | "MATRICULA_DUPLICADA"
  | "VALOR_DESCONHECIDO"
  | "HORARIO_INVALIDO"
  | "VIRA_DIA"
  | "DURACAO_ATIPICA"
  | "INTERJORNADA"
  | "CELULA_VAZIA";

export interface Problema {
  nivel: "erro" | "aviso";
  codigo: CodigoProblema;
  linha: number;
  celula?: string;
  mensagem: string;
}

export interface ResultadoLeitura {
  itens: ItemEscala[];
  problemas: Problema[];
  resumo: {
    colaboradores: number;
    datas: number;
    itens: number;
    porTipo: Record<Tipo, number>;
    periodo: { inicio: string; fim: string } | null;
  };
}

/** Sem acento, minúsculas, espaços colapsados. Mesma regra de f_norm() no banco. */
export function normalizar(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Variações conhecidas de rótulo. Chave já normalizada. */
export const ROTULOS: Record<string, Exclude<Tipo, "TURNO">> = {
  dsr: "DSR",
  ferias: "FERIAS",
  "quebra de escala": "QUEBRA_ESCALA",
  "quegra de escala": "QUEBRA_ESCALA",
};

const TURNO = /^(\d{1,2})[:h](\d{2})\s*(?:as|a|ate|-)\s*(\d{1,2})[:h](\d{2})$/;
const MATRICULA = /^[0-9]+$/;
const INTERJORNADA_MIN = 11 * 60;

const CABECALHOS = { operacao: "operacao", matricula: "matricula", nome: "nome" } as const;

export function colunaLetra(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function texto(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return texto(v.result as ExcelJS.CellValue);
    if ("text" in v) return String(v.text);
  }
  return String(v);
}

/** Data do cabeçalho: Date do Excel, serial numérico ou texto dd/mm/aaaa. */
function dataCabecalho(v: ExcelJS.CellValue): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10); // exceljs entrega datas em UTC
  if (typeof v === "number" && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto(v).trim());
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    const d = new Date(iso + "T00:00:00Z");
    if (!Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso)) return iso;
  }
  return null;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

const diaMs = 86400000;
const diasEntre = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / diaMs;

export async function lerEscala(arquivo: ArrayBuffer | Buffer): Promise<ResultadoLeitura> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arquivo as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.state === "visible") ?? wb.worksheets[0];

  const itens: ItemEscala[] = [];
  const problemas: Problema[] = [];
  const erro = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "erro", ...p });
  const aviso = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "aviso", ...p });
  const vazio = (): ResultadoLeitura => ({
    itens: [],
    problemas,
    resumo: { colaboradores: 0, datas: 0, itens: 0, porTipo: { TURNO: 0, DSR: 0, FERIAS: 0, QUEBRA_ESCALA: 0 }, periodo: null },
  });

  if (!ws || ws.actualRowCount === 0) {
    erro({ codigo: "PLANILHA_VAZIA", linha: 1, mensagem: "A planilha não tem dados." });
    return vazio();
  }

  // --- cabeçalho: colunas localizadas pelo nome, não pela posição
  const col: Partial<Record<keyof typeof CABECALHOS, number>> = {};
  const datas = new Map<number, string>();
  const vistas = new Map<string, string>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, c) => {
    const ref = `${colunaLetra(c)}1`;
    const data = dataCabecalho(cell.value);
    if (data) {
      if (vistas.has(data)) {
        erro({ codigo: "DATA_DUPLICADA", linha: 1, celula: ref, mensagem: `Data ${data} repetida (também em ${vistas.get(data)}).` });
      } else {
        vistas.set(data, ref);
        datas.set(c, data);
      }
      return;
    }
    const n = normalizar(texto(cell.value));
    const chave = (Object.keys(CABECALHOS) as (keyof typeof CABECALHOS)[]).find((k) => CABECALHOS[k] === n);
    if (chave) col[chave] = c;
    else erro({ codigo: "CABECALHO_DESCONHECIDO", linha: 1, celula: ref, mensagem: `Cabeçalho "${texto(cell.value)}" não reconhecido.` });
  });
  for (const k of ["matricula", "nome"] as const) {
    if (!col[k]) erro({ codigo: "CABECALHO_AUSENTE", linha: 1, mensagem: `Coluna "${k === "matricula" ? "Matrícula" : "Nome"}" não encontrada na linha 1.` });
  }
  if (datas.size === 0) erro({ codigo: "SEM_COLUNA_DATA", linha: 1, mensagem: "Nenhuma coluna de data encontrada na linha 1." });
  if (problemas.some((p) => p.nivel === "erro")) return vazio();

  // --- linhas
  const matriculas = new Map<string, number>();
  const duracoes = new Map<number, number>();
  const turnos: { item: ItemEscala; ini: number; fim: number }[] = [];

  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r === 1) return;
    const valores = [col.operacao, col.matricula, col.nome, ...datas.keys()]
      .filter((c): c is number => !!c)
      .map((c) => texto(row.getCell(c).value).trim());
    if (valores.every((v) => v === "")) return; // linha só com formatação

    const nome = texto(row.getCell(col.nome!).value).trim();
    const operacao = col.operacao ? texto(row.getCell(col.operacao).value).trim() || null : null;
    const matCell = row.getCell(col.matricula!);
    let matricula: string | null = texto(matCell.value).trim() || null;

    if (!nome) erro({ codigo: "NOME_AUSENTE", linha: r, celula: `${colunaLetra(col.nome!)}${r}`, mensagem: "Nome do colaborador vazio." });
    if (matricula === null) {
      aviso({
        codigo: "SEM_MATRICULA",
        linha: r,
        celula: matCell.address,
        mensagem: `${nome || "Colaborador"} sem matrícula: os itens da linha entram como NÃO REALIZADO (SEM_MATRICULA) se você confirmar.`,
      });
    } else if (!MATRICULA.test(matricula)) {
      erro({ codigo: "MATRICULA_INVALIDA", linha: r, celula: matCell.address, mensagem: `Matrícula "${matricula}" deve conter só números.` });
      matricula = null;
    } else if (matriculas.has(matricula)) {
      erro({ codigo: "MATRICULA_DUPLICADA", linha: r, celula: matCell.address, mensagem: `Matrícula ${matricula} repetida (linha ${matriculas.get(matricula)}).` });
    } else {
      matriculas.set(matricula, r);
    }

    for (const [c, data] of datas) {
      const cell = row.getCell(c);
      const ref = cell.address;
      const original = texto(cell.value).trim();
      if (!original) {
        aviso({ codigo: "CELULA_VAZIA", linha: r, celula: ref, mensagem: `${nome}: ${data} sem valor; nenhum item criado.` });
        continue;
      }
      const n = normalizar(original);
      const base = { linha: r, celula: ref, operacao, matricula, colaborador: nome, data, valorOriginal: original };

      const rotulo = ROTULOS[n];
      if (rotulo) {
        itens.push({ ...base, tipo: rotulo, horaIni: null, horaFim: null, viraDia: false });
        continue;
      }
      const m = TURNO.exec(n);
      if (!m) {
        erro({ codigo: "VALOR_DESCONHECIDO", linha: r, celula: ref, mensagem: `Valor "${original}" não reconhecido como turno, DSR, férias ou quebra de escala.` });
        continue;
      }
      const [h1, m1, h2, m2] = m.slice(1).map(Number);
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) {
        erro({ codigo: "HORARIO_INVALIDO", linha: r, celula: ref, mensagem: `Horário "${original}" fora do intervalo 00:00–23:59.` });
        continue;
      }
      const ini = h1 * 60 + m1;
      let fim = h2 * 60 + m2;
      const viraDia = fim <= ini;
      if (viraDia) {
        fim += 1440;
        aviso({ codigo: "VIRA_DIA", linha: r, celula: ref, mensagem: `"${original}" termina no dia seguinte. Confirme a virada de dia.` });
      }
      const item: ItemEscala = { ...base, tipo: "TURNO", horaIni: hhmm(ini), horaFim: hhmm(fim), viraDia };
      itens.push(item);
      turnos.push({ item, ini, fim });
      duracoes.set(fim - ini, (duracoes.get(fim - ini) ?? 0) + 1);
    }
  });

  // --- avisos que dependem do conjunto
  const duracaoPadrao = [...duracoes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const t of turnos) {
    const d = t.fim - t.ini;
    if (duracaoPadrao !== undefined && d !== duracaoPadrao) {
      aviso({
        codigo: "DURACAO_ATIPICA",
        linha: t.item.linha,
        celula: t.item.celula,
        mensagem: `Turno de ${hhmm(d)} difere do padrão da planilha (${hhmm(duracaoPadrao)}).`,
      });
    }
  }
  const porLinha = new Map<number, typeof turnos>(); // sem Map.groupBy: Node 20 não tem
  for (const t of turnos) porLinha.set(t.item.linha, [...(porLinha.get(t.item.linha) ?? []), t]);
  for (const lista of porLinha.values()) {
    lista.sort((a, b) => a.item.data.localeCompare(b.item.data));
    for (let i = 1; i < lista.length; i++) {
      const ant = lista[i - 1], atu = lista[i];
      if (diasEntre(ant.item.data, atu.item.data) !== 1) continue;
      const descanso = atu.ini + 1440 - ant.fim;
      if (descanso < INTERJORNADA_MIN) {
        aviso({
          codigo: "INTERJORNADA",
          linha: atu.item.linha,
          celula: atu.item.celula,
          mensagem: `${atu.item.colaborador}: ${hhmm(descanso)} de descanso entre ${ant.item.data} e ${atu.item.data} (mínimo 11:00).`,
        });
      }
    }
  }

  const porTipo: Record<Tipo, number> = { TURNO: 0, DSR: 0, FERIAS: 0, QUEBRA_ESCALA: 0 };
  for (const i of itens) porTipo[i.tipo]++;
  const ordenadas = [...datas.values()].sort();
  return {
    itens,
    problemas: problemas.sort((a, b) => a.linha - b.linha || (a.celula ?? "").localeCompare(b.celula ?? "")),
    resumo: {
      colaboradores: new Set(itens.map((i) => i.linha)).size,
      datas: datas.size,
      itens: itens.length,
      porTipo,
      periodo: ordenadas.length ? { inicio: ordenadas[0], fim: ordenadas[ordenadas.length - 1] } : null,
    },
  };
}
