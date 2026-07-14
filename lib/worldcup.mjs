/**
 * Copa do Mundo FIFA 2026 — sorteio por potes e formato do torneio.
 *
 * O sorteio segue os procedimentos oficiais da FIFA (Final Draw 2026):
 * potes pelo Ranking FIFA, anfitriões fixos (MEX A1, CAN B1, USA D1),
 * restrições de confederação, pathways dos 4 melhores e padrão de posições.
 */
import { formatDateLabel } from './calendar.mjs';
import { resolveStage } from './engine.mjs';
import { addDays, performanceRating, simulateMatchTimeline } from './events.mjs';
import { HOSTS } from './formats.mjs';
import { teamRating } from './match.mjs';
import { rngFrom } from './rng.mjs';
import { averageOverall, bestSquad, SQUAD_RULES } from './squad.mjs';
import { rankAcrossGroups, conductScoresFromEvents } from './rules.mjs';
import { worldCupScorers } from './scorers.mjs';

export const WC_GROUPS = 'ABCDEFGHIJKL'.split('');

/** Pathways e quarters do Appendix A (FIFA Draw Procedures 2026). */
export const WC_PATHWAY = {
  H1: ['E', 'F', 'I', 'D', 'G', 'H'], // quarters Q1∪Q2
  H2: ['A', 'C', 'L', 'B', 'J', 'K'], // quarters Q3∪Q4
};
export const WC_QUARTERS = {
  Q1: ['E', 'F', 'I'],
  Q2: ['D', 'G', 'H'],
  Q3: ['A', 'C', 'L'],
  Q4: ['B', 'J', 'K'],
};

const PATHWAY_OF = Object.fromEntries(
  WC_GROUPS.map((g) => [g, WC_PATHWAY.H1.includes(g) ? 'H1' : 'H2']),
);
const QUARTER_OF = Object.fromEntries(
  Object.entries(WC_QUARTERS).flatMap(([q, groups]) => groups.map((g) => [g, q])),
);

/** Anfitriões: grupo + posição 1 pré-fixados. */
export const HOST_SLOTS = { MEX: 'A', CAN: 'B', USA: 'D' };

/**
 * Grupos oficiais da Copa 2026 (posições 1–4, alinhadas aos confrontos MD1).
 * Fonte: calendário FIFA / resultados do torneio.
 */
export const REAL_WC_2026_GROUPS = [
  { name: 'A', teams: ['MEX', 'RSA', 'KOR', 'CZE'] },
  { name: 'B', teams: ['CAN', 'BIH', 'QAT', 'SUI'] },
  { name: 'C', teams: ['BRA', 'MAR', 'HAI', 'SCO'] },
  { name: 'D', teams: ['USA', 'PAR', 'AUS', 'TUR'] },
  { name: 'E', teams: ['GER', 'CUW', 'CIV', 'ECU'] },
  { name: 'F', teams: ['NED', 'JPN', 'SWE', 'TUN'] },
  { name: 'G', teams: ['BEL', 'EGY', 'IRN', 'NZL'] },
  { name: 'H', teams: ['ESP', 'CPV', 'KSA', 'URU'] },
  { name: 'I', teams: ['FRA', 'SEN', 'IRQ', 'NOR'] },
  { name: 'J', teams: ['ARG', 'ALG', 'AUT', 'JOR'] },
  { name: 'K', teams: ['POR', 'COD', 'UZB', 'COL'] },
  { name: 'L', teams: ['ENG', 'CRO', 'GHA', 'PAN'] },
];

export const REAL_WC_2026_CODES = REAL_WC_2026_GROUPS.flatMap((g) => g.teams);

/**
 * Padrão de posições (Appendix B): dado o pote e o grupo, em qual posição o time entra.
 * Pot 1 = sempre posição 1.
 */
const POS_BY_POT = {
  // grupo → { pot → position }
  A: { 2: 3, 3: 2, 4: 4 }, D: { 2: 3, 3: 2, 4: 4 }, G: { 2: 3, 3: 2, 4: 4 }, J: { 2: 3, 3: 2, 4: 4 },
  B: { 2: 4, 3: 3, 4: 2 }, E: { 2: 4, 3: 3, 4: 2 }, H: { 2: 4, 3: 3, 4: 2 }, K: { 2: 4, 3: 3, 4: 2 },
  C: { 2: 2, 3: 4, 4: 3 }, F: { 2: 2, 3: 4, 4: 3 }, I: { 2: 2, 3: 4, 4: 3 }, L: { 2: 2, 3: 4, 4: 3 },
};

/** Pote FIFA (1–4) que, no padrão Appendix B, ocupa a posição dada no grupo. */
function potForGroupPosition(groupName, position) {
  if (position === 1) return 1;
  const map = POS_BY_POT[groupName] ?? {};
  for (const [pot, pos] of Object.entries(map)) {
    if (Number(pos) === position) return Number(pot);
  }
  return position;
}

/** Confrontos por matchday, por posição no grupo (1–4). */
const PAIRINGS = {
  1: [[1, 2], [3, 4]],
  2: [[1, 3], [4, 2]],
  3: [[4, 1], [2, 3]],
};

/**
 * Calendário da fase de grupos — datas e horários em UTC (oficial FIFA / KickoffClock).
 *
 * MD1 e MD2: cada partida tem date+kickoff UTC únicos → nunca simultâneas.
 * MD3: os dois jogos do mesmo grupo compartilham o mesmo UTC (simultâneos de fato).
 *
 * Para cada grupo: { matchday → [{ date, kickoff }] } na ordem de PAIRINGS.
 */
const GROUP_SCHEDULE = {
  A: {
    1: [
      { date: '2026-06-11', kickoff: '19:00' },
      { date: '2026-06-12', kickoff: '02:00' },
    ],
    2: [
      { date: '2026-06-19', kickoff: '01:00' },
      { date: '2026-06-18', kickoff: '16:00' },
    ],
    3: [
      { date: '2026-06-25', kickoff: '01:00' },
      { date: '2026-06-25', kickoff: '01:00' },
    ],
  },
  B: {
    1: [
      { date: '2026-06-12', kickoff: '19:00' },
      { date: '2026-06-13', kickoff: '19:00' },
    ],
    2: [
      { date: '2026-06-18', kickoff: '22:00' },
      { date: '2026-06-18', kickoff: '19:00' },
    ],
    3: [
      { date: '2026-06-24', kickoff: '19:00' },
      { date: '2026-06-24', kickoff: '19:00' },
    ],
  },
  C: {
    1: [
      { date: '2026-06-13', kickoff: '22:00' },
      { date: '2026-06-14', kickoff: '01:00' },
    ],
    2: [
      { date: '2026-06-20', kickoff: '00:30' },
      { date: '2026-06-19', kickoff: '22:00' },
    ],
    3: [
      { date: '2026-06-24', kickoff: '22:00' },
      { date: '2026-06-24', kickoff: '22:00' },
    ],
  },
  D: {
    1: [
      { date: '2026-06-13', kickoff: '01:00' },
      { date: '2026-06-14', kickoff: '16:00' },
    ],
    2: [
      { date: '2026-06-19', kickoff: '19:00' },
      { date: '2026-06-20', kickoff: '03:00' },
    ],
    3: [
      { date: '2026-06-26', kickoff: '02:00' },
      { date: '2026-06-26', kickoff: '02:00' },
    ],
  },
  E: {
    1: [
      { date: '2026-06-14', kickoff: '17:00' },
      { date: '2026-06-14', kickoff: '23:00' },
    ],
    2: [
      { date: '2026-06-20', kickoff: '20:00' },
      { date: '2026-06-21', kickoff: '00:00' },
    ],
    3: [
      { date: '2026-06-25', kickoff: '20:00' },
      { date: '2026-06-25', kickoff: '20:00' },
    ],
  },
  F: {
    1: [
      { date: '2026-06-14', kickoff: '20:00' },
      { date: '2026-06-15', kickoff: '02:00' },
    ],
    2: [
      { date: '2026-06-20', kickoff: '17:00' },
      { date: '2026-06-21', kickoff: '04:00' },
    ],
    3: [
      { date: '2026-06-25', kickoff: '23:00' },
      { date: '2026-06-25', kickoff: '23:00' },
    ],
  },
  G: {
    1: [
      { date: '2026-06-15', kickoff: '19:00' },
      { date: '2026-06-16', kickoff: '01:00' },
    ],
    2: [
      { date: '2026-06-21', kickoff: '19:00' },
      { date: '2026-06-22', kickoff: '01:00' },
    ],
    3: [
      { date: '2026-06-27', kickoff: '03:00' },
      { date: '2026-06-27', kickoff: '03:00' },
    ],
  },
  H: {
    1: [
      { date: '2026-06-15', kickoff: '16:00' },
      { date: '2026-06-15', kickoff: '22:00' },
    ],
    2: [
      { date: '2026-06-21', kickoff: '16:00' },
      { date: '2026-06-21', kickoff: '22:00' },
    ],
    3: [
      { date: '2026-06-27', kickoff: '00:00' },
      { date: '2026-06-27', kickoff: '00:00' },
    ],
  },
  I: {
    1: [
      { date: '2026-06-16', kickoff: '19:00' },
      { date: '2026-06-16', kickoff: '22:00' },
    ],
    2: [
      { date: '2026-06-22', kickoff: '21:00' },
      { date: '2026-06-23', kickoff: '00:00' },
    ],
    3: [
      { date: '2026-06-26', kickoff: '19:00' },
      { date: '2026-06-26', kickoff: '19:00' },
    ],
  },
  J: {
    1: [
      { date: '2026-06-17', kickoff: '01:00' },
      { date: '2026-06-17', kickoff: '04:00' },
    ],
    2: [
      { date: '2026-06-22', kickoff: '17:00' },
      { date: '2026-06-23', kickoff: '03:00' },
    ],
    3: [
      { date: '2026-06-28', kickoff: '02:00' },
      { date: '2026-06-28', kickoff: '02:00' },
    ],
  },
  K: {
    1: [
      { date: '2026-06-17', kickoff: '17:00' },
      { date: '2026-06-18', kickoff: '02:00' },
    ],
    2: [
      { date: '2026-06-23', kickoff: '17:00' },
      { date: '2026-06-24', kickoff: '02:00' },
    ],
    3: [
      { date: '2026-06-27', kickoff: '23:30' },
      { date: '2026-06-27', kickoff: '23:30' },
    ],
  },
  L: {
    1: [
      { date: '2026-06-17', kickoff: '20:00' },
      { date: '2026-06-17', kickoff: '23:00' },
    ],
    2: [
      { date: '2026-06-23', kickoff: '20:00' },
      { date: '2026-06-23', kickoff: '23:00' },
    ],
    3: [
      { date: '2026-06-27', kickoff: '21:00' },
      { date: '2026-06-27', kickoff: '21:00' },
    ],
  },
};

/**
 * Datas/horários dos mata-matas — calendário oficial FIFA 2026 (Wikipedia /
 * FIFA Match Schedule), convertidos para UTC a partir do horário local + fuso.
 *
 * Fonte: https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage
 * Ordem cronológica por kickoff UTC (16avos 28 jun–3 jul | oitavas 4–7 jul).
 */
const KO_SCHEDULE = {
  r32: [
    { date: '2026-06-28', kickoff: '19:00' }, // Match 73 RSA–CAN · 12:00 UTC−7
    { date: '2026-06-29', kickoff: '17:00' }, // Match 76 BRA–JPN · 12:00 UTC−5
    { date: '2026-06-29', kickoff: '20:30' }, // Match 74 GER–PAR · 16:30 UTC−4
    { date: '2026-06-30', kickoff: '01:00' }, // Match 75 NED–MAR · 19:00 UTC−6 (29 jun)
    { date: '2026-06-30', kickoff: '17:00' }, // Match 78 CIV–NOR · 12:00 UTC−5
    { date: '2026-06-30', kickoff: '21:00' }, // Match 77 FRA–SWE · 17:00 UTC−4
    { date: '2026-07-01', kickoff: '02:00' }, // Match 79 MEX–ECU · 20:00 UTC−6 (30 jun)
    { date: '2026-07-01', kickoff: '16:00' }, // Match 80 ENG–COD · 12:00 UTC−4
    { date: '2026-07-01', kickoff: '20:00' }, // Match 82 BEL–SEN · 13:00 UTC−7
    { date: '2026-07-02', kickoff: '00:00' }, // Match 81 USA–BIH · 17:00 UTC−7 (1 jul)
    { date: '2026-07-02', kickoff: '19:00' }, // Match 84 ESP–AUT · 12:00 UTC−7
    { date: '2026-07-02', kickoff: '23:00' }, // Match 83 POR–CRO · 19:00 UTC−4
    { date: '2026-07-03', kickoff: '03:00' }, // Match 85 SUI–ALG · 20:00 UTC−7 (2 jul)
    { date: '2026-07-03', kickoff: '18:00' }, // Match 88 AUS–EGY · 13:00 UTC−5
    { date: '2026-07-03', kickoff: '22:00' }, // Match 86 ARG–CPV · 18:00 UTC−4
    { date: '2026-07-04', kickoff: '01:30' }, // Match 87 COL–GHA · 20:30 UTC−5 (3 jul)
  ],
  r16: [
    { date: '2026-07-04', kickoff: '17:00' }, // Match 90 CAN–MAR · 12:00 UTC−5
    { date: '2026-07-04', kickoff: '21:00' }, // Match 89 PAR–FRA · 17:00 UTC−4
    { date: '2026-07-05', kickoff: '20:00' }, // Match 91 BRA–NOR · 16:00 UTC−4
    { date: '2026-07-06', kickoff: '00:00' }, // Match 92 MEX–ENG · 18:00 UTC−6 (5 jul, horário previsto)
    { date: '2026-07-06', kickoff: '19:00' }, // Match 93 POR–ESP · 14:00 UTC−5
    { date: '2026-07-07', kickoff: '00:00' }, // Match 94 USA–BEL · 17:00 UTC−7 (6 jul)
    { date: '2026-07-07', kickoff: '16:00' }, // Match 95 ARG–EGY · 12:00 UTC−4
    { date: '2026-07-07', kickoff: '20:00' }, // Match 96 SUI–COL · 13:00 UTC−7
  ],
  qf: [
    { date: '2026-07-09', kickoff: '20:00' }, // Match 97 · 16:00 UTC−4
    { date: '2026-07-10', kickoff: '19:00' }, // Match 98 · 12:00 UTC−7
    { date: '2026-07-11', kickoff: '21:00' }, // Match 99 · 17:00 UTC−4
    { date: '2026-07-12', kickoff: '01:00' }, // Match 100 · 20:00 UTC−5 (11 jul)
  ],
  sf: [
    { date: '2026-07-14', kickoff: '19:00' }, // Match 101 · 14:00 UTC−5
    { date: '2026-07-15', kickoff: '19:00' }, // Match 102 · 15:00 UTC−4
  ],
  third: [{ date: '2026-07-18', kickoff: '21:00' }], // Match 103 · 17:00 UTC−4
  final: [{ date: '2026-07-19', kickoff: '19:00' }], // Match 104 · 15:00 UTC−4
};

/** Fase seguinte só entra na fila de simulação quando a fase exigida terminou. */
const KO_STAGE_REQUIRES = {
  wc_r16: 'wc_r32',
  wc_qf: 'wc_r16',
  wc_sf: 'wc_qf',
  wc_third: 'wc_sf',
  wc_final: 'wc_sf',
};

const KO_SCHEDULE_BY_KEY = {
  wc_r32: KO_SCHEDULE.r32,
  wc_r16: KO_SCHEDULE.r16,
  wc_qf: KO_SCHEDULE.qf,
  wc_sf: KO_SCHEDULE.sf,
  wc_third: KO_SCHEDULE.third,
  wc_final: KO_SCHEDULE.final,
};

/** País fantasma: jogos TBD×TBD existem no chaveamento, mas não entram na simulação. */
export const TBD_CODE = 'TBD';

/** Fases seguintes aos 16avos — criadas cedo e preenchidas aos poucos. */
const KO_SKELETON_ROUNDS = [
  { key: 'wc_r16', name: 'Oitavas de final', count: 8, slots: KO_SCHEDULE.r16 },
  { key: 'wc_qf', name: 'Quartas de final', count: 4, slots: KO_SCHEDULE.qf },
  { key: 'wc_sf', name: 'Semifinais', count: 2, slots: KO_SCHEDULE.sf },
  { key: 'wc_third', name: 'Disputa de 3º lugar', count: 1, slots: KO_SCHEDULE.third },
  { key: 'wc_final', name: 'Final', count: 1, slots: KO_SCHEDULE.final },
];

const KO_ADVANCE_STEPS = [
  { from: 'wc_r32', to: 'wc_r16' },
  { from: 'wc_r16', to: 'wc_qf' },
  { from: 'wc_qf', to: 'wc_sf' },
];

/** Partida com seleções reais (não placeholder do chaveamento). */
function isPlayableCupMatch(m) {
  return m.home !== TBD_CODE && m.away !== TBD_CODE;
}

/** Oitavas só depois dos 16avos (e assim por diante) — mesmo se as datas se sobrepuserem. */
function isCupStageEligible(db, careerId, stageKey) {
  const requires = KO_STAGE_REQUIRES[stageKey];
  if (!requires) return true;
  const pending = db.prepare(`
    SELECT 1 FROM matches m
    JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.key = ? AND m.played = 0
    LIMIT 1
  `).get(careerId, requires);
  return !pending;
}

function eligibleCupMatches(db, careerId, matches) {
  return matches.filter((m) => isCupStageEligible(db, careerId, m.stage_key));
}

/** Realinha date/kickoff dos jogos ainda não jogados com o calendário FIFA. */
function resyncKnockoutSchedule(db, careerId) {
  for (const [key, slots] of Object.entries(KO_SCHEDULE_BY_KEY)) {
    const stage = db.prepare(
      'SELECT id FROM stages WHERE career_id = ? AND key = ?',
    ).get(careerId, key);
    if (!stage) continue;
    const matches = db.prepare(
      'SELECT id, played FROM matches WHERE stage_id = ? ORDER BY id',
    ).all(stage.id);
    const upd = db.prepare('UPDATE matches SET date = ?, kickoff = ? WHERE id = ?');
    matches.forEach((m, i) => {
      if (m.played) return;
      const slot = slots[i];
      if (!slot) return;
      upd.run(slot.date, slot.kickoff, m.id);
    });
  }
}

function ensureTbdCountry(db) {
  if (db.prepare('SELECT 1 FROM countries WHERE code = ?').get(TBD_CODE)) return;
  db.prepare(`
    INSERT INTO countries (code, name, en_name, confederation, fifa_rank, fifa_points, strength)
    VALUES (?, 'A definir', 'TBD', 'OFC', NULL, NULL, 0)
  `).run(TBD_CODE);
}

function koWinnerCode(tie) {
  const w = tie?.winner;
  return w && w !== TBD_CODE ? w : TBD_CODE;
}

function koLoserCode(tie) {
  const l = tie?.loser;
  return l && l !== TBD_CODE ? l : TBD_CODE;
}

function setKnockoutTieTeams(db, tieDbId, home, away) {
  db.prepare('UPDATE ties SET home = ?, away = ? WHERE id = ?').run(home, away, tieDbId);
  db.prepare(`
    UPDATE matches SET home = ?, away = ? WHERE tie_id = ? AND played = 0
  `).run(home, away, tieDbId);
}

/** Cria R16→final/3º com TBD×TBD se ainda não existirem (após os 16avos). */
function ensureKnockoutSkeletons(db, careerId) {
  if (!db.prepare("SELECT 1 FROM stages WHERE career_id = ? AND key = 'wc_r32'").get(careerId)) {
    return;
  }
  ensureTbdCountry(db);
  for (const round of KO_SKELETON_ROUNDS) {
    if (db.prepare('SELECT 1 FROM stages WHERE career_id = ? AND key = ?').get(careerId, round.key)) {
      continue;
    }
    const pairs = Array.from({ length: round.count }, () => [TBD_CODE, TBD_CODE]);
    const stage = knockoutStageSpec(round.key, round.name, pairs, round.slots);
    const ord = (db.prepare('SELECT MAX(ord) AS max FROM stages WHERE career_id = ?').get(careerId).max ?? 0) + 1;
    saveCupStage(db, careerId, ord, stage, koMatchesFromStage(stage));
  }
  resyncKnockoutSchedule(db, careerId);
}

/**
 * Preenche confrontos da fase seguinte assim que os dois jogos “alimentadores” têm vencedor
 * (não espera a fase atual inteira acabar).
 */
function fillKnockoutAdvances(db, careerId, w) {
  for (const { from, to } of KO_ADVANCE_STEPS) {
    const stage = loadCupStage(db, careerId, from, w.ranks);
    const next = loadCupStage(db, careerId, to, w.ranks);
    if (!stage || !next) continue;

    for (let i = 0; i < next.ties.length; i++) {
      const a = stage.ties[i * 2];
      const b = stage.ties[i * 2 + 1];
      if (!a || !b) continue;
      if (next.matches.some((m) => m.tie === next.ties[i].id && m.played)) continue;

      const home = koWinnerCode(a);
      const away = koWinnerCode(b);
      const tie = next.ties[i];
      if (tie.home === home && tie.away === away) continue;
      setKnockoutTieTeams(db, tie._dbId, home, away);
    }

    if (stage.status !== 'done' && stage.matches.every((m) => m.played)) {
      db.prepare("UPDATE stages SET status = 'done' WHERE id = ?").run(stage._row.id);
    }
  }

  const sf = loadCupStage(db, careerId, 'wc_sf', w.ranks);
  const fin = loadCupStage(db, careerId, 'wc_final', w.ranks);
  const third = loadCupStage(db, careerId, 'wc_third', w.ranks);
  if (sf && fin?.ties?.[0] && !fin.matches.some((m) => m.played)) {
    const home = koWinnerCode(sf.ties[0]);
    const away = koWinnerCode(sf.ties[1]);
    if (fin.ties[0].home !== home || fin.ties[0].away !== away) {
      setKnockoutTieTeams(db, fin.ties[0]._dbId, home, away);
    }
  }
  if (sf && third?.ties?.[0] && !third.matches.some((m) => m.played)) {
    const home = koLoserCode(sf.ties[0]);
    const away = koLoserCode(sf.ties[1]);
    if (third.ties[0].home !== home || third.ties[0].away !== away) {
      setKnockoutTieTeams(db, third.ties[0]._dbId, home, away);
    }
  }
  if (sf && sf.status !== 'done' && sf.matches.every((m) => m.played)) {
    db.prepare("UPDATE stages SET status = 'done' WHERE id = ?").run(sf._row.id);
  }

  for (const key of ['wc_third', 'wc_final']) {
    const stage = loadCupStage(db, careerId, key, w.ranks);
    if (!stage || stage.status === 'done') continue;
    const playable = stage.matches.filter(isPlayableCupMatch);
    if (playable.length && playable.every((m) => m.played)) {
      db.prepare("UPDATE stages SET status = 'done' WHERE id = ?").run(stage._row.id);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Potes
 * ------------------------------------------------------------------ */

/**
 * Monta os 4 potes a partir dos 48 classificados e do ranking no banco.
 * Anfitriões vão sempre ao Pote 1; o restante por fifa_rank.
 */
export function allocatePots(qualified, ranks) {
  const hosts = HOSTS.filter((c) => qualified.includes(c));
  const others = qualified
    .filter((c) => !HOSTS.includes(c))
    .sort((a, b) => (ranks[a] ?? 999) - (ranks[b] ?? 999) || a.localeCompare(b));

  const pot1 = [...hosts, ...others.slice(0, 12 - hosts.length)];
  const pot2 = others.slice(12 - hosts.length, 24 - hosts.length);
  const pot3 = others.slice(24 - hosts.length, 36 - hosts.length);
  const pot4 = others.slice(36 - hosts.length);

  if (pot1.length !== 12 || pot2.length !== 12 || pot3.length !== 12 || pot4.length !== 12) {
    throw new Error(`Potes inválidos: ${[pot1, pot2, pot3, pot4].map((p) => p.length).join(',')}`);
  }
  return [pot1, pot2, pot3, pot4];
}

/* ------------------------------------------------------------------ *
 * Sorteio
 * ------------------------------------------------------------------ */

function confederationOf(code, confByCode) {
  return confByCode[code];
}

/**
 * Verifica se `team` pode entrar no grupo (times já colocados).
 * UEFA: máx. 2; demais confeds: máx. 1.
 */
function canPlace(team, groupName, groups, confByCode) {
  const conf = confederationOf(team, confByCode);
  const current = groups[groupName];
  const confs = current.map((c) => confederationOf(c, confByCode));

  if (conf === 'UEFA') {
    if (confs.filter((c) => c === 'UEFA').length >= 2) return false;
  } else if (confs.includes(conf)) {
    return false;
  }
  return true;
}

/**
 * Sorteio completo. Devolve `{ groups, pots, steps }`.
 *
 * Ordem aleatória dentro do pote (urna FIFA); o computador só oferece grupos
 * válidos. Se emperrar, reinicia — barato e fiel ao draw computer.
 */
export function drawWorldCup2026(qualified, ranks, confByCode, rng) {
  if (qualified.length !== 48) {
    throw new Error(`A Copa precisa de 48 classificados (tem ${qualified.length})`);
  }

  const pots = allocatePots(qualified, ranks);
  const pot1Rest = pots[0].filter((c) => !HOSTS.includes(c));
  const rankedNonHost = [...pot1Rest].sort(
    (a, b) => (ranks[a] ?? 999) - (ranks[b] ?? 999) || a.localeCompare(b),
  );
  const top4 = rankedNonHost.slice(0, 4);
  const top4Set = new Set(top4);

  for (let attempt = 0; attempt < 200; attempt++) {
    const groups = Object.fromEntries(WC_GROUPS.map((g) => [g, [null, null, null, null]]));
    const groupPots = Object.fromEntries(WC_GROUPS.map((g) => [g, {}]));
    const steps = [];

    const place = (team, group, pot) => {
      const pos = pot === 1 ? 1 : POS_BY_POT[group][pot];
      groups[group][pos - 1] = team;
      groupPots[group][team] = pot;
      steps.push({
        pot, team, group, position: pos,
        host: HOSTS.includes(team),
        pathway: PATHWAY_OF[group],
        quarter: QUARTER_OF[group],
      });
    };

    const filled = () => Object.fromEntries(
      WC_GROUPS.map((name) => [name, groups[name].filter(Boolean)]),
    );

    const validGroups = (team, pot) => WC_GROUPS.filter((g) => {
      const pos = pot === 1 ? 1 : POS_BY_POT[g][pot];
      if (groups[g][pos - 1] !== null) return false;
      return canPlace(team, g, filled(), confByCode);
    });

    for (const host of ['MEX', 'CAN', 'USA']) {
      if (qualified.includes(host)) place(host, HOST_SLOTS[host], 1);
    }

    const usedQuarters = new Set();
    let pot1Ok = true;
    for (const team of rng.shuffle(pot1Rest)) {
      let candidates = validGroups(team, 1);
      if (top4Set.has(team)) {
        const idx = top4.indexOf(team);
        const partner = idx % 2 === 0 ? top4[idx + 1] : top4[idx - 1];
        const partnerStep = steps.find((s) => s.team === partner);
        if (partnerStep) {
          const need = partnerStep.pathway === 'H1' ? 'H2' : 'H1';
          candidates = candidates.filter((g) => PATHWAY_OF[g] === need);
        }
        candidates = candidates.filter((g) => !usedQuarters.has(QUARTER_OF[g]));
      }
      if (!candidates.length) { pot1Ok = false; break; }
      const g = candidates[rng.int(candidates.length)];
      place(team, g, 1);
      if (top4Set.has(team)) usedQuarters.add(QUARTER_OF[g]);
    }
    if (!pot1Ok) continue;

    let restOk = true;
    for (let pot = 2; pot <= 4 && restOk; pot++) {
      const order = rng.shuffle(pots[pot - 1]);
      // Europeus primeiro ajudam a cobrir a regra “≥1 UEFA”
      order.sort((a, b) => {
        const ua = confederationOf(a, confByCode) === 'UEFA' ? 0 : 1;
        const ub = confederationOf(b, confByCode) === 'UEFA' ? 0 : 1;
        return ua - ub;
      });

      for (const team of order) {
        let candidates = validGroups(team, pot);
        if (!candidates.length) { restOk = false; break; }

        if (confederationOf(team, confByCode) === 'UEFA') {
          const need = candidates.filter((g) =>
            !filled()[g].some((c) => confederationOf(c, confByCode) === 'UEFA'));
          if (need.length) candidates = need;
        } else {
          const stillUefa = order.some((c) =>
            confederationOf(c, confByCode) === 'UEFA'
            && !steps.some((s) => s.team === c));
          if (stillUefa) {
            const safe = candidates.filter((g) =>
              filled()[g].some((c) => confederationOf(c, confByCode) === 'UEFA'));
            if (safe.length) candidates = safe;
          }
        }

        place(team, candidates[rng.int(candidates.length)], pot);
      }
    }
    if (!restOk) continue;

    let valid = true;
    for (const g of WC_GROUPS) {
      if (groups[g].some((c) => c == null)) { valid = false; break; }
      const uefa = groups[g].filter((c) => confederationOf(c, confByCode) === 'UEFA').length;
      if (uefa < 1 || uefa > 2) { valid = false; break; }
      const counts = {};
      for (const c of groups[g]) {
        const conf = confederationOf(c, confByCode);
        if (conf === 'UEFA') continue;
        counts[conf] = (counts[conf] ?? 0) + 1;
        if (counts[conf] > 1) { valid = false; break; }
      }
      if (!valid) break;
    }
    if (!valid) continue;

    return {
      pots,
      steps,
      groups: WC_GROUPS.map((name) => ({
        name,
        teams: groups[name],
        pots: groupPots[name],
        pathway: PATHWAY_OF[name],
        quarter: QUARTER_OF[name],
      })),
    };
  }

  throw new Error('Não foi possível sortear os grupos com as restrições FIFA');
}

/* ------------------------------------------------------------------ *
 * Partidas da fase de grupos
 * ------------------------------------------------------------------ */

export function groupStageMatches(drawnGroups) {
  const matches = [];
  for (const group of drawnGroups) {
    const byPos = group.teams; // index 0 = pos 1
    for (const md of [1, 2, 3]) {
      const pairs = PAIRINGS[md];
      const slots = GROUP_SCHEDULE[group.name][md];
      pairs.forEach(([pa, pb], i) => {
        const home = byPos[pa - 1];
        const away = byPos[pb - 1];
        const slot = slots[i];
        matches.push({
          group: group.name,
          matchday: md,
          leg: 1,
          home,
          away,
          neutral: 1,
          played: 0,
          date: slot.date,
          kickoff: slot.kickoff,
        });
      });
    }
  }
  return matches;
}

/** Stage espec da fase de grupos. */
export function wcGroupsStage(drawnGroups) {
  return {
    key: 'wc_groups',
    name: 'Copa do Mundo 2026 — Fase de Grupos',
    kind: 'groups',
    legs: 1,
    neutral: true,
    tiebreak: 'wc2026',
    advance: 2,
    playoff: 3, // 3ºs disputam as 8 melhores vagas
    groups: drawnGroups.map((g) => ({
      name: g.name,
      teams: g.teams,
      pots: g.pots,
    })),
    schedule: () => {
      // Não usamos roundRobin padrão — as partidas vêm de groupStageMatches.
      throw new Error('Use groupStageMatches para a Copa');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Classificação / mata-mata
 * ------------------------------------------------------------------ */

/**
 * Com a fase de grupos resolvida: 1ºs, 2ºs e os 8 melhores 3ºs.
 * Critério dos 3ºs: pts → SG → GP → fair play (cartões) → ranking FIFA.
 */
export function advanceFromGroups(stage, ranks) {
  const firsts = {};
  const seconds = {};
  const thirds = [];

  for (const g of stage.groups) {
    firsts[g.name] = g.table[0].code;
    seconds[g.name] = g.table[1].code;
    thirds.push({ ...g.table[2], group: g.name });
  }

  const bestThirds = rankAcrossGroups(thirds, { ranks }).slice(0, 8);
  return { firsts, seconds, bestThirds };
}

/**
 * Chaveamento R32 da Copa 2026 — 16 confrontos.
 *
 * Estrutura oficiais da FIFA: oito 1ºs enfrentam os oito melhores 3ºs;
 * os demais 1ºs e 2ºs se cruzam em pares que preservam as duas pathways
 * (H1 = E,F,I,D,G,H · H2 = A,C,L,B,J,K). A atribuição exata dos 3ºs
 * depende da combinação de grupos — usamos a tabela FIFA quando conhecida,
 * senão um fallback determinístico por pontos.
 */
export function roundOf32Ties(firsts, seconds, bestThirds) {
  const W = (g) => firsts[g];
  const R = (g) => seconds[g];
  const thirds = [...bestThirds];
  const t = () => thirds.shift()?.code;

  // 32 times únicos: 12×1º + 12×2º + 8×3º. Pathways H2 / H1 separadas.
  return [
    // Pathway H2 (A,C,L,B,J,K)
    [W('A'), t()],
    [W('B'), t()],
    [W('C'), t()],
    [W('L'), t()],
    [W('J'), R('A')],
    [W('K'), R('B')],
    [R('C'), R('L')],
    [R('J'), R('K')],
    // Pathway H1 (E,F,I,D,G,H)
    [W('E'), t()],
    [W('F'), t()],
    [W('I'), t()],
    [W('D'), t()],
    [W('G'), R('E')],
    [W('H'), R('F')],
    [R('I'), R('D')],
    [R('G'), R('H')],
  ].filter(([a, b]) => a && b);
}

/** Constrói stage de mata-mata a partir de pares [home, away]. */
export function knockoutStageSpec(key, name, pairs, scheduleSlots) {
  return {
    key,
    name,
    kind: 'knockout',
    legs: 1,
    neutral: true,
    ties: pairs.map(([home, away], i) => ({
      id: `${key}-${i + 1}`,
      name: `${name} ${i + 1}`,
      home,
      away,
      date: scheduleSlots[i]?.date,
      kickoff: scheduleSlots[i]?.kickoff,
    })),
  };
}

export function koMatchesFromStage(stage) {
  return stage.ties.map((tie, i) => ({
    group: null,
    tie: tie.id,
    matchday: 1,
    leg: 1,
    home: tie.home,
    away: tie.away,
    neutral: 1,
    played: 0,
    date: tie.date ?? KO_SCHEDULE.r32[i]?.date,
    kickoff: tie.kickoff ?? KO_SCHEDULE.r32[i]?.kickoff,
  }));
}

/* ------------------------------------------------------------------ *
 * Persistência + loop da Copa
 * ------------------------------------------------------------------ */

function playerRow(p) {
  return {
    id: p.id, name: p.name, position: p.position, overall: p.overall,
    shooting: p.shooting, passing: p.passing, defending: p.defending,
    physical: p.physical, keeping: p.keeping, pace: p.pace, dribbling: p.dribbling,
  };
}

function availablePlayers(db, careerId, countryCode, onDate) {
  return db.prepare('SELECT * FROM players WHERE country_code = ? ORDER BY overall DESC')
    .all(countryCode)
    .filter((p) => {
      const av = db.prepare(
        'SELECT suspended_until, injured_until FROM player_availability WHERE career_id = ? AND player_id = ?',
      ).get(careerId, p.id);
      if (!av) return true;
      if (av.suspended_until && av.suspended_until >= onDate) return false;
      if (av.injured_until && av.injured_until >= onDate) return false;
      return true;
    })
    .map(playerRow);
}

function squadForCountry(db, careerId, countryCode, playerCountry) {
  if (countryCode === playerCountry) {
    return db.prepare(`
      SELECT p.* FROM call_ups cu JOIN players p ON p.id = cu.player_id
      WHERE cu.career_id = ? ORDER BY cu.shirt
    `).all(careerId).map(playerRow);
  }
  const ai = db.prepare(`
    SELECT p.* FROM team_call_ups t JOIN players p ON p.id = t.player_id
    WHERE t.career_id = ? AND t.country_code = ? ORDER BY t.shirt
  `).all(careerId, countryCode).map(playerRow);
  if (ai.length) return ai;
  return availablePlayers(db, careerId, countryCode, '9999-12-31').slice(0, 23);
}

function loadCupCareer(db, careerId) {
  return db.prepare(`
    SELECT ca.*, co.name AS country_name, co.flag, co.fifa_rank, co.confederation AS country_conf
    FROM careers ca JOIN countries co ON co.code = ca.country_code WHERE ca.id = ?
  `).get(careerId);
}

function loadCupRanks(db) {
  const countries = db.prepare('SELECT code, confederation, fifa_rank, strength FROM countries').all();
  return {
    countries,
    ranks: Object.fromEntries(countries.map((c) => [c.code, c.fifa_rank ?? 999])),
    confByCode: Object.fromEntries(countries.map((c) => [c.code, c.confederation])),
    strengthOf: Object.fromEntries(countries.map((c) => [c.code, c.strength])),
  };
}

/**
 * Mundo da Copa. Por padrão só calcula rating das 48 classificadas (+ a seleção do jogador);
 * recalcular 211 seleções a cada GET travava a tela "Ver tabelas".
 */
function cupWorld(db, careerId, { rateAll = false } = {}) {
  const career = loadCupCareer(db, careerId);
  const { countries, ranks, confByCode, strengthOf } = loadCupRanks(db);
  const ratings = { ...strengthOf };

  const focus = new Set(loadQualifiedCodes(db, careerId));
  if (career?.country_code) focus.add(career.country_code);

  for (const code of Object.keys(strengthOf)) {
    if (!rateAll && !focus.has(code)) continue;
    const squad = squadForCountry(db, careerId, code, career.country_code);
    if (squad.length < 11) continue;
    const pool = db.prepare('SELECT position, overall FROM players WHERE country_code = ?').all(code);
    ratings[code] = teamRating(
      strengthOf[code],
      averageOverall(squad),
      averageOverall(bestSquad(pool)),
    );
  }

  return {
    career,
    ranks,
    ratings,
    confByCode,
    countries,
    rngFor: (key) => rngFrom(`career:${careerId}|wc|${key}`),
  };
}

export function loadQualifiedCodes(db, careerId) {
  return db.prepare('SELECT country_code FROM qualified WHERE career_id = ?')
    .all(careerId).map((r) => r.country_code);
}

export function hasWorldCupDraw(db, careerId) {
  return !!db.prepare(
    "SELECT 1 FROM stages WHERE career_id = ? AND key = 'wc_groups' LIMIT 1",
  ).get(careerId);
}

/** Estado pré-sorteio (para a tela espectadora). */
export function drawPreview(db, careerId) {
  const drawn = hasWorldCupDraw(db, careerId);
  const career = loadCupCareer(db, careerId);
  const codes = loadQualifiedCodes(db, careerId);
  const base = {
    ready: !drawn,
    drawn,
    playerCountry: career.country_code,
    playerQualified: codes.includes(career.country_code),
    career,
  };
  if (drawn) return { ...base, pots: [] };

  if (codes.length !== 48) {
    throw new Error(`A Copa precisa de 48 classificados (tem ${codes.length})`);
  }
  const { ranks } = loadCupRanks(db);
  const pots = allocatePots(codes, ranks);
  const info = (code) => db.prepare(
    'SELECT code, name, flag, fifa_rank, confederation FROM countries WHERE code = ?',
  ).get(code);
  return {
    ...base,
    pots: pots.map((pot, i) => ({
      pot: i + 1,
      teams: pot.map(info),
    })),
  };
}

function saveCupStage(db, careerId, ord, stage, matches) {
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO stages (career_id, confederation, ord, key, name, kind, legs, neutral,
                        tiebreak, matchdays, advance, playoff, status)
    VALUES (?, 'FIFA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    careerId, ord, stage.key, stage.name, stage.kind, stage.legs,
    stage.neutral ? 1 : 0, stage.tiebreak ?? 'fifa',
    stage.kind === 'groups' ? 3 : 1,
    stage.advance ?? null, stage.playoff ?? null,
  );
  const stageId = Number(lastInsertRowid);
  const groupIds = {};
  const tieIds = {};

  for (const group of stage.groups ?? []) {
    const row = db.prepare('INSERT INTO groups (stage_id, name) VALUES (?, ?)').run(stageId, group.name);
    groupIds[group.name] = Number(row.lastInsertRowid);
    for (const code of group.teams) {
      db.prepare('INSERT INTO group_teams (group_id, country_code, pot) VALUES (?, ?, ?)')
        .run(groupIds[group.name], code, group.pots?.[code] ?? null);
    }
  }

  for (const tie of stage.ties ?? []) {
    const row = db.prepare('INSERT INTO ties (stage_id, name, home, away) VALUES (?, ?, ?, ?)')
      .run(stageId, tie.name, tie.home, tie.away);
    tieIds[tie.id] = Number(row.lastInsertRowid);
  }

  const insert = db.prepare(`
    INSERT INTO matches (career_id, stage_id, group_id, tie_id, matchday, leg, home, away,
                         neutral, played, date, kickoff)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  for (const m of matches) {
    insert.run(
      careerId, stageId,
      m.group ? groupIds[m.group] : null,
      m.tie ? tieIds[m.tie] : null,
      m.matchday, m.leg, m.home, m.away, m.neutral ?? 1,
      m.date ?? null, m.kickoff ?? null,
    );
  }
  return stageId;
}

/**
 * Executa o sorteio, grava grupos + partidas, zera callup para a única convocação da Copa.
 * Devolve os steps para animação.
 */
export function runWorldCupDraw(db, careerId) {
  if (hasWorldCupDraw(db, careerId)) {
    return drawState(db, careerId);
  }

  const w = cupWorld(db, careerId);
  const codes = loadQualifiedCodes(db, careerId);
  if (codes.length !== 48) {
    throw new Error(`A Copa precisa de 48 classificados (tem ${codes.length})`);
  }

  const drawn = drawWorldCup2026(codes, w.ranks, w.confByCode, w.rngFor('draw'));
  const stage = wcGroupsStage(drawn.groups);
  const matches = groupStageMatches(drawn.groups);

  const ord = (db.prepare('SELECT MAX(ord) AS max FROM stages WHERE career_id = ?').get(careerId).max ?? -1) + 1;

  db.exec('BEGIN');
  try {
    saveCupStage(db, careerId, ord, stage, matches);

    const first = db.prepare(`
      SELECT date, kickoff FROM matches m
      JOIN stages s ON s.id = m.stage_id
      WHERE m.career_id = ? AND s.key = 'wc_groups'
      ORDER BY m.date, m.kickoff, m.id LIMIT 1
    `).get(careerId);

    db.prepare(`
      UPDATE careers SET stage = 'world_cup', sim_date = ?, window_ord = 0, callup_done = 0,
                         updated_at = datetime('now') WHERE id = ?
    `).run(first?.date ?? '2026-06-11', careerId);

    // Grava steps do sorteio em meta JSON? — retornamos na resposta; DB já tem groups.
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    ...drawState(db, careerId),
    steps: drawn.steps.map((s) => ({
      ...s,
      ...db.prepare('SELECT name, flag, fifa_rank, confederation FROM countries WHERE code = ?').get(s.team),
      code: s.team,
    })),
  };
}

/** Preview dos grupos reais (para a tela de atalho). */
export function realWorldCupPreview(db) {
  const info = (code) => db.prepare(
    'SELECT code, name, flag, fifa_rank, confederation FROM countries WHERE code = ?',
  ).get(code);
  return {
    groups: REAL_WC_2026_GROUPS.map((g) => ({
      name: g.name,
      teams: g.teams.map((code, i) => ({
        ...info(code),
        position: i + 1,
        host: HOSTS.includes(code),
      })),
    })),
  };
}

/**
 * Carreira express: 48 seleções reais + grupos oficiais da Copa 2026.
 * Pula eliminatórias e sorteio.
 */
export function startRealWorldCup(db, { coachName, countryCode }) {
  const coach = String(coachName ?? '').trim();
  const code = String(countryCode ?? '').toUpperCase();
  if (coach.length < 2) throw new Error('Informe o nome do treinador');
  if (!REAL_WC_2026_CODES.includes(code)) {
    throw new Error('Escolha uma das 48 seleções classificadas para a Copa 2026');
  }
  const country = db.prepare(
    'SELECT code, name, confederation, flag FROM countries WHERE code = ?',
  ).get(code);
  if (!country) throw new Error('Seleção inválida');

  for (const c of REAL_WC_2026_CODES) {
    if (!db.prepare('SELECT 1 FROM countries WHERE code = ?').get(c)) {
      throw new Error(`Seleção ausente no banco: ${c}`);
    }
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO careers (coach_name, country_code, formation, stage)
    VALUES (?, ?, '4-3-3', 'world_cup')
  `).run(coach, code);
  const careerId = Number(lastInsertRowid);

  const groups = REAL_WC_2026_GROUPS.map((g) => ({
    name: g.name,
    teams: [...g.teams],
    pots: Object.fromEntries(
      g.teams.map((t, i) => [t, potForGroupPosition(g.name, i + 1)]),
    ),
  }));

  db.exec('BEGIN');
  try {
    const qIns = db.prepare(`
      INSERT INTO qualified (career_id, country_code, route, note)
      VALUES (?, ?, 'real_2026', ?)
    `);
    for (const g of REAL_WC_2026_GROUPS) {
      for (const t of g.teams) {
        qIns.run(careerId, t, HOSTS.includes(t) ? 'anfitrião' : `Grupo ${g.name}`);
      }
    }

    const stage = wcGroupsStage(groups);
    const matches = groupStageMatches(groups);
    saveCupStage(db, careerId, 0, stage, matches);

    const first = db.prepare(`
      SELECT date, kickoff FROM matches m
      JOIN stages s ON s.id = m.stage_id
      WHERE m.career_id = ? AND s.key = 'wc_groups'
      ORDER BY m.date, m.kickoff, m.id LIMIT 1
    `).get(careerId);

    db.prepare(`
      UPDATE careers SET sim_date = ?, window_ord = 0, callup_done = 0,
                         updated_at = datetime('now') WHERE id = ?
    `).run(first?.date ?? '2026-06-11', careerId);

    autoCallUpCup(db, careerId, { skipPlayer: true });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare('DELETE FROM careers WHERE id = ?').run(careerId);
    throw err;
  }

  return {
    careerId,
    coach_name: coach,
    country_code: code,
    confederation: country.confederation,
    country_name: country.name,
    flag: country.flag,
  };
}

export function drawState(db, careerId) {
  const w = cupWorld(db, careerId);
  const codes = loadQualifiedCodes(db, careerId);
  const stageRow = db.prepare(
    "SELECT * FROM stages WHERE career_id = ? AND key = 'wc_groups'",
  ).get(careerId);

  let groups = null;
  if (stageRow) {
    groups = db.prepare('SELECT id, name FROM groups WHERE stage_id = ? ORDER BY name').all(stageRow.id)
      .map((g) => {
        const teams = db.prepare(`
          SELECT gt.country_code, gt.pot, c.name, c.flag, c.fifa_rank, c.confederation
          FROM group_teams gt JOIN countries c ON c.code = gt.country_code
          WHERE gt.group_id = ? ORDER BY gt.pot
        `).all(g.id);
        // Ordenar por posição no grupo = ordem do pot pattern; pot sozinho não basta.
        // Os times foram inseridos na ordem das posições 1..4 em saveCupStage.
        const ordered = db.prepare(`
          SELECT gt.country_code AS code, gt.pot, c.name, c.flag, c.fifa_rank, c.confederation
          FROM group_teams gt JOIN countries c ON c.code = gt.country_code
          WHERE gt.group_id = ?
        `).all(g.id);
        // Reconstruir ordem de posição a partir do pot + padrão
        const byPos = [null, null, null, null];
        for (const t of ordered) {
          const pot = Number(t.pot) || 0;
          const pos = pot === 1 ? 1 : (POS_BY_POT[g.name]?.[pot] ?? pot);
          if (pos >= 1 && pos <= 4) byPos[pos - 1] = t;
        }
        return {
          name: g.name,
          pathway: PATHWAY_OF[g.name],
          teams: byPos.filter(Boolean),
          mine: byPos.some((t) => t?.code === w.career.country_code),
        };
      });
  }

  return {
    drawn: !!stageRow,
    playerCountry: w.career.country_code,
    playerQualified: codes.includes(w.career.country_code),
    career: w.career,
    pots: allocatePots(codes, w.ranks).map((pot, i) => ({
      pot: i + 1,
      teams: pot.map((code) => db.prepare(
        'SELECT code, name, flag, fifa_rank, confederation FROM countries WHERE code = ?',
      ).get(code)),
    })),
    groups,
  };
}

/* ------------------------------------------------------------------ *
 * Convocação única + simulação por slot
 * ------------------------------------------------------------------ */

export function autoCallUpCup(db, careerId, { skipPlayer = false } = {}) {
  const w = cupWorld(db, careerId);
  const me = w.career.country_code;
  const codes = loadQualifiedCodes(db, careerId);
  const onDate = w.career.sim_date ?? '2026-06-11';

  const clear = db.prepare('DELETE FROM team_call_ups WHERE career_id = ? AND country_code = ?');
  const insert = db.prepare(
    'INSERT INTO team_call_ups (career_id, country_code, player_id, shirt) VALUES (?, ?, ?, ?)',
  );

  for (const code of codes) {
    if (skipPlayer && code === me) continue;
    if (code === me) continue;
    const pool = availablePlayers(db, careerId, code, onDate);
    const squad = bestSquad(pool);
    clear.run(careerId, code);
    squad.forEach((p, i) => insert.run(careerId, code, p.id, i + 1));
  }
}

const FORMATION_SLOTS = {
  '4-3-3': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'],
  '4-4-2': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
  '4-2-3-1': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW'],
  '3-5-2': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
  '3-4-3': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'],
  '5-3-2': ['GK', 'DF', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW'],
};

function autoLineup(squad, formation) {
  const slots = FORMATION_SLOTS[formation] ?? FORMATION_SLOTS['4-3-3'];
  const pool = [...squad].sort((a, b) => b.overall - a.overall);
  const starters = [];
  const used = new Set();
  for (const pos of slots) {
    const pick = pool.find((p) => p.position === pos && !used.has(p.id))
      ?? pool.find((p) => !used.has(p.id));
    if (pick) {
      used.add(pick.id);
      starters.push({ ...pick, is_starter: 1, position_slot: pos });
    }
  }
  const bench = pool.filter((p) => !used.has(p.id)).map((p) => ({
    ...p, is_starter: 0, position_slot: p.position,
  }));
  return [...starters, ...bench];
}

function ensureCpuLineups(db, careerId, match, w) {
  for (const side of ['home', 'away']) {
    const code = match[side];
    if (code === w.career.country_code) {
      const has = db.prepare(
        'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? AND is_starter = 1 LIMIT 1',
      ).get(match.id, code);
      if (!has) throw new Error('Defina a escalação antes de simular o seu jogo');
      continue;
    }
    if (db.prepare('SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? LIMIT 1')
      .get(match.id, code)) continue;

    const lined = autoLineup(squadForCountry(db, careerId, code, w.career.country_code), '4-3-3');
    const insert = db.prepare(`
      INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of lined) insert.run(match.id, code, p.id, p.is_starter ? 1 : 0, p.position_slot);
  }
}

function loadLineupPlayers(db, matchId, countryCode) {
  return db.prepare(`
    SELECT p.*, l.is_starter, l.position_slot
    FROM lineups l JOIN players p ON p.id = l.player_id
    WHERE l.match_id = ? AND l.country_code = ?
    ORDER BY l.is_starter DESC, l.rowid
  `).all(matchId, countryCode).map((p) => ({
    ...playerRow(p), is_starter: p.is_starter, position_slot: p.position_slot,
  }));
}

function upsertAvailability(db, careerId, playerId, patch) {
  db.prepare(`
    INSERT INTO player_availability (career_id, player_id, yellows, suspended_until, injured_until, injury_note, last_rating)
    VALUES (?, ?, 0, NULL, NULL, NULL, NULL)
    ON CONFLICT(career_id, player_id) DO NOTHING
  `).run(careerId, playerId);
  const cur = db.prepare(
    'SELECT * FROM player_availability WHERE career_id = ? AND player_id = ?',
  ).get(careerId, playerId);
  db.prepare(`
    UPDATE player_availability SET
      yellows = ?, suspended_until = ?, injured_until = ?, injury_note = ?, last_rating = ?
    WHERE career_id = ? AND player_id = ?
  `).run(
    patch.yellows ?? cur.yellows,
    patch.suspended_until !== undefined ? patch.suspended_until : cur.suspended_until,
    patch.injured_until !== undefined ? patch.injured_until : cur.injured_until,
    patch.injury_note !== undefined ? patch.injury_note : cur.injury_note,
    patch.last_rating !== undefined ? patch.last_rating : cur.last_rating,
    careerId, playerId,
  );
}

function applyPostMatch(db, careerId, match, events, date) {
  const participants = new Set();
  for (const e of events) {
    if (e.player_id) participants.add(e.player_id);
    if (e.assist_id && e.type === 'sub') participants.add(e.assist_id);
  }
  for (const row of db.prepare(
    'SELECT player_id FROM lineups WHERE match_id = ? AND is_starter = 1',
  ).all(match.id)) {
    participants.add(row.player_id);
  }

  for (const pid of participants) {
    const rating = performanceRating(pid, events);
    const av = db.prepare(
      'SELECT last_rating FROM player_availability WHERE career_id = ? AND player_id = ?',
    ).get(careerId, pid);
    if (av?.last_rating != null) {
      const delta = rating > av.last_rating + 0.3 ? 1 : rating < av.last_rating - 0.3 ? -1 : 0;
      if (delta) {
        db.prepare('UPDATE players SET overall = MIN(99, MAX(38, overall + ?)) WHERE id = ?')
          .run(delta, pid);
      }
    }
    upsertAvailability(db, careerId, pid, { last_rating: rating });
  }

  for (const e of events) {
    if (e.type === 'yellow' && e.player_id) {
      const cur = db.prepare(
        'SELECT yellows FROM player_availability WHERE career_id = ? AND player_id = ?',
      ).get(careerId, e.player_id);
      const yellows = (cur?.yellows ?? 0) + 1;
      const patch = { yellows };
      if (yellows >= 2) {
        patch.yellows = 0;
        patch.suspended_until = addDays(date, 1);
      }
      upsertAvailability(db, careerId, e.player_id, patch);
    }
    if (e.type === 'red' && e.player_id) {
      upsertAvailability(db, careerId, e.player_id, {
        yellows: 0,
        suspended_until: addDays(date, e.meta ? JSON.parse(e.meta)?.straight ? 2 : 1 : 1),
      });
    }
    if (e.type === 'injury' && e.player_id) {
      const meta = e.meta ? JSON.parse(e.meta) : {};
      const days = meta.days ?? (meta.grade === 'grave' ? 21 : meta.grade === 'leve' ? 5 : 10);
      upsertAvailability(db, careerId, e.player_id, {
        injured_until: addDays(date, days),
        injury_note: `Lesão ${meta.grade ?? 'média'} (${days} dias)`,
      });
      db.prepare('UPDATE players SET overall = MAX(38, overall - ?) WHERE id = ?')
        .run(meta.grade === 'grave' ? 2 : 1, e.player_id);
    }
  }
}

/** Próximo slot (date+kickoff) com jogos pendentes da Copa (ignora TBD e fases antecipadas). */
export function nextCupSlot(db, careerId) {
  const rows = db.prepare(`
    SELECT m.date, m.kickoff, s.key AS stage_key
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.confederation = 'FIFA' AND m.played = 0
      AND m.date IS NOT NULL
      AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
    ORDER BY m.date, m.kickoff, m.id
  `).all(careerId);

  for (const row of rows) {
    if (!isCupStageEligible(db, careerId, row.stage_key)) continue;
    return { date: row.date, kickoff: row.kickoff };
  }
  return undefined;
}

/** Próximo jogo pendente da seleção do técnico na Copa. */
export function nextPlayerCupMatch(db, careerId, countryCode) {
  const rows = db.prepare(`
    SELECT m.id, m.date, m.kickoff, m.home, m.away, s.key AS stage_key
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.confederation = 'FIFA' AND m.played = 0
      AND (m.home = ? OR m.away = ?)
      AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
      AND m.date IS NOT NULL
    ORDER BY m.date, m.kickoff, m.id
  `).all(careerId, countryCode, countryCode);
  return rows.find((r) => isCupStageEligible(db, careerId, r.stage_key)) ?? null;
}

function cupSlotBefore(a, b) {
  if (a.date !== b.date) return a.date < b.date;
  return (a.kickoff ?? '') < (b.kickoff ?? '');
}

function pointCupSimDate(db, careerId, date) {
  db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(date, careerId);
}

/**
 * Simula em silêncio todos os slots até o próximo jogo da seleção do técnico
 * (sem jogar esse confronto — para em escalação / “Iniciar simulação”).
 */
export function advanceCupToPlayerMatch(db, careerId) {
  if (!hasWorldCupDraw(db, careerId)) throw new Error('Sorteio ainda não realizado');
  const career = loadCupCareer(db, careerId);
  const me = career.country_code;
  if (!loadQualifiedCodes(db, careerId).includes(me)) {
    throw new Error('Sua seleção não está na Copa');
  }

  const target = nextPlayerCupMatch(db, careerId, me);
  if (!target) throw new Error('Não há mais jogos da sua seleção na Copa');

  let skipped = 0;
  for (let i = 0; i < 250; i++) {
    const slot = nextCupSlot(db, careerId);
    if (!slot) break;

    if (!cupSlotBefore(slot, target) && !(slot.date === target.date && slot.kickoff === target.kickoff)) {
      // Passou do alvo (calendário estranho) — ancora no jogo do técnico
      pointCupSimDate(db, careerId, target.date);
      break;
    }

    if (slot.date === target.date && slot.kickoff === target.kickoff) {
      pointCupSimDate(db, careerId, slot.date);
      break;
    }

    simulateCupSlot(db, careerId, slot);
    skipped += 1;

    const next = nextCupSlot(db, careerId);
    if (next) pointCupSimDate(db, careerId, next.date);
  }

  return {
    skipped,
    targetMatch: {
      id: target.id,
      date: target.date,
      kickoff: target.kickoff,
      home: target.home,
      away: target.away,
      dateLabel: formatDateLabel(target.date),
    },
    ...cupSimState(db, careerId),
  };
}

const CUP_STAGE_SHORT = {
  wc_groups: 'Fase de grupos',
  wc_r32: 'Dieciseisavos de final',
  wc_r16: 'Oitavas de final',
  wc_qf: 'Quartas de final',
  wc_sf: 'Semifinais',
  wc_third: 'Disputa de 3º lugar',
  wc_final: 'Final',
};

/** Rótulo de fase (e aba preferida nas tabelas) a partir de um jogo. */
export function cupPhaseMeta(ref) {
  if (!ref?.stage_key) {
    return { stageKey: null, stageName: null, matchday: null, stageLabel: null, tablesTab: 'groups' };
  }
  const key = ref.stage_key;
  const md = ref.matchday ?? null;
  const stageName = CUP_STAGE_SHORT[key] ?? ref.stage_name ?? key;
  if (key === 'wc_groups') {
    const round = md === 1 ? '1ª rodada'
      : md === 2 ? '2ª rodada'
      : md === 3 ? '3ª rodada'
      : (md != null ? `Rodada ${md}` : null);
    return {
      stageKey: key,
      stageName,
      matchday: md,
      stageLabel: round ? `${stageName} · ${round}` : stageName,
      tablesTab: 'groups',
    };
  }
  return {
    stageKey: key,
    stageName,
    matchday: md,
    stageLabel: stageName,
    tablesTab: 'knockout',
  };
}

function cupPhaseFromMatches(me, slotMatches = [], dayMatches = []) {
  const ref = slotMatches.find((m) => m.home === me || m.away === me)
    ?? dayMatches.find((m) => !m.played && (m.home === me || m.away === me))
    ?? slotMatches[0]
    ?? dayMatches.find((m) => !m.played)
    ?? dayMatches[0]
    ?? null;
  return cupPhaseMeta(ref);
}

export function cupSimState(db, careerId) {
  if (!hasWorldCupDraw(db, careerId)) {
    return { phase: 'draw', ...drawPreview(db, careerId) };
  }

  const career = loadCupCareer(db, careerId);
  const me = career.country_code;
  const qualified = loadQualifiedCodes(db, careerId).includes(me);
  const needsCallUp = !career.callup_done;

  if (needsCallUp && !qualified) {
    autoCallUpCup(db, careerId, { skipPlayer: true });
    db.prepare('UPDATE careers SET callup_done = 1 WHERE id = ?').run(careerId);
    return cupSimState(db, careerId);
  }

  const daySql = `
    SELECT m.id, m.home, m.away, m.played, m.home_goals, m.away_goals, m.home_pens, m.away_pens,
           m.extra_time, m.date, m.kickoff, m.matchday, s.key AS stage_key, s.name AS stage_name,
           g.name AS "group"
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.career_id = ? AND s.confederation = 'FIFA' AND m.date = ?
      AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
    ORDER BY m.kickoff, m.id
  `;

  const next = nextCupSlot(db, careerId);

  // Mantém o dia atual até o jogador avançar (Continuar) — não pula pro próximo slot
  let focusDate = career.sim_date;
  if (!focusDate) {
    focusDate = next?.date ?? null;
    if (focusDate) {
      db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(focusDate, careerId);
    }
  }

  const squad = db.prepare(`
    SELECT p.*, cu.shirt AS squad_shirt FROM call_ups cu
    JOIN players p ON p.id = cu.player_id WHERE cu.career_id = ? ORDER BY cu.shirt
  `).all(careerId);

  if (!focusDate && !next) {
    return {
      mode: 'worldcup',
      phase: 'done',
      career,
      qualified,
      playerQualified: qualified,
      callupDone: true,
      squad,
      formation: career.formation,
    };
  }

  let dayMatches = focusDate ? eligibleCupMatches(db, careerId, db.prepare(daySql).all(careerId, focusDate)) : [];
  const dayDone = dayMatches.length > 0 && dayMatches.every((m) => m.played);

  if (dayDone) {
    return {
      mode: 'worldcup',
      phase: next ? 'post' : 'done',
      career,
      playerQualified: qualified,
      date: focusDate,
      kickoff: null,
      dateLabel: formatDateLabel(focusDate),
      slotMatches: [],
      dayMatches,
      myMatch: null,
      needsCallUp: false,
      callupDone: true,
      squad,
      formation: career.formation,
      simultaneous: false,
      ...cupPhaseFromMatches(me, [], dayMatches),
    };
  }

  if (!next) {
    return {
      mode: 'worldcup',
      phase: 'done',
      career,
      qualified,
      playerQualified: qualified,
      callupDone: true,
      squad,
      formation: career.formation,
    };
  }

  // sim_date sem jogos (ou inválida): aponta para o próximo slot
  if (focusDate !== next.date && dayMatches.length === 0) {
    db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(next.date, careerId);
    focusDate = next.date;
    dayMatches = eligibleCupMatches(db, careerId, db.prepare(daySql).all(careerId, focusDate));
  }

  const activeDate = focusDate === next.date ? next.date : focusDate;
  const activeKick = focusDate === next.date ? next.kickoff : null;

  const slotMatches = activeKick != null
    ? eligibleCupMatches(db, careerId, db.prepare(`
        SELECT m.id, m.home, m.away, m.played, m.home_goals, m.away_goals, m.home_pens, m.away_pens,
               m.extra_time, m.date, m.kickoff, m.matchday, s.key AS stage_key, s.name AS stage_name,
               g.name AS "group"
        FROM matches m
        JOIN stages s ON s.id = m.stage_id
        LEFT JOIN groups g ON g.id = m.group_id
        WHERE m.career_id = ? AND s.confederation = 'FIFA'
          AND m.date = ? AND m.kickoff = ?
          AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
        ORDER BY m.id
      `).all(careerId, activeDate, activeKick))
    : [];

  const dayNow = eligibleCupMatches(db, careerId, db.prepare(daySql).all(careerId, activeDate));
  const myMatch = slotMatches.find((m) => m.home === me || m.away === me)
    ?? dayNow.find((m) => !m.played && (m.home === me || m.away === me))
    ?? null;

  const pendingSlot = slotMatches.some((m) => !m.played);

  let phase = 'ready';
  if (needsCallUp && qualified) phase = 'callup';
  else if (myMatch && !myMatch.played && qualified) {
    const lined = db.prepare(
      'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? AND is_starter = 1 LIMIT 1',
    ).get(myMatch.id, me);
    phase = lined ? 'ready' : 'lineup';
  } else if (!pendingSlot && dayNow.some((m) => !m.played)) {
    phase = 'ready';
  }

  const nextPlayer = qualified ? nextPlayerCupMatch(db, careerId, me) : null;
  const minePendingHere = myMatch
    && (myMatch.home === me || myMatch.away === me)
    && !myMatch.played;
  const canSkipToMe = !!(
    nextPlayer
    && !needsCallUp
    && !minePendingHere
    && !(activeDate === nextPlayer.date && activeKick === nextPlayer.kickoff)
  );

  return {
    mode: 'worldcup',
    phase,
    career,
    playerQualified: qualified,
    date: activeDate,
    kickoff: activeKick,
    dateLabel: formatDateLabel(activeDate),
    slotMatches,
    dayMatches: dayNow,
    myMatch: myMatch && (myMatch.home === me || myMatch.away === me) ? myMatch : null,
    needsCallUp: needsCallUp && qualified,
    callupDone: !!career.callup_done,
    squad,
    formation: career.formation,
    simultaneous: slotMatches.length > 1,
    nextPlayerMatch: nextPlayer ? {
      id: nextPlayer.id,
      date: nextPlayer.date,
      kickoff: nextPlayer.kickoff,
      home: nextPlayer.home,
      away: nextPlayer.away,
      dateLabel: formatDateLabel(nextPlayer.date),
    } : null,
    canSkipToMe,
    ...cupPhaseFromMatches(me, slotMatches, dayNow),
  };
}

export function saveCupCallUp(db, careerId, playerIds, opts = {}) {
  const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  const ids = [...new Set(playerIds.map(Number))];
  if (ids.length !== SQUAD_RULES.size) {
    throw new Error(`A convocação precisa ter exatamente ${SQUAD_RULES.size} jogadores`);
  }
  const byPosition = { GK: 0, DF: 0, MF: 0, FW: 0 };
  for (const pid of ids) {
    const player = db.prepare('SELECT id, position, country_code FROM players WHERE id = ?').get(pid);
    if (!player || player.country_code !== career.country_code) {
      throw new Error('Só é possível convocar jogadores da própria seleção');
    }
    byPosition[player.position]++;
  }
  for (const [pos, min] of Object.entries(SQUAD_RULES.min)) {
    if (byPosition[pos] < min) throw new Error(`Convoque ao menos ${min} na posição ${pos}`);
  }

  db.prepare('DELETE FROM call_ups WHERE career_id = ?').run(careerId);
  const add = db.prepare('INSERT INTO call_ups (career_id, player_id, shirt) VALUES (?, ?, ?)');
  ids.forEach((pid, i) => add.run(careerId, pid, i + 1));
  db.prepare(`
    UPDATE careers SET formation = ?, captain_id = ?, callup_done = 1,
                       updated_at = datetime('now') WHERE id = ?
  `).run(opts.formation || career.formation, opts.captainId ?? career.captain_id, careerId);

  autoCallUpCup(db, careerId, { skipPlayer: true });
}

/**
 * Simula o slot atual (1 jogo, ou 2 na 3ª rodada quando compartilham horário).
 */
const CUP_CHRONICLE_KO = ['wc_r32', 'wc_r16', 'wc_qf', 'wc_sf', 'wc_third', 'wc_final'];

function groupMatchdayComplete(db, careerId, matchday) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN m.played = 1 THEN 1 ELSE 0 END) AS played
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.key = 'wc_groups' AND m.matchday = ?
  `).get(careerId, matchday);
  return row.total > 0 && row.total === row.played;
}

function knockoutStageComplete(db, careerId, stageKey) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN m.played = 1 THEN 1 ELSE 0 END) AS played
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.key = ?
      AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
  `).get(careerId, stageKey);
  return row.total > 0 && row.total === row.played;
}

function snapCupProgress(db, careerId) {
  return {
    matchdays: {
      1: groupMatchdayComplete(db, careerId, 1),
      2: groupMatchdayComplete(db, careerId, 2),
      3: groupMatchdayComplete(db, careerId, 3),
    },
    stages: Object.fromEntries(
      CUP_CHRONICLE_KO.map((key) => [key, knockoutStageComplete(db, careerId, key)]),
    ),
  };
}

/** Crônicas a disparar após um slot (rodada de grupos, fase KO, final). */
function detectCupChronicles(db, careerId, before) {
  const after = snapCupProgress(db, careerId);
  const out = [];
  for (const md of [1, 2, 3]) {
    if (!before.matchdays[md] && after.matchdays[md]) {
      out.push({ kind: 'round', matchday: md });
    }
  }
  for (const key of CUP_CHRONICLE_KO) {
    if (before.stages[key] || !after.stages[key]) continue;
    if (key === 'wc_final') out.push({ kind: 'final' });
    else out.push({ kind: 'phase', stageKey: key });
  }
  return out;
}

export function simulateCupSlot(db, careerId, { date, kickoff } = {}) {
  const w = cupWorld(db, careerId);
  if (!hasWorldCupDraw(db, careerId)) throw new Error('Sorteio ainda não realizado');

  const slot = date && kickoff
    ? { date, kickoff }
    : nextCupSlot(db, careerId);
  if (!slot) throw new Error('Não há mais jogos na Copa');

  const progressBefore = snapCupProgress(db, careerId);

  const matches = eligibleCupMatches(db, careerId, db.prepare(`
    SELECT m.*, s.key AS stage_key, s.kind AS stage_kind, s.legs AS stage_legs
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.confederation = 'FIFA'
      AND m.date = ? AND m.kickoff = ? AND m.played = 0
      AND m.home != '${TBD_CODE}' AND m.away != '${TBD_CODE}'
    ORDER BY m.id
  `).all(careerId, slot.date, slot.kickoff));

  if (!matches.length) throw new Error('Não há jogos neste horário');

  const me = w.career.country_code;
  const playerMatch = matches.find((m) => m.home === me || m.away === me);

  db.exec('BEGIN');
  try {
    const results = [];
    for (const match of matches) {
      ensureCpuLineups(db, careerId, match, w);
      const homeXI = loadLineupPlayers(db, match.id, match.home);
      const awayXI = loadLineupPlayers(db, match.id, match.away);
      const rng = w.rngFor(`match|${match.stage_key}|${match.id}`);

      let opts = { neutral: true };
      if (match.stage_kind === 'knockout') opts = { ...opts, knockout: true };
      if (match.home === me) opts.manualSides = ['home'];
      else if (match.away === me) opts.manualSides = ['away'];

      const timeline = simulateMatchTimeline(
        rng, w.ratings[match.home], w.ratings[match.away], homeXI, awayXI, opts,
      );

      db.prepare(`
        UPDATE matches SET home_goals = ?, away_goals = ?, home_pens = ?, away_pens = ?,
                           extra_time = ?, played = 1 WHERE id = ?
      `).run(
        timeline.home_goals, timeline.away_goals,
        timeline.home_pens, timeline.away_pens,
        timeline.extra_time ?? 0, match.id,
      );

      db.prepare('DELETE FROM match_events WHERE match_id = ?').run(match.id);
      const ins = db.prepare(`
        INSERT INTO match_events (match_id, minute, stoppage, type, team, player_id, assist_id, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of timeline.events) {
        const teamCode = e.team === 'home' ? match.home : e.team === 'away' ? match.away : null;
        ins.run(match.id, e.minute, e.stoppage ?? 0, e.type, teamCode, e.player_id, e.assist_id, e.meta ?? null);
      }
      applyPostMatch(db, careerId, match, timeline.events, slot.date);

      const nameOf = (pid) => {
        if (!pid) return null;
        return db.prepare('SELECT name FROM players WHERE id = ?').get(pid)?.name ?? null;
      };

      const mine = match.home === me || match.away === me;
      let lineup = null;
      if (mine) {
        const rows = db.prepare(`
          SELECT p.id, p.name, p.position, p.overall, l.is_starter, l.position_slot
          FROM lineups l JOIN players p ON p.id = l.player_id
          WHERE l.match_id = ? AND l.country_code = ?
          ORDER BY l.is_starter DESC, p.overall DESC
        `).all(match.id, me);
        lineup = {
          starters: rows.filter((r) => r.is_starter).map((r) => ({
            id: r.id, name: r.name, position: r.position, overall: r.overall, slot: r.position_slot,
          })),
          bench: rows.filter((r) => !r.is_starter).map((r) => ({
            id: r.id, name: r.name, position: r.position, overall: r.overall, slot: r.position_slot,
          })),
        };
      }

      results.push({
        id: match.id,
        home: match.home,
        away: match.away,
        home_goals: timeline.home_goals,
        away_goals: timeline.away_goals,
        home_pens: timeline.home_pens,
        away_pens: timeline.away_pens,
        extra_time: timeline.extra_time,
        mine,
        group: db.prepare('SELECT name FROM groups WHERE id = ?').get(match.group_id)?.name,
        lineup,
        events: timeline.events.map((e) => ({
          ...e,
          team: e.team === 'home' ? match.home : e.team === 'away' ? match.away : null,
          player_name: nameOf(e.player_id),
          assist_name: nameOf(e.assist_id),
          clock: e.stoppage ? `${e.minute}+${e.stoppage}'` : `${e.minute}'`,
        })),
      });
    }

    db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(slot.date, careerId);

    // Progressão de fase de grupos → mata-mata
    tryProgressCup(db, careerId, w);

    const chronicles = detectCupChronicles(db, careerId, progressBefore);

    db.exec('COMMIT');
    return {
      date: slot.date,
      kickoff: slot.kickoff,
      dateLabel: formatDateLabel(slot.date),
      playerMatch: !!playerMatch,
      simultaneous: results.length > 1,
      matches: results,
      chronicles,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function loadCupStage(db, careerId, key, ranks) {
  const row = db.prepare(
    'SELECT * FROM stages WHERE career_id = ? AND key = ?',
  ).get(careerId, key);
  if (!row) return null;

  const matches = db.prepare(`
    SELECT m.id, g.name AS "group", m.tie_id AS tie, m.matchday, m.leg, m.home, m.away,
           m.neutral, m.home_goals, m.away_goals, m.home_pens, m.away_pens, m.extra_time,
           m.played, m.date, m.kickoff
    FROM matches m LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.stage_id = ?
    ORDER BY m.matchday, m.kickoff, m.id
  `).all(row.id).map((m) => ({
    ...m,
    tie: m.tie == null ? null : db.prepare(
      "SELECT id FROM ties WHERE id = ?",
    ).get(m.tie) ? String(m.tie) : m.tie,
  }));

  // Resolve tie ids as stage-local string keys used in resolveStage
  const ties = db.prepare('SELECT id, name, home, away FROM ties WHERE stage_id = ? ORDER BY id').all(row.id);
  const tieKey = Object.fromEntries(ties.map((t) => [t.id, `${row.key}-${ties.indexOf(t) + 1}`]));

  const matchesNorm = matches.map((m) => ({
    ...m,
    tie: m.tie != null ? (tieKey[m.tie] ?? String(m.tie)) : null,
  }));

  const matchIds = matchesNorm.map((m) => m.id);
  let events = [];
  if (matchIds.length) {
    const ph = matchIds.map(() => '?').join(',');
    events = db.prepare(`
      SELECT match_id, team, type, player_id, meta FROM match_events
      WHERE match_id IN (${ph}) AND type IN ('yellow','red')
    `).all(...matchIds);
  }
  const fairPlay = conductScoresFromEvents(events);

  const groups = db.prepare('SELECT id, name FROM groups WHERE stage_id = ? ORDER BY name').all(row.id)
    .map((g) => {
      const teams = db.prepare(
        'SELECT country_code, pot FROM group_teams WHERE group_id = ?',
      ).all(g.id);
      const byPos = [null, null, null, null];
      for (const t of teams) {
        const pot = Number(t.pot) || 0;
        const pos = pot === 1 ? 1 : (POS_BY_POT[g.name]?.[pot] ?? pot);
        if (pos >= 1 && pos <= 4) byPos[pos - 1] = t.country_code;
      }
      return {
        id: g.id,
        name: g.name,
        teams: byPos.filter(Boolean),
        pots: Object.fromEntries(teams.map((t) => [t.country_code, t.pot])),
      };
    });

  const spec = {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    legs: row.legs,
    neutral: !!row.neutral,
    tiebreak: row.tiebreak,
    advance: row.advance,
    playoff: row.playoff,
    status: row.status,
    groups,
    ties: ties.map((t, i) => ({
      id: `${row.key}-${i + 1}`,
      name: t.name,
      home: t.home,
      away: t.away,
      _dbId: t.id,
    })),
  };
  // Copa: sempre o desempate do regulamento 2026 (fair play incluso)
  if (row.key === 'wc_groups') spec.tiebreak = 'wc2026';

  return { ...resolveStage(spec, matchesNorm, ranks, { fairPlay, events }), matches: matchesNorm, _row: row };
}

function tryProgressCup(db, careerId, w) {
  const groups = loadCupStage(db, careerId, 'wc_groups', w.ranks);
  if (!groups || groups.status === 'done') {
    // Progress knockouts
    progressKnockouts(db, careerId, w);
    return;
  }
  if (!groups.matches.every((m) => m.played)) return;

  db.prepare("UPDATE stages SET status = 'done' WHERE id = ?").run(groups._row.id);

  // Cria R32
  if (db.prepare("SELECT 1 FROM stages WHERE career_id = ? AND key = 'wc_r32'").get(careerId)) {
    return;
  }

  const { firsts, seconds, bestThirds } = advanceFromGroups(groups, w.ranks);
  const pairs = roundOf32Ties(firsts, seconds, bestThirds);
  const stage = knockoutStageSpec('wc_r32', 'Dieciseisavos de final', pairs, KO_SCHEDULE.r32);
  const ord = (db.prepare('SELECT MAX(ord) AS max FROM stages WHERE career_id = ?').get(careerId).max ?? 0) + 1;
  saveCupStage(db, careerId, ord, stage, koMatchesFromStage(stage));
  ensureKnockoutSkeletons(db, careerId);
  resyncKnockoutSchedule(db, careerId);
}

function progressKnockouts(db, careerId, w) {
  ensureKnockoutSkeletons(db, careerId);
  fillKnockoutAdvances(db, careerId, w);
}

export function advanceCupPointer(db, careerId) {
  const slot = nextCupSlot(db, careerId);
  if (!slot) return cupSimState(db, careerId);
  db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(slot.date, careerId);
  return cupSimState(db, careerId);
}

/** Hub de tabelas da Copa. */
export function worldCupState(db, careerId) {
  const career = loadCupCareer(db, careerId);
  const me = career.country_code;
  const { ranks } = loadCupRanks(db);

  // Carreiras antigas / fases a meio: cria esqueleto e preenche vagas já decididas.
  if (db.prepare("SELECT 1 FROM stages WHERE career_id = ? AND key = 'wc_r32'").get(careerId)) {
    ensureKnockoutSkeletons(db, careerId);
    fillKnockoutAdvances(db, careerId, { ranks });
  }

  const groups = loadCupStage(db, careerId, 'wc_groups', ranks);

  const stages = [];
  for (const key of ['wc_groups', 'wc_r32', 'wc_r16', 'wc_qf', 'wc_sf', 'wc_third', 'wc_final']) {
    const s = loadCupStage(db, careerId, key, ranks);
    if (s) {
      stages.push({
        key: s.key,
        name: s.name,
        kind: s.kind,
        status: s.status,
        groups: s.groups?.map((g) => ({
          name: g.name,
          teams: g.teams,
          mine: g.teams.includes(me),
          table: g.table,
        })),
        ties: s.ties?.map((t) => ({
          id: t.id,
          name: t.name,
          home: t.home,
          away: t.away,
          winner: t.winner,
          loser: t.loser,
          legs: t.legs,
          mine: (t.home === me || t.away === me) && t.home !== TBD_CODE && t.away !== TBD_CODE,
        })),
      });
    }
  }

  return {
    career,
    playerQualified: loadQualifiedCodes(db, careerId).includes(me),
    groups: groups?.groups?.map((g) => ({
      name: g.name,
      teams: g.teams,
      mine: g.teams.includes(me),
      table: g.table,
    })) ?? [],
    stages,
    scorers: worldCupScorers(db, careerId),
    sim: cupSimState(db, careerId),
  };
}

export { FORMATION_SLOTS as CUP_FORMATION_SLOTS };
