/**
 * Motor de partida.
 *
 * Uma partida é decidida pela força das duas seleções (0–100, derivada do Ranking FIFA),
 * pelo mando de campo e por sorte. Os gols saem de uma Poisson cuja média cresce
 * exponencialmente com a diferença de força — é o modelo clássico de simulação de futebol:
 * favorito ganha quase sempre, mas "quase" é a graça do negócio.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Vantagem do mando, em pontos de força. Vale ~0,3 gol para o mandante. */
export const HOME_ADVANTAGE = 4;

/** Média de gols de um jogo equilibrado, para cada lado. */
const BASE_HOME = 1.45;
const BASE_AWAY = 1.15;

/** O quanto cada ponto de diferença de força pesa na média de gols. */
const SPREAD = 0.038;

/** Oscilação de rendimento no dia do jogo (em pontos de força). É daqui que vêm as zebras. */
export const FORM = 5;

/**
 * Força efetiva de uma seleção na simulação.
 *
 * Parte da força do Ranking FIFA e ajusta pelo overall do elenco convocado, na régua do
 * MELHOR elenco possível: o Ranking já pressupõe a seleção com seus melhores. Levar os 23
 * melhores rende um bônus; deixar craque em casa custa bem mais — e o overall pesa de
 * verdade no placar (fator e teto de penalidade altos o bastante para a convocação mudar jogo).
 *
 * `squadAvg` e `bestAvg` são overalls médios; a conversão para pontos de força usa o fator
 * abaixo (1 ponto de overall ≈ SQUAD_OVERALL_WEIGHT de força).
 */
export const SQUAD_BONUS = 3;
export const SQUAD_OVERALL_WEIGHT = 3.0;
export const SQUAD_PENALTY_CAP = -18;

export function teamRating(strength, squadAvg, bestAvg) {
  if (!squadAvg || !bestAvg) return strength;
  const penalty = clamp((squadAvg - bestAvg) * SQUAD_OVERALL_WEIGHT, SQUAD_PENALTY_CAP, 0);
  return clamp(Math.round(strength + SQUAD_BONUS + penalty), 30, 95);
}

/** Médias de gol esperadas para mandante e visitante. */
export function expectedGoalsFor(rngHome, rngAway, neutral) {
  const diff = rngHome + (neutral ? 0 : HOME_ADVANTAGE) - rngAway;
  return [
    clamp(BASE_HOME * Math.exp(SPREAD * diff), 0.12, 5.5),
    clamp(BASE_AWAY * Math.exp(-SPREAD * diff), 0.08, 5.5),
  ];
}

/**
 * Simula os 90 minutos. Devolve { home_goals, away_goals }.
 * `home` e `away` são as forças efetivas (ver teamRating).
 */
export function playMatch(rng, home, away, { neutral = false } = {}) {
  const form = () => (rng() - 0.5) * 2 * FORM;
  const [eh, ea] = expectedGoalsFor(home + form(), away + form(), neutral);
  return { home_goals: rng.poisson(eh), away_goals: rng.poisson(ea) };
}

/** Simula a prorrogação (30 min ≈ um terço de um jogo, e mais travada). */
export function playExtraTime(rng, home, away, { neutral = false } = {}) {
  const [eh, ea] = expectedGoalsFor(home, away, neutral);
  return { home_goals: rng.poisson(eh * 0.28), away_goals: rng.poisson(ea * 0.28) };
}

/**
 * Disputa de pênaltis: 5 cobranças para cada lado, depois morte súbita.
 * A força pesa pouco — como na vida real.
 */
export function playPenalties(rng, home, away) {
  const rate = (mine, theirs) => clamp(0.75 + (mine - theirs) * 0.0015, 0.6, 0.9);
  const [pHome, pAway] = [rate(home, away), rate(away, home)];

  let h = 0;
  let a = 0;
  for (let i = 0; i < 5; i++) {
    if (rng() < pHome) h++;
    if (rng() < pAway) a++;
    // Encerra assim que um dos lados não puder mais ser alcançado.
    const left = 4 - i;
    if (h > a + left || a > h + left) return { home_pens: h, away_pens: a };
  }
  while (h === a) {
    if (rng() < pHome) h++;
    if (rng() < pAway) a++;
  }
  return { home_pens: h, away_pens: a };
}

/**
 * Resolve um mata-mata de jogo único: prorrogação e pênaltis se empatar.
 * Devolve o placar já com prorrogação embutida e, se houver, os pênaltis.
 */
export function playKnockout(rng, home, away, { neutral = false } = {}) {
  const result = playMatch(rng, home, away, { neutral });
  if (result.home_goals !== result.away_goals) return { ...result, extra_time: 0 };

  const et = playExtraTime(rng, home, away, { neutral });
  const out = {
    home_goals: result.home_goals + et.home_goals,
    away_goals: result.away_goals + et.away_goals,
    extra_time: 1,
  };
  if (out.home_goals !== out.away_goals) return out;

  return { ...out, ...playPenalties(rng, home, away) };
}

/**
 * Decide um confronto de ida e volta pelo agregado. Sem gol qualificado fora de casa —
 * a FIFA aboliu a regra em 2021. Empate no agregado: prorrogação e pênaltis na volta.
 *
 * `first` é a ida já jogada; a volta é simulada aqui, com os mandos invertidos.
 * Devolve o resultado da volta (que é onde a prorrogação/pênaltis acontecem).
 */
export function playSecondLeg(rng, first, homeRating, awayRating) {
  // Na volta, quem era visitante joga em casa.
  const second = playMatch(rng, homeRating, awayRating);
  const aggHost = second.home_goals + first.away_goals; // mandante da volta = visitante da ida
  const aggGuest = second.away_goals + first.home_goals;
  if (aggHost !== aggGuest) return { ...second, extra_time: 0 };

  const et = playExtraTime(rng, homeRating, awayRating);
  const out = {
    home_goals: second.home_goals + et.home_goals,
    away_goals: second.away_goals + et.away_goals,
    extra_time: 1,
  };
  if (out.home_goals + first.away_goals !== out.away_goals + first.home_goals) return out;

  return { ...out, ...playPenalties(rng, homeRating, awayRating) };
}

/** Vencedor de uma partida de mata-mata já jogada (considera pênaltis). Devolve o código do país. */
export function winnerOf(match) {
  if (match.home_goals > match.away_goals) return match.home;
  if (match.away_goals > match.home_goals) return match.away;
  return match.home_pens > match.away_pens ? match.home : match.away;
}
