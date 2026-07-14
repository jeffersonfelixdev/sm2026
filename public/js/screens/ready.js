import { api } from '../api.js';
import { html, esc, toast, overallTier, POSITION_ORDER, POSITION_LABEL } from '../ui.js';

/** Tela 5 — convocação confirmada; ponte para as Eliminatórias (próxima rodada). */
export async function readyScreen({ state, go }) {
  const el = html(`
    <section class="screen">
      <div class="done">
        <div class="done__icon">📋</div>
        <h2 class="screen__title">Convocação registrada</h2>
        <p class="screen__subtitle" data-sub></p>
      </div>
      <div data-squad><p class="loading">Carregando convocados…</p></div>
    </section>
  `);

  let career;
  try {
    career = await api.career(state.careerId);
  } catch (err) {
    toast(err.message);
    return el;
  }

  const media = career.squad.reduce((sum, p) => sum + p.overall, 0) / (career.squad.length || 1);

  el.querySelector('[data-sub]').innerHTML =
    `<strong>${esc(career.coach_name)}</strong> assume ${esc(career.country_name)} ` +
    `(${career.fifa_rank ? `${career.fifa_rank}º do mundo` : 'sem ranking'}) com ` +
    `${career.squad.length} convocados · formação ${esc(career.formation)} · ` +
    `overall médio ${media.toFixed(1)}`;

  const box = el.querySelector('[data-squad]');
  box.innerHTML = '';

  for (const pos of POSITION_ORDER) {
    const group = career.squad.filter((p) => p.position === pos);
    if (!group.length) continue;

    box.append(html(`<h3 class="screen__title" style="font-size:18px;margin:28px 0 4px">
        ${POSITION_LABEL[pos]} <span style="color:var(--muted);font-weight:400">(${group.length})</span>
      </h3>`));

    const grid = html('<div class="lineup"></div>');
    for (const p of group) {
      grid.append(html(`
        <div class="player" style="cursor:default">
          <span class="player__ov" data-tier="${overallTier(p.overall)}">${p.overall}</span>
          <span class="pos" data-pos="${p.position}">${p.position}</span>
          <span>
            <span class="player__name">${esc(p.name)}${career.captain_id === p.id ? ' <b title="Capitão">(C)</b>' : ''}</span>
            <span class="player__club">${esc(p.club ?? 'sem clube')}</span>
          </span>
          <span></span><span></span>
        </div>
      `));
    }
    box.append(grid);
  }

  box.append(html(`
    <div class="next">
      <h3>Próxima etapa: as Eliminatórias</h3>
      Com o elenco definido, ${esc(career.country_name)} entra nas Eliminatórias da
      ${esc(career.confederation)} — no formato oficial da confederação, com todas as partidas
      simuladas pelo jogo, inclusive as suas. Quem sobreviver ao caminho disputa a Copa do Mundo
      de 2026; os classificados saem da simulação, não da vida real.
      <br><br>
      A convocação pesa: a força da sua seleção nas partidas sai da média dos 23 que você
      levou, comparada com a melhor lista que daria para montar com esse elenco.
    </div>
  `));

  const start = html('<button class="btn btn--primary" style="margin-top:24px">Começar as Eliminatórias</button>');
  start.addEventListener('click', () => go('sim'));

  const again = html('<button class="btn btn--ghost" style="margin:24px 0 0 10px">Recomeçar carreira</button>');
  again.addEventListener('click', () => {
    state.reset();
    go('coach');
  });
  box.append(start, again);

  return el;
}
