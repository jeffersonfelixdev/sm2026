/**
 * Motor das Eliminatórias — a cola entre os formatos, as regras e a simulação.
 * Não conhece o banco: recebe dados, devolve dados. Quem persiste é lib/qualifiers.mjs.
 *
 * Toda aleatoriedade vem de `rngFor(chave)`, um gerador semeado por uma chave estável
 * (o sorteio da terceira fase da AFC, o jogo tal entre tais times). Não existe um "fluxo"
 * de números aleatórios que precise ser guardado: qualquer parte da simulação pode ser
 * refeita a qualquer momento, em qualquer ordem, e sai igual. É o que permite ao jogador
 * fechar o navegador no meio das Eliminatórias e voltar depois sem que a história mude.
 */
import { nextPlayoffStage, nextStage } from './formats.mjs';
import { playKnockout, playMatch, playSecondLeg, winnerOf } from './match.mjs';
import { rankAcrossGroups, standings } from './rules.mjs';

/** Contexto que os formatos recebem: os times da confederação, o ranking e um sorteio. */
export function context({ teams, ranks }, rng) {
  return {
    teams,
    ranks,
    rng,
    byRank: (list) => [...list].sort((a, b) => (ranks[a] ?? 999) - (ranks[b] ?? 999)),
    rankAcross: (rows) => rankAcrossGroups(rows, { ranks }),
  };
}

/** Ordena códigos de país pelo Ranking FIFA (melhor primeiro). */
export const byRank = (codes, ranks) =>
  [...codes].sort((a, b) => (ranks[a] ?? 999) - (ranks[b] ?? 999));

/* ------------------------------------------------------------------ *
 * Da fase para as partidas
 * ------------------------------------------------------------------ */

/** Quantas rodadas a fase tem. Num grupo de 5 há folga: 10 rodadas para 8 jogos de cada. */
export function stageMatchdays(stage) {
  if (stage.kind === 'knockout') return stage.legs;
  return Math.max(...stage.groups.map((g) => stage.schedule(g.teams).length));
}

/** Gera todas as partidas de uma fase, ainda sem placar. */
export function stageMatches(stage) {
  const out = [];

  if (stage.kind === 'groups') {
    for (const group of stage.groups) {
      stage.schedule(group.teams).forEach((round, i) => {
        for (const [home, away] of round) {
          out.push({
            group: group.name, tie: null, matchday: i + 1, leg: 1,
            home, away, neutral: stage.neutral ? 1 : 0, played: 0,
          });
        }
      });
    }
    return out;
  }

  for (const tie of stage.ties) {
    out.push({
      group: null, tie: tie.id, matchday: 1, leg: 1,
      home: tie.home, away: tie.away, neutral: stage.neutral ? 1 : 0, played: 0,
    });
    if (stage.legs === 2) {
      // Na volta os mandos se invertem — quem é cabeça de chave decide em casa.
      out.push({
        group: null, tie: tie.id, matchday: 2, leg: 2,
        home: tie.away, away: tie.home, neutral: 0, played: 0,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Simulação
 * ------------------------------------------------------------------ */

/** Chave estável de uma partida: o mesmo jogo sempre sorteia os mesmos números. */
const matchKey = (stage, m) =>
  `match|${stage.key}|${m.group ?? m.tie}|${m.matchday}|${m.home}|${m.away}`;

/**
 * Joga uma rodada da fase (altera as partidas no lugar).
 * A volta de um mata-mata precisa da ida: é lá que saem prorrogação e pênaltis.
 */
export function playMatchday(stage, matches, matchday, ratings, rngFor) {
  const played = [];

  for (const m of matches) {
    if (m.matchday !== matchday || m.played) continue;
    const rng = rngFor(matchKey(stage, m));
    const [home, away] = [ratings[m.home], ratings[m.away]];

    let result;
    if (stage.kind !== 'knockout') {
      result = playMatch(rng, home, away, { neutral: !!m.neutral });
    } else if (stage.legs === 2 && m.leg === 2) {
      const first = matches.find((x) => x.tie === m.tie && x.leg === 1);
      result = playSecondLeg(rng, first, home, away);
    } else {
      result = playKnockout(rng, home, away, { neutral: !!m.neutral });
    }

    Object.assign(m, { home_pens: null, away_pens: null, extra_time: 0 }, result, { played: 1 });
    played.push(m);
  }
  return played;
}

/** Vencedor de um confronto (jogo único ou ida e volta, no agregado). */
export function tieWinner(tie, legs) {
  if (legs.length === 1) return winnerOf(legs[0]);

  const [first, second] = legs;
  const homeAgg = first.home_goals + second.away_goals; // gols do mandante da IDA
  const awayAgg = first.away_goals + second.home_goals;
  if (homeAgg !== awayAgg) return homeAgg > awayAgg ? tie.home : tie.away;

  // Agregado empatado: decidiu nos pênaltis, na volta — onde o mandante é o visitante da ida.
  return second.home_pens > second.away_pens ? tie.away : tie.home;
}

/** Fase + resultados: tabelas dos grupos, ou vencedor e eliminado de cada confronto. */
export function resolveStage(stage, matches, ranks, { events, fairPlay } = {}) {
  if (stage.kind === 'groups') {
    return {
      ...stage,
      groups: stage.groups.map((group) => ({
        ...group,
        matches: matches.filter((m) => m.group === group.name),
        table: standings(
          group.teams,
          matches.filter((m) => m.group === group.name),
          { tiebreak: stage.tiebreak, ranks, events, fairPlay },
        ),
      })),
    };
  }

  return {
    ...stage,
    ties: stage.ties.map((tie) => {
      const legs = matches.filter((m) => m.tie === tie.id).sort((a, b) => a.leg - b.leg);
      const settled = legs.length === stage.legs && legs.every((m) => m.played);
      const winner = settled ? tieWinner(tie, legs) : null;
      return {
        ...tie,
        legs,
        winner,
        loser: winner ? (winner === tie.home ? tie.away : tie.home) : null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Simulação completa de uma confederação (as que o jogador não treina)
 * ------------------------------------------------------------------ */

/**
 * Roda uma confederação (ou a repescagem intercontinental) do começo ao fim.
 * `format` é `nextStage(conf, …)` ou `playoffFormat`.
 */
export function runToEnd(format, base, ratings, rngFor) {
  const done = [];
  const stages = [];

  for (;;) {
    const ctx = context(base, rngFor(`draw|${done.length}`));
    const step = format(ctx, done);
    if (step.result) return { result: step.result, stages };

    const stage = step.stage;
    const matches = stageMatches(stage);
    for (let md = 1; md <= stageMatchdays(stage); md++) {
      playMatchday(stage, matches, md, ratings, rngFor);
    }
    const resolved = resolveStage(stage, matches, base.ranks);
    done.push(resolved);
    stages.push({ stage, matches, resolved });
  }
}

/** Roda uma confederação inteira. */
export const runConfederation = (conf, base, ratings, rngFor) =>
  runToEnd((ctx, done) => nextStage(conf, ctx, done), base, ratings, (key) => rngFor(`${conf}|${key}`));

/** Roda a repescagem intercontinental inteira. */
export const runPlayoff = (base, ratings, rngFor) =>
  runToEnd(nextPlayoffStage, base, ratings, (key) => rngFor(`ICPO|${key}`));

/**
 * Como a seleção se classificou — para a lista das 48 da Copa.
 * Varre as fases de trás para frente: quem venceu o último mata-mata veio por aí;
 * o resto veio da posição no grupo.
 */
export function qualifyNote(code, stages) {
  for (const stage of [...stages].reverse()) {
    if (stage.kind === 'knockout') {
      if (stage.ties.some((t) => t.winner === code)) return stage.name;
      continue;
    }
    for (const group of stage.groups) {
      const row = group.table.find((r) => r.code === code);
      if (!row) continue;
      return group.name === 'Único'
        ? `${row.position}º colocado`
        : `${row.position}º do Grupo ${group.name}`;
    }
  }
  return null;
}
