/** Utilitários de UI compartilhados pelas telas. */

/** Cria um elemento a partir de HTML. */
export function html(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

/** Escapa texto vindo de dados públicos antes de injetar no HTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
export function toast(message, kind = 'error') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind === 'ok' ? 'ok' : 'error';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

export const POSITION_LABEL = {
  GK: 'Goleiros',
  DF: 'Defensores',
  MF: 'Meio-campistas',
  FW: 'Atacantes',
};

export const POSITION_ORDER = ['GK', 'DF', 'MF', 'FW'];

export function overallTier(overall) {
  if (overall >= 84) return 'elite';
  if (overall >= 76) return 'great';
  return 'normal';
}

/** Imagem que some sozinha quando o arquivo não existe (nem toda federação tem escudo). */
export function imgOrNothing(src, className, alt = '') {
  if (!src) return '';
  return `<img src="/${esc(src)}" class="${className}" alt="${esc(alt)}" loading="lazy"
               onerror="this.remove()">`;
}
