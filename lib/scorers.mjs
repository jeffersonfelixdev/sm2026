/**
 * Ranking de artilheiros a partir de match_events (type = 'goal').
 * Eliminatórias: por confederação. Copa: quadro único (stages FIFA).
 */

const DEFAULT_LIMIT = 20;

function topScorers(db, careerId, confederation, limit = DEFAULT_LIMIT) {
  const rows = db.prepare(`
    SELECT e.player_id,
           p.name AS player_name,
           p.position,
           e.team AS team_code,
           COUNT(*) AS goals
    FROM match_events e
    JOIN matches m ON m.id = e.match_id
    JOIN stages s ON s.id = m.stage_id
    JOIN players p ON p.id = e.player_id
    WHERE s.career_id = ?
      AND s.confederation = ?
      AND e.type = 'goal'
      AND e.player_id IS NOT NULL
    GROUP BY e.player_id, e.team
    ORDER BY goals DESC, p.name ASC
    LIMIT ?
  `).all(careerId, confederation, limit);

  return rows.map((r, i) => ({
    position: i + 1,
    player_id: r.player_id,
    player_name: r.player_name,
    team_code: r.team_code,
    player_position: r.position,
    goals: r.goals,
  }));
}

/** Artilharia das Eliminatórias de uma confederação. */
export function scorersForConfederation(db, careerId, confederation, limit = DEFAULT_LIMIT) {
  if (!confederation) return [];
  return topScorers(db, careerId, confederation, limit);
}

/** Artilharia única da Copa do Mundo (todas as fases FIFA). */
export function worldCupScorers(db, careerId, limit = DEFAULT_LIMIT) {
  return topScorers(db, careerId, 'FIFA', limit);
}
