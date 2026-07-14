/**
 * Regras de competição: sorteio, tabela de jogos e classificação.
 *
 * Os critérios de desempate seguem os regulamentos de verdade. Há três conjuntos:
 *
 *  - `fifa`    — eliminatórias FIFA / AFC / CAF / CONCACAF / CONMEBOL:
 *                saldo e gols do grupo TODO vêm antes do confronto direto;
 *                depois fair play (team conduct) e Ranking FIFA.
 *  - `uefa`    — a UEFA inverte: o confronto direto entre os empatados vem antes do saldo geral.
 *  - `wc2026`  — Copa do Mundo 2026: confronto direto primeiro, depois saldo/gols do grupo,
 *                team conduct score e Ranking FIFA.
 *
 * Em ambos, quando um critério separa parte do grupo, os que continuam empatados são
 * reavaliados só entre si (o confronto direto é recalculado no subgrupo menor).
 *
 * Fair play (FIFA Team Conduct Score): parte de 0; cartões descontam. Maior pontuação
 * (mais próxima de zero) classifica à frente.
 */

/* ------------------------------------------------------------------ *
 * Tabela de jogos
 * ------------------------------------------------------------------ */

/**
 * Turno único pelo método do círculo (round-robin de Berger).
 * Devolve um array de rodadas, cada uma com os confrontos [mandante, visitante].
 * O mando alterna de forma equilibrada: num grupo de 5, todo mundo faz 2 em casa e 2 fora.
 */
export function roundRobin(teams) {
  const list = [...teams];
  if (list.length % 2) list.push(null); // bye
  const n = list.length;
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null || b === null) continue; // quem pegou o bye folga
      // O par que envolve o time fixo alterna o mando a cada rodada; sem isso ele
      // jogaria sempre em casa e a tabela ficaria torta.
      matches.push(i === 0 && r % 2 === 1 ? [b, a] : [a, b]);
    }
    rounds.push(matches);
    list.splice(1, 0, list.pop()); // rotaciona mantendo o primeiro fixo
  }
  return rounds;
}

/** Turno e returno: o returno repete o turno com os mandos invertidos. */
export function doubleRoundRobin(teams) {
  const first = roundRobin(teams);
  return [...first, ...first.map((round) => round.map(([h, a]) => [a, h]))];
}

/* ------------------------------------------------------------------ *
 * Sorteios
 * ------------------------------------------------------------------ */

const GROUP_NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Sorteio de grupos por potes, como o da FIFA: os times entram em potes segundo o
 * Ranking FIFA (pote 1 = os melhores) e cada grupo recebe um time de cada pote.
 *
 * Quando o número de times não divide certinho, os primeiros grupos ficam maiores e são
 * eles que recebem o pote incompleto — o dos piores ranqueados. (Ex.: a UEFA tem 55
 * seleções em 12 grupos: 7 grupos de 5 e 5 de 4.)
 *
 * `teams` precisa vir ordenado do melhor para o pior ranqueado.
 */
export function drawGroups(teams, groupCount, rng) {
  const size = Math.floor(teams.length / groupCount);
  const bigger = teams.length % groupCount; // quantos grupos ganham um time a mais
  const groups = Array.from({ length: groupCount }, (_, i) => ({
    name: GROUP_NAMES[i],
    teams: [],
    pots: {},
  }));

  for (let pot = 0; pot < size; pot++) {
    const drawn = rng.shuffle(teams.slice(pot * groupCount, (pot + 1) * groupCount));
    drawn.forEach((team, i) => {
      groups[i].teams.push(team);
      groups[i].pots[team] = pot + 1;
    });
  }
  // Pote incompleto: só os grupos maiores recebem.
  if (bigger) {
    const drawn = rng.shuffle(teams.slice(size * groupCount));
    drawn.forEach((team, i) => {
      groups[i].teams.push(team);
      groups[i].pots[team] = size + 1;
    });
  }
  return groups;
}

/**
 * Sorteio de mata-mata em dois potes: os melhores ranqueados enfrentam os piores,
 * e o cabeça de chave decide em casa (ou faz a volta em casa, nos confrontos de ida e volta).
 * `teams` ordenado do melhor para o pior.
 */
export function drawKnockout(teams, rng) {
  const half = teams.length / 2;
  const seeded = rng.shuffle(teams.slice(0, half));
  const unseeded = rng.shuffle(teams.slice(half));
  return seeded.map((seed, i) => [seed, unseeded[i]]);
}

/**
 * Chaveamento por índice: 1º x último, 2º x penúltimo, e assim por diante.
 * É o formato das semifinais da repescagem africana e da intercontinental.
 * `teams` ordenado do melhor para o pior.
 */
export function seedPairs(teams) {
  return teams.slice(0, teams.length / 2).map((team, i) => [team, teams[teams.length - 1 - i]]);
}

/* ------------------------------------------------------------------ *
 * Fair play / Team Conduct Score (regulamento FIFA)
 * ------------------------------------------------------------------ */

/**
 * Deduzido por jogador/partida (só um desconto vale):
 *  - amarelo: −1
 *  - vermelho indireto (2 amarelos): −3
 *  - vermelho direto: −4
 *  - amarelo + vermelho direto: −5
 */
export function conductDeduction(yellows, reds, { straight = false } = {}) {
  if (reds > 0) {
    if (straight && yellows >= 1) return -5;
    if (straight || yellows === 0) return -4;
    return -3; // segundo amarelo → vermelho
  }
  if (yellows >= 2) return -3;
  if (yellows === 1) return -1;
  return 0;
}

/**
 * Soma o team conduct score por seleção a partir dos eventos de cartão.
 * `events`: `{ match_id, team, type, player_id, meta }` com team = código FIFA.
 * Parte de 0; cartões só descontam. Maior (menos negativo) = melhor.
 */
export function conductScoresFromEvents(events) {
  const perPlayerMatch = new Map();

  for (const e of events ?? []) {
    if (e.type !== 'yellow' && e.type !== 'red') continue;
    if (!e.team || !e.player_id) continue;
    const key = `${e.match_id}|${e.player_id}`;
    const cur = perPlayerMatch.get(key) ?? {
      team: e.team, yellows: 0, reds: 0, straight: false,
    };
    if (e.type === 'yellow') cur.yellows += 1;
    if (e.type === 'red') {
      cur.reds += 1;
      let meta = e.meta;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = null; }
      }
      if (meta?.reason === 'straight' || meta?.straight) cur.straight = true;
    }
    perPlayerMatch.set(key, cur);
  }

  const scores = {};
  for (const { team, yellows, reds, straight } of perPlayerMatch.values()) {
    scores[team] = (scores[team] ?? 0) + conductDeduction(yellows, reds, { straight });
  }
  return scores;
}

/* ------------------------------------------------------------------ *
 * Classificação
 * ------------------------------------------------------------------ */

/** Linha zerada da tabela. */
const emptyRow = (code) => ({
  code, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0, fair_play: 0,
});

/** Monta as linhas da tabela a partir dos jogos já disputados. */
export function tableRows(teams, matches) {
  const rows = new Map(teams.map((code) => [code, emptyRow(code)]));

  for (const m of matches) {
    if (!m.played) continue;
    const home = rows.get(m.home);
    const away = rows.get(m.away);
    if (!home || !away) continue; // jogo de outro grupo

    home.played++; away.played++;
    home.gf += m.home_goals; home.ga += m.away_goals;
    away.gf += m.away_goals; away.ga += m.home_goals;

    if (m.home_goals > m.away_goals) { home.won++; away.lost++; home.points += 3; }
    else if (m.home_goals < m.away_goals) { away.won++; home.lost++; away.points += 3; }
    else { home.drawn++; away.drawn++; home.points++; away.points++; }
  }

  for (const row of rows.values()) row.gd = row.gf - row.ga;
  return [...rows.values()];
}

/** Mini-tabela considerando apenas os jogos entre os times de `subset`. */
function headToHead(subset, matches) {
  const codes = new Set(subset.map((r) => r.code));
  const only = matches.filter((m) => codes.has(m.home) && codes.has(m.away));
  const rows = new Map(tableRows([...codes], only).map((r) => [r.code, r]));
  return rows;
}

/**
 * Critérios, do mais forte para o mais fraco. Cada um devolve um número — maior é melhor —
 * e recebe o subgrupo empatado, porque o confronto direto depende de quem ainda está empatado.
 */
const CRITERIA = {
  fifa: [
    (r) => r.points,
    (r) => r.gd,
    (r) => r.gf,
    (r, h2h) => h2h.get(r.code).points,
    (r, h2h) => h2h.get(r.code).gd,
    (r, h2h) => h2h.get(r.code).gf,
    (r) => r.fair_play ?? 0,
  ],
  /** Ordem oficial da Copa 2026 (regulamento FWC26). */
  wc2026: [
    (r) => r.points,
    (r, h2h) => h2h.get(r.code).points,
    (r, h2h) => h2h.get(r.code).gd,
    (r, h2h) => h2h.get(r.code).gf,
    (r) => r.gd,
    (r) => r.gf,
    (r) => r.fair_play ?? 0,
  ],
  uefa: [
    (r) => r.points,
    (r, h2h) => h2h.get(r.code).points,
    (r, h2h) => h2h.get(r.code).gd,
    (r, h2h) => h2h.get(r.code).gf,
    (r) => r.gd,
    (r) => r.gf,
    (r) => r.won,
    (r) => r.fair_play ?? 0,
  ],
};

/**
 * Ordena um grupo aplicando os critérios em cascata.
 *
 * Quando um critério parte o grupo em blocos, cada bloco que continua empatado é
 * reavaliado do começo — e o confronto direto é recalculado só entre os que sobraram.
 *
 * Depois do fair play, `ranks` (código → posição no Ranking FIFA) é o desempate final.
 */
export function sortTable(rows, matches, { tiebreak = 'fifa', ranks = {} } = {}) {
  const criteria = CRITERIA[tiebreak] ?? CRITERIA.fifa;

  const resolve = (subset) => {
    if (subset.length <= 1) return subset;

    const h2h = headToHead(subset, matches);
    for (const criterion of criteria) {
      const buckets = new Map();
      for (const row of subset) {
        const value = criterion(row, h2h);
        if (!buckets.has(value)) buckets.set(value, []);
        buckets.get(value).push(row);
      }
      if (buckets.size === 1) continue; // ninguém separou; próximo critério

      return [...buckets.entries()]
        .sort((a, b) => b[0] - a[0])
        .flatMap(([, bucket]) => resolve(bucket));
    }

    // Empate total após fair play: Ranking FIFA (na vida real seria o sorteio).
    return [...subset].sort(
      (a, b) => (ranks[a.code] ?? 999) - (ranks[b.code] ?? 999) || a.code.localeCompare(b.code),
    );
  };

  return resolve(rows).map((row, i) => ({ ...row, position: i + 1 }));
}

/** Tabela pronta de um grupo: monta as linhas e ordena. */
export function standings(teams, matches, options = {}) {
  const rows = tableRows(teams, matches);
  const fairPlay = options.fairPlay
    ?? (options.events ? conductScoresFromEvents(options.events) : {});
  for (const row of rows) row.fair_play = fairPlay[row.code] ?? 0;
  return sortTable(rows, matches, options);
}

/**
 * Ranking entre times de grupos diferentes — os "melhores segundos/terceiros".
 *
 * Critério FIFA (Copa 2026 para 3ºs): pts → SG → GP → fair play → Ranking FIFA.
 * A FIFA descarta os jogos contra o último colocado quando os grupos têm tamanhos
 * diferentes; aqui os grupos da Copa têm o mesmo tamanho.
 */
export function rankAcrossGroups(rows, { ranks = {} } = {}) {
  return [...rows].sort(
    (a, b) =>
      b.points - a.points ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      (b.fair_play ?? 0) - (a.fair_play ?? 0) ||
      (ranks[a.code] ?? 999) - (ranks[b.code] ?? 999) ||
      a.code.localeCompare(b.code),
  );
}
