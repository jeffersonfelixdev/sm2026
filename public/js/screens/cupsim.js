import { api, teamIndex } from '../api.js';
import { esc, html, toast, overallTier, POSITION_ORDER, POSITION_LABEL } from '../ui.js';
import { playCupChronicleQueue } from './matchSummary.js';

const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2', '3-4-3', '5-3-2'];
const SPEED_KEY = 'sm2026_sim_speed';

function loadSpeedIdx() {
  const n = Number(localStorage.getItem(SPEED_KEY));
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
}

function saveSpeedIdx(i) {
  localStorage.setItem(SPEED_KEY, String(i));
}

/**
 * Loop da Copa: uma convocação, slots por horário (MD3 = 2 jogos simultâneos).
 */
export async function cupSimScreen({ state, go }) {
  const el = html(`<section class="screen screen--wide" data-cupsim>
    <p class="loading">Abrindo a Copa…</p>
  </section>`);

  let sim;
  let teams;

  try {
    const draw = await api.drawPreview(state.careerId);
    if (!draw.drawn) {
      await go('draw');
      return el;
    }
    [sim, teams] = await Promise.all([api.cupSim(state.careerId), teamIndex()]);
  } catch (err) {
    el.innerHTML = '';
    toast(err.message);
    return el;
  }

  if (sim.phase === 'draw') {
    await go('draw');
    return el;
  }
  if (sim.phase === 'done' || sim.phase === 'post') {
    await go('worldcup');
    return el;
  }

  let holdingSummary = false;
  let simulating = false;

  async function refresh() {
    sim = await api.cupSim(state.careerId);
    await render();
  }

  async function render() {
    if (holdingSummary) return;
    if (sim.phase === 'done' || sim.phase === 'post') return go('worldcup');
    if (sim.phase === 'callup') el.replaceChildren(await callUpView());
    else if (sim.phase === 'lineup') el.replaceChildren(await lineupView());
    else if (sim.phase === 'live') {
      if (simulating) return;
      el.replaceChildren(await liveView());
    }
    else el.replaceChildren(await readyView());
  }

  const name = (code) => teams[code]?.name ?? code;
  const flag = (code) => {
    const src = teams[code]?.flag;
    return src ? `<img class="tt__flag" src="/${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  };
  const teamLabel = (code) =>
    `<span class="match__name${code === state.country ? ' is-mine' : ''}">${esc(name(code))}</span>`;
  const teamHome = (code) => `${teamLabel(code)}${flag(code)}`;
  const teamAway = (code) => `${flag(code)}${teamLabel(code)}`;
  const kickUtc = (t) => (t ? `${t} UTC` : '');

  /* ---- convocação única ---- */

  async function callUpView() {
    const view = html(`
      <section class="screen screen--wide">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Convocação da Copa</h2>
            <p class="qual__meta">Única lista da Copa · ajuste os 23 antes do torneio</p>
          </div>
        </header>
        <p class="screen__subtitle" data-sub></p>
        <div class="squad-layout">
          <div>
            <div class="toolbar">
              <div class="chips" data-filters></div>
              <input type="search" placeholder="Buscar…" data-search>
            </div>
            <div class="pool" data-pool></div>
          </div>
          <aside class="side" data-side></aside>
        </div>
      </section>
    `);

    const { players, rules } = await api.players(state.country, state.careerId);
    const picked = new Map(sim.squad.map((p) => [p.id, p]));
    let filter = 'ALL';
    let captainId = sim.career.captain_id;
    let formation = sim.formation || FORMATIONS[0];

    const poolEl = view.querySelector('[data-pool]');
    const sideEl = view.querySelector('[data-side]');
    const filtersEl = view.querySelector('[data-filters]');
    const searchEl = view.querySelector('[data-search]');

    view.querySelector('[data-sub]').textContent =
      'Os convocados da última lista já estão marcados. Indisponíveis por cartão ou lesão não entram. Na Copa só há esta convocação.';

    const countBy = (pos) => [...picked.values()].filter((p) => p.position === pos).length;
    const isValid = () =>
      picked.size === rules.size && POSITION_ORDER.every((p) => countBy(p) >= rules.min[p]);

    const available = players.filter((p) => {
      if (p.suspended_until && p.suspended_until >= (sim.date || '2026-06-11')) return false;
      if (p.injured_until && p.injured_until >= (sim.date || '2026-06-11')) return false;
      return true;
    });

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

    function toggle(p) {
      if (picked.has(p.id)) {
        picked.delete(p.id);
        if (captainId === p.id) captainId = null;
      } else {
        if (picked.size >= rules.size) return toast(`Máximo de ${rules.size} jogadores`);
        picked.set(p.id, p);
      }
      renderPool();
      renderSide();
    }

    function renderPool() {
      const term = searchEl.value.trim().toLowerCase();
      poolEl.innerHTML = '';
      for (const p of available) {
        if (filter !== 'ALL' && p.position !== filter) continue;
        if (term && !p.name.toLowerCase().includes(term) && !(p.club ?? '').toLowerCase().includes(term)) continue;
        const on = picked.has(p.id);
        const row = html(`
          <button class="player" aria-pressed="${on}">
            <span class="player__ov" data-tier="${overallTier(p.overall)}">${p.overall}</span>
            <span class="pos" data-pos="${p.position}">${p.position}</span>
            <span>
              <span class="player__name">${esc(p.name)}</span>
              <span class="player__club">${esc(p.club ?? '')}${p.injury_note ? ` · ${esc(p.injury_note)}` : ''}</span>
            </span>
          </button>
        `);
        row.addEventListener('click', () => toggle(p));
        poolEl.append(row);
      }
    }

    function renderSide() {
      sideEl.innerHTML = `
        <div class="side__count ${picked.size === rules.size ? 'is-full' : ''}">
          <b>${picked.size}</b> <span>de ${rules.size}</span>
        </div>
        <div class="field">
          <label>Formação</label>
          <select data-form>${FORMATIONS.map((f) =>
            `<option ${f === formation ? 'selected' : ''}>${f}</option>`).join('')}</select>
        </div>
        <button class="btn btn--primary btn--block" data-ok ${isValid() ? '' : 'disabled'}>
          Confirmar convocação
        </button>
      `;
      sideEl.querySelector('[data-form]').addEventListener('change', (e) => { formation = e.target.value; });
      sideEl.querySelector('[data-ok]').addEventListener('click', async () => {
        try {
          sim = await api.cupCallUp(state.careerId, {
            player_ids: [...picked.keys()],
            captain_id: captainId,
            formation,
          });
          await render();
        } catch (err) {
          toast(err.message);
        }
      });
    }

    searchEl.addEventListener('input', renderPool);
    renderPool();
    renderSide();
    return view;
  }

  /* ---- escalação ---- */

  async function lineupView() {
    const match = sim.myMatch;
    const squad = sim.squad;
    const formation = sim.formation || '4-3-3';
    const slots = {
      '4-3-3': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'],
      '4-4-2': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
      '4-2-3-1': ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW'],
      '3-5-2': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW'],
      '3-4-3': ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'],
      '5-3-2': ['GK', 'DF', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW'],
    }[formation] ?? ['GK', 'DF', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW'];

    const starters = new Set();
    const pool = [...squad].sort((a, b) => b.overall - a.overall);
    for (const pos of slots) {
      const pick = pool.find((p) => p.position === pos && !starters.has(p.id))
        ?? pool.find((p) => !starters.has(p.id));
      if (pick) starters.add(pick.id);
    }

    let form = formation;
    const opponent = match.home === state.country ? match.away : match.home;
    const home = match.home === state.country;

    const view = html(`
      <section class="screen screen--wide">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Escalação</h2>
            <p class="qual__meta">${sim.stageLabel ? `${esc(sim.stageLabel)} · ` : ''}${esc(sim.dateLabel)} · ${esc(kickUtc(sim.kickoff))} · ${home ? 'mandante' : 'visitante'} vs
              ${flag(opponent)} ${esc(name(opponent))}</p>
          </div>
        </header>
        <div class="field" style="max-width:220px;margin-bottom:18px">
          <label>Formação</label>
          <select data-form>
            ${FORMATIONS.map((f) => `<option ${f === form ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="lineup-pick" data-list></div>
        <p class="hint" data-hint>Selecione 11 titulares.</p>
        <button class="btn btn--primary" data-start disabled>Iniciar partida</button>
      </section>
    `);

    const list = view.querySelector('[data-list]');
    const hint = view.querySelector('[data-hint]');
    const startBtn = view.querySelector('[data-start]');
    const formSel = view.querySelector('[data-form]');

    function paint() {
      list.innerHTML = '';
      for (const p of squad) {
        const on = starters.has(p.id);
        const row = html(`
          <button class="player" aria-pressed="${on}">
            <span class="player__ov" data-tier="${overallTier(p.overall)}">${p.overall}</span>
            <span class="pos" data-pos="${p.position}">${p.position}</span>
            <span class="player__name">${esc(p.name)}</span>
            <span class="player__tag">${on ? 'TITULAR' : ''}</span>
          </button>
        `);
        row.addEventListener('click', () => {
          if (on) starters.delete(p.id);
          else {
            if (starters.size >= 11) return toast('Já há 11 titulares');
            starters.add(p.id);
          }
          paint();
        });
        list.append(row);
      }
      const ok = starters.size === 11;
      hint.textContent = ok ? 'Pronto para o apito inicial.' : `Titulares: ${starters.size}/11`;
      startBtn.disabled = !ok;
    }

    formSel.addEventListener('change', (e) => { form = e.target.value; });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        await api.cupLineup(state.careerId, {
          match_id: match.id,
          starter_ids: [...starters],
          formation: form,
        });
        sim = { ...(await api.cupSim(state.careerId)), phase: 'live' };
        await render();
      } catch (err) {
        toast(err.message);
        startBtn.disabled = false;
      }
    });

    paint();
    return view;
  }

  /* ---- ready ---- */

  async function readyView() {
    const nextHint = sim.nextPlayerMatch
      ? `${esc(name(sim.nextPlayerMatch.home))} × ${esc(name(sim.nextPlayerMatch.away))} · ${esc(sim.nextPlayerMatch.dateLabel)}${sim.nextPlayerMatch.kickoff ? ` · ${esc(kickUtc(sim.nextPlayerMatch.kickoff))}` : ''}`
      : '';
    const view = html(`
      <section class="screen">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Copa do Mundo</h2>
            <p class="qual__meta">${sim.stageLabel ? `<b>${esc(sim.stageLabel)}</b> · ` : ''}${esc(sim.dateLabel)} · ${esc(kickUtc(sim.kickoff))}
              · ${sim.slotMatches.length} partida(s)
              ${sim.simultaneous ? ' · <b>simultâneas</b>' : ''}</p>
          </div>
        </header>
        <div class="matches" style="margin:20px 0">
          ${sim.slotMatches.map((m) => {
            const mine = m.home === state.country || m.away === state.country;
            return `
            <div class="match"${mine ? ' data-mine' : ''}>
              <span class="match__team match__team--home">${teamHome(m.home)}</span>
              <span class="match__score match__score--todo">×</span>
              <span class="match__team">${teamAway(m.away)}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="qual__actions" style="display:flex;flex-wrap:wrap;gap:10px">
          <button class="btn btn--primary" data-go>Iniciar simulação</button>
          ${sim.canSkipToMe ? `<button class="btn btn--ghost" data-skip>Avançar para meu jogo</button>` : ''}
          <button class="btn btn--ghost" data-tables>Ver tabelas</button>
        </div>
        ${sim.canSkipToMe && nextHint ? `<p class="qual__note" style="margin-top:12px">Próximo jogo da sua seleção: ${nextHint}</p>` : ''}
      </section>
    `);
    view.querySelector('[data-go]').addEventListener('click', async () => {
      const btn = view.querySelector('[data-go]');
      btn.disabled = true;
      sim = { ...sim, phase: 'live' };
      await render();
    });
    view.querySelector('[data-skip]')?.addEventListener('click', async () => {
      const btn = view.querySelector('[data-skip]');
      const goBtn = view.querySelector('[data-go]');
      btn.disabled = true;
      if (goBtn) goBtn.disabled = true;
      btn.textContent = 'Avançando…';
      try {
        sim = await api.cupSkipToMe(state.careerId);
        toast(sim.skipped
          ? `${sim.skipped} horário(s) simulado(s) até o seu jogo`
          : 'Você já está no horário do seu jogo');
        await render();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        if (goBtn) goBtn.disabled = false;
        btn.textContent = 'Avançar para meu jogo';
      }
    });
    view.querySelector('[data-tables]').addEventListener('click', () => go('worldcup'));
    return view;
  }

  /* ---- live ---- */

  async function liveView() {
    if (simulating) {
      return html('<section class="screen"><p class="loading">Simulação em andamento…</p></section>');
    }
    simulating = true;

    const hasMine = !!sim.myMatch;
    const baseHalfMs = hasMine ? 60000 : 30000;
    const speeds = [
      { label: '1×', halfMs: baseHalfMs },
      { label: '2×', halfMs: baseHalfMs / 2 },
      { label: '4×', halfMs: baseHalfMs / 4 },
    ];
    if (!hasMine) speeds.push({ label: '8×', halfMs: baseHalfMs / 8 });
    let speedIdx = Math.min(loadSpeedIdx(), speeds.length - 1);
    let paused = false;
    let waitingSub = null;
    let currentMinute = 0;
    let currentStoppage = 0;
    let inEt = false;

    const FIFA = { maxReg: 5, maxWinReg: 3, extraEt: 1, extraWinEt: 1 };
    let subsUsed = 0;
    let windowsUsed = 0;
    const onPitch = new Map();
    const onBench = new Map();
    const subbedOff = new Set();
    const matchCards = new Map();

    function recordCard(playerId, kind, clock) {
      if (!playerId) return;
      const cur = matchCards.get(playerId) ?? { yellows: 0, red: false, clocks: [] };
      if (kind === 'yellow') cur.yellows += 1;
      if (kind === 'red') cur.red = true;
      cur.clocks.push(clock);
      if (cur.yellows >= 2) cur.red = true;
      matchCards.set(playerId, cur);
    }

    function cardBadgeHtml(playerId) {
      const c = matchCards.get(playerId);
      if (!c || (!c.yellows && !c.red)) return '';
      const parts = [];
      if (c.red) parts.push('<span class="match__card match__card--red" title="Vermelho"></span>');
      else if (c.yellows === 1) parts.push('<span class="match__card match__card--yellow" title="Pendurado"></span>');
      if (!c.red && c.yellows > 1) {
        for (let i = 0; i < c.yellows; i++) parts.push('<span class="match__card match__card--yellow"></span>');
      }
      const tip = c.clocks.length ? ` Cartões: ${c.clocks.join(', ')}` : '';
      return `<span class="sub-pick__cards" title="${esc(tip.trim())}">${parts.join('')}</span>`;
    }

    function isSentOff(playerId) {
      return !!matchCards.get(playerId)?.red;
    }

    function dismissSentOff(playerId) {
      if (!playerId || !onPitch.has(playerId)) return;
      onPitch.delete(playerId);
      onBench.delete(playerId);
      subbedOff.add(playerId);
    }

    const fifaLimits = () => ({
      maxSubs: FIFA.maxReg + (inEt ? FIFA.extraEt : 0),
      maxWindows: FIFA.maxWinReg + (inEt ? FIFA.extraWinEt : 0),
    });
    const subsLeft = () => fifaLimits().maxSubs - subsUsed;
    const windowsLeft = () => fifaLimits().maxWindows - windowsUsed;

    const view = html(`
      <section class="screen screen--wide live">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Ao vivo — ${esc(sim.dateLabel)} · ${esc(kickUtc(sim.kickoff))}</h2>
            <p class="qual__meta">${sim.stageLabel ? esc(sim.stageLabel) : 'Copa do Mundo'}${sim.simultaneous ? ' · jogos simultâneos' : ''}</p>
          </div>
          <div class="qual__actions">
            <div class="live__clock" data-clock aria-live="polite">
              <span class="live__clock-face" data-face>00:00</span>
              <small data-period>1º tempo</small>
            </div>
            <div class="chips" data-speeds></div>
            <button class="btn btn--ghost" data-pause>Pausar</button>
            ${hasMine ? '<button class="btn btn--ghost" data-sub>Substituir</button>' : ''}
          </div>
        </header>
        <div class="live__board" data-board></div>
      </section>
    `);

    const faceEl = view.querySelector('[data-face]');
    const periodEl = view.querySelector('[data-period]');
    const boardEl = view.querySelector('[data-board]');
    const speedsEl = view.querySelector('[data-speeds]');
    const pauseBtn = view.querySelector('[data-pause]');
    const modal = document.createElement('div');
    modal.className = 'live__sub';
    modal.hidden = true;
    document.body.appendChild(modal);

    speeds.forEach((s, i) => {
      const chip = html(`<button class="chip" aria-pressed="${i === speedIdx}">${s.label}</button>`);
      chip.addEventListener('click', () => {
        speedIdx = i;
        saveSpeedIdx(i);
        speedsEl.querySelectorAll('.chip').forEach((c, j) =>
          c.setAttribute('aria-pressed', String(j === i)));
      });
      speedsEl.append(chip);
    });

    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Retomar' : 'Pausar';
    });

    const subBtn = view.querySelector('[data-sub]');
    if (subBtn) {
      subBtn.addEventListener('click', () => {
        if (!onPitch.size) return toast('Escalação ainda não carregada');
        if (subsLeft() <= 0) return toast('Sem substituições restantes (FIFA: máx. 5 + 1 na prorrogação)');
        if (windowsLeft() <= 0) return toast('Sem janelas de substituição restantes (FIFA: 3 + 1 na prorrogação)');
        openSubModal({ mode: 'manual', moment: 'play' });
      });
    }

    function setClock(minute, stoppage = 0, seconds = 0) {
      currentMinute = minute;
      currentStoppage = stoppage;
      const mm = String(Math.min(minute, 120)).padStart(2, '0');
      const ss = String(Math.min(59, Math.floor(seconds))).padStart(2, '0');
      faceEl.textContent = stoppage > 0 ? `${mm}:${ss}+${stoppage}` : `${mm}:${ss}`;
      if (minute < 45 || (minute === 45 && stoppage === 0 && seconds < 1)) periodEl.textContent = '1º tempo';
      else if (minute < 90 || (minute === 90 && !stoppage)) periodEl.textContent = '2º tempo';
      else if (minute <= 120) periodEl.textContent = 'Prorrogação';
      else periodEl.textContent = 'Pênaltis';
    }

    function openSubModal({ mode, injury = null, breakTitle = null, moment = 'play' }) {
      paused = true;
      pauseBtn.textContent = 'Retomar';
      modal.hidden = false;

      const freeWindow = moment === 'half_time' || moment === 'pre_et';
      const limits = fifaLimits();
      let maxBatch = Math.max(0, Math.min(
        subsLeft(),
        onBench.size,
        mode === 'injury'
          ? 1
          : [...onPitch.values()].filter((p) => !isSentOff(p.id) && (p.position !== 'GK' || mode === 'injury')).length,
      ));
      if (!freeWindow && windowsLeft() <= 0) maxBatch = 0;

      const selectedOut = injury?.outId != null ? [injury.outId] : [];
      const selectedIn = [];
      const outList = [...onPitch.values()]
        .filter((p) => !isSentOff(p.id) && (p.position !== 'GK' || mode === 'injury'))
        .sort((a, b) => {
          const score = (c) => (c?.yellows || 0);
          return score(matchCards.get(b.id)) - score(matchCards.get(a.id)) || b.overall - a.overall;
        });
      const inList = [...onBench.values()].filter((p) => !isSentOff(p.id) && !subbedOff.has(p.id));
      const canSkip = mode === 'manual' || mode === 'break' || (mode === 'injury' && (maxBatch <= 0 || !inList.length));
      const title = mode === 'injury'
        ? 'Lesão — escolha quem entra'
        : mode === 'break'
          ? (breakTitle || 'Intervalo — substituição')
          : 'Substituição';

      const toggle = (arr, id, side) => {
        if (mode === 'injury' && side === 'out') return;
        const idx = arr.indexOf(id);
        if (idx >= 0) arr.splice(idx, 1);
        else {
          if (arr.length >= maxBatch) return toast(`No máximo ${maxBatch} nesta janela`);
          arr.push(id);
        }
        renderLists();
      };

      const canConfirm = () => {
        if (mode === 'injury') return selectedOut.length === 1 && selectedIn.length === 1 && maxBatch >= 1;
        return selectedOut.length > 0 && selectedOut.length === selectedIn.length && selectedOut.length <= maxBatch;
      };

      const playerRow = (p, side, pressed) => `
        <button class="sub-pick__btn" data-side="${side}" data-id="${p.id}" aria-pressed="${pressed}">
          <span class="pos" data-pos="${p.position}">${p.position}</span>
          <span class="sub-pick__name"><span>${esc(p.name)}</span>${cardBadgeHtml(p.id)}</span>
          <span class="player__ov" data-tier="mid">${p.overall}</span>
        </button>`;

      const renderLists = () => {
        const quota = `${subsUsed}/${limits.maxSubs} substituições · ${windowsUsed}/${limits.maxWindows} janelas`
          + (freeWindow ? ' · janela livre (intervalo)' : '');
        const outHtml = mode === 'injury'
          ? `<div class="sub-pick__fixed">
               <span class="pos" data-pos="${esc(injury.outPos || '')}">${esc(injury.outPos || '')}</span>
               <span class="sub-pick__name"><b>${esc(injury.outName)}</b>${cardBadgeHtml(injury.outId)}</span>
               <small>sai (lesão)</small>
             </div>`
          : outList.map((p) => playerRow(p, 'out', selectedOut.includes(p.id))).join('');
        const inHtml = inList.length
          ? inList.map((p) => playerRow(p, 'in', selectedIn.includes(p.id))).join('')
          : '<p class="qual__note">Sem jogadores no banco.</p>';
        modal.innerHTML = `
          <div class="sub-modal sub-modal--wide">
            <h3>${esc(title)}</h3>
            <p class="qual__note">FIFA: até ${limits.maxSubs} trocas e ${limits.maxWindows} janelas
              (${freeWindow ? 'intervalo não consome janela' : 'em jogo consome 1 janela'}).
              Selecione a mesma quantidade de quem sai e quem entra
              (${selectedOut.length} ↔ ${selectedIn.length}).</p>
            <p class="qual__meta">${esc(quota)}</p>
            <div class="sub-pick">
              <div>
                <h4 class="qual__h3">${mode === 'injury' ? 'Sai' : 'Quem sai'}</h4>
                <div class="sub-pick__list">${outHtml}</div>
              </div>
              <div>
                <h4 class="qual__h3">Quem entra</h4>
                <div class="sub-pick__list">${inHtml}</div>
              </div>
            </div>
            <div class="sub-modal__actions">
              ${canSkip
                ? `<button class="btn btn--ghost" data-cancel>${mode === 'break' ? 'Continuar sem troca' : mode === 'injury' ? 'Seguir com 10' : 'Cancelar'}</button>`
                : ''}
              <button class="btn btn--primary" data-ok ${canConfirm() ? '' : 'disabled'}>
                Confirmar${canConfirm() ? ` (${selectedOut.length})` : ''}
              </button>
            </div>
          </div>`;
        modal.querySelectorAll('[data-side="out"]').forEach((btn) => {
          btn.addEventListener('click', () => toggle(selectedOut, Number(btn.dataset.id), 'out'));
        });
        modal.querySelectorAll('[data-side="in"]').forEach((btn) => {
          btn.addEventListener('click', () => toggle(selectedIn, Number(btn.dataset.id), 'in'));
        });
        modal.querySelector('[data-cancel]')?.addEventListener('click', () => {
          if (mode === 'injury' && injury?.outId) {
            const outP = onPitch.get(injury.outId);
            if (outP) {
              onPitch.delete(injury.outId);
              subbedOff.add(injury.outId);
              const mineMatch = board.find((m) => m.mine);
              if (mineMatch) {
                const clock = currentStoppage ? `${currentMinute}+${currentStoppage}'` : `${currentMinute}'`;
                pushNote(mineMatch, state.country, { kind: 'sub_out', name: outP.name, clock });
                paintBoard();
              }
            }
          }
          finish(null);
        });
        modal.querySelector('[data-ok]')?.addEventListener('click', () => {
          if (!canConfirm()) return;
          const pairs = selectedOut.map((outId, i) => ({ outId, inId: selectedIn[i] }));
          finish({ pairs, freeWindow, count: pairs.length });
        });
      };

      const finish = (result) => {
        modal.hidden = true;
        modal.innerHTML = '';
        if (result?.pairs?.length) {
          if (subsUsed + result.count > fifaLimits().maxSubs) toast('Limite de substituições FIFA excedido');
          else if (!result.freeWindow && windowsUsed >= fifaLimits().maxWindows) toast('Sem janelas de substituição restantes');
          else {
            applySubs(result.pairs);
            subsUsed += result.count;
            if (!result.freeWindow) windowsUsed += 1;
          }
        }
        paused = false;
        pauseBtn.textContent = 'Pausar';
        if (waitingSub) {
          waitingSub(result);
          waitingSub = null;
        }
      };

      if (mode !== 'injury' && maxBatch <= 0) {
        toast(subsLeft() <= 0
          ? 'Sem substituições restantes'
          : windowsLeft() <= 0 && !freeWindow
            ? 'Sem janelas restantes'
            : 'Não há jogadores disponíveis');
        if (mode === 'manual') {
          paused = false;
          pauseBtn.textContent = 'Pausar';
          modal.hidden = true;
          return Promise.resolve(null);
        }
      }

      renderLists();
      return new Promise((resolve) => { waitingSub = resolve; });
    }

    function applySubs(pairs) {
      const clock = currentStoppage ? `${currentMinute}+${currentStoppage}'` : `${currentMinute}'`;
      const mineMatch = board.find((m) => m.mine);
      for (const { outId, inId } of pairs) {
        if (isSentOff(outId) || isSentOff(inId)) continue;
        const outP = onPitch.get(outId);
        const inP = onBench.get(inId);
        if (!outP || !inP || subbedOff.has(inId)) continue;
        onPitch.delete(outId);
        onBench.delete(inId);
        onPitch.set(inId, inP);
        subbedOff.add(outId);
        if (mineMatch) {
          pushNote(mineMatch, state.country, { kind: 'sub_out', name: outP.name, clock });
          pushNote(mineMatch, state.country, { kind: 'sub_in', name: inP.name, clock });
        }
      }
      if (mineMatch) paintBoard();
    }

    let slotResult;
    try {
      const res = await api.cupSlot(state.careerId, sim.date, sim.kickoff);
      slotResult = res.slot;
      // Não sobrescreve a fase local com 'post' — evita pular para tabelas no meio do ao vivo
      sim = { ...res, phase: 'live', slot: undefined };
    } catch (err) {
      simulating = false;
      toast(err.message);
      try { modal.remove(); } catch { /* ignore */ }
      // Não chama refresh() — isso levaria phase=post → worldcup e mataria o ao vivo
      sim = { ...sim, phase: 'ready' };
      return readyView();
    }

    const board = slotResult.matches.map((m) => ({
      id: m.id,
      home: m.home,
      away: m.away,
      scoreH: 0,
      scoreA: 0,
      pensH: null,
      pensA: null,
      mine: m.mine,
      flash: false,
      notesH: [],
      notesA: [],
      events: m.events,
      home_goals: m.home_goals,
      away_goals: m.away_goals,
      home_pens: m.home_pens,
      away_pens: m.away_pens,
      extra_time: m.extra_time,
    }));

    const myLive = slotResult.matches.find((m) => m.mine);
    if (myLive?.lineup) {
      for (const p of myLive.lineup.starters) onPitch.set(p.id, p);
      for (const p of myLive.lineup.bench) onBench.set(p.id, p);
    }

    function pushNote(match, teamCode, note) {
      if (teamCode === match.home) match.notesH.push(note);
      else if (teamCode === match.away) match.notesA.push(note);
    }

    function needsExtra(m) {
      return !!(m.extra_time
        || m.home_pens != null
        || m.away_pens != null
        || (m.events ?? []).some((e) => e.minute > 90 || e.type === 'penalties' || e.type === 'et_end'));
    }

    function scoreHtml(m) {
      const pens = m.pensH != null ? `<small>(${m.pensH}–${m.pensA})</small>` : '';
      return `${pens}${m.scoreH}<i>-</i>${m.scoreA}`;
    }

    function notesHtml(notes, align) {
      if (!notes.length) return `<div class="match__notes match__notes--${align}"></div>`;
      return `<div class="match__notes match__notes--${align}">
        ${notes.map((n) => {
          if (n.kind === 'goal') return `<span class="match__note match__note--goal">⚽ ${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          if (n.kind === 'yellow') return `<span class="match__note match__note--card"><span class="match__card match__card--yellow" aria-hidden="true"></span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          if (n.kind === 'red') return `<span class="match__note match__note--card"><span class="match__card match__card--red" aria-hidden="true"></span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          if (n.kind === 'sub_in') return `<span class="match__note match__note--sub"><span class="match__sub-arrow match__sub-arrow--in" aria-label="entrou">↑</span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          if (n.kind === 'sub_out') return `<span class="match__note match__note--sub"><span class="match__sub-arrow match__sub-arrow--out" aria-label="saiu">↓</span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          return '';
        }).join('')}
      </div>`;
    }

    let filterExtra = false;

    function paintBoard() {
      const shown = filterExtra ? board.filter(needsExtra) : board;
      boardEl.innerHTML = `
        <div class="live__conf">
          <div class="matches live__matches">
            ${shown.map((m) => `
              <div class="match match--live${m.mine ? ' live__mine' : ''}${m.flash ? ' is-flash' : ''}">
                <div class="match__row">
                  <span class="match__team match__team--home">${teamHome(m.home)}</span>
                  <span class="match__score">${scoreHtml(m)}</span>
                  <span class="match__team">${teamAway(m.away)}</span>
                </div>
                <div class="match__notes-row">
                  ${notesHtml(m.notesH, 'home')}
                  <span class="match__notes-gap"></span>
                  ${notesHtml(m.notesA, 'away')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>`;
    }

    function playerName(ev) {
      return ev.player_name || (ev.player_id ? `#${ev.player_id}` : '?');
    }

    function goalCrowd() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = 180;
        g.gain.value = 0.04;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        o.stop(ctx.currentTime + 0.85);
      } catch { /* sem áudio */ }
    }

    const timeline = [];
    for (const m of board) {
      for (const e of m.events) {
        if (!['goal', 'yellow', 'red', 'sub', 'injury', 'half_time', 'full_time', 'et_end', 'penalties'].includes(e.type)) continue;
        timeline.push({ ...e, matchId: m.id, mine: m.mine });
      }
    }
    timeline.sort((a, b) => (a.minute - b.minute) || (a.stoppage - b.stoppage));

    setClock(0, 0, 0);
    paintBoard();

    (async () => {
      let lastMin = 0;
      for (let i = 0; i < timeline.length; i++) {
        while (paused) await sleep(100);
        const ev = timeline[i];
        const halfMs = speeds[speedIdx].halfMs;
        const msPerMin = halfMs / 45;

        if (ev.minute > 90 && lastMin <= 90) {
          filterExtra = true;
          paintBoard();
        }

        for (let m = lastMin; m < ev.minute; m++) {
          while (paused) await sleep(100);
          for (let s = 0; s < 4; s++) {
            setClock(m, 0, s * 15);
            await sleep(Math.max(8, msPerMin / 4));
            while (paused) await sleep(100);
          }
        }
        lastMin = ev.minute;
        setClock(ev.minute, ev.stoppage || 0, 0);
        if (ev.type === 'penalties') periodEl.textContent = 'Pênaltis';
        else if (ev.minute > 90) periodEl.textContent = 'Prorrogação';

        const match = board.find((x) => x.id === ev.matchId);
        if (!match) continue;
        match.flash = false;
        const clock = ev.clock || `${ev.minute}'`;

        if (ev.type === 'goal') {
          const scorer = playerName(ev);
          if (ev.team === match.home) {
            match.scoreH++;
            pushNote(match, match.home, { kind: 'goal', name: scorer, clock });
          } else if (ev.team === match.away) {
            match.scoreA++;
            pushNote(match, match.away, { kind: 'goal', name: scorer, clock });
          }
          if (match.mine) {
            match.flash = true;
            goalCrowd();
          }
        } else if (ev.type === 'yellow' || ev.type === 'red') {
          if (ev.team === state.country && ev.player_id
            && (!onPitch.has(ev.player_id) || subbedOff.has(ev.player_id))) {
            // quem já saiu/expulso não toma cartão
          } else {
            pushNote(match, ev.team, { kind: ev.type, name: playerName(ev), clock });
            if (ev.team === state.country && ev.player_id) {
              recordCard(ev.player_id, ev.type, clock);
              if (isSentOff(ev.player_id)) dismissSentOff(ev.player_id);
            }
          }
        } else if (ev.type === 'sub') {
          if (ev.team === state.country) continue;
          const inName = ev.player_name || playerName(ev);
          const outName = ev.assist_name || null;
          if (outName) pushNote(match, ev.team, { kind: 'sub_out', name: outName, clock });
          pushNote(match, ev.team, { kind: 'sub_in', name: inName, clock });
        } else if (ev.type === 'penalties') {
          match.pensH = match.home_pens;
          match.pensA = match.away_pens;
        } else if (ev.type === 'injury' && ev.team === state.country && onPitch.size) {
          if (!ev.player_id || !onPitch.has(ev.player_id) || isSentOff(ev.player_id) || subbedOff.has(ev.player_id)) {
            // ignora lesão de quem já está fora
          } else {
            await openSubModal({
              mode: 'injury',
              injury: {
                outId: ev.player_id,
                outName: ev.player_name || playerName(ev),
                outPos: onPitch.get(ev.player_id)?.position || '',
              },
              moment: 'play',
            });
          }
        } else if (ev.type === 'half_time' && match.mine && onPitch.size) {
          periodEl.textContent = 'Intervalo';
          await openSubModal({
            mode: 'break',
            breakTitle: 'Intervalo — substituição',
            moment: 'half_time',
          });
        } else if (ev.type === 'full_time' && match.mine && onPitch.size) {
          const goesToEt = !!match.extra_time
            || timeline.some((e) => e.matchId === match.id && (e.minute > 90 || e.type === 'penalties'));
          if (goesToEt) {
            inEt = true;
            periodEl.textContent = 'Antes da prorrogação';
            await openSubModal({
              mode: 'break',
              breakTitle: 'Antes da prorrogação — substituição',
              moment: 'pre_et',
            });
          }
        }

        paintBoard();
        if (match.flash) setTimeout(() => { match.flash = false; paintBoard(); }, 1200);
        await sleep(Math.max(40, msPerMin * 0.2));
      }

      for (const m of board) {
        m.scoreH = m.home_goals;
        m.scoreA = m.away_goals;
        m.pensH = m.home_pens;
        m.pensA = m.away_pens;
        m.flash = false;
      }
      filterExtra = false;
      paintBoard();
      faceEl.textContent = board.some((m) => m.extra_time || m.home_pens != null) ? '120:00' : '90:00';
      periodEl.textContent = 'Fim';
      await sleep(700);
      try { modal.remove(); } catch { /* já removido */ }

      const matches = slotResult?.matches ?? [];
      const mine = matches.find((m) => m.home === state.country || m.away === state.country)
        ?? matches.find((m) => m.mine);
      const playedIds = new Set(matches.map((m) => m.id));
      const dayStillPending = (sim.dayMatches ?? []).some(
        (m) => !m.played && !playedIds.has(m.id),
      );
      const chronicles = slotResult?.chronicles ?? [];

      if (mine || chronicles.length) {
        holdingSummary = true;
        simulating = false;
        const result = await playCupChronicleQueue({
          careerId: state.careerId,
          teams,
          country: state.country,
          playerMatch: mine ?? null,
          chronicles,
          dayStillPending,
          go,
        });
        holdingSummary = false;
        if (result?.wentTables) return;
        return;
      }

      simulating = false;
      if (dayStillPending) {
        sim = await api.cupContinue(state.careerId);
        await go('cupsim');
      } else {
        await go('worldcup');
      }
    })().catch((err) => {
      simulating = false;
      console.error(err);
      toast(err.message || 'Falha ao finalizar a simulação');
      try { modal.remove(); } catch { /* ignore */ }
    });

    return view;
  }

  await render();
  return el;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
