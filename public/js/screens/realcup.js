import { api, teamIndex } from '../api.js';
import { esc, html, toast } from '../ui.js';

/**
 * Atalho: Copa 2026 com as 48 seleções e grupos oficiais.
 * Nome do treinador + escolha de uma das 48 → vai direto à convocação da Copa.
 */
export async function realCupScreen({ state, go }) {
  const el = html(`
    <section class="screen screen--wide">
      <p class="loading">Carregando os grupos oficiais…</p>
    </section>
  `);

  let preview;
  let teams;
  try {
    [preview, teams] = await Promise.all([api.realWorldCupPreview(), teamIndex()]);
  } catch (err) {
    el.innerHTML = '';
    toast(err.message);
    return el;
  }

  let selected = null;
  let coachName = state.coachName ?? '';

  function flag(code) {
    const src = teams[code]?.flag;
    return src ? `<img class="tt__flag" src="/${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  }

  function render() {
    el.replaceChildren(html(`
      <section class="screen screen--wide realcup">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Copa do Mundo 2026 — grupos reais</h2>
            <p class="qual__meta">As 48 seleções classificadas, nos grupos oficiais. Sem eliminatórias nem sorteio.</p>
          </div>
          <button type="button" class="btn btn--ghost" data-back>← Voltar</button>
        </header>

        <form class="field-group realcup__form" novalidate>
          <div class="field">
            <label for="real-coach">Nome do treinador</label>
            <input id="real-coach" type="text" maxlength="40" autocomplete="off"
                   placeholder="Como você quer ser chamado?" required value="${esc(coachName)}">
          </div>
          <p class="realcup__pick">
            ${selected
              ? `Seleção: <b>${esc(teams[selected]?.name ?? selected)}</b>`
              : 'Escolha abaixo a seleção que você vai comandar'}
          </p>
          <button class="btn btn--primary" type="submit" ${selected ? '' : 'disabled'}>
            Começar a Copa →
          </button>
        </form>

        <div class="cup-groups realcup__groups" data-groups></div>
      </section>
    `));

    el.querySelector('[data-back]').addEventListener('click', () => go('coach'));

    const form = el.querySelector('form');
    const input = form.querySelector('#real-coach');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name.length < 2) {
        input.focus();
        return;
      }
      if (!selected) return toast('Escolha uma seleção');
      coachName = name;
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Preparando…';
      try {
        const res = await api.startRealWorldCup(name, selected);
        state.coachName = name;
        state.country = res.country_code;
        state.confederation = res.confederation;
        state.careerId = res.careerId;
        state.save();
        await go('cupsim');
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Começar a Copa →';
      }
    });

    const box = el.querySelector('[data-groups]');
    for (const g of preview.groups ?? []) {
      const block = html(`
        <div class="qual__block">
          <h3 class="qual__h3">Grupo ${esc(g.name)}</h3>
          <ul class="realcup__teams"></ul>
        </div>
      `);
      const list = block.querySelector('ul');
      for (const t of g.teams) {
        const li = html(`
          <li>
            <button type="button" class="realcup__team${selected === t.code ? ' is-on' : ''}"
                    data-code="${esc(t.code)}">
              ${flag(t.code)}
              <span>${esc(t.name)}</span>
              ${t.host ? '<small>anfitrião</small>' : ''}
            </button>
          </li>
        `);
        list.append(li);
      }
      box.append(block);
    }

    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-code]');
      if (!btn) return;
      selected = btn.dataset.code;
      coachName = input.value.trim();
      render();
      queueMicrotask(() => el.querySelector('#real-coach')?.focus());
    });
  }

  render();
  return el;
}
