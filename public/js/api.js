/** Cliente da API do SM2026. */

async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

const post = (url, body) =>
  request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const api = {
  confederations: () => request('/api/confederations'),
  countries: (conf) => request(`/api/confederations/${conf}/countries`),
  country: (code) => request(`/api/countries/${code}`),
  players: (code, careerId) =>
    request(`/api/countries/${code}/players${careerId ? `?career=${careerId}` : ''}`),
  createCareer: (coach_name, country_code) => post('/api/careers', { coach_name, country_code }),
  career: (id) => request(`/api/careers/${id}`),
  saveSquad: (id, payload) => post(`/api/careers/${id}/squad`, payload),

  realWorldCupPreview: () => request('/api/worldcup/real'),
  startRealWorldCup: (coach_name, country_code) =>
    post('/api/worldcup/real', { coach_name, country_code }),

  startQualifiers: (id) => post(`/api/careers/${id}/qualifiers`, {}),
  advance: (id) => post(`/api/careers/${id}/qualifiers/advance`, {}),
  simulate: (id) => post(`/api/careers/${id}/qualifiers/simulate`, {}),
  world: (id) => request(`/api/careers/${id}/world`),
  allCountries: () => request('/api/countries'),
  qualifiers: (id) => request(`/api/careers/${id}/qualifiers`),
  scorers: (id, { confederation, scope } = {}) => {
    const q = new URLSearchParams();
    if (scope) q.set('scope', scope);
    if (confederation) q.set('confederation', confederation);
    const qs = q.toString();
    return request(`/api/careers/${id}/scorers${qs ? `?${qs}` : ''}`);
  },

  sim: (id) => request(`/api/careers/${id}/sim`),
  simCallUp: (id, payload) => post(`/api/careers/${id}/sim/call-up`, payload),
  simLineup: (id, payload) => post(`/api/careers/${id}/sim/lineup`, payload),
  simDay: (id, date) => post(`/api/careers/${id}/sim/day`, { date }),
  simContinue: (id) => post(`/api/careers/${id}/sim/continue`, {}),
  simSkipToMe: (id) => post(`/api/careers/${id}/sim/skip-to-me`, {}),
  formations: () => request('/api/formations'),

  drawPreview: (id) => request(`/api/careers/${id}/worldcup/draw`),
  runDraw: (id) => post(`/api/careers/${id}/worldcup/draw`, {}),
  worldCup: (id) => request(`/api/careers/${id}/worldcup`),
  cupSim: (id) => request(`/api/careers/${id}/worldcup/sim`),
  cupCallUp: (id, payload) => post(`/api/careers/${id}/worldcup/sim/call-up`, payload),
  cupLineup: (id, payload) => post(`/api/careers/${id}/worldcup/sim/lineup`, payload),
  cupSlot: (id, date, kickoff) => post(`/api/careers/${id}/worldcup/sim/slot`, { date, kickoff }),
  cupContinue: (id) => post(`/api/careers/${id}/worldcup/sim/continue`, {}),
  cupSkipToMe: (id) => post(`/api/careers/${id}/worldcup/sim/skip-to-me`, {}),
  matchSummary: (careerId, matchId) =>
    post(`/api/careers/${careerId}/matches/${matchId}/summary`, {}),
  cupRoundSummary: (careerId, matchday) =>
    post(`/api/careers/${careerId}/worldcup/summary/round`, { matchday }),
  cupPhaseSummary: (careerId, stageKey) =>
    post(`/api/careers/${careerId}/worldcup/summary/phase`, { stageKey }),
  cupFinalSummary: (careerId) =>
    post(`/api/careers/${careerId}/worldcup/summary/final`, {}),
};

/** As 211 seleções, por código — as telas das Eliminatórias falam em BRA, ARG, JPN… */
let index;
export async function teamIndex() {
  index ??= Object.fromEntries((await api.allCountries()).map((c) => [c.code, c]));
  return index;
}
