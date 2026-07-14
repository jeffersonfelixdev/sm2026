/**
 * Calendário FIFA das Eliminatórias 2026.
 *
 * Usa as janelas oficiais do International Match Calendar (ciclo 2023–2025), não os
 * fixtures históricos de cada confederação. Cada matchday de uma fase consome a próxima
 * janela disponível a partir de um offset — assim UEFA md1 e CONMEBOL md1 caem na mesma
 * Data FIFA.
 */

/** Janelas do International Match Calendar com dias típicos de jogos. */
export const FIFA_WINDOWS = [
  { label: 'Setembro 2023', start: '2023-09-04', end: '2023-09-12', days: ['2023-09-07', '2023-09-10'] },
  { label: 'Outubro 2023', start: '2023-10-09', end: '2023-10-17', days: ['2023-10-12', '2023-10-15'] },
  { label: 'Novembro 2023', start: '2023-11-13', end: '2023-11-21', days: ['2023-11-16', '2023-11-19'] },
  { label: 'Janeiro 2024', start: '2024-01-08', end: '2024-01-16', days: ['2024-01-11', '2024-01-14'] },
  { label: 'Março 2024', start: '2024-03-18', end: '2024-03-26', days: ['2024-03-21', '2024-03-24'] },
  { label: 'Junho 2024', start: '2024-06-03', end: '2024-06-11', days: ['2024-06-06', '2024-06-09'] },
  { label: 'Setembro 2024', start: '2024-09-02', end: '2024-09-10', days: ['2024-09-05', '2024-09-08'] },
  { label: 'Outubro 2024', start: '2024-10-07', end: '2024-10-15', days: ['2024-10-10', '2024-10-13'] },
  { label: 'Novembro 2024', start: '2024-11-11', end: '2024-11-19', days: ['2024-11-14', '2024-11-17'] },
  { label: 'Março 2025', start: '2025-03-17', end: '2025-03-25', days: ['2025-03-20', '2025-03-23'] },
  { label: 'Junho 2025', start: '2025-06-02', end: '2025-06-10', days: ['2025-06-05', '2025-06-08'] },
  { label: 'Setembro 2025', start: '2025-09-01', end: '2025-09-09', days: ['2025-09-04', '2025-09-07'] },
  { label: 'Outubro 2025', start: '2025-10-06', end: '2025-10-14', days: ['2025-10-09', '2025-10-12'] },
  { label: 'Novembro 2025', start: '2025-11-10', end: '2025-11-18', days: ['2025-11-13', '2025-11-16'] },
  // Extra para caminhos longos (AFC) e repescagem — slots sintéticos no mesmo espírito.
  { label: 'Março 2026', start: '2026-03-16', end: '2026-03-24', days: ['2026-03-19', '2026-03-22'] },
  { label: 'Maio 2026', start: '2026-05-25', end: '2026-06-02', days: ['2026-05-28', '2026-05-31'] },
  { label: 'Extra A', start: '2026-01-12', end: '2026-01-20', days: ['2026-01-15', '2026-01-18'] },
  { label: 'Extra B', start: '2026-02-09', end: '2026-02-17', days: ['2026-02-12', '2026-02-15'] },
  { label: 'Extra C', start: '2025-12-08', end: '2025-12-16', days: ['2025-12-11', '2025-12-14'] },
  { label: 'Extra D', start: '2024-06-17', end: '2024-06-25', days: ['2024-06-20', '2024-06-23'] },
  { label: 'Extra E', start: '2025-06-16', end: '2025-06-24', days: ['2025-06-19', '2025-06-22'] },
  { label: 'Extra F', start: '2024-01-22', end: '2024-01-30', days: ['2024-01-25', '2024-01-28'] },
  { label: 'Extra G', start: '2025-04-14', end: '2025-04-22', days: ['2025-04-17', '2025-04-20'] },
  { label: 'Extra H', start: '2025-05-12', end: '2025-05-20', days: ['2025-05-15', '2025-05-18'] },
];

/** Flatten chronológico: cada dia de jogo do calendário, com a janela de origem. */
export function flatSlots() {
  const slots = [];
  FIFA_WINDOWS.forEach((w, wi) => {
    w.days.forEach((date, di) => {
      slots.push({ windowOrd: wi, date, dayIndex: di, label: w.label });
    });
  });
  return slots;
}

/** Grava as janelas FIFA de uma carreira (idempotente). */
export function seedWindows(db, careerId) {
  if (db.prepare('SELECT 1 FROM fifa_windows WHERE career_id = ? LIMIT 1').get(careerId)) return;

  const insert = db.prepare(
    `INSERT INTO fifa_windows (career_id, ord, label, start_date, end_date) VALUES (?, ?, ?, ?, ?)`,
  );
  FIFA_WINDOWS.forEach((w, i) => insert.run(careerId, i, w.label, w.start, w.end));
}

/**
 * Offset de slots: o primeiro slot livre APÓS a última data já usada pela carreira
 * (ou 0 se ainda não há jogos datados). Usado ao criar fases novas (playoffs etc.).
 */
export function nextSlotOffset(db, careerId) {
  const row = db.prepare(`
    SELECT MAX(date) AS last FROM matches WHERE career_id = ? AND date IS NOT NULL
  `).get(careerId);
  if (!row?.last) return 0;

  const slots = flatSlots();
  const idx = slots.findIndex((s) => s.date === row.last);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Offset específico de uma confederação: slots depois da última data DETAS partidas.
 * Assim a UEFA não espera a CONMEBOL terminar para jogar os playoffs.
 */
export function confederationSlotOffset(db, careerId, confederation) {
  const row = confederation == null
    ? db.prepare(`
        SELECT MAX(m.date) AS last FROM matches m
        JOIN stages s ON s.id = m.stage_id
        WHERE m.career_id = ? AND s.confederation IS NULL AND m.date IS NOT NULL
      `).get(careerId)
    : db.prepare(`
        SELECT MAX(m.date) AS last FROM matches m
        JOIN stages s ON s.id = m.stage_id
        WHERE m.career_id = ? AND s.confederation = ? AND m.date IS NOT NULL
      `).get(careerId, confederation);

  if (!row?.last) return 0;
  const slots = flatSlots();
  const idx = slots.findIndex((s) => s.date === row.last);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * Atribui datas às partidas de uma fase recém-criada.
 * Matchday 1 → slot[offset], matchday 2 → slot[offset+1], …
 * Dentro do mesmo matchday, todos os jogos compartilham a data.
 */
export function assignStageDates(db, careerId, stageId, confederation) {
  const slots = flatSlots();
  const offset = confederationSlotOffset(db, careerId, confederation);

  const matchdays = db.prepare(`
    SELECT DISTINCT matchday FROM matches WHERE stage_id = ? ORDER BY matchday
  `).all(stageId);

  const update = db.prepare('UPDATE matches SET date = ? WHERE stage_id = ? AND matchday = ?');
  matchdays.forEach((row, i) => {
    const slot = slots[offset + i] ?? slots[slots.length - 1];
    update.run(slot.date, stageId, row.matchday);
  });
}

/** Janela FIFA que contém a data (ou null). */
export function windowForDate(date) {
  const wi = FIFA_WINDOWS.findIndex((w) => date >= w.start && date <= w.end);
  if (wi >= 0) return { ...FIFA_WINDOWS[wi], ord: wi };
  // Datas dos slots "Extra" fora do range start/end — buscar pelo dia.
  const slots = flatSlots();
  const hit = slots.find((s) => s.date === date);
  if (!hit) return null;
  const w = FIFA_WINDOWS[hit.windowOrd];
  return { ...w, ord: hit.windowOrd };
}

/** Datas de jogo dentro de uma janela, em ordem. */
export function datesInWindow(ord) {
  return FIFA_WINDOWS[ord]?.days ?? [];
}

/** Formata rótulo amigável da data. */
export function formatDateLabel(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${d} ${months[m - 1]} ${y}`;
}
