#!/usr/bin/env node
/**
 * SM2026 — servidor HTTP sem dependências.
 * Serve os arquivos estáticos de public/ e a API de leitura/gravação sobre o SQLite.
 *
 * Uso: node server.mjs   (porta 3000 por padrão, sobrescrevível com PORT)
 */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './lib/env.mjs';
import {
  advanceMatchday, advanceSimPointer, ensureSchema, qualifiersState,
  saveLineup, savePlayerCallUp, simState, simulateDay, simulateRemaining,
  startQualifiers, worldState, FORMATION_SLOTS, autoCallUpWindow,
  advanceToPlayerMatch,
} from './lib/qualifiers.mjs';
import {
  advanceCupPointer, cupSimState, drawPreview, drawState, hasWorldCupDraw,
  runWorldCupDraw, saveCupCallUp, simulateCupSlot, worldCupState,
  realWorldCupPreview, startRealWorldCup, advanceCupToPlayerMatch,
} from './lib/worldcup.mjs';
import {
  generateCupFinalSummary, generateCupPhaseSummary, generateCupRoundSummary,
  generateMatchSummary,
} from './lib/summary.mjs';
import { scorersForConfederation, worldCupScorers } from './lib/scorers.mjs';
import { SQUAD_RULES } from './lib/squad.mjs';

loadProjectEnv();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'db', 'sm2026.db');
const PORT = Number(process.env.PORT) || 3000;

if (!existsSync(DB_PATH)) {
  console.error('Banco não encontrado. Rode primeiro:\n  node scripts/fetch-data.mjs && node scripts/seed.mjs');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
ensureSchema(db);

/* ------------------------------------------------------------------ *
 * Consultas
 * ------------------------------------------------------------------ */
const q = {
  confederations: db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM countries WHERE confederation = c.code) AS teams
    FROM confederations c
    ORDER BY teams DESC`),

  allCountries: db.prepare(`
    SELECT code, name, confederation, fifa_rank, strength, flag, badge FROM countries`),

  countriesByConf: db.prepare(`
    SELECT co.code, co.name, co.en_name, co.confederation, co.fifa_rank, co.strength,
           co.coach, co.flag, co.badge,
           (SELECT COUNT(*) FROM players p WHERE p.country_code = co.code) AS pool
    FROM countries co
    WHERE co.confederation = ?
    ORDER BY CASE WHEN co.fifa_rank IS NULL THEN 1 ELSE 0 END, co.fifa_rank`),

  country: db.prepare(`
    SELECT co.*, cf.full_name AS confederation_name, cf.logo AS confederation_logo,
           cf.color AS confederation_color, cf.wc_slots
    FROM countries co JOIN confederations cf ON cf.code = co.confederation
    WHERE co.code = ?`),

  playersByCountry: db.prepare(`
    SELECT p.*,
           pa.suspended_until, pa.injured_until, pa.injury_note, pa.yellows, pa.last_rating
    FROM players p
    LEFT JOIN player_availability pa ON pa.player_id = p.id AND pa.career_id = ?
    WHERE p.country_code = ?
    ORDER BY CASE p.position WHEN 'GK' THEN 1 WHEN 'DF' THEN 2 WHEN 'MF' THEN 3 ELSE 4 END,
             p.overall DESC`),

  playersByCountryPlain: db.prepare(`
    SELECT * FROM players WHERE country_code = ?
    ORDER BY CASE position WHEN 'GK' THEN 1 WHEN 'DF' THEN 2 WHEN 'MF' THEN 3 ELSE 4 END,
             overall DESC`),

  createCareer: db.prepare(`
    INSERT INTO careers (coach_name, country_code, formation) VALUES (?, ?, ?)`),

  career: db.prepare(`
    SELECT ca.*, co.name AS country_name, co.flag, co.badge, co.fifa_rank, co.strength,
           co.confederation
    FROM careers ca JOIN countries co ON co.code = ca.country_code
    WHERE ca.id = ?`),

  careerSquad: db.prepare(`
    SELECT p.*, cu.shirt AS squad_shirt
    FROM call_ups cu JOIN players p ON p.id = cu.player_id
    WHERE cu.career_id = ?
    ORDER BY cu.shirt`),

  clearCallUps: db.prepare('DELETE FROM call_ups WHERE career_id = ?'),
  addCallUp: db.prepare('INSERT INTO call_ups (career_id, player_id, shirt) VALUES (?, ?, ?)'),
  setCareerSquad: db.prepare(`
    UPDATE careers SET formation = ?, captain_id = ?, stage = 'qualifiers',
                       updated_at = datetime('now')
    WHERE id = ?`),
  playerCountry: db.prepare('SELECT id, position, country_code FROM players WHERE id = ?'),
  hasStages: db.prepare('SELECT 1 FROM stages WHERE career_id = ? LIMIT 1'),
};

/* ------------------------------------------------------------------ *
 * Rotas
 * ------------------------------------------------------------------ */
const routes = [
  ['GET', /^\/api\/confederations$/, () => q.confederations.all()],

  ['GET', /^\/api\/confederations\/([A-Z]+)\/countries$/i, ([code]) =>
    q.countriesByConf.all(code.toUpperCase())],

  ['GET', /^\/api\/countries\/([A-Z]{3})$/i, ([code]) => {
    const country = q.country.get(code.toUpperCase());
    if (!country) throw new HttpError(404, 'Seleção não encontrada');
    return country;
  }],

  ['GET', /^\/api\/countries\/([A-Z]{3})\/players$/i, ([code], _, url) => {
    const careerId = Number(url.searchParams.get('career') || 0);
    const players = careerId
      ? q.playersByCountry.all(careerId, code.toUpperCase())
      : q.playersByCountryPlain.all(code.toUpperCase());
    if (!players.length) throw new HttpError(404, 'Sem jogadores para esta seleção');
    return { rules: SQUAD_RULES, players };
  }],

  ['POST', /^\/api\/careers$/, (_, body) => {
    const coach = String(body.coach_name ?? '').trim();
    const country = String(body.country_code ?? '').toUpperCase();
    if (coach.length < 2) throw new HttpError(400, 'Informe o nome do treinador');
    if (!q.country.get(country)) throw new HttpError(400, 'Seleção inválida');

    const { lastInsertRowid } = q.createCareer.run(coach, country, body.formation || '4-3-3');
    return q.career.get(Number(lastInsertRowid));
  }],

  ['GET', /^\/api\/worldcup\/real$/, () => realWorldCupPreview(db)],

  ['POST', /^\/api\/worldcup\/real$/, (_, body) => {
    try {
      return startRealWorldCup(db, {
        coachName: body.coach_name,
        countryCode: body.country_code,
      });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }],

  ['GET', /^\/api\/careers\/(\d+)$/, ([id]) => {
    const career = q.career.get(Number(id));
    if (!career) throw new HttpError(404, 'Carreira não encontrada');
    return {
      ...career,
      squad: q.careerSquad.all(Number(id)),
      started: !!q.hasStages.get(Number(id)),
    };
  }],

  ['POST', /^\/api\/careers\/(\d+)\/squad$/, ([id], body) => {
    const careerId = Number(id);
    const career = q.career.get(careerId);
    if (!career) throw new HttpError(404, 'Carreira não encontrada');

    const ids = [...new Set((body.player_ids ?? []).map(Number))];
    if (ids.length !== SQUAD_RULES.size) {
      throw new HttpError(400, `A convocação precisa ter exatamente ${SQUAD_RULES.size} jogadores`);
    }

    const byPosition = { GK: 0, DF: 0, MF: 0, FW: 0 };
    for (const pid of ids) {
      const player = q.playerCountry.get(pid);
      if (!player) throw new HttpError(400, `Jogador ${pid} não existe`);
      if (player.country_code !== career.country_code) {
        throw new HttpError(400, 'Só é possível convocar jogadores da própria seleção');
      }
      byPosition[player.position]++;
    }
    for (const [pos, min] of Object.entries(SQUAD_RULES.min)) {
      if (byPosition[pos] < min) {
        throw new HttpError(400, `Convoque ao menos ${min} jogador(es) na posição ${pos}`);
      }
    }
    const captain = body.captain_id ? Number(body.captain_id) : null;
    if (captain && !ids.includes(captain)) {
      throw new HttpError(400, 'O capitão precisa estar entre os convocados');
    }

    db.exec('BEGIN');
    try {
      q.clearCallUps.run(careerId);
      ids.forEach((pid, i) => { q.addCallUp.run(careerId, pid, i + 1); });
      q.setCareerSquad.run(body.formation || career.formation, captain, careerId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { ...q.career.get(careerId), squad: q.careerSquad.all(careerId) };
  }],

  ['GET', /^\/api\/countries$/, () => q.allCountries.all()],

  ['POST', /^\/api\/careers\/(\d+)\/qualifiers$/, ([id]) => {
    const careerId = Number(id);
    const career = requireCareer(careerId);
    if (career.stage === 'squad') throw new HttpError(400, 'Convoque a seleção antes das Eliminatórias');
    startQualifiers(db, careerId);
    return simState(db, careerId);
  }],

  ['GET', /^\/api\/careers\/(\d+)\/qualifiers$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    if (!db.prepare('SELECT 1 FROM stages WHERE career_id = ? LIMIT 1').get(careerId)) {
      throw new HttpError(409, 'As Eliminatórias desta carreira ainda não começaram');
    }
    return qualifiersState(db, careerId);
  }],

  /* --- Loop Data FIFA -------------------------------------------- */

  ['GET', /^\/api\/careers\/(\d+)\/sim$/, ([id]) => {
    requireCareer(Number(id));
    return simState(db, Number(id));
  }],

  ['POST', /^\/api\/careers\/(\d+)\/sim\/call-up$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      savePlayerCallUp(db, careerId, body.player_ids ?? [], {
        formation: body.formation,
        captainId: body.captain_id ? Number(body.captain_id) : null,
      });
      const state = simState(db, careerId);
      autoCallUpWindow(db, careerId, state.window.ord, { skipPlayer: true });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return simState(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/sim\/lineup$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      saveLineup(db, careerId, Number(body.match_id), body.starter_ids ?? [], body.formation);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return simState(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/sim\/day$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    const state = simState(db, careerId);
    const date = body.date || state.date;
    let day;
    try {
      day = simulateDay(db, careerId, date);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    return { day, ...simState(db, careerId) };
  }],

  ['POST', /^\/api\/careers\/(\d+)\/sim\/continue$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    return advanceSimPointer(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/sim\/skip-to-me$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      return advanceToPlayerMatch(db, careerId);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  }],

  ['GET', /^\/api\/careers\/(\d+)\/matches\/(\d+)\/lineups$/, ([cid, mid], _body, url) => {
    const careerId = Number(cid);
    const matchId = Number(mid);
    requireCareer(careerId);
    const match = db.prepare('SELECT * FROM matches WHERE id = ? AND career_id = ?').get(matchId, careerId);
    if (!match) throw new HttpError(404, 'Partida não encontrada');

    const upToMinute = url.searchParams.get('minute');
    const evQuery = upToMinute != null
      ? db.prepare(
          'SELECT player_id, type FROM match_events WHERE match_id = ? AND player_id IS NOT NULL AND minute <= ?',
        )
      : db.prepare(
          'SELECT player_id, type FROM match_events WHERE match_id = ? AND player_id IS NOT NULL',
        );
    const events = upToMinute != null
      ? evQuery.all(matchId, Number(upToMinute))
      : evQuery.all(matchId);
    const stats = {};
    for (const e of events) {
      stats[e.player_id] ??= { goals: 0, yellows: 0, reds: 0 };
      if (e.type === 'goal') stats[e.player_id].goals++;
      if (e.type === 'yellow') stats[e.player_id].yellows++;
      if (e.type === 'red') stats[e.player_id].reds++;
    }

    const loadSide = (code) => {
      const rows = db.prepare(`
        SELECT p.id, p.name, p.position, p.overall, p.shirt, l.is_starter, l.position_slot
        FROM lineups l JOIN players p ON p.id = l.player_id
        WHERE l.match_id = ? AND l.country_code = ?
        ORDER BY l.is_starter DESC, CASE p.position WHEN 'GK' THEN 1 WHEN 'DF' THEN 2 WHEN 'MF' THEN 3 ELSE 4 END, p.overall DESC
      `).all(matchId, code);
      const country = db.prepare('SELECT name, flag, coach, strength FROM countries WHERE code = ?').get(code);
      const mapRow = (r) => ({
        id: r.id, name: r.name, position: r.position, overall: r.overall,
        shirt: r.shirt ?? null, slot: r.position_slot,
        goals: stats[r.id]?.goals ?? 0,
        yellows: stats[r.id]?.yellows ?? 0,
        reds: stats[r.id]?.reds ?? 0,
      });
      return {
        code,
        name: country?.name ?? code,
        flag: country?.flag ?? null,
        coach: country?.coach ?? null,
        strength: country?.strength ?? null,
        starters: rows.filter((r) => r.is_starter).map(mapRow),
        bench: rows.filter((r) => !r.is_starter).map(mapRow),
      };
    };
    return { home: loadSide(match.home), away: loadSide(match.away) };
  }],

  ['GET', /^\/api\/formations$/, () => ({ formations: Object.keys(FORMATION_SLOTS), slots: FORMATION_SLOTS })],

  // Compat: avanço legado (um dia do calendário)
  ['POST', /^\/api\/careers\/(\d+)\/qualifiers\/advance$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    let round;
    try {
      round = advanceMatchday(db, careerId);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    return { round, ...qualifiersState(db, careerId) };
  }],

  ['POST', /^\/api\/careers\/(\d+)\/qualifiers\/simulate$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    const rounds = simulateRemaining(db, careerId);
    return { rounds: rounds.length, ...qualifiersState(db, careerId) };
  }],

  ['GET', /^\/api\/careers\/(\d+)\/world$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    return worldState(db, careerId);
  }],

  ['GET', /^\/api\/careers\/(\d+)\/scorers$/, ([id], _body, url) => {
    const careerId = Number(id);
    requireCareer(careerId);
    const scope = url.searchParams.get('scope');
    if (scope === 'worldcup') {
      return { scope: 'worldcup', scorers: worldCupScorers(db, careerId) };
    }
    const confederation = url.searchParams.get('confederation');
    if (!confederation) {
      throw new HttpError(400, 'Informe confederation ou scope=worldcup');
    }
    return {
      scope: 'qualifiers',
      confederation,
      scorers: scorersForConfederation(db, careerId, confederation),
    };
  }],

  /* --- Copa do Mundo --------------------------------------------- */

  ['GET', /^\/api\/careers\/(\d+)\/worldcup\/draw$/, ([id]) => {
    const career = requireCareer(Number(id));
    if (career.stage !== 'world_cup' && career.stage !== 'eliminated') {
      throw new HttpError(409, 'As Eliminatórias ainda não terminaram');
    }
    return hasWorldCupDraw(db, Number(id))
      ? drawState(db, Number(id))
      : drawPreview(db, Number(id));
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/draw$/, ([id]) => {
    const career = requireCareer(Number(id));
    if (career.stage !== 'world_cup' && career.stage !== 'eliminated') {
      throw new HttpError(409, 'As Eliminatórias ainda não terminaram');
    }
    try {
      return runWorldCupDraw(db, Number(id));
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  }],

  ['GET', /^\/api\/careers\/(\d+)\/worldcup$/, ([id]) => {
    const career = requireCareer(Number(id));
    if (career.stage !== 'world_cup' && career.stage !== 'eliminated') {
      throw new HttpError(409, 'A Copa ainda não começou para esta carreira');
    }
    if (!hasWorldCupDraw(db, Number(id))) {
      throw new HttpError(409, 'O sorteio ainda não foi realizado');
    }
    return worldCupState(db, Number(id));
  }],

  ['GET', /^\/api\/careers\/(\d+)\/worldcup\/sim$/, ([id]) => {
    requireCareer(Number(id));
    if (!hasWorldCupDraw(db, Number(id))) {
      throw new HttpError(409, 'O sorteio ainda não foi realizado');
    }
    return cupSimState(db, Number(id));
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/sim\/call-up$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      saveCupCallUp(db, careerId, body.player_ids ?? [], {
        formation: body.formation,
        captainId: body.captain_id ? Number(body.captain_id) : null,
      });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return cupSimState(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/sim\/lineup$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      saveLineup(db, careerId, Number(body.match_id), body.starter_ids ?? [], body.formation);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    return cupSimState(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/sim\/slot$/, ([id], body) => {
    const careerId = Number(id);
    requireCareer(careerId);
    let slot;
    try {
      slot = simulateCupSlot(db, careerId, {
        date: body.date,
        kickoff: body.kickoff,
      });
    } catch (err) {
      throw new HttpError(409, err.message);
    }
    return { slot, ...cupSimState(db, careerId) };
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/sim\/continue$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    return advanceCupPointer(db, careerId);
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/sim\/skip-to-me$/, ([id]) => {
    const careerId = Number(id);
    requireCareer(careerId);
    try {
      return advanceCupToPlayerMatch(db, careerId);
    } catch (err) {
      throw new HttpError(409, err.message);
    }
  }],

  ['POST', /^\/api\/careers\/(\d+)\/matches\/(\d+)\/summary$/, async ([careerId, matchId]) => {
    requireCareer(Number(careerId));
    try {
      return await generateMatchSummary(db, Number(careerId), Number(matchId));
    } catch (err) {
      const status = /não encontrad|não foi jogada|somente para/i.test(err.message) ? 400 : 502;
      throw new HttpError(status, err.message);
    }
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/summary\/round$/, async ([careerId], body) => {
    requireCareer(Number(careerId));
    try {
      return await generateCupRoundSummary(db, Number(careerId), body?.matchday);
    } catch (err) {
      const status = /inválid|não exist|não terminou|Sem resultados/i.test(err.message) ? 400 : 502;
      throw new HttpError(status, err.message);
    }
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/summary\/phase$/, async ([careerId], body) => {
    requireCareer(Number(careerId));
    try {
      return await generateCupPhaseSummary(db, Number(careerId), body?.stageKey);
    } catch (err) {
      const status = /inválid|não encontrad|não terminou/i.test(err.message) ? 400 : 502;
      throw new HttpError(status, err.message);
    }
  }],

  ['POST', /^\/api\/careers\/(\d+)\/worldcup\/summary\/final$/, async ([careerId]) => {
    requireCareer(Number(careerId));
    try {
      return await generateCupFinalSummary(db, Number(careerId));
    } catch (err) {
      const status = /não exist|não encontrad|ainda não/i.test(err.message) ? 400 : 502;
      throw new HttpError(status, err.message);
    }
  }],
];

function requireCareer(id) {
  const career = q.career.get(id);
  if (!career) throw new HttpError(404, 'Carreira não encontrada');
  return career;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Estáticos
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'text/plain', 'Proibido');

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('não é arquivo');
    const body = await readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const cache = rel.startsWith('assets/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache });
    res.end(body);
  } catch {
    send(res, 404, 'text/plain; charset=utf-8', 'Arquivo não encontrado');
  }
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const json = (res, status, data) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1e6) throw new HttpError(413, 'Corpo grande demais');
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Método não permitido');
    return serveStatic(res, pathname);
  }

  let pathExists = false;

  for (const [method, pattern, handler] of routes) {
    const match = pathname.match(pattern);
    if (!match) continue;
    pathExists = true;
    if (req.method !== method) continue;
    try {
      const body = method === 'POST' ? await readBody(req) : null;
      const result = await handler(match.slice(1), body, url);
      return json(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Erro interno' });
    }
  }

  if (pathExists) return json(res, 405, { error: 'Método não permitido' });
  json(res, 404, { error: 'Rota não encontrada' });
});

server.listen(PORT, () => {
  console.log(`\n  ⚽  SM2026 rodando em http://localhost:${PORT}\n`);
});
