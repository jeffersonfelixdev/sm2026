import { api, teamIndex } from '../api.js';
import { esc, html, toast } from '../ui.js';

/**
 * Hub de tabelas / jogos da Copa (Fase 8 — pós cada dia de jogos).
 */
export async function worldCupScreen({ state, go }) {
  const el = html(`<section class="screen screen--wide"><p class="loading">Carregando a Copa…</p></section>`);

  let data;
  let teams;
  try {
    if (!(await api.drawPreview(state.careerId)).drawn) {
      await go('draw');
      return el;
    }
    [data, teams] = await Promise.all([api.worldCup(state.careerId), teamIndex()]);
  } catch (err) {
    el.innerHTML = '';
    toast(err.message);
    return el;
  }

  const name = (code) => teams[code]?.name ?? code;
  const flag = (code) => {
    const src = teams[code]?.flag;
    return src ? `<img class="tt__flag" src="/${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  };

  let tab = data.sim?.tablesTab === 'knockout' ? 'knockout' : 'groups';

  function render() {
    const sim = data.sim;
    const over = sim?.phase === 'done';

    el.replaceChildren(html(`
      <section class="screen screen--wide">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Copa do Mundo 2026</h2>
            <p class="qual__meta">
              ${data.playerQualified
                ? `${esc(data.career.country_name)} está na Copa`
                : `${esc(data.career.country_name)} acompanha como espectador`}
              ${sim?.stageLabel ? ` · <b>${esc(sim.stageLabel)}</b>` : ''}
              ${sim?.dateLabel ? ` · ${esc(sim.dateLabel)}` : ''}
            </p>
          </div>
          <div class="qual__actions" data-actions></div>
        </header>

        <nav class="chips qual__tabs" data-tabs>
          <button type="button" data-tab="groups" class="${tab === 'groups' ? 'is-on' : ''}">Grupos</button>
          <button type="button" data-tab="knockout" class="${tab === 'knockout' ? 'is-on' : ''}">Mata-mata</button>
          <button type="button" data-tab="fixtures" class="${tab === 'fixtures' ? 'is-on' : ''}">Jogos do dia</button>
        </nav>

        <div data-panel></div>
      </section>
    `));

    const actions = el.querySelector('[data-actions]');
    if (!over) {
      const cont = html('<button class="btn btn--primary">Continuar simulação</button>');
      cont.addEventListener('click', async () => {
        try {
          if (data.sim?.phase === 'post') {
            await api.cupContinue(state.careerId);
          }
          await go('cupsim');
        } catch (err) {
          toast(err.message);
        }
      });
      actions.append(cont);
    } else {
      actions.append(html('<p class="qual__meta">Torneio encerrado.</p>'));
    }

    el.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      tab = btn.dataset.tab;
      render();
    });

    const panel = el.querySelector('[data-panel]');
    if (tab === 'groups') panel.replaceChildren(renderGroups());
    else if (tab === 'knockout') panel.replaceChildren(renderKnockout());
    else panel.replaceChildren(renderFixtures());
  }

  function renderGroups() {
    const box = html('<div class="cup-groups"></div>');
    for (const g of data.groups ?? []) {
      const block = html(`
        <div class="qual__block${g.mine ? ' is-mine-block' : ''}" ${g.mine ? 'data-focus-group' : ''}>
          <h3 class="qual__h3">Grupo ${esc(g.name)}${g.mine ? ' <small>· a sua chave</small>' : ''}</h3>
          <table class="tt">
            <thead>
              <tr>
                <th>#</th><th>Seleção</th><th>J</th><th>V</th><th>E</th><th>D</th>
                <th>GP</th><th>GC</th><th>SG</th><th>Pts</th><th title="Fair play (team conduct)">FP</th>
              </tr>
            </thead>
            <tbody>
              ${(g.table ?? []).map((r) => `
                <tr class="${r.position <= 2 ? 'tt--up' : r.position === 3 ? 'tt--playoff' : ''}
                  ${r.code === state.country ? 'tt--mine' : ''}">
                  <td>${r.position}</td>
                  <td class="tt__team">${flag(r.code)}<span>${esc(name(r.code))}</span></td>
                  <td>${r.played}</td><td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
                  <td>${r.gf}</td><td>${r.ga}</td><td>${r.gd}</td><td><b>${r.points}</b></td>
                  <td>${r.fair_play ?? 0}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `);
      box.append(block);
    }
    queueMicrotask(() => {
      box.querySelector('[data-focus-group]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return box;
  }

  function renderKnockout() {
    const kos = (data.stages ?? []).filter((s) => s.kind === 'knockout');
    if (!kos.length) {
      return html('<p class="qual__note">O mata-mata começa após a fase de grupos.</p>');
    }

    const byKey = Object.fromEntries(kos.map((s) => [s.key, s]));
    const currentKey = data.sim?.stageKey;

    const ROUNDS = [
      { key: 'wc_r32', label: '16avos', count: 16 },
      { key: 'wc_r16', label: 'Oitavas', count: 8 },
      { key: 'wc_qf', label: 'Quartas', count: 4 },
      { key: 'wc_sf', label: 'Semis', count: 2 },
      { key: 'wc_final', label: 'Final', count: 1 },
    ];

    function padTies(key, count) {
      const ties = byKey[key]?.ties ?? [];
      return Array.from({ length: count }, (_, i) => ties[i] ?? null);
    }

    function sideHtml(code, winner) {
      if (!code || code === 'TBD') {
        return `<span class="bracket__side bracket__side--tbd"><span class="bracket__code">a definir</span></span>`;
      }
      const won = winner && code === winner;
      const mine = code === state.country;
      return `
        <span class="bracket__side${won ? ' is-won' : ''}${mine ? ' is-mine' : ''}">
          ${flag(code)}
          <span class="bracket__code" title="${esc(name(code))}">${esc(code)}</span>
        </span>`;
    }

    function slotHtml(tie) {
      if (!tie) {
        return `<div class="bracket__slot bracket__slot--empty">
          <span class="bracket__side bracket__side--tbd"><span class="bracket__code">a definir</span></span>
          <span class="bracket__side bracket__side--tbd"><span class="bracket__code">a definir</span></span>
        </div>`;
      }
      const leg = tie.legs?.[0];
      const played = !!leg?.played;
      const hasPens = played && leg.home_pens != null;
      const goals = (n) => `<span class="bracket__goals${!played ? ' bracket__goals--todo' : ''}">${played ? n : '·'}</span>`;
      const pens = (n) => hasPens ? `<span class="bracket__pens">(${n})</span>` : '';
      return `
        <div class="bracket__slot${tie.mine ? ' is-mine' : ''}${played ? ' is-played' : ''}">
          <div class="bracket__row">
            ${sideHtml(tie.home, tie.winner)}
            <span class="bracket__scoreline">${pens(leg?.home_pens)}${goals(leg?.home_goals)}</span>
          </div>
          <div class="bracket__row">
            ${sideHtml(tie.away, tie.winner)}
            <span class="bracket__scoreline">${pens(leg?.away_pens)}${goals(leg?.away_goals)}</span>
          </div>
        </div>`;
    }

    const roundsHtml = ROUNDS.map((r) => {
      const ties = padTies(r.key, r.count);
      const isCurrent = r.key === currentKey;
      // Só monta a coluna se a fase já existe ou se a anterior já avançou o suficiente
      // para o usuário antecipar o caminho — 16avos sempre (ou o primeiro KO existente).
      const exists = !!byKey[r.key];
      if (!exists && r.key !== 'wc_r32' && !byKey.wc_r32) return '';
      return `
        <div class="bracket__round${isCurrent ? ' is-current' : ''}" data-stage="${esc(r.key)}"
          ${isCurrent ? 'data-focus-stage' : ''}>
          <h3 class="bracket__title">${esc(r.label)}${isCurrent ? ' <small>atual</small>' : ''}</h3>
          <div class="bracket__list" style="--slots:${r.count}">
            ${ties.map(slotHtml).join('')}
          </div>
        </div>`;
    }).join('');

    const third = byKey.wc_third?.ties?.[0];
    const thirdHtml = third || byKey.wc_sf || byKey.wc_final ? `
      <div class="bracket__third${currentKey === 'wc_third' ? ' is-current' : ''}"
        ${currentKey === 'wc_third' ? 'data-focus-stage' : ''}>
        <h3 class="bracket__title">3º lugar</h3>
        ${slotHtml(third ?? null)}
      </div>` : '';

    const box = html(`
      <div class="cup-bracket-wrap">
        <div class="cup-bracket" data-bracket>
          ${roundsHtml}
        </div>
        ${thirdHtml}
      </div>
    `);

    queueMicrotask(() => {
      const focus = box.querySelector('[data-focus-stage]');
      focus?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    });
    return box;
  }

  function renderFixtures() {
    const day = data.sim?.dayMatches ?? [];
    if (!day.length) {
      return html('<p class="qual__note">Sem jogos neste dia.</p>');
    }
    const box = html(`
      <div class="qual__block">
        <h3 class="qual__h3">${esc(data.sim.dateLabel)}</h3>
        <div class="matches"></div>
      </div>
    `);
    const list = box.querySelector('.matches');
    for (const m of day) {
      const mine = m.home === state.country || m.away === state.country;
      const score = m.played
        ? `${m.home_goals}×${m.away_goals}`
        : '×';
      list.append(html(`
        <div class="match"${mine ? ' data-mine' : ''}>
          <span class="match__kick">${esc(m.kickoff ? `${m.kickoff} UTC` : '')}</span>
          <span class="match__team match__team--home">${esc(name(m.home))}${flag(m.home)}</span>
          <span class="match__score${!m.played ? ' match__score--todo' : ''}">${score}</span>
          <span class="match__team">${flag(m.away)}${esc(name(m.away))}</span>
          ${m.group ? `<span class="match__group">Grp ${esc(m.group)}</span>` : ''}
        </div>
      `));
    }
    return box;
  }

  try {
    render();
  } catch (err) {
    el.innerHTML = '';
    toast(err.message || 'Falha ao montar as tabelas');
  }
  return el;
}
