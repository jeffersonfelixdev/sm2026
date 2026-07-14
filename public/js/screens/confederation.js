import { api } from '../api.js';
import { html, esc, imgOrNothing, toast } from '../ui.js';

/** Tela 2 — escolha da confederação. */
export async function confederationScreen({ state, go }) {
  const el = html(`
    <section class="screen">
      <h2 class="screen__title">Escolha a confederação</h2>
      <p class="screen__subtitle">
        Cada confederação tem seu próprio formato de Eliminatórias e um número de vagas na Copa.
        É por ela que passa o seu caminho até o torneio.
      </p>
      <div class="grid" data-list><p class="loading">Carregando confederações…</p></div>
    </section>
  `);

  const list = el.querySelector('[data-list]');

  try {
    const confederations = await api.confederations();
    list.innerHTML = '';

    for (const c of confederations) {
      // Ex.: 6.5 vaga = 6 diretas + 1 na repescagem intercontinental
      const direct = Math.floor(c.wc_slots);
      const playoff = c.wc_slots % 1 !== 0;
      const slots = `${direct} vaga${direct > 1 ? 's' : ''} direta${direct > 1 ? 's' : ''}` +
        (playoff ? ' + repescagem' : '');

      const card = html(`
        <button class="card" style="--card-color:${esc(c.color)}" data-code="${esc(c.code)}">
          <div class="card__head">
            ${imgOrNothing(c.logo, 'card__logo', c.code)}
            <div>
              <div class="card__name">${esc(c.code)}</div>
              <div class="card__region">${esc(c.region)}</div>
            </div>
          </div>
          <div class="card__region">${esc(c.full_name)}</div>
          <div class="card__meta">
            <span><b>${c.teams}</b> seleções</span>
            <span><b>${esc(slots)}</b> na Copa</span>
          </div>
        </button>
      `);
      card.addEventListener('click', () => {
        state.confederation = c.code;
        go('country');
      });
      list.append(card);
    }
  } catch (err) {
    list.innerHTML = '<p class="loading">Não foi possível carregar as confederações.</p>';
    toast(err.message);
  }

  return el;
}
