import { api } from '../api.js';
import { html, esc, toast, overallTier, POSITION_ORDER, POSITION_LABEL } from '../ui.js';

const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2', '3-4-3', '5-3-2'];
const POS_COLOR = { GK: 'var(--gk)', DF: 'var(--df)', MF: 'var(--mf)', FW: 'var(--fw)' };

/** Tela 4 — convocação do elenco. */
export async function squadScreen({ state, go }) {
  const el = html(`
    <section class="screen screen--wide">
      <h2 class="screen__title">Convocação</h2>
      <p class="screen__subtitle" data-sub>Carregando elenco…</p>
      <div class="squad-layout">
        <div>
          <div class="toolbar">
            <div class="chips" data-filters></div>
            <input type="search" placeholder="Buscar jogador ou clube…" data-search aria-label="Buscar jogador">
          </div>
          <div class="pool" data-pool><p class="loading">Carregando jogadores…</p></div>
        </div>
        <aside class="side" data-side></aside>
      </div>
    </section>
  `);

  const poolEl = el.querySelector('[data-pool]');
  const sideEl = el.querySelector('[data-side]');
  const filtersEl = el.querySelector('[data-filters]');
  const searchEl = el.querySelector('[data-search]');

  let players = [];
  let rules = { size: 23, min: { GK: 3, DF: 6, MF: 5, FW: 3 } };
  let country = null;
  const picked = new Map(); // id → jogador, na ordem de convocação
  let filter = 'ALL';
  let captainId = null;
  let formation = FORMATIONS[0];

  try {
    [country, { players, rules }] = await Promise.all([
      api.country(state.country),
      api.players(state.country),
    ]);
  } catch (err) {
    poolEl.innerHTML = '<p class="loading">Não foi possível carregar o elenco.</p>';
    return toast(err.message), el;
  }

  el.querySelector('[data-sub]').innerHTML =
    `Escolha <strong>${rules.size}</strong> jogadores entre os ${players.length} disponíveis para ` +
    `${esc(country.name)}. Mínimos por posição: ` +
    POSITION_ORDER.map((p) => `${rules.min[p]} ${p}`).join(', ') + '.';

  const countBy = (pos) => [...picked.values()].filter((p) => p.position === pos).length;
  const isValid = () =>
    picked.size === rules.size && POSITION_ORDER.every((p) => countBy(p) >= rules.min[p]);

  /* ---------------------------------------------------------- filtros */
  for (const key of ['ALL', ...POSITION_ORDER]) {
    const chip = html(
      `<button class="chip" aria-pressed="${key === 'ALL'}" data-key="${key}">
         ${key === 'ALL' ? 'Todos' : POSITION_LABEL[key]}
       </button>`,
    );
    chip.addEventListener('click', () => {
      filter = key;
      filtersEl.querySelectorAll('.chip').forEach((c) =>
        c.setAttribute('aria-pressed', String(c.dataset.key === key)));
      renderPool();
    });
    filtersEl.append(chip);
  }

  /* ---------------------------------------------------------- lista de jogadores */
  function renderPool() {
    const term = searchEl.value.trim().toLowerCase();
    const shown = players.filter((p) => {
      if (filter !== 'ALL' && p.position !== filter) return false;
      if (!term) return true;
      return p.name.toLowerCase().includes(term) || (p.club ?? '').toLowerCase().includes(term);
    });

    poolEl.innerHTML = '';
    if (!shown.length) {
      poolEl.innerHTML = '<p class="loading">Nenhum jogador encontrado.</p>';
      return;
    }

    for (const p of shown) {
      const on = picked.has(p.id);
      const row = html(`
        <button class="player" aria-pressed="${on}" data-id="${p.id}">
          <span class="player__ov" data-tier="${overallTier(p.overall)}">${p.overall}</span>
          <span class="pos" data-pos="${p.position}">${p.position}</span>
          <span>
            <span class="player__name">${esc(p.name)}</span>
            <span class="player__club">${esc(p.club ?? 'sem clube')}${p.age ? ` · ${p.age} anos` : ''}</span>
          </span>
          <span class="player__stats"><b>${p.caps}</b> jogos<br><b>${p.goals}</b> gols</span>
          ${p.source === 'squad'
            ? '<span class="player__tag" title="Estava na última convocação oficial da seleção">ÚLTIMA LISTA</span>'
            : '<span></span>'}
        </button>
      `);
      row.addEventListener('click', () => toggle(p));
      poolEl.append(row);
    }
  }

  function toggle(player) {
    if (picked.has(player.id)) {
      picked.delete(player.id);
      if (captainId === player.id) captainId = null;
    } else {
      if (picked.size >= rules.size) {
        return toast(`A convocação já tem ${rules.size} jogadores. Corte alguém para incluir outro.`);
      }
      picked.set(player.id, player);
    }
    renderPool();
    renderSide();
  }

  /* ---------------------------------------------------------- painel lateral */
  function renderSide() {
    const full = picked.size === rules.size;

    sideEl.innerHTML = '';
    sideEl.append(html(`
      <div class="side__count ${full ? 'is-full' : ''}">
        <b>${picked.size}</b> <span>de ${rules.size} convocados</span>
      </div>
    `));

    const quota = html('<div class="quota"></div>');
    for (const pos of POSITION_ORDER) {
      const n = countBy(pos);
      const min = rules.min[pos];
      const pct = Math.min(100, (n / Math.max(min, 1)) * 100);
      quota.append(html(`
        <div class="quota__row ${n >= min ? 'is-ok' : 'is-short'}">
          <span class="pos" data-pos="${pos}">${pos}</span>
          <span class="quota__bar">
            <span class="quota__fill" style="width:${pct}%;background:${POS_COLOR[pos]}"></span>
          </span>
          <span class="quota__n">${n}/${min}</span>
        </div>
      `));
    }
    sideEl.append(quota);

    // lista de convocados
    const list = html('<div class="side__list"></div>');
    if (!picked.size) {
      list.append(html('<p class="side__empty">Ninguém convocado ainda.<br>Clique nos jogadores à esquerda.</p>'));
    } else {
      const ordered = [...picked.values()].sort(
        (a, b) => POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position) ||
                  b.overall - a.overall,
      );
      for (const p of ordered) {
        const row = html(`
          <div class="side__player">
            <span class="pos" data-pos="${p.position}">${p.position}</span>
            <span>${esc(p.name)}${captainId === p.id ? ' <b title="Capitão">(C)</b>' : ''}</span>
            <button title="Cortar da convocação" aria-label="Cortar ${esc(p.name)}">×</button>
          </div>
        `);
        row.querySelector('button').addEventListener('click', () => toggle(p));
        list.append(row);
      }
    }
    sideEl.append(list);

    // capitão e formação
    const ordered = [...picked.values()];
    const captainOptions = ordered.length
      ? ordered.map((p) => `<option value="${p.id}" ${captainId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
      : '<option value="">— convoque jogadores primeiro —</option>';

    const controls = html(`
      <div>
        <div class="field">
          <label for="formation">Formação</label>
          <select id="formation">
            ${FORMATIONS.map((f) => `<option ${f === formation ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="captain">Capitão</label>
          <select id="captain" ${ordered.length ? '' : 'disabled'}>
            <option value="">— sem capitão —</option>
            ${ordered.length ? captainOptions : ''}
          </select>
        </div>
      </div>
    `);
    controls.querySelector('#formation').addEventListener('change', (e) => { formation = e.target.value; });
    controls.querySelector('#captain').addEventListener('change', (e) => {
      captainId = e.target.value ? Number(e.target.value) : null;
      renderSide();
    });
    sideEl.append(controls);

    const confirm = html(`
      <button class="btn btn--primary btn--block" ${isValid() ? '' : 'disabled'}>
        Confirmar convocação
      </button>
    `);
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      confirm.textContent = 'Registrando…';
      try {
        await api.saveSquad(state.careerId, {
          player_ids: [...picked.keys()],
          captain_id: captainId,
          formation,
        });
        go('ready');
      } catch (err) {
        toast(err.message);
        confirm.disabled = false;
        confirm.textContent = 'Confirmar convocação';
      }
    });
    sideEl.append(confirm);

    if (!isValid()) {
      const missing = POSITION_ORDER
        .filter((p) => countBy(p) < rules.min[p])
        .map((p) => `${rules.min[p] - countBy(p)} ${p}`);
      sideEl.append(html(`
        <p class="hint">
          ${picked.size < rules.size ? `Faltam ${rules.size - picked.size} jogadores. ` : ''}
          ${missing.length ? `Ainda é preciso: ${missing.join(', ')}.` : ''}
        </p>
      `));
    }
  }

  searchEl.addEventListener('input', renderPool);
  renderPool();
  renderSide();
  return el;
}
