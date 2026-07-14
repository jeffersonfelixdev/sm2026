import { api, teamIndex } from '../api.js';
import { esc, html, toast, overallTier, POSITION_ORDER, POSITION_LABEL } from '../ui.js';
import { matchSummaryView, mountMatchSummary } from './matchSummary.js';

const FORMATIONS = ['4-3-3', '4-4-2', '4-2-3-1', '3-5-2', '3-4-3', '5-3-2'];
const POS_COLOR = { GK: 'var(--gk)', DF: 'var(--df)', MF: 'var(--mf)', FW: 'var(--fw)' };
const SPEED_KEY = 'sm2026_sim_speed';

function loadSpeedIdx() {
  const n = Number(localStorage.getItem(SPEED_KEY));
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
}

function saveSpeedIdx(i) {
  localStorage.setItem(SPEED_KEY, String(i));
}

/**
 * Hub do loop Data FIFA — despacha para convocação, escalação, live ou pós-jogo.
 */
export async function simScreen({ state, go }) {
  const el = html(`<section class="screen screen--wide" data-sim><p class="loading">Montando o calendário FIFA…</p></section>`);

  let sim;
  let teams;

  try {
    await api.startQualifiers(state.careerId);
    [sim, teams] = await Promise.all([api.sim(state.careerId), teamIndex()]);
  } catch (err) {
    el.innerHTML = '';
    toast(err.message);
    return el;
  }

  if (sim.phase === 'done') {
    go('qualifiers');
    return el;
  }

  let holdingSummary = false;
  let simulating = false;

  async function refresh() {
    sim = await api.sim(state.careerId);
    await render();
  }

  async function render() {
    if (holdingSummary) return;
    if (sim.phase === 'done') return go('qualifiers');
    if (sim.phase === 'callup') el.replaceChildren(await callUpView());
    else if (sim.phase === 'lineup') el.replaceChildren(await lineupView());
    else if (sim.phase === 'live') {
      if (simulating) return;
      el.replaceChildren(await liveView());
    }
    else if (sim.phase === 'post') el.replaceChildren(await postView());
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

  /* -------------------- convocação (fase 4) -------------------- */

  async function callUpView() {
    const view = html(`
      <section class="screen screen--wide">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">Convocação — ${esc(sim.window.label)}</h2>
            <p class="qual__meta">Data FIFA · ajuste os 23 antes dos jogos de ${esc(sim.window.label)}</p>
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
      `Os convocados da última lista já estão marcados. Indisponíveis por cartão ou lesão não entram.`;

    const countBy = (pos) => [...picked.values()].filter((p) => p.position === pos).length;
    const isValid = () =>
      picked.size === rules.size && POSITION_ORDER.every((p) => countBy(p) >= rules.min[p]);

    const available = players.filter((p) => {
      if (p.suspended_until && p.suspended_until >= sim.date) return false;
      if (p.injured_until && p.injured_until >= sim.date) return false;
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
          sim = await api.simCallUp(state.careerId, {
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

  /* -------------------- escalação -------------------- */

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
            <p class="qual__meta">${esc(sim.dateLabel)} · ${home ? 'mandante' : 'visitante'} vs
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
        await api.simLineup(state.careerId, {
          match_id: match.id,
          starter_ids: [...starters],
          formation: form,
        });
        sim = { ...(await api.sim(state.careerId)), phase: 'live' };
        await render();
      } catch (err) {
        toast(err.message);
        startBtn.disabled = false;
      }
    });

    paint();
    return view;
  }

  /* -------------------- live board -------------------- */

  async function liveView() {
    if (simulating) {
      return html('<section class="screen"><p class="loading">Simulação em andamento…</p></section>');
    }
    simulating = true;

    const myConf = sim.career.confederation;
    const hasMine = !!sim.myMatch && !sim.myMatch.played;
    const baseHalfMs = hasMine ? 60000 : 30000; // 1×: 1 min / 30 s por tempo de 45
    const speeds = [
      { label: '1×', halfMs: baseHalfMs },
      { label: '2×', halfMs: baseHalfMs / 2 },
      { label: '4×', halfMs: baseHalfMs / 4 },
    ];
    if (!hasMine) speeds.push({ label: '8×', halfMs: baseHalfMs / 8 });
    let speedIdx = Math.min(loadSpeedIdx(), speeds.length - 1);
    let paused = false;
    let dayResult = null;
    let waitingSub = null; // Promise resolver when sub modal closes
    let currentMinute = 0;
    let currentStoppage = 0;
    let inEt = false; // após 90' / pré-prorrogação

    // FIFA Law 3 — espelha lib/subs.mjs
    const FIFA = { maxReg: 5, maxWinReg: 3, extraEt: 1, extraWinEt: 1 };
    let subsUsed = 0;
    let windowsUsed = 0;

    // Estado em campo da seleção do jogador (para o modal de sub)
    let onPitch = new Map(); // id → player
    let onBench = new Map();
    const subbedOff = new Set(); // quem já saiu não volta no mesmo jogo (FIFA)
    // Cartões na partida: playerId → { yellows, red, clocks[] }
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
      if (c.red) {
        parts.push('<span class="match__card match__card--red" title="Vermelho"></span>');
      } else if (c.yellows === 1) {
        parts.push('<span class="match__card match__card--yellow" title="Pendurado"></span>');
      }
      if (!c.red && c.yellows > 1) {
        for (let i = 0; i < c.yellows; i++) {
          parts.push('<span class="match__card match__card--yellow"></span>');
        }
      }
      const tip = c.clocks.length ? ` Cartões: ${c.clocks.join(', ')}` : '';
      return `<span class="sub-pick__cards" title="${esc(tip.trim())}">${parts.join('')}</span>`;
    }

    function isSentOff(playerId) {
      return !!matchCards.get(playerId)?.red;
    }

    /** Expulso sai do campo e não pode ser substituído / reentrar. */
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
            <h2 class="screen__title">Ao vivo — ${esc(sim.dateLabel)}</h2>
            <p class="qual__meta">${esc(sim.window.label)}</p>
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
        <div class="live__board" data-board><p class="loading">Preparando partidas…</p></div>
      </section>
    `);

    const board = view.querySelector('[data-board]');
    const faceEl = view.querySelector('[data-face]');
    const periodEl = view.querySelector('[data-period]');
    const pauseBtn = view.querySelector('[data-pause]');
    const speedsEl = view.querySelector('[data-speeds]');
    // Overlay no body → sempre no centro da viewport, independente do scroll dos jogos
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

    /** Relógio estilo digital: MM:SS (minutos de jogo + segundos do tick). */
    function setClock(minute, stoppage = 0, seconds = 0) {
      currentMinute = minute;
      currentStoppage = stoppage;
      const mm = String(Math.min(minute, 120)).padStart(2, '0');
      const ss = String(Math.min(59, Math.floor(seconds))).padStart(2, '0');
      if (stoppage > 0) {
        faceEl.textContent = `${mm}:${ss}+${stoppage}`;
      } else {
        faceEl.textContent = `${mm}:${ss}`;
      }
      if (minute < 45 || (minute === 45 && stoppage === 0 && seconds < 1)) {
        periodEl.textContent = '1º tempo';
      } else if (minute < 90 || (minute === 90 && !stoppage)) {
        periodEl.textContent = '2º tempo';
      } else if (minute <= 120) {
        periodEl.textContent = 'Prorrogação';
      } else {
        periodEl.textContent = 'Pênaltis';
      }
    }

    /**
     * Modal de substituição (multipla: Qtd que sai === Qtd que entra).
     * mode: 'manual' | 'injury' | 'break'
     * moment: 'play' | 'half_time' | 'pre_et' — janela livre no intervalo / pré-ET
     * Devolve Promise<{ pairs: [{outId,inId}] } | null>
     */
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
      // Em jogo: sem janelas restantes → não dá para trocar (lesão: segue com 10)
      if (!freeWindow && windowsLeft() <= 0) maxBatch = 0;

      const selectedOut = injury?.outId != null ? [injury.outId] : [];
      const selectedIn = [];

      const outList = [...onPitch.values()]
        .filter((p) => !isSentOff(p.id) && (p.position !== 'GK' || mode === 'injury'))
        .sort((a, b) => {
          // Pendurados primeiro — ajuda a decidir a troca
          const ca = matchCards.get(a.id);
          const cb = matchCards.get(b.id);
          const score = (c) => (c?.yellows || 0);
          return score(cb) - score(ca) || b.overall - a.overall;
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
        <button class="sub-pick__btn" data-side="${side}" data-id="${p.id}"
          aria-pressed="${pressed}">
          <span class="pos" data-pos="${p.position}">${p.position}</span>
          <span class="sub-pick__name">
            <span>${esc(p.name)}</span>
            ${cardBadgeHtml(p.id)}
          </span>
          <span class="player__ov" data-tier="mid">${p.overall}</span>
        </button>`;

      const renderLists = () => {
        const quota = `${subsUsed}/${limits.maxSubs} substituições · ${windowsUsed}/${limits.maxWindows} janelas`
          + (freeWindow ? ' · janela livre (intervalo)' : '');

        const outHtml = mode === 'injury'
          ? `<div class="sub-pick__fixed">
               <span class="pos" data-pos="${esc(injury.outPos || '')}">${esc(injury.outPos || '')}</span>
               <span class="sub-pick__name">
                 <b>${esc(injury.outName)}</b>
                 ${cardBadgeHtml(injury.outId)}
               </span>
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
              const mineMatch = orderedMatches().find((m) => m.mine);
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
          if (subsUsed + result.count > fifaLimits().maxSubs) {
            toast('Limite de substituições FIFA excedido');
          } else if (!result.freeWindow && windowsUsed >= fifaLimits().maxWindows) {
            toast('Sem janelas de substituição restantes');
          } else {
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
        if (mode === 'break') {
          // ainda abre para Continuar sem troca
        } else if (mode === 'manual') {
          paused = false;
          pauseBtn.textContent = 'Pausar';
          modal.hidden = true;
          return Promise.resolve(null);
        }
      }

      renderLists();

      return new Promise((resolve) => {
        waitingSub = resolve;
      });
    }

    function applySubs(pairs) {
      const clock = currentStoppage
        ? `${currentMinute}+${currentStoppage}'`
        : `${currentMinute}'`;
      const mineMatch = orderedMatches().find((m) => m.mine);

      for (const { outId, inId } of pairs) {
        if (isSentOff(outId) || isSentOff(inId)) continue;
        const outP = onPitch.get(outId);
        const inP = onBench.get(inId);
        if (!outP || !inP) continue;
        if (subbedOff.has(inId)) continue; // nunca reentra
        onPitch.delete(outId);
        onBench.delete(inId);
        onPitch.set(inId, inP);
        subbedOff.add(outId); // não volta ao banco disponível
        if (mineMatch) {
          pushNote(mineMatch, state.country, { kind: 'sub_out', name: outP.name, clock });
          pushNote(mineMatch, state.country, { kind: 'sub_in', name: inP.name, clock });
        }
      }

      if (mineMatch) paintBoard();
    }

    function pushNote(match, teamCode, note) {
      if (teamCode === match.home) match.notesH.push(note);
      else if (teamCode === match.away) match.notesA.push(note);
    }
    // Simula o dia no servidor (timeline completa), depois anima
    try {
      const res = await api.simDay(state.careerId, sim.date);
      dayResult = res.day;
      // Mantém phase 'live' até a crônica / ponteiro avançar
      sim = { ...res, phase: 'live', day: undefined };
    } catch (err) {
      simulating = false;
      toast(err.message);
      board.innerHTML = `<p class="loading">${esc(err.message)}</p>`;
      return view;
    }

    // Inicializa escalação em campo a partir do lineup devolvido
    const myLive = dayResult.matches.find((m) => m.mine);
    if (myLive?.lineup) {
      for (const p of myLive.lineup.starters) onPitch.set(p.id, p);
      for (const p of myLive.lineup.bench) onBench.set(p.id, p);
    }

    // Agrupa por confederação — a do jogador primeiro; jogo dele no topo
    const byConf = {};
    for (const m of dayResult.matches) {
      const conf = m.confederation ?? 'ICPO';
      byConf[conf] ??= [];
      byConf[conf].push({
        ...m,
        scoreH: 0,
        scoreA: 0,
        flash: false,
        pensH: null,
        pensA: null,
        notesH: [], // { kind, name, clock } — goal | yellow | red | sub_in | sub_out
        notesA: [],
      });
    }
    for (const conf of Object.keys(byConf)) {
      byConf[conf].sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.id - b.id);
    }

    function orderedConfEntries() {
      const entries = Object.entries(byConf);
      entries.sort(([a], [b]) => {
        if (a === myConf) return -1;
        if (b === myConf) return 1;
        if (a === 'ICPO') return 1;
        if (b === 'ICPO') return -1;
        return a.localeCompare(b);
      });
      return entries;
    }

    function orderedMatches() {
      return orderedConfEntries().flatMap(([, list]) => list);
    }

    function notesHtml(notes, align) {
      if (!notes.length) return `<div class="match__notes match__notes--${align}"></div>`;
      return `<div class="match__notes match__notes--${align}">
        ${notes.map((n) => {
          if (n.kind === 'goal') {
            return `<span class="match__note match__note--goal">⚽ ${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          }
          if (n.kind === 'yellow') {
            return `<span class="match__note match__note--card"><span class="match__card match__card--yellow" aria-hidden="true"></span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          }
          if (n.kind === 'red') {
            return `<span class="match__note match__note--card"><span class="match__card match__card--red" aria-hidden="true"></span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          }
          if (n.kind === 'sub_in') {
            return `<span class="match__note match__note--sub"><span class="match__sub-arrow match__sub-arrow--in" aria-label="entrou">↑</span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          }
          if (n.kind === 'sub_out') {
            return `<span class="match__note match__note--sub"><span class="match__sub-arrow match__sub-arrow--out" aria-label="saiu">↓</span>${esc(n.name)} <i>${esc(n.clock)}</i></span>`;
          }
          return '';
        }).join('')}
      </div>`;
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

    let filterExtra = false;

    const lineupsOverlay = document.createElement('div');
    lineupsOverlay.className = 'live__sub';
    lineupsOverlay.hidden = true;

    function sideHtml(side) {
      const flagImg = side.flag
        ? `<img class="tt__flag" src="/${esc(side.flag)}" alt="" loading="lazy" onerror="this.remove()">`
        : '';
      const badges = (p) => {
        let b = '';
        if (p.goals) b += `<span class="lu-row__badge lu-row__badge--goal">${'⚽'.repeat(p.goals)}</span>`;
        if (p.reds) b += '<span class="match__card match__card--red"></span>';
        else if (p.yellows) b += '<span class="match__card match__card--yellow"></span>'.repeat(p.yellows);
        return b;
      };
      const row = (p) =>
        `<li class="lu-row"><span class="lu-row__num">${p.shirt ?? ''}</span><span class="lu-row__pos" data-pos="${p.position}">${esc(p.position)}</span><span class="lu-row__name">${esc(p.name)}${badges(p)}</span><span class="lu-row__ov" data-tier="${overallTier(p.overall)}">${p.overall}</span></li>`;
      return `
        <div class="lu-side">
          <h3 class="qual__h3">${flagImg} ${esc(side.name)} <small>força ${side.strength ?? '?'}</small></h3>
          ${side.coach ? `<p class="qual__note">Técnico: ${esc(side.coach)}</p>` : ''}
          <ul class="lu-list">${side.starters.map(row).join('')}</ul>
          <h4 class="lu-label">Reservas</h4>
          <ul class="lu-list lu-list--bench">${side.bench.map(row).join('')}</ul>
        </div>`;
    }

    async function openLineupsDialog(matchId) {
      paused = true;
      pauseBtn.textContent = 'Retomar';
      lineupsOverlay.hidden = false;
      lineupsOverlay.innerHTML = `<div class="sub-modal sub-modal--wide"><p class="loading">Carregando escalações…</p></div>`;
      document.body.append(lineupsOverlay);
      try {
        const data = await api.matchLineups(state.careerId, matchId, { minute: currentMinute });
        lineupsOverlay.innerHTML = `
          <div class="sub-modal sub-modal--wide">
            <div class="sub-pick">${sideHtml(data.home)}${sideHtml(data.away)}</div>
            <div class="sub-modal__actions">
              <button class="btn btn--primary" data-close-lineups>Fechar</button>
            </div>
          </div>`;
      } catch (err) {
        lineupsOverlay.innerHTML = `
          <div class="sub-modal">
            <p class="qual__note">${esc(err.message)}</p>
            <div class="sub-modal__actions">
              <button class="btn btn--primary" data-close-lineups>Fechar</button>
            </div>
          </div>`;
      }
      return new Promise((resolve) => {
        lineupsOverlay.querySelector('[data-close-lineups]').addEventListener('click', () => {
          lineupsOverlay.hidden = true;
          try { lineupsOverlay.remove(); } catch { /* */ }
          paused = false;
          pauseBtn.textContent = 'Pausar';
          resolve();
        });
      });
    }

    function paintBoard() {
      board.innerHTML = orderedConfEntries().map(([conf, list]) => {
        const shown = filterExtra ? list.filter(needsExtra) : list;
        if (!shown.length) return '';
        return `
        <section class="live__conf${conf === myConf ? ' is-mine-conf' : ''}">
          <h3 class="qual__h3">${esc(conf === 'ICPO' ? 'Repescagem' : conf)}
            ${conf === myConf ? '<small>sua confederação</small>' : ''}</h3>
          <div class="matches live__matches">
            ${shown.map((m) => `
              <div class="match match--live${m.mine ? ' live__mine' : ''}${m.flash ? ' is-flash' : ''}" data-id="${m.id}" data-lineup-match="${m.id}">
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
        </section>`;
      }).join('');

      board.querySelectorAll('[data-lineup-match]').forEach((el) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openLineupsDialog(Number(el.dataset.lineupMatch));
        });
      });
    }

    // Achata eventos visíveis
    const allEvents = [];
    for (const m of dayResult.matches) {
      for (const e of m.events) {
        if (!['goal', 'yellow', 'red', 'sub', 'injury', 'half_time', 'full_time', 'et_end', 'penalties'].includes(e.type)) continue;
        allEvents.push({ ...e, matchId: m.id, mine: m.mine, home: m.home, away: m.away });
      }
    }
    allEvents.sort((a, b) => a.minute - b.minute || a.stoppage - b.stoppage);

    setClock(0, 0, 0);
    paintBoard();

    let idx = 0;

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
      } catch { /* autoplay / no audio */ }
    }

    function playerName(ev) {
      return ev.player_name || (ev.player_id ? `#${ev.player_id}` : '?');
    }

    async function tick() {
      let lastMin = 0;
      while (idx < allEvents.length) {
        while (paused) await sleep(100);
        const ev = allEvents[idx++];
        const halfMs = speeds[speedIdx].halfMs;
        const msPerMin = halfMs / 45;

        // Entra em prorrogação / pênaltis: fica só quem ainda joga
        if (ev.minute > 90 && lastMin <= 90) {
          filterExtra = true;
          paintBoard();
        }

        // Interpola o relógio até o minuto do evento
        const targetMin = ev.minute;
        for (let m = lastMin; m < targetMin; m++) {
          while (paused) await sleep(100);
          for (let s = 0; s < 4; s++) {
            setClock(m, 0, s * 15);
            await sleep(Math.max(8, msPerMin / 4));
            while (paused) await sleep(100);
          }
        }
        lastMin = targetMin;
        setClock(ev.minute, ev.stoppage || 0, 0);

        if (ev.type === 'penalties') periodEl.textContent = 'Pênaltis';
        else if (ev.minute > 90) periodEl.textContent = 'Prorrogação';

        for (const list of Object.values(byConf)) {
          for (const m of list) {
            m.flash = false;
            if (m.id !== ev.matchId) continue;

            if (ev.type === 'goal') {
              const scorer = playerName(ev);
              const clock = ev.clock || `${ev.minute}'`;
              if (ev.team === m.home) {
                m.scoreH++;
                pushNote(m, m.home, { kind: 'goal', name: scorer, clock });
              }
              if (ev.team === m.away) {
                m.scoreA++;
                pushNote(m, m.away, { kind: 'goal', name: scorer, clock });
              }
              if (m.mine) {
                m.flash = true;
                goalCrowd();
              }
            } else if (ev.type === 'yellow' || ev.type === 'red') {
              const clock = ev.clock || `${ev.minute}'`;
              const who = playerName(ev);
              // Quem já saiu / foi expulso não toma mais cartão
              if (ev.team === state.country && ev.player_id
                && (!onPitch.has(ev.player_id) || subbedOff.has(ev.player_id))) {
                continue;
              }
              pushNote(m, ev.team, { kind: ev.type, name: who, clock });
              if (ev.team === state.country && ev.player_id) {
                recordCard(ev.player_id, ev.type, clock);
                if (isSentOff(ev.player_id)) dismissSentOff(ev.player_id);
              }
            } else if (ev.type === 'sub') {
              // Nunca aplicar/exibir sub simulada da seleção do treinador — só as que ele pediu.
              if (ev.team === state.country) continue;

              const clock = ev.clock || `${ev.minute}'`;
              const inName = ev.player_name || playerName(ev);
              const outName = ev.assist_name || null;
              if (outName) pushNote(m, ev.team, { kind: 'sub_out', name: outName, clock });
              pushNote(m, ev.team, { kind: 'sub_in', name: inName, clock });
            } else if (ev.type === 'penalties') {
              const raw = dayResult.matches.find((x) => x.id === m.id);
              m.pensH = raw?.home_pens ?? m.home_pens;
              m.pensA = raw?.away_pens ?? m.away_pens;
            } else if (ev.type === 'injury' && ev.team === state.country) {
              const outId = ev.player_id;
              // Só lesiona quem ainda está em campo
              if (!outId || !onPitch.has(outId) || isSentOff(outId) || subbedOff.has(outId)) continue;
              const outName = ev.player_name || playerName(ev);
              const outPos = onPitch.get(outId)?.position || '';
              await openSubModal({
                mode: 'injury',
                injury: { outId, outName, outPos },
                moment: 'play',
              });
            } else if (ev.type === 'half_time' && m.mine && onPitch.size) {
              periodEl.textContent = 'Intervalo';
              await openSubModal({
                mode: 'break',
                breakTitle: 'Intervalo — substituição',
                moment: 'half_time',
              });
            } else if (ev.type === 'full_time' && m.mine && onPitch.size) {
              const raw = dayResult.matches.find((x) => x.id === m.id);
              const goesToEt = !!raw?.extra_time
                || allEvents.some((e) => e.matchId === m.id && (e.minute > 90 || e.type === 'penalties'));
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
          }
        }
        paintBoard();
        await sleep(Math.max(40, msPerMin * 0.2));
      }

      for (const list of Object.values(byConf)) {
        for (const m of list) {
          const raw = dayResult.matches.find((x) => x.id === m.id);
          m.scoreH = raw.home_goals;
          m.scoreA = raw.away_goals;
          m.pensH = raw.home_pens;
          m.pensA = raw.away_pens;
          m.flash = false;
        }
      }
      paintBoard();
      faceEl.textContent = filterExtra ? '120:00' : '90:00';
      periodEl.textContent = 'Fim';
      filterExtra = false;
      paintBoard();

      await sleep(800);
      try { modal.remove(); } catch { /* já removido */ }

      const matches = dayResult?.matches ?? [];
      const mine = matches.find((m) => m.home === state.country || m.away === state.country)
        ?? matches.find((m) => m.mine);

      if (mine) {
        holdingSummary = true;
        simulating = false;
        mountMatchSummary({
          careerId: state.careerId,
          matchId: mine.id,
          teams,
          country: state.country,
          preview: mine,
          tablesLabel: 'Ver tabelas',
          onTables: () => {
            holdingSummary = false;
            go('qualifiers');
          },
          continueLabel: 'Continuar',
          onContinue: () => {
            holdingSummary = false;
            go('qualifiers');
          },
        });
        return;
      }

      simulating = false;
      sim = await api.simContinue(state.careerId);
      await render();
    }

    tick().catch((err) => {
      simulating = false;
      console.error(err);
      toast(err.message || 'Falha ao finalizar a simulação');
      try { modal.remove(); } catch { /* ignore */ }
    });
    return view;
  }

  /* -------------------- ready (janela ok, sem jogo do jogador ainda) -------------------- */

  async function readyView() {
    const nextHint = sim.nextPlayerMatch
      ? `${esc(name(sim.nextPlayerMatch.home))} × ${esc(name(sim.nextPlayerMatch.away))} · ${esc(sim.nextPlayerMatch.dateLabel)}`
      : '';
    const view = html(`
      <section class="screen">
        <header class="qual__head">
          <div>
            <h2 class="screen__title">${esc(sim.window.label)}</h2>
            <p class="qual__meta">Próximo dia de jogos: <b>${esc(sim.dateLabel)}</b>
              · ${sim.dayMatches.length} partida(s)</p>
          </div>
        </header>
        <div class="matches" style="margin:20px 0">
          ${[...sim.dayMatches].sort((a, b) => {
            const ac = a.confederation === sim.career.confederation ? 0 : 1;
            const bc = b.confederation === sim.career.confederation ? 0 : 1;
            if (ac !== bc) return ac - bc;
            const am = a.home === state.country || a.away === state.country ? 0 : 1;
            const bm = b.home === state.country || b.away === state.country ? 0 : 1;
            return am - bm;
          }).slice(0, 12).map((m) => {
            const mine = m.home === state.country || m.away === state.country;
            return `
            <div class="match"${mine ? ' data-mine' : ''}>
              <span class="match__team match__team--home">${esc(name(m.home))}${flag(m.home)}</span>
              <span class="match__score match__score--todo">×</span>
              <span class="match__team">${flag(m.away)}${esc(name(m.away))}</span>
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
      // Força fase live
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
        sim = await api.simSkipToMe(state.careerId);
        toast(sim.skipped
          ? `${sim.skipped} dia(s) simulado(s) até o seu jogo`
          : 'Você já está no dia do seu jogo');
        await render();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        if (goBtn) goBtn.disabled = false;
        btn.textContent = 'Avançar para meu jogo';
      }
    });
    view.querySelector('[data-tables]').addEventListener('click', () => go('qualifiers'));
    return view;
  }

  /* -------------------- post (fallback se cair aqui) -------------------- */

  async function postView() {
    const view = html(`
      <section class="screen">
        <h2 class="screen__title">Fim do dia — ${esc(sim.dateLabel)}</h2>
        <p class="screen__subtitle">Confira as tabelas e continue para o próximo dia / Data FIFA.</p>
        <button class="btn btn--primary" data-tables>Ver classificação</button>
        <button class="btn btn--ghost" data-next style="margin-left:10px">Continuar</button>
      </section>
    `);
    view.querySelector('[data-tables]').addEventListener('click', () => go('qualifiers'));
    view.querySelector('[data-next]').addEventListener('click', async () => {
      sim = await api.simContinue(state.careerId);
      await render();
    });
    return view;
  }

  await render();
  return el;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
