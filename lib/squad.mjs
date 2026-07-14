/**
 * Regras de convocação. O front valida junto, mas quem manda é o servidor.
 */
export const SQUAD_RULES = {
  size: 23,
  min: { GK: 3, DF: 6, MF: 5, FW: 3 },
};

/**
 * A melhor convocação legal possível de um elenco: preenche os mínimos por posição com os
 * melhores de cada uma e completa com os melhores que sobraram, sem olhar posição.
 *
 * Serve de régua para medir a convocação do jogador — é a escolha que um treinador que só
 * olha o overall faria.
 */
export function bestSquad(players) {
  const pool = [...players].sort((a, b) => b.overall - a.overall);
  const need = { ...SQUAD_RULES.min };
  const picked = new Set();

  for (const p of pool) {
    if (need[p.position] > 0) {
      need[p.position]--;
      picked.add(p);
    }
  }
  for (const p of pool) {
    if (picked.size >= SQUAD_RULES.size) break;
    picked.add(p);
  }
  return [...picked];
}

/** Overall médio de um grupo de jogadores. */
export const averageOverall = (players) =>
  players.length ? players.reduce((sum, p) => sum + p.overall, 0) / players.length : 0;
