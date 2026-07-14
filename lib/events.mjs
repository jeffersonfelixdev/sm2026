/**
 * Simulação event-driven de uma partida.
 *
 * Parte das médias Poisson de lib/match.mjs e espalha gols, cartões, lesões, defesas,
 * roubadas e substituições ao longo dos 90' (e prorrogação, se houver). A timeline é
 * pré-calculada no servidor; o cliente só a reproduz.
 */
import {
  expectedGoalsFor, playExtraTime, playPenalties, FORM,
} from './match.mjs';
import { FIFA_SUBS, subLimits } from './subs.mjs';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Formata minuto no padrão FIFA: 43' / 90+2' / 120+1'. */
export function formatMinute(minute, stoppage = 0) {
  if (stoppage > 0) return `${minute}+${stoppage}'`;
  return `${minute}'`;
}

/**
 * Escolhe um jogador entre os titulares com peso pelo atributo relevante.
 * `attr` é o nome do campo (shooting, defending…). GK nunca marca (salvo último recurso).
 */
function pickWeighted(rng, players, attr, { allowGk = false, positionMul } = {}) {
  const pool = players.filter((p) => allowGk || p.position !== 'GK');
  if (!pool.length) return players[0] ?? null;
  const weights = pool.map((p) => {
    const base = Math.max(1, (p[attr] ?? p.overall ?? 50) ** 1.4);
    const mul = positionMul ? (positionMul[p.position] ?? 1) : 1;
    return Math.max(0.01, base * mul);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Peso por posição na atribuição de gols (FW/MF sobem; DF cai). */
const GOAL_POSITION_MUL = { FW: 2.6, MF: 1.55, DF: 0.28, GK: 0.04 };

function randomMinute(rng, from, to) {
  return from + Math.floor(rng() * (to - from + 1));
}

/** Acrescimos típicos (1–5) ao fim de cada tempo. */
function stoppageFor(rng, half) {
  return 1 + Math.floor(rng() * (half === 1 ? 4 : 5));
}

/**
 * Gera a timeline completa de um jogo de 90 minutos (+ ET/pênaltis se pedido).
 *
 * `homeXI` / `awayXI` — arrays de jogadores com { id, position, overall, shooting… }.
 * `opts.knockout` / `secondLeg` / `firstLeg` — espelham a lógica de lib/match.mjs.
 * `opts.manualSides` — lados ('home'|'away') cuja troca o treinador controla: sem auto-sub.
 */
export function simulateMatchTimeline(rng, homeRating, awayRating, homeXI, awayXI, opts = {}) {
  const neutral = !!opts.neutral;
  const manualSides = new Set(opts.manualSides ?? []);
  const isManual = (side) => manualSides.has(side);
  const form = () => (rng() - 0.5) * 2 * FORM;
  const [eh, ea] = expectedGoalsFor(homeRating + form(), awayRating + form(), neutral);

  const homeGoals = rng.poisson(eh);
  const awayGoals = rng.poisson(ea);

  const events = [];
  const onPitch = {
    home: homeXI.filter((p) => p.is_starter !== 0).slice(0, 11),
    away: awayXI.filter((p) => p.is_starter !== 0).slice(0, 11),
  };
  // Se não veio is_starter, assume que a lista já é o XI.
  if (!onPitch.home.length) onPitch.home = homeXI.slice(0, 11);
  if (!onPitch.away.length) onPitch.away = awayXI.slice(0, 11);

  // Snapshot do XI inicial — a sanitização cronológica parte daqui.
  const kickoffXI = {
    home: [...onPitch.home],
    away: [...onPitch.away],
  };

  const benches = {
    home: homeXI.filter((p) => !onPitch.home.includes(p)),
    away: awayXI.filter((p) => !onPitch.away.includes(p)),
  };

  const push = (ev) => events.push(ev);

  function placeGoals(side, count, from, to) {
    const used = new Set();
    for (let i = 0; i < count; i++) {
      let minute = randomMinute(rng, from, to);
      while (used.has(minute) && used.size < (to - from)) {
        minute = randomMinute(rng, from, to);
      }
      used.add(minute);
      const scorers = onPitch[side];
      const scorer = pickWeighted(rng, scorers, 'shooting', { positionMul: GOAL_POSITION_MUL })
        ?? scorers[0];
      const assistPool = scorers.filter((p) => p !== scorer && p.position !== 'GK');
      const assist = assistPool.length && rng() < 0.72
        ? pickWeighted(rng, assistPool, 'passing')
        : null;
      push({
        minute, stoppage: 0, type: 'goal', team: side,
        player_id: scorer?.id ?? null,
        assist_id: assist?.id ?? null,
      });
      if (assist) {
        push({
          minute, stoppage: 0, type: 'assist', team: side,
          player_id: assist.id, assist_id: null,
        });
      }
    }
  }

  // Gols nos dois tempos
  const split = (n) => {
    const first = Math.floor(rng() * (n + 1));
    return [first, n - first];
  };
  const [home1, home2] = split(homeGoals);
  const [away1, away2] = split(awayGoals);
  placeGoals('home', home1, 1, 45);
  placeGoals('away', away1, 1, 45);
  placeGoals('home', home2, 46, 90);
  placeGoals('away', away2, 46, 90);

  // Cartões, lesões, defesas, roubadas — proporcional à força relativa
  const cardNoise = () => 1 + Math.floor(rng() * 3);
  const yellows = cardNoise() + cardNoise();
  for (let i = 0; i < yellows; i++) {
    const side = rng() < 0.5 ? 'home' : 'away';
    const p = pickWeighted(rng, onPitch[side], 'defending', { allowGk: true });
    push({
      minute: randomMinute(rng, 8, 88), stoppage: 0, type: 'yellow', team: side,
      player_id: p?.id ?? null, assist_id: null,
    });
  }

  if (rng() < 0.08) {
    const side = rng() < 0.5 ? 'home' : 'away';
    const p = pickWeighted(rng, onPitch[side], 'physical', { allowGk: true });
    push({
      minute: randomMinute(rng, 20, 85), stoppage: 0, type: 'red', team: side,
      player_id: p?.id ?? null, assist_id: null,
      meta: JSON.stringify({ reason: 'straight' }),
    });
  }

  // Lesões (grau leve/médio/grave → dias)
  const injurySubUsed = { home: 0, away: 0 };
  const injuryWindowUsed = { home: 0, away: 0 };

  if (rng() < 0.12) {
    const side = rng() < 0.5 ? 'home' : 'away';
    const p = pickWeighted(rng, onPitch[side], 'physical', { allowGk: true });
    const grade = rng() < 0.55 ? 'leve' : rng() < 0.85 ? 'média' : 'grave';
    const days = grade === 'leve' ? 7 + Math.floor(rng() * 10)
      : grade === 'média' ? 18 + Math.floor(rng() * 25)
        : 45 + Math.floor(rng() * 60);
    const minute = randomMinute(rng, 10, 80);
    push({
      minute, stoppage: 0, type: 'injury', team: side,
      player_id: p?.id ?? null, assist_id: null,
      meta: JSON.stringify({ grade, days, needs_sub: true }),
    });
    // Auto-sub só para seleções da CPU — conta nas 5 / 3 janelas FIFA.
    if (!isManual(side) && p) {
      const limits = subLimits(false);
      const bench = benches[side].filter((b) => b.position === p.position || b.position !== 'GK' || p.position === 'GK');
      const incoming = bench[0] ?? benches[side][0];
      if (incoming && injurySubUsed[side] < limits.maxSubs) {
        push({
          minute: minute + 1, stoppage: 0, type: 'sub', team: side,
          player_id: incoming.id, assist_id: p.id,
          meta: JSON.stringify({ reason: 'injury' }),
        });
        onPitch[side] = onPitch[side].map((x) => (x === p ? incoming : x));
        benches[side] = benches[side].filter((x) => x !== incoming);
        injurySubUsed[side] += 1;
        injuryWindowUsed[side] += 1;
      }
    }
  }

  // Substituições táticas da CPU — FIFA: ≤5 trocas em ≤3 janelas (vários no mesmo minuto = 1 janela)
  for (const side of ['home', 'away']) {
    if (isManual(side)) continue;
    const limits = subLimits(false);
    let used = injurySubUsed[side];
    let windows = injuryWindowUsed[side];
    const remaining = limits.maxSubs - used;
    const windowsLeft = limits.maxWindows - windows;
    if (remaining <= 0 || windowsLeft <= 0 || !benches[side].length) continue;

    const nWindows = Math.min(windowsLeft, 1 + Math.floor(rng() * windowsLeft));
    const usedMinutes = new Set();
    let left = remaining;

    for (let w = 0; w < nWindows && left > 0 && benches[side].length; w++) {
      let minute = randomMinute(rng, 50, 88);
      let guard = 0;
      while (usedMinutes.has(minute) && guard++ < 20) minute = randomMinute(rng, 50, 88);
      usedMinutes.add(minute);

      const batch = Math.min(left, benches[side].length, 1 + Math.floor(rng() * 2));
      for (let i = 0; i < batch; i++) {
        const out = onPitch[side].find((p) => p.position !== 'GK') ?? onPitch[side][0];
        const incoming = benches[side].shift();
        if (!out || !incoming) break;
        push({
          minute, stoppage: 0, type: 'sub', team: side,
          player_id: incoming.id, assist_id: out.id,
          meta: JSON.stringify({ reason: 'tactical', batch: true }),
        });
        onPitch[side] = onPitch[side].map((x) => (x === out ? incoming : x));
        left -= 1;
        used += 1;
      }
      windows += 1;
    }
  }

  // Cap de segurança: nunca mais de maxRegulation eventos `sub` por lado no 90'
  for (const side of ['home', 'away']) {
    const sideSubs = events.filter((e) => e.type === 'sub' && e.team === side && e.minute <= 90);
    if (sideSubs.length > FIFA_SUBS.maxRegulation) {
      const drop = new Set(sideSubs.slice(FIFA_SUBS.maxRegulation));
      for (let i = events.length - 1; i >= 0; i--) {
        if (drop.has(events[i])) events.splice(i, 1);
      }
    }
  }

  // Ações defensivas (só registro)
  const actions = 4 + Math.floor(rng() * 6);
  for (let i = 0; i < actions; i++) {
    const side = rng() < 0.5 ? 'home' : 'away';
    const type = rng() < 0.45 ? 'tackle' : 'save';
    const pool = type === 'save'
      ? onPitch[side].filter((p) => p.position === 'GK')
      : onPitch[side].filter((p) => p.position === 'DF' || p.position === 'MF');
    const p = pickWeighted(rng, pool.length ? pool : onPitch[side], type === 'save' ? 'keeping' : 'defending', { allowGk: true });
    push({
      minute: randomMinute(rng, 5, 90), stoppage: 0, type, team: side,
      player_id: p?.id ?? null, assist_id: null,
    });
  }

  // Acréscimos nos fins de tempo
  const st1 = stoppageFor(rng, 1);
  const st2 = stoppageFor(rng, 2);
  push({ minute: 45, stoppage: st1, type: 'half_time', team: null, player_id: null, assist_id: null });
  push({ minute: 90, stoppage: st2, type: 'full_time', team: null, player_id: null, assist_id: null });

  let result = { home_goals: homeGoals, away_goals: awayGoals, extra_time: 0, home_pens: null, away_pens: null };

  // Prorrogação / pênaltis
  const needsEt = opts.forceEt
    || (opts.knockout && homeGoals === awayGoals)
    || (opts.secondLeg && opts.firstLeg && (() => {
      const aggH = homeGoals + opts.firstLeg.away_goals;
      const aggA = awayGoals + opts.firstLeg.home_goals;
      return aggH === aggA;
    })());

  if (needsEt) {
    const et = playExtraTime(rng, homeRating, awayRating, { neutral });
    result.home_goals += et.home_goals;
    result.away_goals += et.away_goals;
    result.extra_time = 1;
    placeGoals('home', et.home_goals, 91, 120);
    placeGoals('away', et.away_goals, 91, 120);
    push({ minute: 120, stoppage: 1 + Math.floor(rng() * 3), type: 'et_end', team: null, player_id: null, assist_id: null });

    const stillTied = opts.secondLeg && opts.firstLeg
      ? (result.home_goals + opts.firstLeg.away_goals) === (result.away_goals + opts.firstLeg.home_goals)
      : result.home_goals === result.away_goals;

    if (stillTied) {
      const pens = playPenalties(rng, homeRating, awayRating);
      result.home_pens = pens.home_pens;
      result.away_pens = pens.away_pens;
      push({
        minute: 120, stoppage: 0, type: 'penalties', team: null,
        player_id: null, assist_id: null,
        meta: JSON.stringify(pens),
      });
    }
  }

  // Ordena: minuto, depois stoppage, depois tipo
  const order = { goal: 0, assist: 1, yellow: 2, red: 2, injury: 3, sub: 4, tackle: 5, save: 5, half_time: 6, full_time: 7, et_end: 8, penalties: 9 };
  events.sort((a, b) =>
    a.minute - b.minute
    || a.stoppage - b.stoppage
    || (order[a.type] ?? 9) - (order[b.type] ?? 9));

  // Quem saiu (sub/expulsão) não toma cartão, não se lesiona e não marca.
  // Expulso não é substituído — fica fora do jogo.
  return { ...result, events: sanitizePitchEvents(events, kickoffXI) };
}

/**
 * Reaplica a timeline em ordem cronológica e descarta eventos inválidos
 * (cartão/lesão/gol de quem já não está em campo).
 */
function sanitizePitchEvents(events, initialOnPitch) {
  const pitch = {
    home: new Set(initialOnPitch.home.map((p) => p.id).filter(Boolean)),
    away: new Set(initialOnPitch.away.map((p) => p.id).filter(Boolean)),
  };
  const yellows = { home: new Map(), away: new Map() };
  const out = [];

  for (const e of events) {
    const side = e.team === 'home' || e.team === 'away' ? e.team : null;

    if (e.type === 'sub' && side) {
      const outId = e.assist_id;
      const inId = e.player_id;
      // Só troca se o titular ainda está em campo (não expulso / já saiu)
      if (!outId || !pitch[side].has(outId)) continue;
      pitch[side].delete(outId);
      if (inId) pitch[side].add(inId);
      out.push(e);
      continue;
    }

    if ((e.type === 'yellow' || e.type === 'red' || e.type === 'injury'
      || e.type === 'goal' || e.type === 'assist' || e.type === 'tackle' || e.type === 'save')
      && side && e.player_id) {
      if (!pitch[side].has(e.player_id)) continue;
    }

    if (e.type === 'yellow' && side && e.player_id) {
      const n = (yellows[side].get(e.player_id) ?? 0) + 1;
      yellows[side].set(e.player_id, n);
      out.push(e);
      // Segundo amarelo = expulsão
      if (n >= 2) {
        pitch[side].delete(e.player_id);
        out.push({
          ...e,
          type: 'red',
          meta: JSON.stringify({ reason: 'second_yellow' }),
        });
      }
      continue;
    }

    if (e.type === 'red' && side && e.player_id) {
      out.push(e);
      pitch[side].delete(e.player_id);
      continue;
    }

    out.push(e);
  }

  return out;
}

/**
 * Nota de atuação 0–10 a partir dos eventos do jogador no jogo.
 * Base 6; gols/assistências sobem; cartões/lesões descem.
 */
export function performanceRating(playerId, events) {
  let score = 6;
  for (const e of events) {
    if (e.player_id === playerId) {
      if (e.type === 'goal') score += 1.2;
      if (e.type === 'assist') score += 0.8;
      if (e.type === 'save') score += 0.25;
      if (e.type === 'tackle') score += 0.15;
      if (e.type === 'yellow') score -= 0.4;
      if (e.type === 'red') score -= 1.5;
      if (e.type === 'injury') score -= 0.8;
    }
    if (e.assist_id === playerId && e.type === 'goal') score += 0.8;
  }
  return clamp(Math.round(score * 10) / 10, 3, 10);
}

/** Dias a adicionar a uma data ISO. */
export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
