import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { lerPlanilha } from "./index";

const CAB = [
  "MATRÍCULA",
  "CÉLULA ",
  "DATA INICIO ATIVIDADE",
  "HORA INICIO ATIVIDADE",
  "HORA FIM ATIVIDADE",
  "QUAL ATIVIDADE A SER LANÇADA :",
  "MOTIVO DO AJUSTE",
];

const data = (iso: string) => new Date(iso + "T00:00:00Z");
/** Hora como o Excel guarda numa célula formatada hh:mm. */
const hora = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(1899, 11, 30, h, m));
};

async function planilha(cab: ExcelJS.CellValue[], linhas: ExcelJS.CellValue[][], titulo: string[] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Chamado");
  for (const t of titulo) ws.addRow([t]);
  ws.addRow(cab);
  for (const l of linhas) {
    const r = ws.addRow(l);
    r.eachCell((c) => {
      if (c.value instanceof Date) c.numFmt = c.value.getUTCFullYear() === 1899 ? "hh:mm" : "dd/mm/yyyy";
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const linha = (over: Partial<Record<number, ExcelJS.CellValue>> = {}): ExcelJS.CellValue[] => {
  const base: ExcelJS.CellValue[] = ["366001", "Amil/TC", data("2026-11-10"), hora("06:00"), hora("06:30"), "Treinamento", "Esqueceu de registrar"];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v as ExcelJS.CellValue;
  return base;
};

const codigos = (r: Awaited<ReturnType<typeof lerPlanilha>>, nivel: "erro" | "aviso") =>
  r.problemas.filter((p) => p.nivel === nivel).map((p) => [p.codigo, p.celula]);

describe("lerPlanilha: layout de chamado", () => {
  it("lê as 7 colunas e gera um item por linha", async () => {
    const r = await lerPlanilha(
      await planilha(CAB, [
        linha(),
        linha({ 0: 366002, 3: hora("13:40"), 4: hora("14:00"), 5: "Feedback", 6: "Sistema fora do ar" }),
      ]),
    );
    expect(r.layout).toBe("CHAMADO");
    expect(r.problemas).toEqual([]);
    expect(r.itens[0]).toEqual({
      linha: 2,
      ref: "F2",
      celula: "Amil/TC",
      matricula: "366001",
      colaborador: null,
      data: "2026-11-10",
      horaIni: "06:00",
      horaFim: "06:30",
      viraDia: false,
      atividade: "Treinamento",
      atividadeOriginal: "Treinamento",
      motivoAjuste: "Esqueceu de registrar",
    });
    expect(r.itens[1]).toMatchObject({ matricula: "366002", horaIni: "13:40", horaFim: "14:00", atividade: "Feedback" });
    expect(r.resumo).toMatchObject({ itens: 2, matriculas: 2, erros: 0, avisos: 0, porAtividade: { Treinamento: 1, Feedback: 1 } });
  });

  it("acha o cabeçalho abaixo de linhas de título e com colunas fora de ordem", async () => {
    const cab = [CAB[5], CAB[0], CAB[2], CAB[3], CAB[4], CAB[6], CAB[1]];
    const l = linha();
    const r = await lerPlanilha(await planilha(cab, [[l[5], l[0], l[2], l[3], l[4], l[6], l[1]]], ["CHAMADO DE AJUSTE", "Supervisor: X"]));
    expect(r.problemas).toEqual([]);
    expect(r.itens[0]).toMatchObject({ linha: 4, ref: "A4", matricula: "366001", celula: "Amil/TC", atividade: "Treinamento" });
  });

  it("aceita data e hora em texto, serial e fração do dia", async () => {
    const r = await lerPlanilha(
      await planilha(CAB, [
        linha({ 2: "05/11/2026", 3: "6:00", 4: "06h30" }),
        linha({ 0: "2", 2: 46332, 3: 0.25, 4: 0.3125 }), // serial 46332 = 06/11/2026; 06:00 e 07:30
        linha({ 0: "3", 2: "2026-11-07", 3: "08:00:00", 4: "09:15" }),
      ]),
    );
    expect(r.problemas).toEqual([]);
    expect(r.itens.map((i) => [i.data, i.horaIni, i.horaFim])).toEqual([
      ["2026-11-05", "06:00", "06:30"],
      ["2026-11-06", "06:00", "07:30"],
      ["2026-11-07", "08:00", "09:15"],
    ]);
  });

  it("preserva zeros à esquerda na matrícula em texto", async () => {
    const r = await lerPlanilha(await planilha(CAB, [linha({ 0: "007788" })]));
    expect(r.itens[0].matricula).toBe("007788");
  });

  it("mesma pessoa com duas atividades no mesmo dia, sem sobreposição", async () => {
    const r = await lerPlanilha(
      await planilha(CAB, [linha(), linha({ 3: hora("10:00"), 4: hora("11:00"), 5: "Reunião" })]),
    );
    expect(r.problemas).toEqual([]);
    expect(r.itens).toHaveLength(2);
  });
});

describe("lerPlanilha: chamado com erros", () => {
  it("coluna obrigatória ausente", async () => {
    const r = await lerPlanilha(await planilha(CAB.filter((_, i) => i !== 4), [["1", "X", data("2026-11-10"), hora("06:00"), "T", "M"]]));
    expect(codigos(r, "erro")).toEqual([["CABECALHO_AUSENTE", undefined]]);
    expect(r.itens).toEqual([]);
  });

  it("erros por célula", async () => {
    const r = await lerPlanilha(
      await planilha(CAB, [
        linha({ 0: "12A" }), // 2
        linha({ 2: "31/02/2026" }), // 3
        linha({ 3: "25:00" }), // 4
        linha({ 4: null }), // 5
        linha({ 5: "  " }), // 6
        linha({ 3: hora("08:00"), 4: hora("08:00") }), // 7
        linha({ 2: null }), // 8
      ]),
    );
    expect(codigos(r, "erro")).toEqual([
      ["MATRICULA_INVALIDA", "A2"],
      ["DATA_INVALIDA", "C3"],
      ["HORA_INVALIDA", "D4"],
      ["HORA_AUSENTE", "E5"],
      ["ATIVIDADE_AUSENTE", "F6"],
      ["HORA_INVALIDA", "E7"],
      ["DATA_AUSENTE", "C8"],
    ]);
    expect(r.itens).toEqual([]);
  });

  it("linha repetida", async () => {
    const r = await lerPlanilha(await planilha(CAB, [linha(), linha({ 5: "TREINAMENTO", 6: "outro motivo" })]));
    expect(codigos(r, "erro")).toEqual([["LINHA_REPETIDA", "F3"]]);
    expect(r.itens).toHaveLength(1);
  });

  it("layout desconhecido e arquivo inválido", async () => {
    const r1 = await lerPlanilha(await planilha(["Colaborador", "Pedido"], [["A", "B"]]));
    expect(r1.layout).toBeNull();
    expect(codigos(r1, "erro")).toEqual([["LAYOUT_DESCONHECIDO", undefined]]);

    const r2 = await lerPlanilha(Buffer.from("não sou um xlsx"));
    expect(codigos(r2, "erro")).toEqual([["PLANILHA_VAZIA", undefined]]);
  });
});

describe("lerPlanilha: chamado com avisos", () => {
  it("sem matrícula, virada de dia, duração curta, sobreposição, motivo ausente e coluna extra", async () => {
    const r = await lerPlanilha(
      await planilha(
        [...CAB, "OBS"],
        [
          linha({ 0: null }), // 2: sem matrícula
          linha({ 3: hora("22:00"), 4: hora("02:00"), 5: "Hora extra" }), // 3: vira dia
          linha({ 3: hora("12:00"), 4: hora("12:03"), 5: "Pausa" }), // 4: 3 min
          linha({ 3: hora("06:15"), 4: hora("07:00"), 5: "Reunião" }), // 5: 06:15-07:00
          linha({ 6: null }), // 6: 06:00-06:30, sobrepõe a linha 5 e não tem motivo
        ],
      ),
    );
    expect(codigos(r, "erro")).toEqual([]);
    expect(codigos(r, "aviso")).toEqual([
      ["CABECALHO_DESCONHECIDO", "H1"],
      ["SEM_MATRICULA", "A2"],
      ["VIRA_DIA", "E3"],
      ["DURACAO_CURTA", "E4"],
      ["SOBREPOSICAO", "D6"],
      ["MOTIVO_AUSENTE", "G6"],
    ]);
    expect(r.itens).toHaveLength(5);
    expect(r.itens[1]).toMatchObject({ horaIni: "22:00", horaFim: "02:00", viraDia: true });
  });
});
