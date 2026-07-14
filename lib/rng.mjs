/**
 * Aleatoriedade determinística.
 *
 * Toda a simulação — sorteios, gols, pênaltis — sai daqui. Semear com a carreira faz
 * a mesma carreira produzir sempre os mesmos resultados: recarregar a página não
 * reescreve a história, e um bug é sempre reproduzível.
 */

/** Converte uma string em uma semente de 32 bits (FNV-1a). */
export function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — pequeno, rápido e de qualidade suficiente para um simulador. */
export function rngFrom(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : seedFrom(seed);
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Inteiro em [0, n). */
  rng.int = (n) => Math.floor(rng() * n);

  /** Embaralhamento Fisher-Yates (não altera o array original). */
  rng.shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  /** Amostra de uma Poisson(λ) — o número de gols de um time numa partida. */
  rng.poisson = (lambda) => {
    if (lambda <= 0) return 0;
    // Knuth: multiplica uniformes até cair abaixo de e^-λ.
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng();
    } while (p > limit && k < 30);
    return k - 1;
  };

  return rng;
}
