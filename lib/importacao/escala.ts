/**
 * Leitor da planilha de escala em matriz (formato "Escala_Nova.xlsx").
 *
 *   linha 1: Operação | Matrícula | Nome | <data> | <data> | ...
 *   demais:  uma linha por colaborador; cada célula de data contém um turno
 *            ("06:00 AS 14:20", "09:00 - 17:20") ou um rótulo (DSR, Férias, Quebra de escala).
 *
 * Cada célula de data preenchida vira um item. "Operação" é gravada como célula operacional.
 */
import type ExcelJS from "exceljs";
import {
  type ItemImportado,
  type Problema,
  MATRICULA,
  colunaLetra,
  hhmm,
  lerData,
  normalizar,
  normalizarCabecalho,
  ordenarProblemas,
  texto,
} from "./comum";

/** Nomes iguais aos do catálogo `atividade` no banco. */
export const ATIVIDADES_ESCALA = {
  TURNO: "Turno",
  DSR: "DSR",
  FERIAS: "Férias",
  QUEBRA_ESCALA: "Quebra de escala",
} as const;

/** Variações conhecidas de rótulo. Chave já normalizada. */
export const ROTULOS: Record<string, keyof typeof ATIVIDADES_ESCALA> = {
  dsr: "DSR",
  ferias: "FERIAS",
  "quebra de escala": "QUEBRA_ESCALA",
  "quegra de escala": "QUEBRA_ESCALA",
};

const TURNO = /^(\d{1,2})[:h](\d{2})\s*(?:as|a|ate|-)\s*(\d{1,2})[:h](\d{2})$/;
const INTERJORNADA_MIN = 11 * 60;
const CABECALHOS: Record<string, "operacao" | "matricula" | "nome"> = {
  operacao: "operacao",
  celula: "operacao",
  matricula: "matricula",
  nome: "nome",
};

const diasEntre = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

/** Escala: linha 1 com ao menos uma data. As colunas obrigatórias são cobradas por lerEscala, com erro preciso. */
export function pareceEscala(ws: ExcelJS.Worksheet): boolean {
  let datas = 0;
  ws.getRow(1).eachCell({ includeEmpty: false }, (c) => {
    if (lerData(c.value)) datas++;
  });
  return datas > 0;
}

export function lerEscala(ws: ExcelJS.Worksheet): { itens: ItemImportado[]; problemas: Problema[] } {
  const itens: ItemImportado[] = [];
  const problemas: Problema[] = [];
  const erro = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "erro", ...p });
  const aviso = (p: Omit<Problema, "nivel">) => problemas.push({ nivel: "aviso", ...p });

  // --- cabeçalho
  const col: Partial<Record<"operacao" | "matricula" | "nome", number>> = {};
  const datas = new Map<number, string>();
  const vistas = new Map<string, string>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, c) => {
    const ref = `${colunaLetra(c)}1`;
    const data = lerData(cell.value);
    if (data) {
      if (vistas.has(data)) {
        erro({ codigo: "DATA_DUPLICADA", linha: 1, celula: ref, mensagem: `Data ${data} repetida (também em ${vistas.get(data)}).` });
      } else {
        vistas.set(data, ref);
        datas.set(c, data);
      }
      return;
    }
    const chave = CABECALHOS[normalizarCabecalho(texto(cell.value))];
    if (chave) col[chave] = c;
    else erro({ codigo: "CABECALHO_DESCONHECIDO", linha: 1, celula: ref, mensagem: `Cabeçalho "${texto(cell.value)}" não reconhecido.` });
  });
  for (const k of ["matricula", "nome"] as const) {
    if (!col[k]) erro({ codigo: "CABECALHO_AUSENTE", linha: 1, mensagem: `Coluna "${k === "matricula" ? "Matrícula" : "Nome"}" não encontrada na linha 1.` });
  }
  if (datas.size === 0) erro({ codigo: "SEM_COLUNA_DATA", linha: 1, mensagem: "Nenhuma coluna de data encontrada na linha 1." });
  if (problemas.some((p) => p.nivel === "erro")) return { itens, problemas };

  // --- linhas
  const matriculas = new Map<string, number>();
  const duracoes = new Map<number, number>();
  const turnos: { item: ItemImportado; ini: number; fim: number }[] = [];

  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r === 1) return;
    const valores = [col.operacao, col.matricula, col.nome, ...datas.keys()]
      .filter((c): c is number => !!c)
      .map((c) => texto(row.getCell(c).value).trim());
    if (valores.every((v) => v === "")) return; // linha só com formatação

    const nome = texto(row.getCell(col.nome!).value).trim();
    const celula = col.operacao ? texto(row.getCell(col.operacao).value).trim() || null : null;
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
      const base = { linha: r, ref, celula, matricula, colaborador: nome || null, data, atividadeOriginal: original, motivoAjuste: null };

      const rotulo = ROTULOS[n];
      if (rotulo) {
        itens.push({ ...base, atividade: ATIVIDADES_ESCALA[rotulo], horaIni: null, horaFim: null, viraDia: false });
        continue;
      }
      const m = TURNO.exec(n);
      if (!m) {
        erro({ codigo: "VALOR_DESCONHECIDO", linha: r, celula: ref, mensagem: `Valor "${original}" não reconhecido como turno, DSR, férias ou quebra de escala.` });
        continue;
      }
      const [h1, m1, h2, m2] = m.slice(1).map(Number);
      if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) {
        erro({ codigo: "HORARIO_INVALIDO", linha: r, celula: ref, mensagem: `Horário "${original}" fora do intervalo 00:00 a 23:59.` });
        continue;
      }
      const ini = h1 * 60 + m1;
      let fim = h2 * 60 + m2;
      const viraDia = fim <= ini;
      if (viraDia) {
        fim += 1440;
        aviso({ codigo: "VIRA_DIA", linha: r, celula: ref, mensagem: `"${original}" termina no dia seguinte. Confirme a virada de dia.` });
      }
      const item: ItemImportado = { ...base, atividade: ATIVIDADES_ESCALA.TURNO, horaIni: hhmm(ini), horaFim: hhmm(fim), viraDia };
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
        celula: t.item.ref,
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
          celula: atu.item.ref,
          mensagem: `${atu.item.colaborador}: ${hhmm(descanso)} de descanso entre ${ant.item.data} e ${atu.item.data} (mínimo 11:00).`,
        });
      }
    }
  }

  return { itens, problemas: ordenarProblemas(problemas) };
}
