import { api } from '../api.js';
import { esc, html, toast } from '../ui.js';

/**
 * Tela de crônica (partida, rodada, fase ou final).
 * `fetcher` devolve { summary, competition?, title?, subtitle?, match? }.
 */
export function chronicleView({
  title = 'Crônica',
  teams,
  country,
  preview = null,
  tablesLabel = 'Ver tabelas',
  onTables,
  continueLabel = 'Continuar',
  onContinue,
  fetcher,
}) {
  const name = (code) => teams[code]?.name ?? code;
  const flag = (code) => {
    const src = teams[code]?.flag;
    return src ? `<img class="tt__flag" src="/${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  };

  const view = html(`
    <section class="screen screen--wide report">
      <header class="qual__head">
        <div>
          <h2 class="screen__title" data-title>${esc(title)}</h2>
          <p class="qual__meta" data-meta>Gerando o resumo…</p>
        </div>
      </header>
      <div class="report__score" data-score></div>
      <article class="report__body" data-body>
        <p class="loading">O cronista está escrevendo…</p>
      </article>
      <div class="qual__actions report__actions" data-actions hidden>
        <button class="btn btn--primary" data-next>${esc(continueLabel)}</button>
        <button class="btn btn--ghost" data-tables>${esc(tablesLabel)}</button>
      </div>
    </section>
  `);

  const titleEl = view.querySelector('[data-title]');
  const meta = view.querySelector('[data-meta]');
  const scoreBox = view.querySelector('[data-score]');
  const body = view.querySelector('[data-body]');
  const actions = view.querySelector('[data-actions]');

  function paintScore(m) {
    if (!m) {
      scoreBox.innerHTML = '';
      return;
    }
    const pens = m.home_pens != null
      ? `<small>(${m.home_pens}–${m.away_pens})</small>`
      : '';
    const et = m.extra_time && m.home_pens == null ? '<small>pror.</small>' : '';
    const homeName = m.home_name ?? name(m.home);
    const awayName = m.away_name ?? name(m.away);
    scoreBox.innerHTML = `
      <div class="match report__match"${m.home === country || m.away === country ? ' data-mine' : ''}>
        <span class="match__team match__team--home">
          <span class="match__name${m.home === country ? ' is-mine' : ''}">${esc(homeName)}</span>
          ${flag(m.home)}
        </span>
        <span class="match__score">${pens}${m.home_goals}<i>-</i>${m.away_goals}${et}</span>
        <span class="match__team">
          ${flag(m.away)}
          <span class="match__name${m.away === country ? ' is-mine' : ''}">${esc(awayName)}</span>
        </span>
      </div>`;
  }

  function bindActions() {
    actions.hidden = false;
    const next = view.querySelector('[data-next]');
    const tables = view.querySelector('[data-tables]');
    next.replaceWith(next.cloneNode(true));
    tables.replaceWith(tables.cloneNode(true));
    view.querySelector('[data-next]').addEventListener('click', () => onContinue?.());
    view.querySelector('[data-tables]').addEventListener('click', () => onTables?.());
  }

  if (preview) {
    paintScore({
      home: preview.home,
      away: preview.away,
      home_goals: preview.home_goals ?? preview.scoreH ?? 0,
      away_goals: preview.away_goals ?? preview.scoreA ?? 0,
      home_pens: preview.home_pens ?? preview.pensH ?? null,
      away_pens: preview.away_pens ?? preview.pensA ?? null,
      extra_time: preview.extra_time,
    });
  }

  (async () => {
    try {
      const data = await fetcher();
      if (data.title) titleEl.textContent = data.title;
      const m = data.match;
      meta.textContent = [
        data.subtitle,
        data.competition,
        m?.stage_name,
        m?.group_name ? `Grupo ${m.group_name}` : null,
        m?.dateLabel,
      ].filter(Boolean).join(' · ');
      if (m) paintScore(m);
      else if (!preview) scoreBox.innerHTML = '';

      const paragraphs = String(data.summary || '')
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
      body.innerHTML = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')
        || `<p>${esc(data.summary || '')}</p>`;
      bindActions();
    } catch (err) {
      body.innerHTML = `<p class="qual__note">Não foi possível gerar a crônica: ${esc(err.message)}</p>`;
      meta.textContent = 'Resumo indisponível';
      bindActions();
      toast(err.message);
    }
  })();

  return view;
}

/**
 * Tela de crônica pós-partida (IA) — jogos da seleção do técnico.
 */
export function matchSummaryView(opts) {
  const { careerId, matchId, ...rest } = opts;
  return chronicleView({
    ...rest,
    title: 'Crônica da partida',
    fetcher: () => api.matchSummary(careerId, matchId),
  });
}

/** Monta a crônica no `#screen`, por cima de qualquer tela atual. */
export function mountMatchSummary(opts) {
  const root = document.getElementById('screen');
  const view = matchSummaryView(opts);
  if (root) root.replaceChildren(view);
  return view;
}

export function mountChronicle(opts) {
  const root = document.getElementById('screen');
  const view = chronicleView(opts);
  if (root) root.replaceChildren(view);
  return view;
}

/**
 * Fila: crônica do jogo do técnico (se houver) + resumos de rodada/fase/final.
 * `after` roda quando a fila termina.
 */
export function playCupChronicleQueue({
  careerId,
  teams,
  country,
  playerMatch = null,
  chronicles = [],
  dayStillPending = false,
  go,
}) {
  const queue = [];
  if (playerMatch) {
    queue.push({
      kind: 'match',
      title: 'Crônica da partida',
      preview: playerMatch,
      fetcher: () => api.matchSummary(careerId, playerMatch.id),
    });
  }
  for (const c of chronicles) {
    if (c.kind === 'round') {
      queue.push({
        kind: 'round',
        title: `Crônica da ${c.matchday}ª rodada`,
        fetcher: () => api.cupRoundSummary(careerId, c.matchday),
      });
    } else if (c.kind === 'phase') {
      queue.push({
        kind: 'phase',
        title: 'Crônica da fase',
        fetcher: () => api.cupPhaseSummary(careerId, c.stageKey),
      });
    } else if (c.kind === 'final') {
      queue.push({
        kind: 'final',
        title: 'Crônica da final',
        fetcher: () => api.cupFinalSummary(careerId),
      });
    }
  }

  if (!queue.length) {
    return Promise.resolve({ skipped: true });
  }

  let i = 0;
  return new Promise((resolve) => {
    const showNext = () => {
      if (i >= queue.length) {
        resolve({ skipped: false });
        return;
      }
      const item = queue[i++];
      const last = i >= queue.length;
      mountChronicle({
        title: item.title,
        teams,
        country,
        preview: item.preview ?? null,
        tablesLabel: 'Ver tabelas',
        continueLabel: last
          ? (dayStillPending ? 'Próximos jogos' : 'Ver tabelas da Copa')
          : 'Continuar leitura',
        onTables: () => {
          go('worldcup');
          resolve({ skipped: false, wentTables: true });
        },
        onContinue: async () => {
          if (!last) {
            showNext();
            return;
          }
          if (dayStillPending) {
            await api.cupContinue(careerId);
            await go('cupsim');
          } else {
            await go('worldcup');
          }
          resolve({ skipped: false });
        },
        fetcher: item.fetcher,
      });
    };
    showNext();
  });
}
