import { api, teamIndex } from '../api.js';
import { esc, html, toast } from '../ui.js';

/**
 * Hub de tabelas das Eliminatórias (pós-jogo / consulta).
 * O loop Data FIFA (convocação → live) vive em sim.js; daqui o jogador continua a simulação.
 */
export async function qualifiersScreen({ state, go }) {
  const teams = await teamIndex();

  const el = html(`
    <section class="screen screen--wide">
      <div data-outcome></div>
      <header class="qual__head">
        <div>
          <h2 class="screen__title" data-stage>Eliminatórias</h2>
          <p class="qual__meta" data-meta></p>
        </div>
        <div class="qual__actions" data-actions></div>
      </header>
      <div class="chips qual__tabs" data-tabs></div>
      <div data-panel><p class="loading">Sorteando o mundo…</p></div>
    </section>
  `);

  const [outcomeBox, stageTitle, meta, actions, tabs, panel] =
    ['[data-outcome]', '[data-stage]', '[data-meta]', '[data-actions]', '[data-tabs]', '[data-panel]']
      .map((sel) => el.querySelector(sel));

  let data;
  let round = null; // a rodada recém-jogada, quando o jogador acaba de avançar
  let tab = 'mine';
  let world = null; // carregado sob demanda, na primeira vez que a aba "Pelo mundo" abre
  let scorersConf = null; // confederação selecionada na aba Artilharia
  const scorersCache = {}; // conf → lista de artilheiros

  /* ---------------------------------------------------------------- helpers */

  const name = (code) => teams[code]?.name ?? code;
  const flag = (code) => {
    const src = teams[code]?.flag;
    return src ? `<img class="tt__flag" src="/${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  };

  /** Todas as partidas de uma fase, sejam elas de grupo ou de mata-mata. */
  const matchesOf = (stage) =>
    !stage ? []
      : stage.kind === 'groups' ? stage.groups.flatMap((g) => g.matches)
        : stage.ties.flatMap((t) => t.legs);

  const isMine = (m) => m.home === state.country || m.away === state.country;

  /** Placar de uma partida, com pênaltis e prorrogação quando houve. */
  function score(m) {
    if (!m.played) return '<span class="match__score match__score--todo">×</span>';
    const pens = m.home_pens != null ? `<small>(${m.home_pens}–${m.away_pens})</small>` : '';
    const aet = !pens && m.extra_time ? '<small>pror.</small>' : '';
    return `<span class="match__score">${pens}${m.home_goals}<i>-</i>${m.away_goals}${aet}</span>`;
  }

  function matchRow(m) {
    const won = (side) => m.played && (side === 'home'
      ? m.home_goals > m.away_goals || (m.home_pens ?? 0) > (m.away_pens ?? 0)
      : m.away_goals > m.home_goals || (m.away_pens ?? 0) > (m.home_pens ?? 0));

    return `
      <div class="match"${isMine(m) ? ' data-mine' : ''}>
        <span class="match__team match__team--home"${won('home') ? ' data-won' : ''}>
          ${esc(name(m.home))}${flag(m.home)}
        </span>
        ${score(m)}
        <span class="match__team"${won('away') ? ' data-won' : ''}>
          ${flag(m.away)}${esc(name(m.away))}
        </span>
      </div>`;
  }

  /** Tabela de um grupo, com as linhas de corte do regulamento. */
  function table(group, stage) {
    const rows = group.table.map((r) => {
      const cut = r.position <= stage.advance ? 'direct'
        : r.position <= stage.playoff ? 'playoff' : 'out';
      return `
        <tr data-cut="${cut}"${r.code === state.country ? ' data-mine' : ''}>
          <td class="tt__pos">${r.position}</td>
          <td class="tt__team">${flag(r.code)}<span>${esc(name(r.code))}</span></td>
          <td><b>${r.points}</b></td>
          <td>${r.played}</td>
          <td>${r.won}</td><td>${r.drawn}</td><td>${r.lost}</td>
          <td>${r.gf}:${r.ga}</td>
          <td>${r.gd > 0 ? `+${r.gd}` : r.gd}</td>
        </tr>`;
    }).join('');

    return `
      <table class="tt">
        <thead>
          <tr>
            <th></th><th>${group.name === 'Único' ? 'Seleção' : `Grupo ${esc(group.name)}`}</th>
            <th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>Gols</th><th>SG</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function tieCard(tie) {
    const decided = tie.winner
      ? `<div class="tie__winner">${flag(tie.winner)} <b>${esc(name(tie.winner))}</b> avança</div>`
      : '';
    return `
      <div class="tie"${tie.mine ? ' data-mine' : ''}>
        <div class="tie__name">${esc(tie.name)}</div>
        ${tie.legs.map(matchRow).join('')}
        ${decided}
      </div>`;
  }

  /* ---------------------------------------------------------------- painéis */

  /** A rodada que acabou de ser jogada (ou a última disputada, ao abrir a tela). */
  function lastRound() {
    const pool = [...matchesOf(data.current), ...matchesOf(data.previous)];
    if (round) return pool.filter((m) => round.played.includes(m.id));

    const played = matchesOf(data.current).filter((m) => m.played);
    if (!played.length) return [];
    const last = Math.max(...played.map((m) => m.matchday));
    return played.filter((m) => m.matchday === last);
  }

  function minePanel() {
    const stage = data.current ?? data.previous;
    if (!stage) return '<p class="loading">Eliminatórias encerradas.</p>';

    const results = lastRound();
    const mine = results.find(isMine);

    // O jogo da sua seleção em destaque, e o resto da rodada embaixo.
    const highlight = mine
      ? `<div class="hero-match">${matchRow(mine)}</div>`
      : results.length
        ? '<p class="qual__note">Sua seleção não jogou esta rodada.</p>'
        : '';

    const others = results.filter((m) => m !== mine);
    const roundBox = results.length ? `
      <section class="qual__block">
        <h3 class="qual__h3">${round ? 'Resultados da rodada' : 'Última rodada disputada'}</h3>
        ${highlight}
        ${others.length ? `<div class="matches">${others.map(matchRow).join('')}</div>` : ''}
      </section>` : '';

    const group = stage.groups.find((g) => g.mine);
    const tie = stage.ties.find((t) => t.mine);

    const mineBox = group
      ? `<section class="qual__block">
           <h3 class="qual__h3">${group.name === 'Único' ? 'Classificação' : `Seu grupo — ${esc(group.name)}`}</h3>
           ${table(group, stage)}
           ${legend(stage)}
           <h3 class="qual__h3">Seus jogos</h3>
           <div class="matches">
             ${group.matches.filter(isMine).map(matchRow).join('')}
           </div>
         </section>`
      : tie
        ? `<section class="qual__block"><h3 class="qual__h3">Seu confronto</h3>${tieCard(tie)}</section>`
        : `<section class="qual__block">
             <p class="qual__note">Sua seleção não disputa esta fase — ela segue para que a
             confederação termine e as vagas sejam definidas.</p>
           </section>`;

    return roundBox + mineBox;
  }

  const legend = (stage) => `
    <p class="qual__legend">
      <i data-cut="direct"></i> vaga direta na Copa
      ${stage.playoff > stage.advance ? '<i data-cut="playoff"></i> segue vivo (repescagem ou próxima fase)' : ''}
    </p>`;

  function stagePanel() {
    const stage = data.current ?? data.previous;
    if (!stage) return '';
    if (stage.kind === 'knockout') {
      return `<div class="ties">${stage.ties.map(tieCard).join('')}</div>`;
    }
    return `
      <div class="tables">
        ${stage.groups.map((g) => `<div${g.mine ? ' data-mine' : ''}>${table(g, stage)}</div>`).join('')}
      </div>
      ${legend(stage)}`;
  }

  function worldPanel() {
    if (!world) return '<p class="loading">Carregando…</p>';

    const confs = world.confederations.map((c) => `
      <div class="conf-box${c.code === data.career.confederation ? ' is-mine' : ''}">
        <h3 class="qual__h3">${esc(c.code)}
          <small>${c.finished ? `${c.direct.length} classificados` : 'ainda em disputa'}</small>
        </h3>
        <div class="conf-box__teams">
          ${c.finished
            ? ''
            : `<p class="qual__note">${c.code === data.career.confederation
              ? 'Em andamento no calendário FIFA — acompanhe rodada a rodada.'
              : 'Em andamento no calendário mundial.'}</p>`}
          ${c.direct.map((code) => `<span class="pill" data-kind="in">${flag(code)}${esc(name(code))}</span>`).join('')}
          ${c.playoff.map((code) => `<span class="pill" data-kind="po">${flag(code)}${esc(name(code))}</span>`).join('')}
        </div>
      </div>`).join('');

    const playoff = world.playoff.length ? `
      <section class="qual__block">
        <h3 class="qual__h3">Repescagem Intercontinental</h3>
        <p class="qual__note">Seis seleções, duas vagas. As duas melhores no Ranking FIFA
        entram direto nas finais; as outras quatro jogam as semifinais.</p>
        <div class="ties">${world.playoff.flatMap((s) => s.ties).map(tieCard).join('')}</div>
      </section>` : '';

    return `<div class="confs">${confs}</div>${playoff}`;
  }

  function qualifiedPanel() {
    const list = data.qualified;
    const rows = list.map((t) => `
      <div class="pill pill--row"${t.country_code === state.country ? ' data-mine' : ''}>
        ${flag(t.country_code)}
        <b>${esc(t.name)}</b>
        <small>${esc(t.route === 'host' ? 'Anfitrião' : t.route)} · ${esc(t.note ?? '')}</small>
      </div>`).join('');

    return `
      <p class="qual__note">${list.length} de 48 vagas definidas.</p>
      <div class="qualified">${rows}</div>`;
  }

  const CONFEDS = ['CONMEBOL', 'CONCACAF', 'UEFA', 'AFC', 'CAF', 'OFC'];

  function scorersTable(list) {
    if (!list?.length) {
      return '<p class="qual__note">Ainda não há gols registrados nesta confederação.</p>';
    }
    const rows = list.map((r) => `
      <tr${r.team_code === state.country ? ' data-mine' : ''}>
        <td class="tt__pos">${r.position}</td>
        <td class="tt__team">${flag(r.team_code)}<span>${esc(name(r.team_code))}</span></td>
        <td class="scorers__player">${esc(r.player_name)}</td>
        <td class="scorers__goals"><b>${r.goals}</b></td>
      </tr>`).join('');
    return `
      <table class="tt scorers">
        <thead>
          <tr><th>#</th><th>Seleção</th><th>Jogador</th><th>Gols</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function scorersPanel() {
    const conf = scorersConf ?? data.career.confederation;
    const chips = CONFEDS.map((c) => `
      <button type="button" class="chip${c === conf ? ' is-on' : ''}" data-scorers-conf="${c}">
        ${esc(c)}
      </button>`).join('');

    const list = scorersCache[conf];
    const body = list === undefined
      ? '<p class="loading">Carregando artilharia…</p>'
      : scorersTable(list);

    return `
      <div class="scorers-panel">
        <p class="qual__note">Artilharia das Eliminatórias · ${esc(conf)}</p>
        <div class="chips scorers__confs">${chips}</div>
        ${body}
      </div>`;
  }

  const PANELS = {
    mine: { label: 'Minha chave', render: minePanel },
    stage: { label: 'A fase', render: stagePanel },
    world: { label: 'Pelo mundo', render: worldPanel },
    scorers: { label: 'Artilharia', render: scorersPanel },
    qualified: { label: 'Classificados', render: qualifiedPanel },
  };

  /* ---------------------------------------------------------------- chrome */

  function renderTabs() {
    tabs.innerHTML = '';
    for (const [key, { label }] of Object.entries(PANELS)) {
      const chip = html(`<button class="chip" aria-pressed="${key === tab}">${label}</button>`);
      chip.addEventListener('click', async () => {
        tab = key;
        if (key === 'world' && !world) {
          renderTabs();
          panel.innerHTML = PANELS.world.render();
          world = await api.world(state.careerId);
        }
        if (key === 'scorers') {
          scorersConf ??= data.career.confederation;
          if (data.scorers && scorersCache[scorersConf] === undefined
              && scorersConf === data.career.confederation) {
            scorersCache[scorersConf] = data.scorers;
          }
          renderTabs();
          panel.innerHTML = PANELS.scorers.render();
          bindScorersConfs();
          if (scorersCache[scorersConf] === undefined) {
            try {
              const res = await api.scorers(state.careerId, { confederation: scorersConf });
              scorersCache[scorersConf] = res.scorers;
            } catch (err) {
              toast(err.message);
              scorersCache[scorersConf] = [];
            }
            if (tab === 'scorers') {
              panel.innerHTML = PANELS.scorers.render();
              bindScorersConfs();
            }
          }
          return;
        }
        renderTabs();
        panel.innerHTML = PANELS[tab].render();
      });
      tabs.append(chip);
    }
  }

  function bindScorersConfs() {
    panel.querySelectorAll('[data-scorers-conf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const conf = btn.dataset.scorersConf;
        if (conf === scorersConf) return;
        scorersConf = conf;
        panel.innerHTML = PANELS.scorers.render();
        bindScorersConfs();
        if (scorersCache[conf] === undefined) {
          try {
            const res = await api.scorers(state.careerId, { confederation: conf });
            scorersCache[conf] = res.scorers;
          } catch (err) {
            toast(err.message);
            scorersCache[conf] = [];
          }
          if (tab === 'scorers' && scorersConf === conf) {
            panel.innerHTML = PANELS.scorers.render();
            bindScorersConfs();
          }
        }
      });
    });
  }

  function renderHeader() {
    const { current, previous, career } = data;
    const over = career.stage !== 'qualifiers';
    // Entre fases (ou sem chave ativa) current pode ser null — usa a anterior.
    const stage = current ?? previous;

    stageTitle.textContent = over
      ? 'Eliminatórias encerradas'
      : (stage?.name ?? 'Eliminatórias');

    meta.innerHTML = over
      ? `${esc(career.confederation)} · sua campanha terminou`
      : stage
        ? [
            esc(stage.intercontinental ? 'Repescagem Intercontinental' : career.confederation),
            stage.index != null && stage.total != null ? `fase ${stage.index} de ${stage.total}` : null,
            stage.matchday != null && stage.matchdays != null
              ? `rodada ${stage.matchday} de ${stage.matchdays}`
              : null,
            `força da sua seleção <b>${data.rating}</b>`,
          ].filter(Boolean).join(' · ')
        : `${esc(career.confederation)} · aguardando próxima fase · força <b>${data.rating}</b>`;

    actions.innerHTML = '';
    if (over) return;

    const cont = html('<button class="btn btn--primary">Continuar simulação</button>');
    cont.addEventListener('click', async () => {
      cont.disabled = true;
      try {
        await api.simContinue(state.careerId);
        go('sim');
      } catch (err) {
        toast(err.message);
        cont.disabled = false;
      }
    });
    actions.append(cont);

    const rest = html('<button class="btn btn--ghost">Simular até o fim</button>');
    rest.addEventListener('click', () => run(() => api.simulate(state.careerId), true));
    actions.append(rest);
  }

  /** Tela de fim de linha: a Copa, ou a porta da rua. */
  function renderOutcome() {
    outcomeBox.innerHTML = '';
    const { career } = data;
    if (career.stage === 'qualifiers') return;

    const made = career.stage === 'world_cup';
    const box = html(`
      <div class="outcome" data-kind="${made ? 'in' : 'out'}">
        <div class="outcome__icon">${made ? '🏆' : '💔'}</div>
        <h2 class="screen__title">
          ${made
            ? `${esc(career.country_name)} está na Copa do Mundo de 2026`
            : `${esc(career.country_name)} está fora da Copa`}
        </h2>
        <p class="screen__subtitle">
          ${made
            ? 'Missão cumprida, treinador. Agora é a Copa — e ela é outro campeonato.'
            : 'Acabou a caminhada. As Eliminatórias não perdoam.'}
        </p>
        <div class="outcome__actions"></div>
      </div>`);

    const again = html('<button class="btn btn--ghost">Recomeçar carreira</button>');
    again.addEventListener('click', () => { state.reset(); go('coach'); });
    box.querySelector('.outcome__actions').append(again);

    if (made) {
      const cup = html('<button class="btn btn--primary">Sorteio da Copa</button>');
      cup.addEventListener('click', () => go('draw'));
      box.querySelector('.outcome__actions').prepend(cup);
    } else {
      const watch = html('<button class="btn btn--primary">Acompanhar a Copa</button>');
      watch.addEventListener('click', () => go('draw'));
      box.querySelector('.outcome__actions').prepend(watch);
    }
    outcomeBox.append(box);
  }

  function renderAll() {
    renderOutcome();
    renderHeader();
    renderTabs();
    panel.innerHTML = PANELS[tab].render();
  }

  /** Executa uma ação do servidor com o botão travado, e redesenha com o que voltar. */
  async function run(action, wholeThing = false) {
    actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const result = await action();
      round = wholeThing ? null : result.round;
      data = result;
      world = null; // o mundo mudou junto: recarrega na próxima visita à aba
      for (const k of Object.keys(scorersCache)) delete scorersCache[k];
      scorersConf = null;
      if (data.scorers) scorersCache[data.career.confederation] = data.scorers;
      tab = 'mine';
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' }); // a barra fixa cobriria o título
    } catch (err) {
      toast(err.message);
      renderHeader();
    }
  }

  /* ---------------------------------------------------------------- início */

  try {
    await api.startQualifiers(state.careerId);
    data = await api.qualifiers(state.careerId);
    if (data.scorers) scorersCache[data.career.confederation] = data.scorers;
  } catch (err) {
    panel.innerHTML = '';
    toast(err.message);
    return el;
  }

  renderAll();
  return el;
}
