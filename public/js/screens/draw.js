import { api, teamIndex } from '../api.js';
import { esc, html, toast } from '../ui.js';

/**
 * Fase 7 — sorteio dos grupos. O jogador só assiste.
 */
export async function drawScreen({ state, go }) {
  const el = html(`<section class="screen screen--wide" data-draw>
    <p class="loading">Preparando o sorteio…</p>
  </section>`);

  let preview;
  let teams;
  try {
    [preview, teams] = await Promise.all([
      api.drawPreview(state.careerId),
      teamIndex(),
    ]);
  } catch (err) {
    el.innerHTML = '';
    toast(err.message);
    return el;
  }

  if (preview.drawn && preview.groups) {
    renderResult(preview);
    return el;
  }

  el.replaceChildren(html(`
    <section class="screen screen--wide draw">
      <header class="qual__head">
        <div>
          <h2 class="screen__title">Sorteio da Copa do Mundo 2026</h2>
          <p class="qual__meta">Potes oficiais FIFA · Ranking do banco · você só assiste</p>
        </div>
      </header>

      <div class="draw__pots" data-pots></div>

      <div class="draw__stage" data-stage>
        <p class="screen__subtitle">Os 48 classificados estão nos potes. Clique para iniciar o sorteio.</p>
        <button class="btn btn--primary" data-start>Iniciar sorteio</button>
      </div>

      <div class="draw__groups" data-groups hidden></div>
      <div class="draw__actions" data-actions hidden></div>
    </section>
  `));

  const potsEl = el.querySelector('[data-pots]');
  potsEl.innerHTML = preview.pots.map((p) => `
    <div class="draw-pot" data-pot="${p.pot}">
      <h3>Pote ${p.pot}</h3>
      <ul>
        ${p.teams.map((t) => `
          <li data-code="${esc(t.code)}"${t.code === preview.playerCountry ? ' data-mine' : ''}>
            ${t.flag ? `<img src="/${esc(t.flag)}" alt="" loading="lazy">` : ''}
            <span>${esc(t.name)}</span>
            <small>#${t.fifa_rank ?? '—'}</small>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('');

  const groupsEl = el.querySelector('[data-groups]');
  groupsEl.innerHTML = 'ABCDEFGHIJKL'.split('').map((g) => `
    <div class="draw-group" data-group="${g}">
      <h3>Grupo ${g}</h3>
      <ol data-slots>
        <li></li><li></li><li></li><li></li>
      </ol>
    </div>
  `).join('');

  el.querySelector('[data-start]').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Sorteando…';
    try {
      const result = await api.runDraw(state.careerId);
      groupsEl.hidden = false;
      el.querySelector('[data-stage]').hidden = true;
      await animateDraw(result);
      el.querySelector('[data-actions]').hidden = false;
      el.querySelector('[data-actions]').replaceChildren(
        (() => {
          const btn = html('<button class="btn btn--primary">Ir para a Copa</button>');
          btn.addEventListener('click', () => go('cupsim'));
          return btn;
        })(),
      );
    } catch (err) {
      toast(err.message);
      ev.target.disabled = false;
      ev.target.textContent = 'Iniciar sorteio';
    }
  });

  async function animateDraw(result) {
    const steps = result.steps ?? [];
    for (const step of steps) {
      const potLi = potsEl.querySelector(`[data-code="${step.code || step.team}"]`);
      if (potLi) potLi.classList.add('is-drawn');

      const group = groupsEl.querySelector(`[data-group="${step.group}"]`);
      const slot = group?.querySelectorAll('li')[step.position - 1];
      if (slot) {
        const mine = step.code === preview.playerCountry || step.team === preview.playerCountry;
        slot.innerHTML = `
          ${step.flag ? `<img src="/${esc(step.flag)}" alt="">` : ''}
          <span>${esc(step.name ?? step.code ?? step.team)}</span>
        `;
        slot.classList.add('is-filled');
        if (mine) {
          slot.classList.add('is-mine');
          group.classList.add('is-mine-group');
        }
        group.classList.add('is-active');
        await sleep(mine ? 900 : 280);
        group.classList.remove('is-active');
      }
    }
  }

  function renderResult(data) {
    el.replaceChildren(html(`
      <section class="screen screen--wide draw">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Grupos da Copa</h2>
            <p class="qual__meta">Sorteio já realizado</p>
          </div>
        </header>
        <div class="draw__groups" data-groups></div>
        <div class="draw__actions">
          <button class="btn btn--primary" data-go>Continuar para a Copa</button>
        </div>
      </section>
    `));
    const box = el.querySelector('[data-groups]');
    box.innerHTML = (data.groups ?? []).map((g) => `
      <div class="draw-group${g.mine ? ' is-mine-group' : ''}">
        <h3>Grupo ${esc(g.name)}</h3>
        <ol>
          ${(g.teams ?? []).map((t) => `
            <li class="is-filled${t.code === data.playerCountry ? ' is-mine' : ''}">
              ${t.flag ? `<img src="/${esc(t.flag)}" alt="">` : ''}
              <span>${esc(t.name)}</span>
            </li>
          `).join('')}
        </ol>
      </div>
    `).join('');
    el.querySelector('[data-go]').addEventListener('click', () => go('cupsim'));
  }

  void teams;
  return el;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
