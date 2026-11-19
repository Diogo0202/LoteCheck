import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { colunaLetra, lerEscala, normalizar } from "./escala";

/** Monta uma planilha no layout real (Operação | Matrícula | Nome | datas...) com dados fictícios. */
async function planilha(cabecalho: ExcelJS.CellValue[], linhas: ExcelJS.CellValue[][], linhasVaziasFormatadas = 0) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Planilha1");
  ws.addRow(cabecalho);
  for (const l of linhas) ws.addRow(l);
  for (let i = 0; i < linhasVaziasFormatadas; i++) {
    const r = ws.getRow(ws.rowCount + 1);
    r.getCell(1).numFmt = "@"; // célula sem valor, só formatação (como no arquivo real)
    r.commit();
  }
  ws.getRow(1).eachCell((c) => {
    if (c.value instanceof Date) c.numFmt = "d-mmm";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const d = (iso: string) => new Date(iso + "T00:00:00Z");
const CAB = ["Operação", "Matrícula", "Nome", d("2026-10-02"), d("2026-10-03"), d("2026-10-04")];

describe("normalizar", () => {
  it("remove acento, caixa, espaços e troca traço tipográfico", () => {
    expect(normalizar("  FÉRIAS ")).toBe("ferias");
    expect(normalizar("09:00 – 17:20")).toBe("09:00 - 17:20");
    expect(normalizar("09:00   ÁS 17:20")).toBe("09:00 as 17:20");
  });
  it("colunaLetra", () => {
    expect([1, 22, 26, 27, 52, 53].map(colunaLetra)).toEqual(["A", "V", "Z", "AA", "AZ", "BA"]);
  });
});

describe("lerEscala: formato real", () => {
  it("lê todas as variações de turno e rótulo vistas no arquivo real", async () => {
    const buf = await planilha(
      CAB,
      [
        ["Op/X", 100001, "MARIA TESTE", "06:00 AS 14:20", "DSR", "09:00 ás 17:20"],
        ["Op/X", 100002, "PEDRO TESTE", "Quegra de escala", "09:00 - 17:20", "13:40 as 22:00"],
        ["Op/X", 100003, "CARLA TESTE", "FÉRIAS", "FÉRIAS", "12:00 as 20:20"],
      ],
      19,
    );
    const r = await lerEscala(buf);

    expect(r.problemas.filter((p) => p.nivel === "erro")).toEqual([]);
    expect(r.resumo).toEqual({
      colaboradores: 3,
      datas: 3,
      itens: 9,
      porTipo: { TURNO: 5, DSR: 1, FERIAS: 2, QUEBRA_ESCALA: 1 },
      periodo: { inicio: "2026-10-02", fim: "2026-10-04" },
    });
    expect(r.itens[0]).toEqual({
      linha: 2,
      celula: "D2",
      operacao: "Op/X",
      matricula: "100001",
      colaborador: "MARIA TESTE",
      data: "2026-10-02",
      tipo: "TURNO",
      horaIni: "06:00",
      horaFim: "14:20",
      viraDia: false,
      valorOriginal: "06:00 AS 14:20",
    });
    expect(r.itens.find((i) => i.celula === "D3")).toMatchObject({ tipo: "QUEBRA_ESCALA", valorOriginal: "Quegra de escala" });
    expect(r.itens.find((i) => i.celula === "F2")).toMatchObject({ horaIni: "09:00", horaFim: "17:20" });
  });

  it("aceita colunas fora de ordem e sem Operação", async () => {
    const buf = await planilha(["Nome", d("2026-10-02"), "Matrícula"], [["ANA TESTE", "DSR", "123"]]);
    const r = await lerEscala(buf);
    expect(r.problemas).toEqual([]);
    expect(r.itens[0]).toMatchObject({ celula: "B2", matricula: "123", operacao: null, tipo: "DSR" });
  });

  it("preserva zeros à esquerda quando a matrícula está como texto", async () => {
    const r = await lerEscala(await planilha(CAB.slice(0, 4), [["Op", "007788", "ANA", "DSR"]]));
    expect(r.itens[0].matricula).toBe("007788");
  });

  it("aceita data de cabeçalho como texto dd/mm/aaaa", async () => {
    const r = await lerEscala(await planilha(["Matrícula", "Nome", "05/10/2026"], [[1, "ANA", "DSR"]]));
    expect(r.itens[0].data).toBe("2026-10-05");
  });
});

describe("lerEscala: erros que bloqueiam a confirmação", () => {
  const erros = async (cab: ExcelJS.CellValue[], linhas: ExcelJS.CellValue[][]) =>
    (await lerEscala(await planilha(cab, linhas))).problemas.filter((p) => p.nivel === "erro").map((p) => [p.codigo, p.celula]);

  it("cabeçalho sem Matrícula ou com coluna desconhecida", async () => {
    expect(await erros(["Operação", "Nome", "Setor", d("2026-10-02")], [["x", "ANA", "y", "DSR"]])).toEqual([
      ["CABECALHO_DESCONHECIDO", "C1"],
      ["CABECALHO_AUSENTE", undefined],
    ]);
  });

  it("data repetida no cabeçalho", async () => {
    expect(await erros(["Matrícula", "Nome", d("2026-10-02"), d("2026-10-02")], [[1, "ANA", "DSR", "DSR"]])).toEqual([
      ["DATA_DUPLICADA", "D1"],
    ]);
  });

  it("valor desconhecido, horário impossível, matrícula inválida ou repetida, nome vazio", async () => {
    expect(
      await erros(CAB, [
        ["Op", 1, "ANA", "Folga", "25:00 as 14:20", "DSR"],
        ["Op", "12A", "BIA", "DSR", "DSR", "DSR"],
        ["Op", 1, "", "DSR", "DSR", "DSR"],
      ]),
    ).toEqual([
      ["VALOR_DESCONHECIDO", "D2"],
      ["HORARIO_INVALIDO", "E2"],
      ["MATRICULA_INVALIDA", "B3"],
      ["MATRICULA_DUPLICADA", "B4"],
      ["NOME_AUSENTE", "C4"],
    ]);
  });
});

describe("lerEscala: avisos para o analista conferir", () => {
  const avisos = async (cab: ExcelJS.CellValue[], linhas: ExcelJS.CellValue[][]) =>
    (await lerEscala(await planilha(cab, linhas))).problemas.filter((p) => p.nivel === "aviso").map((p) => [p.codigo, p.celula]);

  it("sem matrícula: linha aparece e exige confirmação", async () => {
    const r = await lerEscala(await planilha(CAB, [["Op", null, "ANA", "DSR", "DSR", "DSR"]]));
    expect(r.problemas.map((p) => [p.nivel, p.codigo])).toEqual([["aviso", "SEM_MATRICULA"]]);
    expect(r.itens).toHaveLength(3);
    expect(r.itens.every((i) => i.matricula === null)).toBe(true);
  });

  it("virada de dia, interjornada menor que 11 h e duração atípica", async () => {
    expect(
      await avisos(CAB, [
        ["Op", 1, "ANA", "13:40 as 22:00", "06:00 AS 14:20", "22:00 as 06:20"],
        ["Op", 2, "BIA", "06:00 AS 14:20", "06:00 AS 10:00", "DSR"],
      ]),
    ).toEqual([
      ["INTERJORNADA", "E2"], // 22:00 -> 06:00 = 8 h
      ["VIRA_DIA", "F2"],
      ["DURACAO_ATIPICA", "E3"], // 4 h contra o padrão de 8h20
    ]);
  });

  it("interjornada só compara dias consecutivos", async () => {
    const cab = ["Matrícula", "Nome", d("2026-10-04"), d("2026-10-08")]; // domingo -> quinta
    expect(await avisos(cab, [[1, "ANA", "13:40 as 22:00", "06:00 AS 14:20"]])).toEqual([]);
  });

  it("célula vazia não gera item", async () => {
    const r = await lerEscala(await planilha(CAB, [["Op", 1, "ANA", "DSR", null, "DSR"]]));
    expect(r.itens).toHaveLength(2);
    expect(r.problemas.map((p) => [p.codigo, p.celula])).toEqual([["CELULA_VAZIA", "E2"]]);
  });
});
