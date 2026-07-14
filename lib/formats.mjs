/**
 * Os formatos oficiais das Eliminatórias da Copa de 2026 — um por confederação,
 * mais a repescagem intercontinental.
 *
 * Cada formato é uma função pura: recebe as fases já concluídas e devolve a PRÓXIMA fase
 * (ou o resultado final). Nada de estado guardado em memória — assim a mesma função serve
 * para simular a Ásia inteira de uma vez e para conduzir, fase a fase, a confederação do
 * jogador, que pode parar no meio, fechar o navegador e voltar dias depois.
 *
 * Vagas na Copa (48 seleções):
 *
 *   anfitriões  3   Estados Unidos, México e Canadá
 *   UEFA       16
 *   CAF         9  + 1 na repescagem intercontinental
 *   AFC         8  + 1
 *   CONMEBOL    6  + 1
 *   CONCACAF    3  + 2   (os 3 anfitriões já estão dentro)
 *   OFC         1  + 1
 *   repescagem  2   das 6 seleções acima, 2 se classificam
 */

import { drawGroups, drawKnockout, seedPairs, doubleRoundRobin, roundRobin } from './rules.mjs';

/** Os três anfitriões da Copa de 2026, já classificados. */
export const HOSTS = ['USA', 'MEX', 'CAN'];

/* ------------------------------------------------------------------ *
 * Construtores de fase
 * ------------------------------------------------------------------ */

/**
 * Fase de grupos. `advance` é a última posição que passa direto e `playoff` a última que
 * ainda tem uma segunda chance — na tela, a linha verde e a linha âmbar da tabela.
 */
const groupStage = (key, name, groups, { legs = 2, neutral = false, tiebreak = 'fifa', advance, playoff }) => ({
  key, name, kind: 'groups', groups, legs, neutral, tiebreak,
  advance, playoff: playoff ?? advance,
  schedule: legs === 2 ? doubleRoundRobin : roundRobin,
});

/**
 * Fase de mata-mata. Cada confronto vem como [cabeça de chave, adversário].
 * Em jogo único o cabeça de chave decide em casa (salvo em campo neutro);
 * em ida e volta ele joga a volta em casa, que é a vantagem que o chaveamento dá.
 */
const knockoutStage = (key, name, pairs, { legs = 1, neutral = false, label = null } = {}) => ({
  key, name, kind: 'knockout', legs, neutral,
  ties: pairs.map(([seed, other], i) => ({
    id: `${key}-${i + 1}`,
    name: label ? `${label} ${i + 1}` : `${name} ${i + 1}`,
    // Jogo único: manda o cabeça de chave. Ida e volta: o cabeça de chave manda a volta.
    home: legs === 2 ? other : seed,
    away: legs === 2 ? seed : other,
  })),
});

/* ------------------------------------------------------------------ *
 * Leitura das fases concluídas
 * ------------------------------------------------------------------ */

/** Times numa posição do grupo, em todas as chaves de uma fase de grupos. */
const atPosition = (stage, position) =>
  stage.groups.map((g) => g.table[position - 1]?.code).filter(Boolean);

/** Times entre duas posições (inclusive) de cada grupo — ex.: os classificados 1º e 2º. */
const between = (stage, from, to) =>
  stage.groups.flatMap((g) => g.table.slice(from - 1, to).map((r) => r.code));

/** Linhas de tabela numa posição, para o ranking entre grupos (melhores segundos). */
const rowsAt = (stage, position) =>
  stage.groups.map((g) => g.table[position - 1]).filter(Boolean);

const winners = (stage) => stage.ties.map((t) => t.winner);
const losers = (stage) => stage.ties.map((t) => t.loser);

/* ------------------------------------------------------------------ *
 * CONMEBOL — 10 seleções, pontos corridos
 * ------------------------------------------------------------------ */
function conmebol(ctx, done) {
  if (!done.length) {
    return groupStage('conmebol_groups', 'Eliminatórias Sul-Americanas',
      [{ name: 'Único', teams: ctx.teams, pots: {} }],
      { legs: 2, tiebreak: 'fifa', advance: 6, playoff: 7 });
  }
  const table = done[0].groups[0].table;
  return {
    direct: table.slice(0, 6).map((r) => r.code),
    playoff: [table[6].code], // o 7º vai para a repescagem intercontinental
  };
}

/* ------------------------------------------------------------------ *
 * UEFA — 55 seleções, 12 grupos, 16 vagas
 * ------------------------------------------------------------------ */
function uefa(ctx, done) {
  const [groups, semis, finals] = done;

  if (!groups) {
    // 55 seleções em 12 grupos: 7 de cinco e 5 de quatro.
    return groupStage('uefa_groups', 'Fase de Grupos',
      drawGroups(ctx.teams, 12, ctx.rng),
      { legs: 2, tiebreak: 'uefa', advance: 1, playoff: 2 });
  }

  if (!semis) {
    // Playoff: os 12 segundos colocados + 4 repescados.
    //
    // Na vida real os 4 últimos são os melhores campeões de grupo da Liga das Nações que
    // não ficaram entre os dois primeiros das Eliminatórias. O jogo não simula a Liga das
    // Nações, então entram no lugar as 4 melhores do Ranking FIFA nessa mesma situação —
    // mesmo espírito (dar uma segunda chance a quem foi bem antes), critério diferente.
    const runnersUp = atPosition(groups, 2);
    const rest = ctx.teams.filter(
      (code) => !atPosition(groups, 1).includes(code) && !runnersUp.includes(code),
    );
    const teams = ctx.byRank([...runnersUp, ...rest.slice(0, 4)]);

    // 4 potes de 4 pelo ranking; cada caminho leva um time de cada pote.
    const pots = [0, 1, 2, 3].map((p) => ctx.rng.shuffle(teams.slice(p * 4, p * 4 + 4)));
    const paths = [0, 1, 2, 3].map((i) => pots.map((pot) => pot[i]));

    // Semifinais: pote 1 x pote 4 e pote 2 x pote 3, o mais forte em casa.
    return knockoutStage('uefa_po_sf', 'Playoff — Semifinais',
      paths.flatMap(([a, b, c, d]) => [[a, d], [b, c]]),
      { legs: 1, label: 'Semifinal' });
  }

  if (!finals) {
    // Cada caminho tem duas semifinais seguidas; o vencedor da primeira decide em casa.
    const pairs = [];
    for (let i = 0; i < semis.ties.length; i += 2) {
      pairs.push([semis.ties[i].winner, semis.ties[i + 1].winner]);
    }
    return knockoutStage('uefa_po_final', 'Playoff — Finais', pairs, { legs: 1, label: 'Final' });
  }

  return { direct: [...atPosition(groups, 1), ...winners(finals)], playoff: [] };
}

/* ------------------------------------------------------------------ *
 * CAF — 54 seleções, 9 grupos de 6, 9 vagas + 1 na repescagem
 * ------------------------------------------------------------------ */
function caf(ctx, done) {
  const [groups, semis, final] = done;

  if (!groups) {
    return groupStage('caf_groups', 'Fase de Grupos',
      drawGroups(ctx.teams, 9, ctx.rng),
      { legs: 2, tiebreak: 'fifa', advance: 1, playoff: 2 });
  }

  if (!semis) {
    // Os 4 melhores segundos colocados disputam um mini-torneio pela vaga na repescagem.
    const best = ctx.rankAcross(rowsAt(groups, 2)).slice(0, 4).map((r) => r.code);
    return knockoutStage('caf_po_sf', 'Repescagem Africana — Semifinais',
      seedPairs(best), { legs: 1, neutral: true, label: 'Semifinal' });
  }

  if (!final) {
    return knockoutStage('caf_po_final', 'Repescagem Africana — Final',
      [winners(semis)], { legs: 1, neutral: true, label: 'Final' });
  }

  return { direct: atPosition(groups, 1), playoff: winners(final) };
}

/* ------------------------------------------------------------------ *
 * AFC — 46 seleções, cinco fases, 8 vagas + 1 na repescagem
 * ------------------------------------------------------------------ */
function afc(ctx, done) {
  const [r1, r2, r3, r4, r5] = done;

  if (!r1) {
    // Primeira fase: as 20 piores ranqueadas em 10 confrontos de ida e volta.
    return knockoutStage('afc_r1', 'Primeira Fase',
      drawKnockout(ctx.teams.slice(26), ctx.rng), { legs: 2, label: 'Confronto' });
  }

  if (!r2) {
    // Segunda fase: as 26 melhores entram direto e se juntam aos 10 vencedores.
    const teams = ctx.byRank([...ctx.teams.slice(0, 26), ...winners(r1)]);
    return groupStage('afc_r2', 'Segunda Fase',
      drawGroups(teams, 9, ctx.rng), { legs: 2, tiebreak: 'fifa', advance: 2 });
  }

  if (!r3) {
    // Terceira fase: os 2 primeiros de cada grupo, agora em 3 grupos de 6.
    return groupStage('afc_r3', 'Terceira Fase',
      drawGroups(ctx.byRank(between(r2, 1, 2)), 3, ctx.rng),
      { legs: 2, tiebreak: 'fifa', advance: 2, playoff: 4 }); // 3º e 4º ainda têm a quarta fase
  }

  if (!r4) {
    // Quarta fase: 3º e 4º de cada grupo em 2 chaves de 3, turno único em campo neutro.
    return groupStage('afc_r4', 'Quarta Fase',
      drawGroups(ctx.byRank(between(r3, 3, 4)), 2, ctx.rng),
      { legs: 1, neutral: true, tiebreak: 'fifa', advance: 1, playoff: 2 });
  }

  if (!r5) {
    // Quinta fase: os dois segundos colocados decidem quem vai à repescagem.
    return knockoutStage('afc_r5', 'Quinta Fase',
      [ctx.byRank(atPosition(r4, 2))], { legs: 2, label: 'Confronto' });
  }

  return {
    direct: [...between(r3, 1, 2), ...atPosition(r4, 1)], // 6 + 2
    playoff: winners(r5),
  };
}

/* ------------------------------------------------------------------ *
 * CONCACAF — 32 seleções (os 3 anfitriões já estão na Copa), 3 vagas + 2 na repescagem
 * ------------------------------------------------------------------ */
function concacaf(ctx, done) {
  const [r1, r2, r3] = done;
  const entrants = ctx.teams.filter((code) => !HOSTS.includes(code));

  if (!r1) {
    // Primeira fase: as 4 piores ranqueadas em 2 confrontos de ida e volta.
    return knockoutStage('ccf_r1', 'Primeira Fase',
      drawKnockout(entrants.slice(28), ctx.rng), { legs: 2, label: 'Confronto' });
  }

  if (!r2) {
    // Segunda fase: 6 grupos de 5 em turno único — dois jogos em casa e dois fora.
    const teams = ctx.byRank([...entrants.slice(0, 28), ...winners(r1)]);
    return groupStage('ccf_r2', 'Segunda Fase',
      drawGroups(teams, 6, ctx.rng), { legs: 1, tiebreak: 'fifa', advance: 2 });
  }

  if (!r3) {
    // Terceira fase: os 2 primeiros de cada grupo em 3 grupos de 4, ida e volta.
    return groupStage('ccf_r3', 'Terceira Fase',
      drawGroups(ctx.byRank(between(r2, 1, 2)), 3, ctx.rng),
      { legs: 2, tiebreak: 'fifa', advance: 1, playoff: 2 });
  }

  return {
    direct: atPosition(r3, 1), // os 3 campeões de grupo
    playoff: ctx.rankAcross(rowsAt(r3, 2)).slice(0, 2).map((r) => r.code), // os 2 melhores vices
  };
}

/* ------------------------------------------------------------------ *
 * OFC — 11 seleções, 1 vaga + 1 na repescagem
 * ------------------------------------------------------------------ */
function ofc(ctx, done) {
  const [r1sf, r1f, r2, sf, final] = done;

  if (!r1sf) {
    // Primeira fase: as 4 piores ranqueadas jogam um mata-mata; só o campeão avança.
    return knockoutStage('ofc_r1_sf', 'Primeira Fase — Semifinais',
      seedPairs(ctx.teams.slice(7)), { legs: 1, neutral: true, label: 'Semifinal' });
  }

  if (!r1f) {
    return knockoutStage('ofc_r1_final', 'Primeira Fase — Final',
      [winners(r1sf)], { legs: 1, neutral: true, label: 'Final' });
  }

  if (!r2) {
    // Segunda fase: as 7 melhores + o vencedor da primeira, em 2 grupos de 4,
    // turno único em sede única.
    const teams = ctx.byRank([...ctx.teams.slice(0, 7), ...winners(r1f)]);
    return groupStage('ofc_r2', 'Segunda Fase',
      drawGroups(teams, 2, ctx.rng), { legs: 1, neutral: true, tiebreak: 'fifa', advance: 2 });
  }

  if (!sf) {
    // Terceira fase: 1º de um grupo x 2º do outro.
    const [a, b] = r2.groups;
    return knockoutStage('ofc_r3_sf', 'Terceira Fase — Semifinais',
      [[a.table[0].code, b.table[1].code], [b.table[0].code, a.table[1].code]],
      { legs: 1, neutral: true, label: 'Semifinal' });
  }

  if (!final) {
    return knockoutStage('ofc_r3_final', 'Terceira Fase — Final',
      [winners(sf)], { legs: 1, neutral: true, label: 'Final' });
  }

  // O campeão da Oceania vai à Copa; o vice ainda tem a repescagem intercontinental.
  return { direct: winners(final), playoff: losers(final) };
}

/* ------------------------------------------------------------------ *
 * Repescagem intercontinental — 6 seleções, 2 vagas
 * ------------------------------------------------------------------ */

/**
 * As 2 melhores do Ranking FIFA entre as 6 já entram nas finais; as outras 4 jogam as
 * semifinais. Jogo único em campo neutro (na vida real, no México), com prorrogação e
 * pênaltis. Os 2 vencedores das finais vão à Copa.
 */
export function playoffFormat(ctx, done) {
  const [semis, finals] = done;
  const seeded = ctx.byRank(ctx.teams);

  if (!semis) {
    return knockoutStage('icpo_sf', 'Repescagem Intercontinental — Semifinais',
      seedPairs(seeded.slice(2)), { legs: 1, neutral: true, label: 'Semifinal' });
  }

  if (!finals) {
    // Cada finalista sorteado espera um vencedor de semifinal.
    return knockoutStage('icpo_final', 'Repescagem Intercontinental — Finais',
      [[seeded[0], semis.ties[0].winner], [seeded[1], semis.ties[1].winner]],
      { legs: 1, neutral: true, label: 'Final' });
  }

  return { direct: winners(finals), playoff: [] };
}

/* ------------------------------------------------------------------ *
 * Índice
 * ------------------------------------------------------------------ */

export const FORMATS = { AFC: afc, CAF: caf, CONCACAF: concacaf, CONMEBOL: conmebol, OFC: ofc, UEFA: uefa };

/** Quantas fases cada confederação tem, para mostrar o progresso ("fase 2 de 5"). */
export const STAGE_COUNT = { AFC: 5, CAF: 3, CONCACAF: 3, CONMEBOL: 1, OFC: 5, UEFA: 3 };

/** Um formato devolve ou a próxima fase, ou o resultado final. */
const step = (out) => (out.direct ? { result: out } : { stage: out });

/** Próxima fase da confederação — `{ stage }` ou `{ result: { direct, playoff } }`. */
export function nextStage(confederation, ctx, done) {
  const format = FORMATS[confederation];
  if (!format) throw new Error(`Confederação desconhecida: ${confederation}`);
  return step(format(ctx, done));
}

/** Próxima fase da repescagem intercontinental, na mesma interface. */
export const nextPlayoffStage = (ctx, done) => step(playoffFormat(ctx, done));
