/** SM2026 — roteador de telas e estado da carreira. */
import { api } from './api.js';
import { esc, imgOrNothing } from './ui.js';
import { coachScreen } from './screens/coach.js';
import { confederationScreen } from './screens/confederation.js';
import { countryScreen } from './screens/country.js';
import { squadScreen } from './screens/squad.js';
import { readyScreen } from './screens/ready.js';
import { qualifiersScreen } from './screens/qualifiers.js';
import { simScreen } from './screens/sim.js';
import { drawScreen } from './screens/draw.js';
import { worldCupScreen } from './screens/worldcup.js';
import { cupSimScreen } from './screens/cupsim.js';
import { realCupScreen } from './screens/realcup.js';

const STORAGE_KEY = 'sm2026';

const state = {
  ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'),
  save() {
    const { coachName, confederation, country, careerId } = this;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ coachName, confederation, country, careerId }));
  },
  reset() {
    this.coachName = this.confederation = this.country = this.careerId = undefined;
    localStorage.removeItem(STORAGE_KEY);
  },
};

const SCREENS = {
  coach: { render: coachScreen, back: null, step: 'coach' },
  realcup: { render: realCupScreen, back: 'coach', step: 'coach' },
  confederation: { render: confederationScreen, back: 'coach', step: 'confederation' },
  country: { render: countryScreen, back: 'confederation', step: 'country' },
  squad: { render: squadScreen, back: 'country', step: 'squad' },
  ready: { render: readyScreen, back: null, step: 'squad' },
  sim: { render: simScreen, back: null, step: 'qualifiers' },
  qualifiers: { render: qualifiersScreen, back: null, step: 'qualifiers' },
  draw: { render: drawScreen, back: null, step: 'worldcup' },
  worldcup: { render: worldCupScreen, back: null, step: 'worldcup' },
  cupsim: { render: cupSimScreen, back: null, step: 'worldcup' },
};

const STEP_ORDER = ['coach', 'confederation', 'country', 'squad', 'qualifiers', 'worldcup'];

const root = document.getElementById('screen');
const topbar = document.querySelector('.topbar');
const backBtn = document.querySelector('[data-back]');
const resetBtn = document.querySelector('[data-reset]');
const teamBadge = document.querySelector('[data-topbar-team]');

/** Guarda: não dá para pular etapas (nem recarregando a página numa tela adiantada). */
function guard(name) {
  if (name !== 'coach' && name !== 'realcup' && !state.coachName) return 'coach';
  if (!['coach', 'realcup', 'confederation'].includes(name) && !state.confederation) {
    return 'confederation';
  }
  if (['squad', 'ready', 'sim', 'qualifiers', 'draw', 'worldcup', 'cupsim'].includes(name)
      && !(state.country && state.careerId)) {
    return 'country';
  }
  return name;
}

let current = null;
let navToken = 0;

async function go(name) {
  const token = ++navToken;
  current = guard(name);
  state.save();

  const screen = SCREENS[current];
  renderChrome(screen);

  root.innerHTML = '<p class="loading">Carregando…</p>';
  try {
    const view = await screen.render({ state, go });
    if (token !== navToken) return; // navegação mais nova sobrescreveu
    root.replaceChildren(view);
    window.scrollTo({ top: 0 });
  } catch (err) {
    if (token !== navToken) return;
    root.innerHTML = `<p class="loading">${esc(err.message || 'Falha ao carregar')}</p>`;
  }
}

function renderChrome(screen) {
  topbar.hidden = current === 'coach' || current === 'realcup';
  backBtn.disabled = !screen.back;
  backBtn.onclick = () => screen.back && go(screen.back);

  if (resetBtn) {
    resetBtn.hidden = current === 'coach' || current === 'realcup';
    resetBtn.onclick = () => {
      if (!confirm('Reiniciar a simulação desde o início? O progresso desta carreira será abandonado neste dispositivo.')) {
        return;
      }
      state.reset();
      go('coach');
    };
  }

  const at = STEP_ORDER.indexOf(screen.step);
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.dataset.state = i < at ? 'done' : i === at ? 'current' : 'todo';
  });

  renderTeamBadge();
}

async function renderTeamBadge() {
  teamBadge.innerHTML = '';
  if (!state.coachName) return;

  let team = '';
  if (state.country) {
    try {
      const c = await api.country(state.country);
      team = `${imgOrNothing(c.flag, '', c.name)}<span>${esc(c.name)}</span>`;
    } catch { /* sem seleção ainda */ }
  }
  teamBadge.innerHTML = `${team}<small>${esc(state.coachName)}</small>`;
}

/** Retoma a carreira salva no ponto certo. */
async function boot() {
  if (state.careerId) {
    try {
      const career = await api.career(state.careerId);
      if (career.started) {
        if (career.stage === 'world_cup' || career.stage === 'eliminated') {
          try {
            const draw = await api.drawPreview(state.careerId);
            if (!draw.drawn) return go('draw');
            const sim = await api.cupSim(state.careerId);
            if (sim.phase === 'done') return go('worldcup');
            if (sim.phase === 'post') return go('worldcup');
            return go('cupsim');
          } catch {
            return go('qualifiers');
          }
        }
        return go('sim');
      }
      return go(career.squad.length ? 'ready' : 'squad');
    } catch {
      state.reset();
    }
  }
  go(state.confederation ? 'country' : state.coachName ? 'confederation' : 'coach');
}

boot();
