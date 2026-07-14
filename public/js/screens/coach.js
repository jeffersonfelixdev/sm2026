import { html } from '../ui.js';

/** Tela 1 — nome do treinador. */
export function coachScreen({ state, go }) {
  const el = html(`
    <section class="screen hero">
      <div class="hero__inner">
        <h1 class="hero__logo">SM2026</h1>
        <p class="hero__tagline">
          Assuma uma das <strong>211 seleções filiadas à FIFA</strong> e conduza-a pelas
          <strong>Eliminatórias</strong> até a Copa do Mundo de 2026.<br>
          Só quem passar pelo caminho joga o torneio.
        </p>

        <form class="field-group" novalidate>
          <div class="field">
            <label for="coach">Nome do treinador</label>
            <input id="coach" name="coach" type="text" maxlength="40" autocomplete="off"
                   placeholder="Como você quer ser chamado?" required>
          </div>
          <button class="btn btn--primary btn--block" type="submit">Começar carreira →</button>
        </form>

        <div class="hero__alt">
          <p class="hero__alt-label">Ou pule direto para o torneio</p>
          <button type="button" class="btn btn--ghost btn--block" data-realcup>
            Simular a Copa 2026 com os grupos reais
          </button>
        </div>

        <p class="footnote">
          Dados públicos: seleções, elencos e Ranking FIFA da Wikipédia; bandeiras do Wikimedia
          Commons; escudos das federações da TheSportsDB.
        </p>
      </div>
    </section>
  `);

  const input = el.querySelector('#coach');
  input.value = state.coachName ?? '';

  el.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name.length < 2) {
      input.focus();
      input.reportValidity?.();
      return;
    }
    state.coachName = name;
    go('confederation');
  });

  el.querySelector('[data-realcup]').addEventListener('click', () => {
    const name = input.value.trim();
    if (name.length >= 2) state.coachName = name;
    go('realcup');
  });

  queueMicrotask(() => input.focus());
  return el;
}
