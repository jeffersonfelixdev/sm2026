/**
 * Loop de simulação por Data FIFA: convocação, escalação, dia de jogos, pós-jogo.
 */
import {
  assignStageDates, datesInWindow, FIFA_WINDOWS, formatDateLabel,
  seedWindows, windowForDate,
} from './calendar.mjs';
import {
  byRank, context, qualifyNote, resolveStage, stageMatches, stageMatchdays,
} from './engine.mjs';
import { addDays, performanceRating, simulateMatchTimeline } from './events.mjs';
import { HOSTS, STAGE_COUNT, nextPlayoffStage, nextStage } from './formats.mjs';
import { teamRating } from './match.mjs';
import { rngFrom } from './rng.mjs';
import { QUALIFIER_SCHEMA, migrateSchema } from './schema.mjs';
import { averageOverall, bestSquad, SQUAD_RULES } from './squad.mjs';
import { conductScoresFromEvents } from './rules.mjs';
import { scorersForConfederation } from './scorers.mjs';

export const ensureSchema = (db) => {
  db.exec(QUALIFIER_SCHEMA);
  migrateSchema(db);
};

/* ------------------------------------------------------------------ *
 * Mundo / ratings
 * ------------------------------------------------------------------ */

function playerRow(p) {
  return {
    id: p.id, name: p.name, position: p.position, overall: p.overall,
    shooting: p.shooting, passing: p.passing, defending: p.defending,
    physical: p.physical, keeping: p.keeping, pace: p.pace, dribbling: p.dribbling,
  };
}

function availablePlayers(db, careerId, countryCode, onDate) {
  const players = db.prepare(`
    SELECT p.* FROM players p WHERE p.country_code = ?
    ORDER BY p.overall DESC
  `).all(countryCode);

  return players.filter((p) => {
    const av = db.prepare(`
      SELECT suspended_until, injured_until FROM player_availability
      WHERE career_id = ? AND player_id = ?
    `).get(careerId, p.id);
    if (!av) return true;
    if (av.suspended_until && av.suspended_until >= onDate) return false;
    if (av.injured_until && av.injured_until >= onDate) return false;
    return true;
  }).map(playerRow);
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
  // Sem convocação ainda: top do elenco
  return availablePlayers(db, careerId, countryCode, '9999-12-31').slice(0, 23);
}

function world(db, careerId) {
  const countries = db
    .prepare('SELECT code, confederation, fifa_rank, strength FROM countries')
    .all();

  const ranks = Object.fromEntries(countries.map((c) => [c.code, c.fifa_rank ?? 999]));
  const ratings = Object.fromEntries(countries.map((c) => [c.code, c.strength]));
  const confederations = {};
  for (const c of countries) {
    confederations[c.confederation] ??= [];
    confederations[c.confederation].push(c.code);
  }

  const career = db.prepare(`
    SELECT ca.*, co.name AS country_name, co.flag, co.fifa_rank, co.confederation AS country_conf
    FROM careers ca JOIN countries co ON co.code = ca.country_code
    WHERE ca.id = ?`).get(careerId);

  const strengthOf = Object.fromEntries(countries.map((c) => [c.code, c.strength]));

  for (const code of Object.keys(strengthOf)) {
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
    confederations,
    confederation: career.country_conf,
    base: (codes) => ({ teams: byRank(codes, ranks), ranks }),
    rngFor: (key) => rngFrom(`career:${careerId}|${key}`),
  };
}

/* ------------------------------------------------------------------ *
 * Persistência de fases
 * ------------------------------------------------------------------ */

function saveStage(db, careerId, confederation, ord, stage, matches, status) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO stages (career_id, confederation, ord, key, name, kind, legs, neutral,
                                  tiebreak, matchdays, advance, playoff, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(careerId, confederation, ord, stage.key, stage.name, stage.kind, stage.legs,
         stage.neutral ? 1 : 0, stage.tiebreak ?? 'fifa', stageMatchdays(stage),
         stage.advance ?? null, stage.playoff ?? null, status);
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

  const insert = db.prepare(
    `INSERT INTO matches (career_id, stage_id, group_id, tie_id, matchday, leg, home, away,
                          neutral, home_goals, away_goals, home_pens, away_pens, extra_time, played, date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of matches) {
    insert.run(
      careerId, stageId, m.group ? groupIds[m.group] : null, m.tie ? tieIds[m.tie] : null,
      m.matchday, m.leg, m.home, m.away, m.neutral ?? 0,
      m.home_goals ?? null, m.away_goals ?? null, m.home_pens ?? null, m.away_pens ?? null,
      m.extra_time ?? 0, m.played ?? 0, m.date ?? null,
    );
  }

  assignStageDates(db, careerId, stageId, confederation);
  return stageId;
}

function stageMatchRows(db, stageId) {
  return db.prepare(`
    SELECT m.id, g.name AS "group", m.tie_id AS tie, m.matchday, m.leg, m.home, m.away, m.neutral,
           m.home_goals, m.away_goals, m.home_pens, m.away_pens, m.extra_time, m.played, m.date
    FROM matches m LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.stage_id = ?
    ORDER BY m.matchday, m.id`).all(stageId);
}

function loadStages(db, careerId, confederation, ranks) {
  const rows = confederation
    ? db.prepare('SELECT * FROM stages WHERE career_id = ? AND confederation = ? ORDER BY ord')
        .all(careerId, confederation)
    : db.prepare('SELECT * FROM stages WHERE career_id = ? AND confederation IS NULL ORDER BY ord')
        .all(careerId);

  return rows.map((row) => {
    const matches = stageMatchRows(db, row.id);
    const matchIds = matches.map((m) => m.id);
    let events = [];
    if (matchIds.length) {
      const ph = matchIds.map(() => '?').join(',');
      events = db.prepare(`
        SELECT match_id, team, type, player_id, meta FROM match_events
        WHERE match_id IN (${ph}) AND type IN ('yellow','red')
      `).all(...matchIds);
    }
    const fairPlay = conductScoresFromEvents(events);
    const spec = {
      id: row.id,
      key: row.key,
      name: row.name,
      kind: row.kind,
      legs: row.legs,
      neutral: !!row.neutral,
      tiebreak: row.tiebreak,
      matchdays: row.matchdays,
      advance: row.advance,
      playoff: row.playoff,
      status: row.status,
      confederation: row.confederation,
      groups: db.prepare('SELECT id, name FROM groups WHERE stage_id = ? ORDER BY name').all(row.id)
        .map((g) => {
          const teams = db
            .prepare('SELECT country_code, pot FROM group_teams WHERE group_id = ? ORDER BY pot')
            .all(g.id);
          return {
            id: g.id,
            name: g.name,
            teams: teams.map((t) => t.country_code),
            pots: Object.fromEntries(teams.map((t) => [t.country_code, t.pot])),
          };
        }),
      ties: db.prepare('SELECT id, name, home, away FROM ties WHERE stage_id = ? ORDER BY id').all(row.id),
    };
    return { ...resolveStage(spec, matches, ranks, { fairPlay, events }), matches };
  });
}

const completed = (stages) => stages.filter((s) => s.status === 'done');

const nextOrd = (db, careerId) =>
  (db.prepare('SELECT MAX(ord) AS max FROM stages WHERE career_id = ?').get(careerId).max ?? -1) + 1;

const qualify = (db, careerId, code, route, note) =>
  db.prepare('INSERT OR IGNORE INTO qualified (career_id, country_code, route, note) VALUES (?, ?, ?, ?)')
    .run(careerId, code, route, note ?? null);

/* ------------------------------------------------------------------ *
 * Progresso por confederação
 * ------------------------------------------------------------------ */

function progressConfederation(db, careerId, w, conf) {
  const done = completed(loadStages(db, careerId, conf, w.ranks));
  const ctx = context(w.base(w.confederations[conf]), w.rngFor(`${conf}|draw|${done.length}`));
  const step = nextStage(conf, ctx, done);

  if (step.stage) {
    saveStage(db, careerId, conf, nextOrd(db, careerId), step.stage, stageMatches(step.stage), 'active');
    return { advanced: true };
  }

  for (const code of step.result.direct) {
    qualify(db, careerId, code, conf, qualifyNote(code, done));
  }

  return { finished: true, playoff: step.result.playoff };
}

function allConfedsFinished(db, careerId, w) {
  for (const conf of Object.keys(w.confederations)) {
    const done = completed(loadStages(db, careerId, conf, w.ranks));
    const ctx = context(w.base(w.confederations[conf]), w.rngFor(`${conf}|draw|${done.length}`));
    const step = nextStage(conf, ctx, done);
    if (!step.result) return false;
    // Se tem fases active ainda, não
    const active = db.prepare(
      "SELECT 1 FROM stages WHERE career_id = ? AND confederation = ? AND status = 'active'",
    ).get(careerId, conf);
    if (active) return false;
  }
  return true;
}

function playoffTeams(db, careerId, w) {
  const teams = [];
  for (const [conf, codes] of Object.entries(w.confederations)) {
    const done = completed(loadStages(db, careerId, conf, w.ranks));
    const ctx = context(w.base(codes), w.rngFor(`${conf}|draw|${done.length}`));
    const step = nextStage(conf, ctx, done);
    if (!step.result) throw new Error(`${conf} ainda não terminou as Eliminatórias`);
    teams.push(...step.result.playoff);
  }
  return teams;
}

function progressPlayoff(db, careerId, w) {
  const icp = loadStages(db, careerId, null, w.ranks);
  const teams = playoffTeams(db, careerId, w);
  const base = w.base(teams);

  const icpDone = completed(icp);
  const pctx = context(base, w.rngFor(`ICPO|draw|${icpDone.length}`));
  const pstep = nextPlayoffStage(pctx, icpDone);

  if (pstep.stage) {
    saveStage(db, careerId, null, nextOrd(db, careerId), pstep.stage, stageMatches(pstep.stage), 'active');
    return;
  }

  for (const code of pstep.result.direct) {
    qualify(db, careerId, code, 'playoff', 'Repescagem intercontinental');
  }
  finish(db, careerId, w);
}

function finish(db, careerId, w) {
  const made = db
    .prepare('SELECT 1 FROM qualified WHERE career_id = ? AND country_code = ?')
    .get(careerId, w.career.country_code);
  db.prepare("UPDATE careers SET stage = ?, updated_at = datetime('now') WHERE id = ?")
    .run(made ? 'world_cup' : 'eliminated', careerId);
}

function tryProgressAfterStage(db, careerId, w, stageRow) {
  const matches = stageMatchRows(db, stageRow.id);
  if (!matches.every((m) => m.played)) return;

  db.prepare("UPDATE stages SET status = 'done' WHERE id = ?").run(stageRow.id);

  if (stageRow.confederation == null) {
    progressPlayoff(db, careerId, w);
    return;
  }

  progressConfederation(db, careerId, w, stageRow.confederation);

  // Se todas as confeds terminaram e ainda não há ICPO, começa a repescagem
  if (allConfedsFinished(db, careerId, w)) {
    const hasIcp = db.prepare(
      'SELECT 1 FROM stages WHERE career_id = ? AND confederation IS NULL LIMIT 1',
    ).get(careerId);
    if (!hasIcp) {
      progressPlayoff(db, careerId, w);
    } else {
      // ICPO já acabou?
      const active = db.prepare(
        "SELECT 1 FROM stages WHERE career_id = ? AND status = 'active'",
      ).get(careerId);
      const pending = db.prepare(
        'SELECT 1 FROM matches WHERE career_id = ? AND played = 0 LIMIT 1',
      ).get(careerId);
      if (!active && !pending && w.career.stage === 'qualifiers') {
        // Se ICPO terminou via progressPlayoff → finish. Senão force finish.
        const icpDone = completed(loadStages(db, careerId, null, w.ranks));
        if (icpDone.length) {
          const teams = playoffTeams(db, careerId, w);
          const pctx = context(w.base(teams), w.rngFor(`ICPO|draw|${icpDone.length}`));
          const pstep = nextPlayoffStage(pctx, icpDone);
          if (pstep.result) {
            for (const code of pstep.result.direct) {
              qualify(db, careerId, code, 'playoff', 'Repescagem intercontinental');
            }
            finish(db, careerId, w);
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Início
 * ------------------------------------------------------------------ */

export function startQualifiers(db, careerId) {
  if (db.prepare('SELECT 1 FROM stages WHERE career_id = ? LIMIT 1').get(careerId)) return;

  const w = world(db, careerId);
  db.exec('BEGIN');
  try {
    seedWindows(db, careerId);
    for (const host of HOSTS) qualify(db, careerId, host, 'host', 'Anfitrião');

    // Primeira fase de TODAS as confederações, ainda não jogada.
    for (const conf of Object.keys(w.confederations)) {
      progressConfederation(db, careerId, w, conf);
    }

    const firstDate = db.prepare(`
      SELECT MIN(date) AS d FROM matches WHERE career_id = ? AND date IS NOT NULL
    `).get(careerId)?.d;

    const win = firstDate ? windowForDate(firstDate) : { ord: 0 };
    db.prepare(`
      UPDATE careers SET sim_date = ?, window_ord = ?, callup_done = 1,
                         updated_at = datetime('now') WHERE id = ?
    `).run(firstDate, win?.ord ?? 0, careerId);

    // AI call-ups da primeira janela (jogador já convocou no onboarding)
    autoCallUpWindow(db, careerId, win?.ord ?? 0, { skipPlayer: true });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Convocação
 * ------------------------------------------------------------------ */

function countriesPlayingInWindow(db, careerId, windowOrd) {
  const days = datesInWindow(windowOrd);
  if (!days.length) return [];
  const placeholders = days.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT home AS code FROM matches
    WHERE career_id = ? AND played = 0 AND date IN (${placeholders})
    UNION
    SELECT DISTINCT away AS code FROM matches
    WHERE career_id = ? AND played = 0 AND date IN (${placeholders})
  `).all(careerId, ...days, careerId, ...days).map((r) => r.code);
}

export function autoCallUpWindow(db, careerId, windowOrd, { skipPlayer = false } = {}) {
  const w = world(db, careerId);
  const me = w.career.country_code;
  const countries = countriesPlayingInWindow(db, careerId, windowOrd);
  const onDate = datesInWindow(windowOrd)[0] ?? w.career.sim_date ?? '2023-09-07';

  const clear = db.prepare('DELETE FROM team_call_ups WHERE career_id = ? AND country_code = ?');
  const insert = db.prepare(
    'INSERT INTO team_call_ups (career_id, country_code, player_id, shirt) VALUES (?, ?, ?, ?)',
  );

  for (const code of countries) {
    if (skipPlayer && code === me) continue;
    if (code === me) continue; // jogador grava via call_ups

    const pool = availablePlayers(db, careerId, code, onDate);
    const squad = bestSquad(pool);
    clear.run(careerId, code);
    squad.forEach((p, i) => insert.run(careerId, code, p.id, i + 1));
  }
}

export function savePlayerCallUp(db, careerId, playerIds, { formation, captainId } = {}) {
  const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  if (!career) throw new Error('Carreira não encontrada');

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
  `).run(formation || career.formation, captainId ?? career.captain_id, careerId);
}

/* ------------------------------------------------------------------ *
 * Escalação
 * ------------------------------------------------------------------ */

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

export function saveLineup(db, careerId, matchId, starterIds, formation) {
  const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  const match = db.prepare('SELECT * FROM matches WHERE id = ? AND career_id = ?').get(matchId, careerId);
  if (!match) throw new Error('Partida não encontrada');
  const me = career.country_code;
  if (match.home !== me && match.away !== me) throw new Error('Esta não é a sua partida');

  const ids = [...new Set(starterIds.map(Number))];
  if (ids.length !== 11) throw new Error('A escalação precisa de 11 titulares');

  const squad = new Set(
    db.prepare('SELECT player_id FROM call_ups WHERE career_id = ?').all(careerId).map((r) => r.player_id),
  );
  for (const id of ids) {
    if (!squad.has(id)) throw new Error('Titular precisa estar convocado');
  }

  const form = formation || career.formation;
  db.prepare('UPDATE careers SET formation = ? WHERE id = ?').run(form, careerId);
  db.prepare('DELETE FROM lineups WHERE match_id = ? AND country_code = ?').run(matchId, me);

  const insert = db.prepare(`
    INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
    VALUES (?, ?, ?, ?, ?)
  `);
  const slots = FORMATION_SLOTS[form] ?? FORMATION_SLOTS['4-3-3'];
  ids.forEach((pid, i) => {
    const p = db.prepare('SELECT position FROM players WHERE id = ?').get(pid);
    insert.run(matchId, me, pid, 1, slots[i] ?? p.position);
  });
  // Banco
  for (const pid of squad) {
    if (ids.includes(pid)) continue;
    const p = db.prepare('SELECT position FROM players WHERE id = ?').get(pid);
    insert.run(matchId, me, pid, 0, p.position);
  }

  return { matchId, formation: form, starters: ids };
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
    const existing = db.prepare(
      'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? LIMIT 1',
    ).get(match.id, code);
    if (existing) continue;

    const squad = squadForCountry(db, careerId, code, w.career.country_code);
    const lined = autoLineup(squad, '4-3-3');
    const insert = db.prepare(`
      INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const p of lined) {
      insert.run(match.id, code, p.id, p.is_starter ? 1 : 0, p.position_slot);
    }
  }
}

function loadLineupPlayers(db, matchId, countryCode) {
  return db.prepare(`
    SELECT p.*, l.is_starter, l.position_slot
    FROM lineups l JOIN players p ON p.id = l.player_id
    WHERE l.match_id = ? AND l.country_code = ?
    ORDER BY l.is_starter DESC, l.rowid
  `).all(matchId, countryCode).map((p) => ({ ...playerRow(p), is_starter: p.is_starter, position_slot: p.position_slot }));
}

/* ------------------------------------------------------------------ *
 * Simulação do dia
 * ------------------------------------------------------------------ */

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
  // Quem começou também participa
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
        db.prepare('UPDATE players SET overall = MAX(38, MIN(94, overall + ?)) WHERE id = ?')
          .run(delta, pid);
      }
    }
    upsertAvailability(db, careerId, pid, { last_rating: rating });
  }

  // Cartões / expulsões
  const yellowsToday = {};
  for (const e of events) {
    if (!e.player_id) continue;
    if (e.type === 'yellow') {
      yellowsToday[e.player_id] = (yellowsToday[e.player_id] ?? 0) + 1;
      const av = db.prepare(
        'SELECT yellows FROM player_availability WHERE career_id = ? AND player_id = ?',
      ).get(careerId, e.player_id) ?? { yellows: 0 };
      let yellows = (av.yellows ?? 0) + 1;
      let suspended_until = undefined;
      if (yellowsToday[e.player_id] >= 2) {
        // Segundo amarelo no jogo = vermelho
        suspended_until = addDays(date, 1);
        yellows = 0;
      } else if (yellows >= 2) {
        // Acumulação FIFA simplificada: 2 amarelos → 1 jogo (≈ 4 dias)
        suspended_until = addDays(date, 4);
        yellows = 0;
      }
      upsertAvailability(db, careerId, e.player_id, { yellows, suspended_until });
    }
    if (e.type === 'red') {
      upsertAvailability(db, careerId, e.player_id, {
        yellows: 0,
        suspended_until: addDays(date, 7),
      });
    }
    if (e.type === 'injury') {
      let meta = {};
      try { meta = JSON.parse(e.meta || '{}'); } catch { /* */ }
      const days = meta.days ?? 14;
      upsertAvailability(db, careerId, e.player_id, {
        injured_until: addDays(date, days),
        injury_note: `Lesão ${meta.grade ?? 'média'} (${days} dias)`,
      });
      db.prepare('UPDATE players SET overall = MAX(38, overall - ?) WHERE id = ?')
        .run(meta.grade === 'grave' ? 2 : 1, e.player_id);
    }
  }
}

export function simulateDay(db, careerId, date) {
  const w = world(db, careerId);
  if (w.career.stage !== 'qualifiers') throw new Error('As Eliminatórias desta carreira já terminaram');

  const matches = db.prepare(`
    SELECT m.*, s.key AS stage_key, s.kind AS stage_kind, s.legs AS stage_legs,
           s.neutral AS stage_neutral, s.confederation AS stage_conf
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND m.date = ? AND m.played = 0
    ORDER BY m.id
  `).all(careerId, date);

  if (!matches.length) throw new Error('Não há jogos neste dia');

  const me = w.career.country_code;
  const playerMatch = matches.find((m) => m.home === me || m.away === me);

  db.exec('BEGIN');
  try {
    const results = [];

    for (const match of matches) {
      ensureCpuLineups(db, careerId, match, w);

      const homeXI = loadLineupPlayers(db, match.id, match.home);
      const awayXI = loadLineupPlayers(db, match.id, match.away);
      const rng = w.rngFor(`match|${match.stage_key}|${match.id}|${match.home}|${match.away}`);

      let opts = { neutral: !!match.neutral };
      if (match.stage_kind === 'knockout') {
        if (match.stage_legs === 2 && match.leg === 2) {
          const first = db.prepare(
            'SELECT * FROM matches WHERE stage_id = ? AND tie_id = ? AND leg = 1',
          ).get(match.stage_id, match.tie_id);
          opts = { ...opts, secondLeg: true, firstLeg: first, knockout: true };
        } else if (match.stage_legs === 1) {
          opts = { ...opts, knockout: true };
        }
      }

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

      const nameOf = (pid) => {
        if (!pid) return null;
        const p = db.prepare('SELECT name FROM players WHERE id = ?').get(pid);
        return p?.name ?? null;
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

      applyPostMatch(db, careerId, match, timeline.events, date);

      results.push({
        id: match.id,
        home: match.home,
        away: match.away,
        confederation: match.stage_conf,
        home_goals: timeline.home_goals,
        away_goals: timeline.away_goals,
        home_pens: timeline.home_pens,
        away_pens: timeline.away_pens,
        extra_time: timeline.extra_time,
        mine,
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

    // Progressão de fases tocadas
    const stageIds = [...new Set(matches.map((m) => m.stage_id))];
    for (const sid of stageIds) {
      const stageRow = db.prepare('SELECT * FROM stages WHERE id = ?').get(sid);
      tryProgressAfterStage(db, careerId, world(db, careerId), stageRow);
    }

    db.prepare(`UPDATE careers SET sim_date = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(date, careerId);

    db.exec('COMMIT');
    return {
      date,
      dateLabel: formatDateLabel(date),
      playerMatch: !!playerMatch,
      matches: results,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Avança o ponteiro da carreira para o próximo dia com jogos (ou próxima janela).
 * Se a janela mudou, marca callup_done = 0 (exceto se não houver mais jogos).
 */
export function advanceSimPointer(db, careerId) {
  const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  if (career.stage !== 'qualifiers') return { done: true };

  const next = db.prepare(`
    SELECT MIN(date) AS d FROM matches
    WHERE career_id = ? AND played = 0 AND date IS NOT NULL
      AND date > ?
  `).get(careerId, career.sim_date ?? '');

  if (!next?.d) {
    // Pode ainda haver jogos sem date? Ou fim.
    const any = db.prepare(
      'SELECT MIN(date) AS d FROM matches WHERE career_id = ? AND played = 0 AND date IS NOT NULL',
    ).get(careerId);
    if (!any?.d) {
      // Nada pendente — se ainda active stages sem jogos, algo falhou; senão finish
      const pending = db.prepare(
        'SELECT 1 FROM matches WHERE career_id = ? AND played = 0 LIMIT 1',
      ).get(careerId);
      if (!pending) {
        const w = world(db, careerId);
        if (w.career.stage === 'qualifiers' && allConfedsFinished(db, careerId, w)) {
          const hasIcp = db.prepare(
            'SELECT 1 FROM stages WHERE career_id = ? AND confederation IS NULL LIMIT 1',
          ).get(careerId);
          if (!hasIcp) progressPlayoff(db, careerId, w);
          else finish(db, careerId, w);
        }
      }
      return simState(db, careerId);
    }
    // Jogos com date <= sim_date ainda pendentes? Pega o mínimo geral.
    const win = windowForDate(any.d);
    const sameWin = (win?.ord ?? 0) === career.window_ord;
    let callupDone = sameWin ? career.callup_done : 0;
    if (!sameWin && win) {
      autoCallUpWindow(db, careerId, win.ord, { skipPlayer: false });
      const plays = countriesPlayingInWindow(db, careerId, win.ord)
        .includes(career.country_code);
      if (!plays) callupDone = 1;
    }
    db.prepare(`
      UPDATE careers SET sim_date = ?, window_ord = ?, callup_done = ?,
                         updated_at = datetime('now') WHERE id = ?
    `).run(any.d, win?.ord ?? career.window_ord, callupDone, careerId);
    return simState(db, careerId);
  }

  const win = windowForDate(next.d);
  const sameWindow = (win?.ord ?? -1) === career.window_ord;
  let callupDone = sameWindow ? 1 : 0;
  if (!sameWindow && win) {
    autoCallUpWindow(db, careerId, win.ord, { skipPlayer: false });
    // Só pede convocação ao jogador se a seleção dele joga nesta janela
    const plays = countriesPlayingInWindow(db, careerId, win.ord)
      .includes(career.country_code);
    if (!plays) callupDone = 1;
  }
  db.prepare(`
    UPDATE careers SET sim_date = ?, window_ord = ?, callup_done = ?,
                       updated_at = datetime('now') WHERE id = ?
  `).run(
    next.d,
    win?.ord ?? career.window_ord,
    callupDone,
    careerId,
  );

  return simState(db, careerId);
}

/* ------------------------------------------------------------------ *
 * Estado da simulação / UI
 * ------------------------------------------------------------------ */

export function simState(db, careerId) {
  startQualifiers(db, careerId); // idempotente
  const w = world(db, careerId);
  const career = db.prepare(`
    SELECT ca.*, co.name AS country_name, co.flag, co.confederation
    FROM careers ca JOIN countries co ON co.code = ca.country_code
    WHERE ca.id = ?
  `).get(careerId);

  if (career.stage !== 'qualifiers') {
    return {
      phase: 'done',
      career,
      rating: w.ratings[career.country_code],
      qualified: loadQualified(db, careerId),
    };
  }

  const windowOrd = career.window_ord ?? 0;
  const window = FIFA_WINDOWS[windowOrd]
    ? { ord: windowOrd, ...FIFA_WINDOWS[windowOrd] }
    : { ord: 0, ...FIFA_WINDOWS[0] };

  const days = datesInWindow(windowOrd);
  const simDate = career.sim_date ?? days[0];
  const date = simDate;

  const dayMatches = db.prepare(`
    SELECT m.id, m.home, m.away, m.played, m.home_goals, m.away_goals, m.home_pens, m.away_pens,
           m.extra_time, m.date, s.confederation, s.name AS stage_name
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND m.date = ?
    ORDER BY s.confederation, m.id
  `).all(careerId, date);

  const me = career.country_code;
  const myMatch = dayMatches.find((m) => m.home === me || m.away === me) ?? null;
  const countriesInWindow = countriesPlayingInWindow(db, careerId, windowOrd);
  const playerInWindow = countriesInWindow.includes(me);
  // Convocação só se a seleção do jogador joga nesta Data FIFA
  let needsCallUp = !career.callup_done && windowOrd > 0 && playerInWindow;
  if (!career.callup_done && windowOrd > 0 && !playerInWindow) {
    db.prepare('UPDATE careers SET callup_done = 1 WHERE id = ?').run(careerId);
    needsCallUp = false;
  }
  const pendingToday = dayMatches.some((m) => !m.played);
  const playedMineToday = myMatch && myMatch.played;

  const nextPlayer = db.prepare(`
    SELECT id, date, home, away FROM matches
    WHERE career_id = ? AND played = 0 AND (home = ? OR away = ?) AND date IS NOT NULL
    ORDER BY date, id LIMIT 1
  `).get(careerId, me, me);

  const canSkipToMe = !!(
    nextPlayer
    && !needsCallUp
    && !(myMatch && !myMatch.played)
    && nextPlayer.date !== date
  );

  let phase = 'ready';
  if (needsCallUp) {
    phase = 'callup';
  } else if (!pendingToday) {
    // Dia encerrado: pós-jogo se o jogador atuou; senão o cliente deve avançar o ponteiro.
    phase = playedMineToday || dayMatches.length ? 'post' : 'ready';
  } else if (myMatch && !myMatch.played) {
    const lined = db.prepare(
      'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? AND is_starter = 1 LIMIT 1',
    ).get(myMatch.id, me);
    phase = lined ? 'ready' : 'lineup';
  } else {
    phase = 'ready';
  }

  return {
    phase,
    career: { ...career, confederation: career.confederation },
    rating: w.ratings[me],
    window: {
      ord: window.ord,
      label: window.label,
      start: window.start,
      end: window.end,
      days,
      isFirst: window.ord === 0,
    },
    date,
    dateLabel: formatDateLabel(date),
    dayMatches,
    myMatch,
    countriesInWindow,
    needsCallUp,
    callupDone: !needsCallUp,
    squad: db.prepare(`
      SELECT p.*, cu.shirt AS squad_shirt FROM call_ups cu
      JOIN players p ON p.id = cu.player_id WHERE cu.career_id = ? ORDER BY cu.shirt
    `).all(careerId),
    formation: career.formation,
    qualified: loadQualified(db, careerId),
    nextPlayerMatch: nextPlayer ? {
      id: nextPlayer.id,
      date: nextPlayer.date,
      home: nextPlayer.home,
      away: nextPlayer.away,
      dateLabel: formatDateLabel(nextPlayer.date),
    } : null,
    canSkipToMe,
  };
}

const loadQualified = (db, careerId) => db.prepare(`
  SELECT q.country_code, q.route, q.note, c.name, c.flag, c.fifa_rank, c.confederation
  FROM qualified q JOIN countries c ON c.code = q.country_code
  WHERE q.career_id = ?
  ORDER BY CASE q.route WHEN 'host' THEN 0 ELSE 1 END, c.fifa_rank
`).all(careerId);

/** Compat: estado das eliminatórias para a tela de tabelas (pós-jogo / hub). */
export function qualifiersState(db, careerId) {
  const w = world(db, careerId);
  const me = w.career.country_code;
  const conf = w.confederation;

  const icp = loadStages(db, careerId, null, w.ranks);
  const inIcp =
    icp.some((s) => s.ties.some((t) => t.home === me || t.away === me))
    || (icp.length > 0 && w.career.stage === 'qualifiers'
      && !db.prepare("SELECT 1 FROM stages WHERE career_id = ? AND confederation = ? AND status = 'active'")
        .get(careerId, conf));

  const path = [...loadStages(db, careerId, conf, w.ranks), ...(inIcp ? icp : [])];
  const active = path.find((s) => s.status === 'active') ?? null;

  const current = active && {
    ...stageView(active, me),
    index: path.indexOf(active) + 1,
    total: STAGE_COUNT[conf] + (inIcp ? 2 : 0),
    intercontinental: active.confederation === null,
    matchday: nextMatchday(active),
    playing: active.matches.some(
      (m) => !m.played && m.matchday === nextMatchday(active) && (m.home === me || m.away === me),
    ),
  };

  return {
    career: { ...w.career, confederation: conf },
    rating: w.ratings[me],
    current,
    previous: path.filter((s) => s.status === 'done').map((s) => stageView(s, me)).at(-1) ?? null,
    qualified: loadQualified(db, careerId),
    scorers: scorersForConfederation(db, careerId, conf),
    sim: simState(db, careerId),
  };
}

const nextMatchday = (stage) => {
  const pending = stage.matches.filter((m) => !m.played);
  return pending.length ? Math.min(...pending.map((m) => m.matchday)) : stage.matchdays;
};

function stageView(stage, me) {
  return {
    id: stage.id,
    key: stage.key,
    name: stage.name,
    kind: stage.kind,
    legs: stage.legs,
    neutral: stage.neutral,
    matchdays: stage.matchdays,
    advance: stage.advance,
    playoff: stage.playoff,
    status: stage.status,
    groups: stage.groups.map((g) => ({
      name: g.name,
      teams: g.teams,
      mine: g.teams.includes(me),
      table: g.table,
      matches: g.matches,
    })),
    ties: stage.ties.map((t) => ({
      ...t,
      mine: t.home === me || t.away === me,
    })),
  };
}

export function worldState(db, careerId) {
  const w = world(db, careerId);
  const out = [];

  for (const [conf, codes] of Object.entries(w.confederations)) {
    const stages = loadStages(db, careerId, conf, w.ranks);
    const done = completed(stages);
    const ctx = context(w.base(codes), w.rngFor(`${conf}|draw|${done.length}`));
    const step = nextStage(conf, ctx, done);
    out.push({
      code: conf,
      finished: !!step.result && !stages.some((s) => s.status === 'active'),
      stages: stages.map((s) => stageView(s, w.career.country_code)),
      direct: step.result?.direct ?? [],
      playoff: step.result?.playoff ?? [],
    });
  }

  return {
    confederations: out,
    playoff: loadStages(db, careerId, null, w.ranks).map((s) => stageView(s, w.career.country_code)),
  };
}

/** Mantido para quem já foi eliminado e quer acelerar o resto do mundo. */
export function simulateRemaining(db, careerId) {
  const rounds = [];
  while (rounds.length < 200) {
    const career = db.prepare('SELECT stage, sim_date FROM careers WHERE id = ?').get(careerId);
    if (career.stage !== 'qualifiers') break;

    const next = db.prepare(`
      SELECT MIN(date) AS d FROM matches WHERE career_id = ? AND played = 0 AND date IS NOT NULL
    `).get(careerId);
    if (!next?.d) break;

    // Pula convocação/escalação: auto
    const w = world(db, careerId);
    if (!career.sim_date || career.sim_date !== next.d) {
      const win = windowForDate(next.d);
      db.prepare(`UPDATE careers SET sim_date = ?, window_ord = ?, callup_done = 1 WHERE id = ?`)
        .run(next.d, win?.ord ?? 0, careerId);
      autoCallUpWindow(db, careerId, win?.ord ?? 0, { skipPlayer: true });
    }

    // Auto-lineup do jogador se precisar
    const me = w.career.country_code;
    const myMatches = db.prepare(`
      SELECT * FROM matches WHERE career_id = ? AND date = ? AND played = 0
        AND (home = ? OR away = ?)
    `).all(careerId, next.d, me, me);
    for (const m of myMatches) {
      const has = db.prepare(
        'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? LIMIT 1',
      ).get(m.id, me);
      if (!has) {
        const squad = squadForCountry(db, careerId, me, me);
        const lined = autoLineup(squad, w.career.formation || '4-3-3');
        const insert = db.prepare(`
          INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const p of lined) insert.run(m.id, me, p.id, p.is_starter ? 1 : 0, p.position_slot);
      }
    }

    rounds.push(simulateDay(db, careerId, next.d));
    advanceSimPointer(db, careerId);
  }
  return rounds;
}

/**
 * Simula todos os dias anteriores ao próximo jogo da seleção do técnico,
 * parando no dia desse confronto (para escalação / simulação ao vivo).
 */
export function advanceToPlayerMatch(db, careerId) {
  startQualifiers(db, careerId);
  const career0 = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  if (career0.stage !== 'qualifiers') {
    throw new Error('As Eliminatórias desta carreira já terminaram');
  }

  const me = career0.country_code;
  const target = db.prepare(`
    SELECT id, date, home, away FROM matches
    WHERE career_id = ? AND played = 0 AND (home = ? OR away = ?) AND date IS NOT NULL
    ORDER BY date, id LIMIT 1
  `).get(careerId, me, me);
  if (!target) throw new Error('Não há mais jogos da sua seleção nas Eliminatórias');

  let skipped = 0;
  for (let i = 0; i < 200; i++) {
    const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
    if (career.stage !== 'qualifiers') break;

    const next = db.prepare(`
      SELECT MIN(date) AS d FROM matches WHERE career_id = ? AND played = 0 AND date IS NOT NULL
    `).get(careerId);
    if (!next?.d) break;

    if (next.d >= target.date) {
      const win = windowForDate(target.date);
      db.prepare(`
        UPDATE careers SET sim_date = ?, window_ord = ?, updated_at = datetime('now') WHERE id = ?
      `).run(target.date, win?.ord ?? career.window_ord ?? 0, careerId);
      break;
    }

    const w = world(db, careerId);
    const win = windowForDate(next.d);
    db.prepare(`
      UPDATE careers SET sim_date = ?, window_ord = ?, callup_done = 1 WHERE id = ?
    `).run(next.d, win?.ord ?? 0, careerId);
    autoCallUpWindow(db, careerId, win?.ord ?? 0, { skipPlayer: true });

    // Não deve haver jogo do técnico nestes dias (target está depois), mas
    // cobre edge cases com lineup automático se aparecer.
    const myMatches = db.prepare(`
      SELECT * FROM matches WHERE career_id = ? AND date = ? AND played = 0
        AND (home = ? OR away = ?)
    `).all(careerId, next.d, me, me);
    for (const m of myMatches) {
      const has = db.prepare(
        'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? LIMIT 1',
      ).get(m.id, me);
      if (!has) {
        const squad = squadForCountry(db, careerId, me, me);
        const lined = autoLineup(squad, w.career.formation || '4-3-3');
        const insert = db.prepare(`
          INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const p of lined) insert.run(m.id, me, p.id, p.is_starter ? 1 : 0, p.position_slot);
      }
    }

    simulateDay(db, careerId, next.d);
    advanceSimPointer(db, careerId);
    skipped += 1;
  }

  return {
    skipped,
    targetMatch: {
      id: target.id,
      date: target.date,
      home: target.home,
      away: target.away,
      dateLabel: formatDateLabel(target.date),
    },
    ...simState(db, careerId),
  };
}

/** Compatível com a rota antiga — avança um dia do calendário. */
export function advanceMatchday(db, careerId) {
  const state = simState(db, careerId);
  if (state.phase === 'done') throw new Error('As Eliminatórias desta carreira já terminaram');

  if (state.needsCallUp) {
    autoCallUpWindow(db, careerId, state.window.ord, { skipPlayer: true });
    db.prepare('UPDATE careers SET callup_done = 1 WHERE id = ?').run(careerId);
  }

  const date = state.date;
  const pending = db.prepare(
    'SELECT 1 FROM matches WHERE career_id = ? AND date = ? AND played = 0',
  ).get(careerId, date);

  if (pending) {
    // Auto lineup se necessário
    const w = world(db, careerId);
    const me = w.career.country_code;
    const myMatches = db.prepare(`
      SELECT * FROM matches WHERE career_id = ? AND date = ? AND played = 0
        AND (home = ? OR away = ?)
    `).all(careerId, date, me, me);
    for (const m of myMatches) {
      const has = db.prepare(
        'SELECT 1 FROM lineups WHERE match_id = ? AND country_code = ? LIMIT 1',
      ).get(m.id, me);
      if (!has) {
        const squad = squadForCountry(db, careerId, me, me);
        const lined = autoLineup(squad, w.career.formation || '4-3-3');
        const insert = db.prepare(`
          INSERT INTO lineups (match_id, country_code, player_id, is_starter, position_slot)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const p of lined) insert.run(m.id, me, p.id, p.is_starter ? 1 : 0, p.position_slot);
      }
    }
    const day = simulateDay(db, careerId, date);
    return { stage: 'Data FIFA', matchday: date, played: day.matches.map((m) => m.id), day };
  }

  advanceSimPointer(db, careerId);
  return advanceMatchday(db, careerId);
}

export { FORMATION_SLOTS, autoLineup, formatDateLabel };
