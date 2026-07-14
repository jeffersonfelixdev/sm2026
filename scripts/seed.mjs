#!/usr/bin/env node
/**
 * Constrói db/sm2026.db a partir de data/dataset.json.
 *
 * Além de copiar os dados públicos, calcula os atributos de jogo (força da seleção,
 * overall e atributos de cada jogador). Esses números são DERIVADOS — não são dados
 * oficiais: saem do ranking FIFA, de jogos/gols pela seleção, da idade e da posição,
 * com uma variação determinística por jogador (mesmo jogador ⇒ sempre o mesmo número).
 *
 * Uso: node scripts/seed.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUALIFIER_SCHEMA } from '../lib/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'db', 'sm2026.db');
const TODAY = new Date('2026-07-13'); // data de referência do jogo

/* ------------------------------------------------------------------ *
 * Atributos derivados
 * ------------------------------------------------------------------ */

/** Ruído estável por jogador: o mesmo nome sempre gera o mesmo desvio. */
function hashUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000; // 0..1
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function ageFrom(birth_date) {
  if (!birth_date) return null;
  const b = new Date(birth_date);
  if (Number.isNaN(+b)) return null;
  let age = TODAY.getFullYear() - b.getFullYear();
  const m = TODAY.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && TODAY.getDate() < b.getDate())) age--;
  return age >= 15 && age <= 45 ? age : null;
}

/**
 * Força da seleção (0–100) a partir dos pontos do Ranking FIFA.
 * Na escala atual, ~1900 pts é o topo (Argentina) e ~750 pts o fim da fila.
 */
function teamStrength(points, rank) {
  if (points == null) return rank ? clamp(85 - rank * 0.28, 35, 85) : 45;
  return clamp(Math.round(((points - 700) / (1900 - 700)) * 60 + 32), 32, 92);
}

/** Curva de idade: pico entre 26 e 30 anos. */
function ageFactor(age) {
  if (age == null) return 0;
  if (age < 21) return -6 + (age - 17) * 1.2;
  if (age < 26) return -2 + (age - 21) * 0.5;
  if (age <= 30) return 1.5;
  if (age <= 33) return 1.5 - (age - 30) * 1.2;
  return -2.1 - (age - 33) * 2.0;
}

function overallFor(player, strength) {
  const age = ageFrom(player.birth_date);
  const noise = hashUnit(player.name + player.country_code);

  // Base: a força da seleção define o patamar do elenco (≈70 numa potência, ≈40 numa seleção fraca).
  let ov = 20 + strength * 0.55;

  // Experiência internacional, com retornos decrescentes: quem tem 100 jogos não vale
  // o dobro de quem tem 50, mas a diferença para quem tem 5 é grande.
  ov += Math.min(10, Math.sqrt(player.caps) * 1.1);

  // Faro de gol, relevante para quem ataca
  if (player.caps >= 5 && (player.position === 'FW' || player.position === 'MF')) {
    const rate = player.goals / player.caps;
    ov += clamp(rate * 12, 0, player.position === 'FW' ? 6 : 4);
  }

  ov += ageFactor(age);

  // Convocado na última lista vale mais que "lembrado recentemente"
  ov += player.source === 'squad' ? 2.5 : 0;

  ov += (noise - 0.5) * 6; // variação individual determinística

  return Math.round(clamp(ov, 38, 94));
}

/** Atributos no estilo FIFA, ancorados no overall e enviesados pela posição. */
function attributesFor(player, overall) {
  const n = (salt) => hashUnit(player.name + salt) - 0.5;
  const bias = {
    GK: { pace: -14, shooting: -26, passing: -6, dribbling: -16, defending: 4, physical: 2, keeping: 12 },
    DF: { pace: -1, shooting: -14, passing: -3, dribbling: -7, defending: 9, physical: 7, keeping: -30 },
    MF: { pace: 1, shooting: -1, passing: 8, dribbling: 5, defending: -1, physical: -2, keeping: -30 },
    FW: { pace: 6, shooting: 10, passing: -2, dribbling: 7, defending: -16, physical: -1, keeping: -30 },
  }[player.position];

  const out = {};
  for (const [attr, delta] of Object.entries(bias)) {
    out[attr] = Math.round(clamp(overall + delta + n(attr) * 9, 25, 99));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE confederations (
  code       TEXT PRIMARY KEY,          -- CONMEBOL, UEFA, …
  full_name  TEXT NOT NULL,
  region     TEXT NOT NULL,
  color      TEXT NOT NULL,
  logo       TEXT,                      -- caminho relativo em public/
  wc_slots   REAL NOT NULL              -- vagas na Copa 2026 (".5" = repescagem intercontinental)
);

CREATE TABLE countries (
  code          TEXT PRIMARY KEY,       -- código FIFA de 3 letras (BRA, ARG…)
  name          TEXT NOT NULL,          -- nome em português
  en_name       TEXT NOT NULL,
  confederation TEXT NOT NULL REFERENCES confederations(code),
  fifa_rank     INTEGER,
  fifa_points   REAL,
  strength      INTEGER NOT NULL,       -- 0–100, derivado do ranking (usado na simulação)
  coach         TEXT,
  flag          TEXT,
  badge         TEXT,
  wiki          TEXT
);
CREATE INDEX idx_countries_conf ON countries(confederation);

CREATE TABLE players (
  id            INTEGER PRIMARY KEY,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  name          TEXT NOT NULL,
  position      TEXT NOT NULL CHECK (position IN ('GK','DF','MF','FW')),
  shirt         INTEGER,
  birth_date    TEXT,
  age           INTEGER,
  caps          INTEGER NOT NULL DEFAULT 0,
  goals         INTEGER NOT NULL DEFAULT 0,
  club          TEXT,
  club_country  TEXT,
  source        TEXT NOT NULL,          -- squad = última convocação | recent = convocado recentemente
  overall       INTEGER NOT NULL,
  pace          INTEGER NOT NULL,
  shooting      INTEGER NOT NULL,
  passing       INTEGER NOT NULL,
  dribbling     INTEGER NOT NULL,
  defending     INTEGER NOT NULL,
  physical      INTEGER NOT NULL,
  keeping       INTEGER NOT NULL
);
CREATE INDEX idx_players_country ON players(country_code);

-- Uma carreira = um treinador conduzindo uma seleção rumo à Copa.
CREATE TABLE careers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  coach_name    TEXT NOT NULL,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  formation     TEXT NOT NULL DEFAULT '4-3-3',
  captain_id    INTEGER REFERENCES players(id),
  stage         TEXT NOT NULL DEFAULT 'squad',  -- squad → qualifiers → world_cup | eliminated
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE call_ups (
  career_id  INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id),
  shirt      INTEGER,
  PRIMARY KEY (career_id, player_id)
);
${QUALIFIER_SCHEMA}
`;

// Vagas diretas na Copa 2026 por confederação (as ".5" disputam a repescagem intercontinental).
const WC_SLOTS = { UEFA: 16, CAF: 9.5, AFC: 8.5, CONCACAF: 6.5, CONMEBOL: 6.5, OFC: 1.5 };

async function main() {
  const dataset = JSON.parse(await readFile(path.join(ROOT, 'data', 'dataset.json'), 'utf8'));

  await mkdir(path.join(ROOT, 'db'), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);

  const insertConf = db.prepare(
    `INSERT INTO confederations (code, full_name, region, color, logo, wc_slots)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const c of dataset.confederations) {
    insertConf.run(c.code, c.full_name, c.region, c.color, c.logo ?? null, WC_SLOTS[c.code] ?? 0);
  }

  const insertCountry = db.prepare(
    `INSERT INTO countries (code, name, en_name, confederation, fifa_rank, fifa_points, strength, coach, flag, badge, wiki)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const strengthByCountry = new Map();
  for (const c of dataset.countries) {
    const strength = teamStrength(c.fifa_points, c.fifa_rank);
    strengthByCountry.set(c.code, strength);
    insertCountry.run(
      c.code, c.name, c.en_name, c.confederation,
      c.fifa_rank ?? null, c.fifa_points ?? null, strength,
      c.coach ?? null, c.flag ?? null, c.badge ?? null, c.wiki ?? null,
    );
  }

  const insertPlayer = db.prepare(
    `INSERT INTO players (country_code, name, position, shirt, birth_date, age, caps, goals,
                          club, club_country, source, overall, pace, shooting, passing,
                          dribbling, defending, physical, keeping)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  for (const p of dataset.players) {
    const strength = strengthByCountry.get(p.country_code);
    if (strength == null) continue; // jogador de um país que não entrou na base
    const overall = overallFor(p, strength);
    const a = attributesFor(p, overall);
    insertPlayer.run(
      p.country_code, p.name, p.position, p.shirt ?? null, p.birth_date ?? null,
      ageFrom(p.birth_date), p.caps, p.goals, p.club ?? null, p.club_country ?? null, p.source,
      overall, a.pace, a.shooting, a.passing, a.dribbling, a.defending, a.physical, a.keeping,
    );
  }
  db.exec('COMMIT');

  const count = (sql) => db.prepare(sql).get().n;
  const countries = count('SELECT COUNT(*) n FROM countries');
  const players = count('SELECT COUNT(*) n FROM players');
  const playable = count(`
    SELECT COUNT(*) n FROM countries c
    WHERE (SELECT COUNT(*) FROM players p WHERE p.country_code = c.code) >= 16`);

  console.log(`✔ db/sm2026.db criado`);
  console.log(`  ${countries} seleções · ${players} jogadores · ${playable} seleções com elenco jogável (≥16)`);

  // Conferência da calibragem: elenco de potência precisa ficar bem acima do de seleção fraca,
  // e ninguém deve encostar no teto em massa.
  const sample = db.prepare(`
    SELECT c.name, c.fifa_rank, c.strength, COUNT(p.id) n,
           ROUND(AVG(p.overall),1) avg_ov, MAX(p.overall) max_ov
    FROM countries c LEFT JOIN players p ON p.country_code = c.code
    WHERE c.fifa_rank IN (1, 5, 20, 50, 100, 150, 200)
    GROUP BY c.code ORDER BY c.fifa_rank`).all();
  console.log('\n  calibragem dos atributos (derivados):');
  for (const t of sample) {
    console.log(
      `   #${String(t.fifa_rank).padStart(3)} ${t.name.padEnd(16)} força ${String(t.strength).padStart(2)} · ` +
      `${String(t.n).padStart(2)} jogadores · overall médio ${String(t.avg_ov).padStart(4)} · melhor ${t.max_ov}`,
    );
  }

  const best = db.prepare(`
    SELECT p.name, p.position, p.overall, p.caps, p.goals, c.name country
    FROM players p JOIN countries c ON c.code = p.country_code
    ORDER BY p.overall DESC LIMIT 5`).all();
  console.log('\n  melhores do mundo:');
  for (const p of best) {
    console.log(`   ${p.overall} ${p.position} ${p.name} (${p.country}) — ${p.caps} jogos, ${p.goals} gols`);
  }
  db.close();
}

main().catch((e) => {
  console.error('Falha no seed:', e);
  process.exit(1);
});
