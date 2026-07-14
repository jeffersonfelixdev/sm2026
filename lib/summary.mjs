/**
 * Crônicas via GPT — partida do técnico, rodadas/fases da Copa e final.
 */
import { formatDateLabel } from './calendar.mjs';
import { rankAcrossGroups, standings } from './rules.mjs';

const CUP_PHASE_LABEL = {
  wc_r32: 'Dieciseisavos de final',
  wc_r16: 'Oitavas de final',
  wc_qf: 'Quartas de final',
  wc_sf: 'Semifinais',
  wc_third: 'Disputa de 3º lugar',
  wc_final: 'Final',
};

function countryName(db, code) {
  if (!code) return 'a definir';
  return db.prepare('SELECT name FROM countries WHERE code = ?').get(code)?.name ?? code;
}

function clockOf(e) {
  if (e.clock) return e.clock;
  return e.stoppage ? `${e.minute}+${e.stoppage}'` : `${e.minute}'`;
}

function formatScore(m) {
  let s = `${m.home_goals}×${m.away_goals}`;
  if (m.extra_time) s += ' após prorrogação';
  if (m.home_pens != null) s += `, pênaltis ${m.home_pens}–${m.away_pens}`;
  return s;
}

function loadEvents(db, matchId) {
  return db.prepare(`
    SELECT e.*, ph.name AS player_name, pa.name AS assist_name
    FROM match_events e
    LEFT JOIN players ph ON ph.id = e.player_id
    LEFT JOIN players pa ON pa.id = e.assist_id
    WHERE e.match_id = ?
    ORDER BY e.minute, e.stoppage, e.id
  `).all(matchId);
}

function describeEvents(events, nameOf) {
  const lines = [];
  for (const e of events) {
    const clock = clockOf(e);
    const team = e.team ? nameOf(e.team) : null;
    switch (e.type) {
      case 'goal':
        lines.push(
          `${clock} GOL ${team}: ${e.player_name ?? '?'}`
          + (e.assist_name ? ` (assistência: ${e.assist_name})` : ''),
        );
        break;
      case 'yellow':
        lines.push(`${clock} Cartão amarelo ${team}: ${e.player_name ?? '?'}`);
        break;
      case 'red':
        lines.push(`${clock} Cartão vermelho ${team}: ${e.player_name ?? '?'}`);
        break;
      case 'sub':
        lines.push(
          `${clock} Substituição ${team}: saiu ${e.assist_name ?? '?'} · entrou ${e.player_name ?? '?'}`,
        );
        break;
      case 'injury':
        lines.push(`${clock} Lesão ${team}: ${e.player_name ?? '?'}`);
        break;
      case 'penalties':
        lines.push(`${clock} Disputa de pênaltis`);
        break;
      case 'half_time':
        lines.push(`${clock} Intervalo`);
        break;
      case 'full_time':
        lines.push(`${clock} Fim do tempo regulamentar`);
        break;
      case 'et_end':
        lines.push(`${clock} Fim da prorrogação`);
        break;
      default:
        break;
    }
  }
  return lines;
}

function tableLines(table, nameOf, me) {
  if (!table?.length) return [];
  return table.map((r) => {
    const mark = r.code === me ? ' ← SUA SELEÇÃO' : '';
    return `${r.position}. ${nameOf(r.code)} — ${r.played}J ${r.won}V ${r.drawn}E ${r.lost}D `
      + `${r.gf}:${r.ga} (SG ${r.gd}) · ${r.points} pts${mark}`;
  });
}

function loadRanks(db) {
  const countries = db.prepare('SELECT code, fifa_rank FROM countries').all();
  return Object.fromEntries(countries.map((c) => [c.code, c.fifa_rank ?? 999]));
}

/** Próximo jogo ainda não disputado da seleção, após o confronto atual. */
function nextFixtureForTeam(db, careerId, teamCode, afterMatch) {
  const afterDate = afterMatch.date ?? '0000-01-01';
  const afterKick = afterMatch.kickoff ?? '00:00';
  const row = db.prepare(`
    SELECT m.date, m.kickoff, m.home, m.away, m.matchday,
           s.name AS stage_name, g.name AS group_name
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.career_id = ?
      AND m.played = 0
      AND (m.home = ? OR m.away = ?)
      AND m.date IS NOT NULL
      AND (
        m.date > ?
        OR (m.date = ? AND COALESCE(m.kickoff, '00:00') > ?)
        OR (m.date = ? AND COALESCE(m.kickoff, '00:00') = ? AND m.id > ?)
      )
    ORDER BY m.date, COALESCE(m.kickoff, '00:00'), m.id
    LIMIT 1
  `).get(
    careerId, teamCode, teamCode,
    afterDate, afterDate, afterKick,
    afterDate, afterKick, afterMatch.id,
  );
  if (!row) return null;

  const opponent = row.home === teamCode ? row.away : row.home;
  const venue = row.home === teamCode ? 'mandante' : 'visitante';
  return {
    date: row.date,
    dateLabel: formatDateLabel(row.date),
    kickoff: row.kickoff,
    opponent,
    venue,
    stage_name: row.stage_name,
    group_name: row.group_name,
    matchday: row.matchday,
  };
}

function resolveGroupTable(db, stage, group, ranks) {
  const teams = db.prepare(
    'SELECT country_code FROM group_teams WHERE group_id = ? ORDER BY pot, country_code',
  ).all(group.id).map((r) => r.country_code);

  const matches = db.prepare(`
    SELECT home, away, home_goals, away_goals
    FROM matches WHERE group_id = ? AND played = 1
  `).all(group.id).map((m) => ({
    home: m.home,
    away: m.away,
    home_goals: m.home_goals,
    away_goals: m.away_goals,
    played: 1,
  }));

  const events = db.prepare(`
    SELECT e.team, e.type FROM match_events e
    JOIN matches m ON m.id = e.match_id WHERE m.group_id = ?
  `).all(group.id);

  return standings(teams, matches, {
    ranks,
    events,
    tiebreak: stage.tiebreak === 'wc2026' ? 'wc2026' : stage.tiebreak === 'uefa' ? 'uefa' : 'fifa',
  });
}

function legWinner(m) {
  if (!m?.played) return null;
  if (m.home_pens != null && m.away_pens != null) {
    return m.home_pens > m.away_pens ? m.home : m.away;
  }
  if (m.home_goals === m.away_goals) return null;
  return m.home_goals > m.away_goals ? m.home : m.away;
}

function tieWinner(legs) {
  if (!legs?.length || legs.some((l) => !l.played)) return null;
  if (legs.length === 1) return legWinner(legs[0]);

  const gf = {};
  for (const m of legs) {
    gf[m.home] = (gf[m.home] ?? 0) + m.home_goals;
    gf[m.away] = (gf[m.away] ?? 0) + m.away_goals;
  }
  const codes = Object.keys(gf);
  if (codes.length < 2) return legWinner(legs.at(-1));
  const [x, y] = codes;
  if (gf[x] !== gf[y]) return gf[x] > gf[y] ? x : y;
  const last = legs.at(-1);
  if (last.home_pens != null) return last.home_pens > last.away_pens ? last.home : last.away;
  return null;
}

function loadStageTies(db, stageId) {
  const ties = db.prepare(
    'SELECT id, name, home, away FROM ties WHERE stage_id = ? ORDER BY id',
  ).all(stageId);

  return ties.map((t) => {
    const legs = db.prepare(`
      SELECT home, away, home_goals, away_goals, home_pens, away_pens, played, leg, date, kickoff
      FROM matches WHERE tie_id = ? ORDER BY leg, id
    `).all(t.id);
    return { ...t, legs, winner: tieWinner(legs) };
  });
}

function scoreLabel(legs) {
  if (!legs?.length) return 'pendente';
  return legs.map((m) => {
    if (!m.played) return '×';
    let s = `${m.home_goals}×${m.away_goals}`;
    if (m.home_pens != null) s += ` (${m.home_pens}–${m.away_pens} pen)`;
    return s;
  }).join(' / ');
}

/** Texto longo das regras de classificação da fase atual. */
function phaseRulesLines(stage, isCup) {
  if (!stage) return [];
  const lines = ['REGRAS DE CLASSIFICAÇÃO DESTA FASE:'];

  if (isCup) {
    const ko = {
      wc_r32: { next: 'oitavas de final', drop: 'eliminado' },
      wc_r16: { next: 'quartas de final', drop: 'eliminado' },
      wc_qf: { next: 'semifinais', drop: 'eliminado' },
      wc_sf: { next: 'a final (vencedores) ou a disputa de 3º lugar (perdedores)', drop: null },
      wc_third: { title: 'Disputa de 3º lugar — o vencedor fica com o bronze.' },
      wc_final: { title: 'Final — o vencedor é campeão do mundo; o perdedor, vice.' },
    };

    if (stage.key === 'wc_groups') {
      lines.push('- Copa do Mundo 2026: 48 seleções em 12 grupos de 4 (todos contra todos, 3 jogos cada).');
      lines.push('- Classificam-se o 1º e o 2º de cada grupo (24 vagas).');
      lines.push('- Também avançam os 8 melhores 3ºs entre os 12 grupos (pts → saldo → gols pró → fair play → ranking FIFA).');
      lines.push('- Os 32 seguem aos dieciseisavos de final (mata-mata).');
      lines.push('- Desempate no grupo: confronto direto → saldo → gols pró → fair play → ranking FIFA.');
      return lines;
    }

    const meta = ko[stage.key];
    if (meta?.title) {
      lines.push(`- ${meta.title}`);
      lines.push('- Jogo único. Empate no tempo normal → prorrogação (2×15) → pênaltis.');
      return lines;
    }

    lines.push('- Mata-mata em jogo único, campo neutro.');
    lines.push('- Empate no tempo regulamentar → prorrogação → disputa de pênaltis.');
    if (meta?.next) lines.push(`- Vencedor avança para: ${meta.next}.`);
    if (meta?.drop) lines.push(`- Perdedor: ${meta.drop}.`);
    lines.push('- Emparelhamento da próxima fase: vencedores dos confrontos adjacentes no chaveamento (1×2, 3×4, 5×6…).');
    return lines;
  }

  const conf = stage.confederation ?? 'repescagem intercontinental';
  if (stage.kind === 'groups') {
    lines.push(`- Eliminatórias (${conf}): fase de grupos${stage.legs === 2 ? ' em ida e volta' : ''}.`);
    if (stage.advance != null && stage.playoff != null && stage.playoff > stage.advance) {
      lines.push(`- Avançam direto (vaga / próxima fase garantida): do 1º ao ${stage.advance}º de cada grupo.`);
      lines.push(`- Ainda vivos para playoff ou fase seguinte: do ${stage.advance + 1}º ao ${stage.playoff}º.`);
      lines.push(`- Eliminados nesta fase: a partir do ${stage.playoff + 1}º.`);
    } else if (stage.advance != null) {
      lines.push(`- Avançam: os ${stage.advance} primeiro(s) de cada grupo.`);
      lines.push('- Demais posições: eliminados ou fora desta disputa.');
    }
    const tb = stage.tiebreak === 'uefa'
      ? 'UEFA (confronto direto entre empatados antes do saldo geral)'
      : 'FIFA (pontos → saldo → gols pró → …)';
    lines.push(`- Critério de desempate: ${tb}.`);
    return lines;
  }

  lines.push(`- Eliminatórias (${conf}): mata-mata${stage.legs === 2 ? ' em ida e volta' : ' em jogo único'}.`);
  if (stage.legs === 2) {
    lines.push('- Classifica-se quem vencer no placar agregado das duas partidas; prorrogação/pênaltis na volta se necessário.');
  } else {
    lines.push('- Empate no tempo normal → prorrogação → pênaltis. Perdedor eliminado.');
  }
  lines.push('- Próxima fase: emparelhamento sequencial dos classificados (vencedor do confronto 1×2, 3×4…).');
  return lines;
}

/**
 * Chaveamento do mata-mata + “outro lado da chave” (adversário potencial).
 */
function knockoutBracketContext(db, stage, focusCodes, nameOf) {
  if (!stage || stage.kind !== 'knockout') {
    return { lines: [], potentialNext: {} };
  }

  const ties = loadStageTies(db, stage.id);
  const lines = [`CHAVEAMENTO — ${stage.name}:`];

  ties.forEach((t, i) => {
    const focus = focusCodes.includes(t.home) || focusCodes.includes(t.away);
    const win = t.winner ? ` → avança ${nameOf(t.winner)}` : '';
    lines.push(
      `  ${i + 1}. ${nameOf(t.home)} × ${nameOf(t.away)}`
      + ` [${scoreLabel(t.legs)}]${win}${focus ? ' ← envolvido nesta crônica' : ''}`,
    );
  });

  lines.push(
    'Cruzamento para a próxima fase: (1×2), (3×4), (5×6), (7×8)… — '
    + 'o vencedor de um confronto enfrenta o vencedor do vizinho (outro lado da chave).',
  );

  const potentialNext = {};
  for (const code of focusCodes) {
    const idx = ties.findIndex((t) => t.home === code || t.away === code);
    if (idx < 0) continue;
    const sister = ties[idx ^ 1];
    if (!sister) {
      potentialNext[code] = { note: 'Não há outro lado da chave (fase decisiva / chave ímpar).' };
      continue;
    }
    const myTie = ties[idx];
    const lost = myTie.winner && myTie.winner !== code;
    if (lost) {
      potentialNext[code] = { note: 'Eliminado neste mata-mata — sem próximo jogo na chave.' };
      continue;
    }
    if (sister.winner) {
      potentialNext[code] = {
        opponent: sister.winner,
        note: `Se avançar (ou já avançou), o próximo adversário é ${nameOf(sister.winner)} `
          + `(vencedor de ${nameOf(sister.home)} × ${nameOf(sister.away)}, outro lado da chave).`,
      };
    } else {
      potentialNext[code] = {
        pendingPair: [sister.home, sister.away],
        note: `Se avançar, o próximo adversário será o VENCEDOR de ${nameOf(sister.home)} × ${nameOf(sister.away)} `
          + '(outro lado da chave). A data desse jogo só existe após o chaveamento da próxima fase.',
      };
    }
  }

  for (const code of focusCodes) {
    if (potentialNext[code]?.note) {
      lines.push(`Sobre ${nameOf(code)}: ${potentialNext[code].note}`);
    }
  }

  return { lines, potentialNext };
}

function competitionContext(db, careerId, match, me, nameOf) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(match.stage_id);
  const isCup = match.stage_conf === 'FIFA' || String(match.stage_key || '').startsWith('wc_');
  const ranks = loadRanks(db);
  const lines = [];
  let bracketPotential = {};

  if (isCup) {
    lines.push('Competição: Copa do Mundo FIFA 2026');
    lines.push(`Fase atual: ${stage?.name ?? 'Copa'} (chave ${stage?.key ?? '?'})`);
  } else {
    lines.push('Competição: Eliminatórias da Copa do Mundo FIFA 2026');
    lines.push(`Fase atual: ${stage?.name ?? 'Eliminatórias'} (${stage?.kind ?? '?'})`);
    lines.push(
      stage?.confederation
        ? `Confederação: ${stage.confederation}`
        : 'Repescagem intercontinental',
    );
  }

  lines.push(...phaseRulesLines(stage, isCup));

  if (stage?.kind === 'groups' && match.group_id) {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(match.group_id);
    if (group) {
      lines.push(`Grupo em disputa: ${group.name}`);
      const table = resolveGroupTable(db, stage, group, ranks);
      lines.push('Classificação do grupo após esta partida:');
      lines.push(...tableLines(table, nameOf, me));
      const myRow = table.find((r) => r.code === me);
      if (myRow && stage.advance != null) {
        if (isCup) {
          if (myRow.position <= 2) {
            lines.push(`Situação da sua seleção: ${myRow.position}º — zona de classificação automática (1º/2º).`);
          } else if (myRow.position === 3) {
            lines.push('Situação da sua seleção: 3º — disputa vaga entre os melhores terceiros.');
          } else {
            lines.push(`Situação da sua seleção: ${myRow.position}º — fora da zona de classificação do grupo.`);
          }
        } else if (myRow.position <= stage.advance) {
          lines.push(`Situação da sua seleção: ${myRow.position}º — dentro da zona de avanço direto (até o ${stage.advance}º).`);
        } else if (stage.playoff != null && myRow.position <= stage.playoff) {
          lines.push(`Situação da sua seleção: ${myRow.position}º — na zona de playoff/repescagem (até o ${stage.playoff}º).`);
        } else {
          lines.push(`Situação da sua seleção: ${myRow.position}º — fora da zona de classificação desta fase.`);
        }
      }
    }
  } else if (stage?.kind === 'knockout') {
    const bracket = knockoutBracketContext(db, stage, [match.home, match.away], nameOf);
    lines.push(...bracket.lines);
    bracketPotential = bracket.potentialNext;
  }

  const career = db.prepare('SELECT * FROM careers WHERE id = ?').get(careerId);
  const qualified = db.prepare(
    'SELECT 1 FROM qualified WHERE career_id = ? AND country_code = ?',
  ).get(careerId, me);

  if (isCup) {
    lines.push('Situação geral: seleção na Copa do Mundo 2026.');
  } else if (qualified || career.stage === 'world_cup') {
    lines.push('Situação geral: seleção CLASSIFICADA para a Copa do Mundo.');
  } else if (career.stage === 'eliminated') {
    lines.push('Situação geral: seleção ELIMINADA das Eliminatórias.');
  } else {
    lines.push('Situação geral: Eliminatórias ainda em andamento.');
  }

  return {
    competition: isCup ? 'Copa do Mundo FIFA 2026' : 'Eliminatórias FIFA 2026',
    situation: lines,
    bracketPotential,
    isKnockout: stage?.kind === 'knockout',
  };
}

function describeNextFixture(teamName, fixture, nameOf, potential) {
  if (potential?.note && !fixture) {
    return `Próximo jogo de ${teamName}: ${potential.note}`;
  }
  if (!fixture) {
    return `Próximo jogo de ${teamName}: não há confronto agendado no calendário `
      + '(fase encerrada, eliminado ou chaveamento da próxima fase ainda não gerado).'
      + (potential?.note ? ` ${potential.note}` : '');
  }

  const when = fixture.kickoff
    ? `${fixture.dateLabel} · ${fixture.kickoff} UTC`
    : fixture.dateLabel;
  const phase = [
    fixture.stage_name,
    fixture.group_name ? `Grupo ${fixture.group_name}` : null,
    fixture.matchday ? `rodada ${fixture.matchday}` : null,
  ].filter(Boolean).join(' · ');

  let opp;
  if (fixture.opponent) {
    opp = `${nameOf(fixture.opponent)} (${fixture.venue})`;
  } else if (potential?.pendingPair) {
    opp = `vencedor de ${nameOf(potential.pendingPair[0])} × ${nameOf(potential.pendingPair[1])} (outro lado da chave)`;
  } else if (potential?.opponent) {
    opp = `${nameOf(potential.opponent)} (outro lado da chave)`;
  } else {
    opp = 'adversário a definir';
  }

  return `Próximo jogo de ${teamName}: ${opp} em ${when}`
    + (phase ? ` — ${phase}` : '');
}

function buildPrompt(payload) {
  const {
    competition, situation, chronicleFacts, nextFixtures, coach, playerTeam, isKnockout,
  } = payload;
  return `Você é cronista esportivo sênior de um grande jornal brasileiro.

TAREFA
Escreva um resumo jornalístico da partida abaixo, em português do Brasil.
O texto DEVE cobrir, de forma assertiva:
1) como foi a partida (placar, lances relevantes da linha do tempo, leitura do jogo);
2) a situação da seleção "${playerTeam}" após o resultado, à luz das REGRAS DE CLASSIFICAÇÃO e da tabela/chaveamento (zona de classificação, eliminação, avanço, etc.);
3) o próximo passo de cada seleção: adversário e data quando houver; no mata-mata, se o próximo for o vencedor do outro lado da chave, diga isso explicitamente (ex.: "nas oitavas pegaria o vencedor de X×Y").

REGRAS OBRIGATÓRIAS
- Use somente os fatos listados. NÃO invente gols, jogadores, cartões, placares, posições, adversários, datas, estádios, público ou estatísticas ausentes.
- Não invente o chaveamento: cite apenas confrontos e cruzamentos descritos abaixo.
- Se um detalhe não estiver nos fatos, omita-o.
- Pode interpretar o clima do jogo quando os eventos sustentarem.
- Tom profissional de caderno de esportes. Sem emoji, sem hashtags, sem markdown, sem título.
- 2 a 5 parágrafos curtos em prosa contínua.
- Refira-se à seleção do técnico ${coach} pelo nome do país.
${isKnockout ? '- Este jogo é mata-mata: mencione o outro lado da chave quando a informação estiver nos dados.\n' : ''}
COMPETIÇÃO: ${competition}

FATOS DA PARTIDA
${chronicleFacts.join('\n')}

CLASSIFICAÇÃO / SITUAÇÃO / REGRAS / CHAVEAMENTO
${situation.join('\n')}

PRÓXIMOS CONFRONTOS
${nextFixtures.join('\n')}

Escreva agora apenas a crônica.`;
}

async function callGpt(prompt, { maxTokens = 850 } = {}) {
  const key = process.env.GPT_API_KEY;
  if (!key) throw new Error('GPT_API_KEY não configurada no .env');

  const model = process.env.GPT_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.65,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'system',
          content: 'Você escreve crônicas esportivas jornalísticas fiéis aos fatos fornecidos.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `OpenAI HTTP ${res.status}`;
    throw new Error(msg);
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('A IA não retornou texto');
  return text;
}

function loadCupCareer(db, careerId) {
  const career = db.prepare(`
    SELECT ca.*, co.name AS country_name
    FROM careers ca JOIN countries co ON co.code = ca.country_code
    WHERE ca.id = ?
  `).get(careerId);
  if (!career) throw new Error('Carreira não encontrada');
  return career;
}

function loadCupGroupsStage(db, careerId) {
  return db.prepare(
    "SELECT * FROM stages WHERE career_id = ? AND key = 'wc_groups'",
  ).get(careerId);
}

function stylePreamble(coach, extras = '') {
  return `Você é cronista esportivo sênior de um grande jornal brasileiro.

REGRAS OBRIGATÓRIAS
- Use somente os fatos listados. NÃO invente gols, jogadores, cartões, placares, posições, adversários, datas, estádios, público ou estatísticas ausentes.
- Não invente o chaveamento: cite apenas confrontos e cruzamentos descritos abaixo.
- Se um detalhe não estiver nos fatos, omita-o.
- Pode interpretar o clima do jogo quando os eventos sustentarem.
- Tom profissional de caderno de esportes. Sem emoji, sem hashtags, sem markdown, sem título.
- 2 a 5 parágrafos curtos em prosa contínua.
- Quando citar a seleção do técnico ${coach}, use o nome do país.
${extras}`;
}

function matchdayResults(db, careerId, matchday, nameOf) {
  return db.prepare(`
    SELECT m.*, g.name AS group_name
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.career_id = ? AND s.key = 'wc_groups' AND m.matchday = ? AND m.played = 1
    ORDER BY g.name, m.kickoff, m.id
  `).all(careerId, matchday).map((m) => ({
    ...m,
    line: `Grupo ${m.group_name}: ${nameOf(m.home)} ${formatScore(m)} ${nameOf(m.away)}`,
  }));
}

function topScorersOfMatches(db, matchIds, nameOf, limit = 8) {
  if (!matchIds.length) return [];
  const ph = matchIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.player_id, p.name AS player_name, e.team AS team_code, COUNT(*) AS goals
    FROM match_events e
    JOIN players p ON p.id = e.player_id
    WHERE e.match_id IN (${ph}) AND e.type = 'goal' AND e.player_id IS NOT NULL
    GROUP BY e.player_id, e.team
    ORDER BY goals DESC, p.name
    LIMIT ?
  `).all(...matchIds, limit);
  return rows.map((r) => `${r.player_name} (${nameOf(r.team_code)}) · ${r.goals} gol(s)`);
}

function allGroupTablesLines(db, stage, me, nameOf) {
  const ranks = loadRanks(db);
  const groups = db.prepare('SELECT * FROM groups WHERE stage_id = ? ORDER BY name').all(stage.id);
  const lines = [];
  for (const g of groups) {
    const table = resolveGroupTable(db, { ...stage, tiebreak: 'wc2026' }, g, ranks);
    lines.push(`Grupo ${g.name}:`);
    lines.push(...tableLines(table, nameOf, me));
  }
  return lines;
}

function playerGroupSituation(db, stage, me, nameOf) {
  if (!me) return [];
  const ranks = loadRanks(db);
  const gt = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_teams gt ON gt.group_id = g.id
    WHERE g.stage_id = ? AND gt.country_code = ?
  `).get(stage.id, me);
  if (!gt) return [`A seleção ${nameOf(me)} não está nesta Copa / fase de grupos.`];

  const table = resolveGroupTable(db, { ...stage, tiebreak: 'wc2026' }, gt, ranks);
  const myRow = table.find((r) => r.code === me);
  if (!myRow) return [];

  const lines = [
    `Seleção do técnico — ${nameOf(me)} no Grupo ${gt.name}: ${myRow.position}º `
    + `(${myRow.points} pts, SG ${myRow.gd}, ${myRow.gf}:${myRow.ga}).`,
  ];
  if (myRow.position <= 2) {
    lines.push('Zona atual: classificação automática (1º/2º).');
  } else if (myRow.position === 3) {
    lines.push('Zona atual: 3º colocado — depende do ranking dos melhores terceiros.');
  } else {
    lines.push('Zona atual: 4º — fora da zona de classificação do grupo.');
  }
  return lines;
}

function bestThirdsPreview(db, stage, nameOf) {
  const ranks = loadRanks(db);
  const groups = db.prepare('SELECT * FROM groups WHERE stage_id = ? ORDER BY name').all(stage.id);
  const thirds = [];
  for (const g of groups) {
    const table = resolveGroupTable(db, { ...stage, tiebreak: 'wc2026' }, g, ranks);
    if (table[2]) thirds.push({ ...table[2], group: g.name });
  }
  if (thirds.length < 8) return [];
  const ranked = rankAcrossGroups(thirds, { ranks });
  const lines = ['Ranking dos 3ºs (após a rodada):'];
  ranked.forEach((r, i) => {
    const cut = i < 8 ? 'avança' : 'fora';
    lines.push(
      `${i + 1}. ${nameOf(r.code)} (Grupo ${r.group}) — ${r.points} pts · SG ${r.gd} · ${cut}`,
    );
  });
  return lines;
}

/** Gera a crônica do jogo da seleção do técnico. */
export async function generateMatchSummary(db, careerId, matchId) {
  const career = db.prepare(`
    SELECT ca.*, co.name AS country_name
    FROM careers ca JOIN countries co ON co.code = ca.country_code
    WHERE ca.id = ?
  `).get(careerId);
  if (!career) throw new Error('Carreira não encontrada');

  const match = db.prepare(`
    SELECT m.*, s.key AS stage_key, s.name AS stage_name, s.kind AS stage_kind,
           s.confederation AS stage_conf, g.name AS group_name
    FROM matches m
    JOIN stages s ON s.id = m.stage_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE m.id = ? AND m.career_id = ?
  `).get(matchId, careerId);
  if (!match) throw new Error('Partida não encontrada');
  if (!match.played) throw new Error('A partida ainda não foi jogada');

  const me = career.country_code;
  if (match.home !== me && match.away !== me) {
    throw new Error('Resumo disponível somente para jogos da sua seleção');
  }

  const nameOf = (code) => countryName(db, code);
  const homeName = nameOf(match.home);
  const awayName = nameOf(match.away);
  const playerTeam = career.country_name;
  const opponent = match.home === me ? awayName : homeName;
  const venue = match.home === me ? 'mandante' : 'visitante';

  const events = loadEvents(db, matchId);
  const eventLines = describeEvents(events, nameOf);

  const lineupRows = db.prepare(`
    SELECT p.name, p.position, l.is_starter
    FROM lineups l JOIN players p ON p.id = l.player_id
    WHERE l.match_id = ? AND l.country_code = ?
    ORDER BY l.is_starter DESC, l.position_slot, p.name
  `).all(matchId, me);
  const starters = lineupRows.filter((r) => r.is_starter).map((r) => `${r.name} (${r.position})`);
  const scorers = events
    .filter((e) => e.type === 'goal')
    .map((e) => `${clockOf(e)} ${e.player_name ?? '?'} (${nameOf(e.team)})`);

  const chronicleFacts = [
    `Data: ${formatDateLabel(match.date)}${match.kickoff ? ` · ${match.kickoff} UTC` : ''}`,
    `Fase: ${match.stage_name}${match.group_name ? ` · Grupo ${match.group_name}` : ''}`,
    `Placar: ${homeName} ${formatScore(match)} ${awayName}`,
    `Seleção do técnico ${career.coach_name}: ${playerTeam} (${venue}) contra ${opponent}`,
    starters.length ? `Titulares de ${playerTeam}: ${starters.join(', ')}` : null,
    scorers.length ? `Gols: ${scorers.join('; ')}` : 'Gols: nenhum',
    eventLines.length ? `Linha do tempo:\n${eventLines.join('\n')}` : null,
  ].filter(Boolean);

  const ctx = competitionContext(db, careerId, match, me, nameOf);
  const nextHome = nextFixtureForTeam(db, careerId, match.home, match);
  const nextAway = nextFixtureForTeam(db, careerId, match.away, match);
  const nextFixtures = [
    describeNextFixture(homeName, nextHome, nameOf, ctx.bracketPotential[match.home]),
    describeNextFixture(awayName, nextAway, nameOf, ctx.bracketPotential[match.away]),
  ];

  const payload = {
    competition: ctx.competition,
    situation: ctx.situation,
    chronicleFacts,
    nextFixtures,
    coach: career.coach_name,
    playerTeam,
    isKnockout: ctx.isKnockout,
  };

  const summary = await callGpt(buildPrompt(payload));

  return {
    summary,
    competition: ctx.competition,
    match: {
      id: match.id,
      home: match.home,
      away: match.away,
      home_name: homeName,
      away_name: awayName,
      home_goals: match.home_goals,
      away_goals: match.away_goals,
      home_pens: match.home_pens,
      away_pens: match.away_pens,
      extra_time: !!match.extra_time,
      dateLabel: formatDateLabel(match.date),
      stage_name: match.stage_name,
      group_name: match.group_name,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Crônicas da Copa — rodada / fase / final
 * ------------------------------------------------------------------ */

/**
 * Resumo após o encerramento da 1ª, 2ª ou 3ª rodada da fase de grupos.
 */
export async function generateCupRoundSummary(db, careerId, matchday) {
  const md = Number(matchday);
  if (![1, 2, 3].includes(md)) throw new Error('Rodada inválida (use 1, 2 ou 3)');

  const career = loadCupCareer(db, careerId);
  const stage = loadCupGroupsStage(db, careerId);
  if (!stage) throw new Error('Fase de grupos ainda não existe');

  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM matches m
    WHERE m.stage_id = ? AND m.matchday = ? AND m.played = 0
  `).get(stage.id, md).n;
  if (pending > 0) throw new Error(`A ${md}ª rodada ainda não terminou`);

  const nameOf = (code) => countryName(db, code);
  const me = career.country_code;
  const results = matchdayResults(db, careerId, md, nameOf);
  if (!results.length) throw new Error('Sem resultados para esta rodada');

  const scorers = topScorersOfMatches(db, results.map((m) => m.id), nameOf);
  const tables = allGroupTablesLines(db, stage, me, nameOf);
  const mine = playerGroupSituation(db, stage, me, nameOf);
  const thirds = md === 3 ? bestThirdsPreview(db, stage, nameOf) : [];

  const nextStep = md < 3
    ? `Próximo passo do torneio: ${md + 1}ª rodada da fase de grupos.`
    : 'Próximo passo do torneio: dieciseisavos de final (mata-mata), após o ranking dos 8 melhores 3ºs.';

  const facts = [
    `Competição: Copa do Mundo FIFA 2026`,
    `Escopo: resumo da ${md}ª rodada da fase de grupos (${results.length} partidas).`,
    ...phaseRulesLines(stage, true),
    'RESULTADOS DA RODADA:',
    ...results.map((m) => m.line),
    scorers.length ? `Artilheiros da rodada: ${scorers.join('; ')}` : null,
    'TABELAS APÓS A RODADA:',
    ...tables,
    ...mine,
    ...(thirds.length ? thirds : []),
    nextStep,
    career.country_name
      ? `O leitor acompanha sobretudo a seleção ${career.country_name} (técnico ${career.coach_name}).`
      : null,
  ].filter(Boolean);

  const extrasRound = [
    `- Foque na leitura da rodada ${md}: resultados marcantes, mudanças nas tabelas e o que a rodada mudou na corrida às oitavas/32avos.`,
    '- Destaque artilheiros e viradas quando constarem nos fatos.',
    '- Na 3ª rodada, explique quem avançou e a briga dos 3ºs conforme os dados.',
  ].join('\n') + '\n';
  const prompt = [
    stylePreamble(career.coach_name, extrasRound),
    '',
    'TAREFA',
    `Escreva o resumo jornalístico da ${md}ª rodada da fase de grupos da Copa.`,
    'Cubra: clima geral da rodada, destaques, avaliação das tabelas (e da seleção do técnico se houver dados) e o próximo passo da Copa.',
    '',
    'FATOS',
    facts.join('\n'),
    '',
    'Escreva agora apenas a crônica.',
  ].join('\n');

  const summary = await callGpt(prompt, { maxTokens: 1000 });
  return {
    kind: 'round',
    title: `Crônica da ${md}ª rodada`,
    subtitle: `Fase de grupos · ${md}ª rodada`,
    competition: 'Copa do Mundo FIFA 2026',
    summary,
    matchday: md,
  };
}

/**
 * Resumo ao término de uma fase do mata-mata (16avos → disputa de 3º).
 */
export async function generateCupPhaseSummary(db, careerId, stageKey) {
  if (!CUP_PHASE_LABEL[stageKey] || stageKey === 'wc_final') {
    throw new Error('Fase inválida para este resumo (use wc_r32, wc_r16, wc_qf, wc_sf ou wc_third)');
  }

  const career = loadCupCareer(db, careerId);
  const stage = db.prepare(
    'SELECT * FROM stages WHERE career_id = ? AND key = ?',
  ).get(careerId, stageKey);
  if (!stage) throw new Error('Fase não encontrada');

  const pending = db.prepare(
    'SELECT COUNT(*) AS n FROM matches WHERE stage_id = ? AND played = 0',
  ).get(stage.id).n;
  if (pending > 0) throw new Error(`A fase ${CUP_PHASE_LABEL[stageKey]} ainda não terminou`);

  const nameOf = (code) => countryName(db, code);
  const me = career.country_code;
  const ties = loadStageTies(db, stage.id);
  const results = ties.map((t, i) => {
    const score = scoreLabel(t.legs);
    const win = t.winner ? ` → ${nameOf(t.winner)}` : '';
    return `${i + 1}. ${nameOf(t.home)} × ${nameOf(t.away)} [${score}]${win}`
      + (t.home === me || t.away === me ? ' ← seleção do técnico' : '');
  });

  const advancers = ties.map((t) => t.winner).filter(Boolean).map(nameOf);
  const eliminated = ties
    .filter((t) => t.winner)
    .map((t) => (t.winner === t.home ? t.away : t.home))
    .map(nameOf);

  const myTie = ties.find((t) => t.home === me || t.away === me);
  let myFate = `A seleção ${career.country_name} não disputou esta fase.`;
  if (myTie?.winner === me) myFate = `${career.country_name} venceu e avançou.`;
  else if (myTie?.winner) myFate = `${career.country_name} foi eliminada nesta fase.`;
  else if (myTie) myFate = `${career.country_name} disputou, mas o vencedor não está registrado.`;

  const nextName = {
    wc_r32: 'oitavas de final',
    wc_r16: 'quartas de final',
    wc_qf: 'semifinais',
    wc_sf: 'final (vencedores) e disputa de 3º lugar (perdedores)',
    wc_third: 'encerrou a disputa do bronze',
  }[stageKey];

  const facts = [
    'Competição: Copa do Mundo FIFA 2026',
    `Escopo: término da fase — ${CUP_PHASE_LABEL[stageKey]}.`,
    ...phaseRulesLines(stage, true),
    'RESULTADOS DA FASE:',
    ...results,
    advancers.length ? `Avançaram: ${advancers.join(', ')}` : null,
    eliminated.length ? `Eliminados nesta fase: ${eliminated.join(', ')}` : null,
    myFate,
    `Próximo passo: ${nextName}.`,
  ].filter(Boolean);

  const extrasPhase = [
    '- Faça um balanço da fase (não crônica de um único jogo).',
    '- Mencione surpresas e classificados quando constarem nos fatos.',
    '- Situação da seleção do técnico, se houver dados.',
  ].join('\n') + '\n';
  const prompt = [
    stylePreamble(career.coach_name, extrasPhase),
    '',
    'TAREFA',
    `Escreva o resumo jornalístico do encerramento de ${CUP_PHASE_LABEL[stageKey]} da Copa.`,
    'Cubra: panorama dos resultados, quem avançou/eliminou, leitura do chaveamento e o que vem a seguir.',
    '',
    'FATOS',
    facts.join('\n'),
    '',
    'Escreva agora apenas a crônica.',
  ].join('\n');

  const summary = await callGpt(prompt, { maxTokens: 1000 });
  return {
    kind: 'phase',
    title: `Crônica — ${CUP_PHASE_LABEL[stageKey]}`,
    subtitle: 'Fim de fase · mata-mata',
    competition: 'Copa do Mundo FIFA 2026',
    summary,
    stageKey,
  };
}

/**
 * Crônica especial da final da Copa (jogo decisivo + campeão).
 */
export async function generateCupFinalSummary(db, careerId) {
  const career = loadCupCareer(db, careerId);
  const stage = db.prepare(
    "SELECT * FROM stages WHERE career_id = ? AND key = 'wc_final'",
  ).get(careerId);
  if (!stage) throw new Error('Final ainda não existe');

  const match = db.prepare(`
    SELECT m.*, s.name AS stage_name, s.key AS stage_key, s.kind AS stage_kind,
           s.confederation AS stage_conf
    FROM matches m JOIN stages s ON s.id = m.stage_id
    WHERE m.stage_id = ? AND m.career_id = ?
    ORDER BY m.id LIMIT 1
  `).get(stage.id, careerId);
  if (!match) throw new Error('Partida da final não encontrada');
  if (!match.played) throw new Error('A final ainda não foi jogada');

  const nameOf = (code) => countryName(db, code);
  const homeName = nameOf(match.home);
  const awayName = nameOf(match.away);
  const me = career.country_code;
  const events = loadEvents(db, match.id);
  const eventLines = describeEvents(events, nameOf);
  const scorers = events
    .filter((e) => e.type === 'goal')
    .map((e) => `${clockOf(e)} ${e.player_name ?? '?'} (${nameOf(e.team)})`);

  const winner = (() => {
    if (match.home_pens != null && match.away_pens != null) {
      return match.home_pens > match.away_pens ? match.home : match.away;
    }
    if (match.home_goals > match.away_goals) return match.home;
    if (match.away_goals > match.home_goals) return match.away;
    return null;
  })();
  const loser = winner === match.home ? match.away : winner === match.away ? match.home : null;

  const third = db.prepare(`
    SELECT m.* FROM matches m
    JOIN stages s ON s.id = m.stage_id
    WHERE m.career_id = ? AND s.key = 'wc_third' AND m.played = 1
    ORDER BY m.id DESC LIMIT 1
  `).get(careerId);

  let bronze = null;
  if (third) {
    if (third.home_pens != null) {
      bronze = third.home_pens > third.away_pens ? third.home : third.away;
    } else if (third.home_goals !== third.away_goals) {
      bronze = third.home_goals > third.away_goals ? third.home : third.away;
    }
  }

  const myNote = match.home === me || match.away === me
    ? `A seleção do técnico (${career.country_name}) disputou a final.`
    : `A seleção do técnico (${career.country_name}) não disputou a final.`
      + (winner === me ? '' : '');

  const facts = [
    'Competição: Copa do Mundo FIFA 2026 — FINAL',
    `Data: ${formatDateLabel(match.date)}${match.kickoff ? ` · ${match.kickoff} UTC` : ''}`,
    `Placar: ${homeName} ${formatScore(match)} ${awayName}`,
    winner ? `Campeão do mundo: ${nameOf(winner)}` : null,
    loser ? `Vice-campeão: ${nameOf(loser)}` : null,
    bronze ? `3º lugar: ${nameOf(bronze)}` : null,
    scorers.length ? `Gols: ${scorers.join('; ')}` : 'Gols: nenhum',
    eventLines.length ? `Linha do tempo:\n${eventLines.join('\n')}` : null,
    myNote,
    ...phaseRulesLines(stage, true),
  ].filter(Boolean);

  const extrasFinal = [
    '- Esta é a FINAL: tom solene de encerramento do mundial.',
    '- Destaque o campeão e os lances decisivos quando constarem nos fatos.',
    '- Mencione o 3º lugar apenas se estiver nos fatos.',
  ].join('\n') + '\n';
  const prompt = [
    stylePreamble(career.coach_name, extrasFinal),
    '',
    'TAREFA',
    'Escreva a crônica jornalística da final da Copa do Mundo FIFA 2026.',
    'Cubra: como foi a decisão, quem levantou a taça, leitura do jogo e o desfecho do torneio.',
    '',
    'FATOS',
    facts.join('\n'),
    '',
    'Escreva agora apenas a crônica.',
  ].join('\n');

  const summary = await callGpt(prompt, { maxTokens: 1000 });
  return {
    kind: 'final',
    title: 'Crônica da final',
    subtitle: 'Copa do Mundo FIFA 2026',
    competition: 'Copa do Mundo FIFA 2026',
    summary,
    match: {
      id: match.id,
      home: match.home,
      away: match.away,
      home_name: homeName,
      away_name: awayName,
      home_goals: match.home_goals,
      away_goals: match.away_goals,
      home_pens: match.home_pens,
      away_pens: match.away_pens,
      extra_time: !!match.extra_time,
      dateLabel: formatDateLabel(match.date),
      stage_name: match.stage_name,
      group_name: null,
    },
    champion: winner,
    runnerUp: loser,
    third: bronze,
  };
}
