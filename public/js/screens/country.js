import { api } from '../api.js';
import { html, esc, imgOrNothing, toast } from '../ui.js';

const MIN_POOL = 23; // sem 23 jogadores no banco não há convocação possível

/** Tela 3 — escolha do país dentro da confederação. */
export async function countryScreen({ state, go }) {
  const el = html(`
    <section class="screen">
      <h2 class="screen__title">Escolha sua seleção</h2>
      <p class="screen__subtitle" data-sub>Seleções da ${esc(state.confederation)}, por Ranking FIFA.</p>

      <div class="toolbar">
        <input type="search" placeholder="Buscar seleção…" data-search aria-label="Buscar seleção">
        <span class="toolbar__count" data-count></span>
      </div>

      <div class="grid teams" data-list><p class="loading">Carregando seleções…</p></div>
      <div data-panel></div>
    </section>
  `);

  const list = el.querySelector('[data-list]');
  const search = el.querySelector('[data-search]');
  const count = el.querySelector('[data-count]');
  const panel = el.querySelector('[data-panel]');

  let countries = [];
  let chosen = null;

  try {
    countries = await api.countries(state.confederation);
  } catch (err) {
    list.innerHTML = '<p class="loading">Não foi possível carregar as seleções.</p>';
    return toast(err.message), el;
  }

  function renderPanel() {
    panel.innerHTML = '';
    if (!chosen) return;

    const box = html(`
      <div class="selected">
        ${imgOrNothing(chosen.flag, 'flag', chosen.name)}
        ${imgOrNothing(chosen.badge, 'badge', 'Escudo da federação')}
        <div class="selected__body">
          <div class="selected__name">${esc(chosen.name)}</div>
          <div class="selected__info">
            ${chosen.fifa_rank ? `${chosen.fifa_rank}º no Ranking FIFA · ` : ''}
            força ${chosen.strength} · ${chosen.pool} jogadores disponíveis
            ${chosen.coach ? ` · técnico atual: ${esc(chosen.coach)}` : ''}
          </div>
        </div>
        <button class="btn btn--primary" data-confirm>Assumir a seleção →</button>
      </div>
    `);

    box.querySelector('[data-confirm]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Assinando contrato…';
      try {
        const career = await api.createCareer(state.coachName, chosen.code);
        state.careerId = career.id;
        state.country = chosen.code;
        go('squad');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Assumir a seleção →';
      }
    });
    panel.append(box);
  }

  function render() {
    const term = search.value.trim().toLowerCase();
    const shown = countries.filter(
      (c) => !term || c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term),
    );

    list.innerHTML = '';
    count.textContent = `${shown.length} de ${countries.length} seleções`;

    if (!shown.length) {
      list.innerHTML = '<p class="loading">Nenhuma seleção encontrada.</p>';
      return;
    }

    for (const c of shown) {
      const playable = c.pool >= MIN_POOL;
      const info = playable
        ? `${c.fifa_rank ? `<span class="rank">#${c.fifa_rank}</span>` : ''}<span>${c.pool} jogadores</span>`
        : '<span>elenco indisponível</span>';

      const btn = html(`
        <button class="team" ${playable ? '' : 'disabled'}
                aria-pressed="${chosen?.code === c.code}"
                title="${playable ? '' : 'Não há elenco público suficiente para convocar 23 jogadores'}">
          ${imgOrNothing(c.flag, 'team__flag', c.name) || '<div class="team__flag"></div>'}
          <div class="team__body">
            <div class="team__name">${esc(c.name)}</div>
            <div class="team__info">${info}</div>
          </div>
        </button>
      `);
      btn.addEventListener('click', () => {
        chosen = c;
        render();
        renderPanel();
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      list.append(btn);
    }
  }

  search.addEventListener('input', render);
  render();
  return el;
}
