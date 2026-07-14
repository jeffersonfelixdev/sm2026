/**
 * Regras FIFA/IFAB de substituição (Law 3) para jogos oficiais de seleções A.
 *
 * - Até 5 substituições no tempo regulamentar
 * - Até 3 janelas de substituição (oportunidades)
 * - Intervalo e intervalo antes da prorrogação NÃO consomem janela
 * - Na prorrogação: +1 substituição e +1 janela (não usados no 1º tempo carregam)
 * - Vários jogadores na mesma parada = 1 janela, N substituições
 */
export const FIFA_SUBS = {
  maxRegulation: 5,
  maxWindowsRegulation: 3,
  extraInExtraTime: 1,
  extraWindowInExtraTime: 1,
};

/** Limites vigentes conforme o jogo já está na prorrogação ou não. */
export function subLimits(inExtraTime) {
  return {
    maxSubs: FIFA_SUBS.maxRegulation + (inExtraTime ? FIFA_SUBS.extraInExtraTime : 0),
    maxWindows: FIFA_SUBS.maxWindowsRegulation + (inExtraTime ? FIFA_SUBS.extraWindowInExtraTime : 0),
  };
}

/**
 * Janelas “livres”: não contam como opportunity (intervalo HT, pré-ET, HT da prorrogação).
 * @param {'play'|'half_time'|'pre_et'|'et_half'} moment
 */
export function isFreeSubWindow(moment) {
  return moment === 'half_time' || moment === 'pre_et' || moment === 'et_half';
}
