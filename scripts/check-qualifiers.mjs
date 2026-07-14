#!/usr/bin/env node
/**
 * Confere os formatos das Eliminatórias.
 *
 * Simula o ciclo inteiro várias vezes, com sementes diferentes, e verifica o que o
 * regulamento manda: número de vagas, times por grupo, jogos por time, equilíbrio de
 * mando, ninguém classificado duas vezes, e as 48 seleções da Copa no fim.
 *
 * Uso: node scripts/check-qualifiers.mjs [rodadas]
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rngFrom } from '../lib/rng.mjs';
import { byRank, qualifyNote, runConfederation, runPlayoff, stageMatchdays } from '../lib/engine.mjs';
import { HOSTS, STAGE_COUNT } from '../lib/formats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.argv[2]) || 20;

const db = new DatabaseSync(path.join(ROOT, 'db', 'sm2026.db'));
const countries = db.prepare('SELECT code, confederation, fifa_rank, strength FROM countries').all();
db.close();

const ranks = Object.fromEntries(countries.map((c) => [c.code, c.fifa_rank ?? 999]));
const ratings = Object.fromEntries(countries.map((c) => [c.code, c.strength]));
const byConf = {};
for (const c of countries) (byConf[c.confederation] ??= []).push(c.code);

/** Vagas diretas + na repescagem que cada confederação deve entregar. */
const EXPECTED = {
  UEFA: { direct: 16, playoff: 0 },
  CAF: { direct: 9, playoff: 1 },
  AFC: { direct: 8, playoff: 1 },
  CONMEBOL: { direct: 6, playoff: 1 },
  CONCACAF: { direct: 3, playoff: 2 }, // + os 3 anfitriões, que não jogam
  OFC: { direct: 1, playoff: 1 },
};

let failures = 0;
const check = (ok, message) => {
  if (!ok) { failures++; console.error(`  ✗ ${message}`); }
};

/** Cada time de um grupo joga contra todos os outros — uma vez, ou duas em turno e returno. */
function checkGroupStage(conf, stage, matches) {
  for (const group of stage.groups) {
    const size = group.teams.length;
    const own = matches.filter((m) => m.group === group.name);
    const expected = (size * (size - 1)) / 2 * stage.legs;
    check(own.length === expected,
      `${conf}/${stage.key} grupo ${group.name}: ${own.length} jogos, esperado ${expected}`);

    for (const team of group.teams) {
      const played = own.filter((m) => m.home === team || m.away === team);
      const home = own.filter((m) => m.home === team).length;
      check(played.length === (size - 1) * stage.legs,
        `${conf}/${stage.key} ${team}: ${played.length} jogos, esperado ${(size - 1) * stage.legs}`);

      // Mando equilibrado: no returno é exatamente metade; no turno único, no máximo um a mais.
      const away = played.length - home;
      check(Math.abs(home - away) <= (stage.legs === 2 ? 0 : 1),
        `${conf}/${stage.key} ${team}: ${home} em casa x ${away} fora — tabela torta`);

      // Ninguém enfrenta o mesmo adversário mais vezes do que o formato manda.
      const foes = played.map((m) => (m.home === team ? m.away : m.home));
      const most = Math.max(...Object.values(foes.reduce((acc, f) => ({ ...acc, [f]: (acc[f] ?? 0) + 1 }), {})));
      check(most === stage.legs,
        `${conf}/${stage.key} ${team}: enfrentou alguém ${most}x, esperado ${stage.legs}`);
    }

    const table = group.table;
    check(table.length === size, `${conf}/${stage.key} grupo ${group.name}: tabela com ${table.length} times`);
    for (let i = 1; i < table.length; i++) {
      check(table[i - 1].points >= table[i].points,
        `${conf}/${stage.key} grupo ${group.name}: tabela fora de ordem`);
    }
  }
}

function checkKnockout(conf, stage) {
  for (const tie of stage.ties) {
    check(tie.winner === tie.home || tie.winner === tie.away,
      `${conf}/${stage.key}: vencedor ${tie.winner} não está no confronto`);
    check(tie.legs.length === stage.legs,
      `${conf}/${stage.key}: confronto com ${tie.legs.length} jogo(s), esperado ${stage.legs}`);
    for (const m of tie.legs) {
      check(m.played === 1, `${conf}/${stage.key}: partida não jogada`);
      // Mata-mata não termina empatado: ou o placar decide, ou os pênaltis.
      if (stage.legs === 1) {
        check(m.home_goals !== m.away_goals || m.home_pens != null,
          `${conf}/${stage.key}: jogo único empatado sem pênaltis`);
      }
    }
  }
}

console.log(`Simulando ${RUNS} ciclos completos de Eliminatórias…\n`);

for (let run = 0; run < RUNS; run++) {
  const rngFor = (key) => rngFrom(`run${run}|${key}`);
  const qualified = new Set(HOSTS);
  const toPlayoff = [];
  let matchCount = 0;

  for (const [conf, teams] of Object.entries(byConf)) {
    const base = { teams: byRank(teams, ranks), ranks };
    const { result, stages } = runConfederation(conf, base, ratings, rngFor);

    check(stages.length === STAGE_COUNT[conf],
      `${conf}: ${stages.length} fases, esperado ${STAGE_COUNT[conf]}`);
    check(result.direct.length === EXPECTED[conf].direct,
      `${conf}: ${result.direct.length} vagas diretas, esperado ${EXPECTED[conf].direct}`);
    check(result.playoff.length === EXPECTED[conf].playoff,
      `${conf}: ${result.playoff.length} na repescagem, esperado ${EXPECTED[conf].playoff}`);

    for (const { stage, matches, resolved } of stages) {
      matchCount += matches.length;
      check(matches.every((m) => m.played), `${conf}/${stage.key}: sobrou jogo sem placar`);
      check(stageMatchdays(stage) >= 1, `${conf}/${stage.key}: fase sem rodadas`);
      if (stage.kind === 'groups') checkGroupStage(conf, resolved, matches);
      else checkKnockout(conf, resolved);
    }

    // Os anfitriões estão na Copa, não nas Eliminatórias.
    if (conf === 'CONCACAF') {
      const played = new Set(stages.flatMap((s) => s.matches).flatMap((m) => [m.home, m.away]));
      for (const host of HOSTS) {
        check(!played.has(host), `CONCACAF: o anfitrião ${host} não devia jogar as Eliminatórias`);
      }
    }

    for (const code of result.direct) {
      check(!qualified.has(code), `${code} classificado duas vezes`);
      check(!!qualifyNote(code, stages.map((s) => s.resolved)), `${code}: sem descrição de como se classificou`);
      qualified.add(code);
    }
    toPlayoff.push(...result.playoff);
  }

  // Repescagem intercontinental: 6 seleções, 2 vagas.
  check(toPlayoff.length === 6, `repescagem com ${toPlayoff.length} seleções, esperado 6`);
  for (const code of toPlayoff) check(!qualified.has(code), `${code} está na repescagem e já classificado`);

  const base = { teams: byRank(toPlayoff, ranks), ranks };
  const playoff = runPlayoff(base, ratings, rngFor);
  check(playoff.result.direct.length === 2, `repescagem entregou ${playoff.result.direct.length} vagas, esperado 2`);
  for (const code of playoff.result.direct) qualified.add(code);
  matchCount += playoff.stages.reduce((n, s) => n + s.matches.length, 0);

  check(qualified.size === 48, `Copa com ${qualified.size} seleções, esperado 48`);

  if (run === 0) {
    console.log(`  ${matchCount} partidas por ciclo\n`);
    const conmebol = runConfederation('CONMEBOL', { teams: byRank(byConf.CONMEBOL, ranks), ranks }, ratings, rngFor);
    console.log('  amostra — Eliminatórias Sul-Americanas:');
    for (const row of conmebol.stages[0].resolved.groups[0].table) {
      const mark = row.position <= 6 ? '✔' : row.position === 7 ? '↻' : ' ';
      console.log(
        `   ${mark} ${String(row.position).padStart(2)}. ${row.code}  ${String(row.points).padStart(2)} pts  ` +
        `${row.won}-${row.drawn}-${row.lost}  ${String(row.gf).padStart(2)}:${String(row.ga).padStart(2)}`,
      );
    }
    console.log();
  }

  process.stdout.write(`\r  ciclo ${run + 1}/${RUNS}`);
}

console.log('\n');
if (failures) {
  console.error(`✗ ${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log(`✔ ${RUNS} ciclos sem nenhuma violação de regra`);
