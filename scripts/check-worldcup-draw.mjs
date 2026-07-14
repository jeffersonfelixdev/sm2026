#!/usr/bin/env node
/**
 * Smoke test do sorteio WC 2026 — não precisa de carreira completa.
 */
import { DatabaseSync } from 'node:sqlite';
import { allocatePots, drawWorldCup2026, groupStageMatches, HOST_SLOTS, WC_PATHWAY } from '../lib/worldcup.mjs';
import { rngFrom } from '../lib/rng.mjs';
import { HOSTS } from '../lib/formats.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(path.join(ROOT, 'db', 'sm2026.db'));

const countries = db.prepare(
  'SELECT code, confederation, fifa_rank FROM countries ORDER BY fifa_rank NULLS LAST, code',
).all();
const ranks = Object.fromEntries(countries.map((c) => [c.code, c.fifa_rank ?? 999]));
const confByCode = Object.fromEntries(countries.map((c) => [c.code, c.confederation]));

// 48 classificados sintéticos: hosts + melhores de cada confed até fechar vagas
const slots = { UEFA: 16, CAF: 9, AFC: 8, CONMEBOL: 6, CONCACAF: 3, OFC: 1 };
const picked = new Set(HOSTS);
for (const [conf, n] of Object.entries(slots)) {
  const pool = countries
    .filter((c) => c.confederation === conf && !HOSTS.includes(c.code))
    .sort((a, b) => (a.fifa_rank ?? 999) - (b.fifa_rank ?? 999));
  for (const c of pool.slice(0, n)) picked.add(c.code);
}
// +2 playoff: próximos AFC/CONMEBOL
for (const conf of ['AFC', 'CONMEBOL']) {
  const extra = countries.find((c) => c.confederation === conf && !picked.has(c.code));
  if (extra) picked.add(extra.code);
}

const qualified = [...picked];
if (qualified.length !== 48) {
  console.error('Esperava 48, tem', qualified.length);
  process.exit(1);
}

const pots = allocatePots(qualified, ranks);
console.log('Potes:', pots.map((p) => p.length).join(','));
for (const h of HOSTS) {
  if (!pots[0].includes(h)) {
    console.error('Host fora do pote 1:', h);
    process.exit(1);
  }
}

let ok = 0;
for (let seed = 0; seed < 20; seed++) {
  try {
    const drawn = drawWorldCup2026(qualified, ranks, confByCode, rngFrom(`test|${seed}`));
    // Validar hosts
    for (const [host, g] of Object.entries(HOST_SLOTS)) {
      const group = drawn.groups.find((x) => x.name === g);
      if (group.teams[0] !== host) throw new Error(`${host} não está em ${g}1`);
    }
    // UEFA 1–2
    for (const g of drawn.groups) {
      const uefa = g.teams.filter((c) => confByCode[c] === 'UEFA').length;
      if (uefa < 1 || uefa > 2) throw new Error(`Grupo ${g.name} UEFA=${uefa}`);
      // demais confeds ≤1
      const counts = {};
      for (const c of g.teams) {
        const conf = confByCode[c];
        if (conf === 'UEFA') continue;
        counts[conf] = (counts[conf] ?? 0) + 1;
        if (counts[conf] > 1) throw new Error(`Grupo ${g.name} repetiu ${conf}`);
      }
    }
    // Top 4 pathways
    const top4 = pots[0]
      .filter((c) => !HOSTS.includes(c))
      .sort((a, b) => ranks[a] - ranks[b])
      .slice(0, 4);
    const groupOf = Object.fromEntries(
      drawn.groups.flatMap((g) => g.teams.map((t) => [t, g.name])),
    );
    const path = (c) => (WC_PATHWAY.H1.includes(groupOf[c]) ? 'H1' : 'H2');
    if (path(top4[0]) === path(top4[1])) throw new Error('Top1 e Top2 no mesmo pathway');
    if (path(top4[2]) === path(top4[3])) throw new Error('Top3 e Top4 no mesmo pathway');

    const matches = groupStageMatches(drawn.groups);
    if (matches.length !== 72) throw new Error(`Partidas=${matches.length}`);

    // MD1/MD2: nenhum date+kickoff UTC compartilhado (sem jogos simultâneos)
    for (const md of [1, 2]) {
      const seen = new Map();
      for (const m of matches.filter((x) => x.matchday === md)) {
        const key = `${m.date}|${m.kickoff}`;
        if (seen.has(key)) {
          throw new Error(`MD${md} horário UTC duplicado ${key} (${seen.get(key)} e ${m.group})`);
        }
        seen.set(key, m.group);
      }
    }

    // MD3: os dois jogos do mesmo grupo no mesmo UTC
    const md3Same = matches.filter((m) => m.matchday === 3);
    for (const g of drawn.groups) {
      const pair = md3Same.filter((m) => m.group === g.name);
      if (pair.length !== 2) throw new Error(`MD3 grupo ${g.name}`);
      if (pair[0].date !== pair[1].date || pair[0].kickoff !== pair[1].kickoff) {
        throw new Error(`MD3 ${g.name} não simultâneo`);
      }
    }
    ok++;
  } catch (err) {
    console.error(`Seed ${seed} falhou:`, err.message);
    process.exit(1);
  }
}

console.log(`OK — ${ok}/20 sorteios válidos, 72 jogos, MD1/MD2 sem simultâneos, MD3 simultâneo.`);
