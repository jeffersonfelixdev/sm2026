/** Metadados fixos: confederações, nomes em pt-BR e apelidos para casar com o ranking FIFA. */

export const CONFEDERATIONS = [
  { code: 'CONMEBOL', full_name: 'Confederação Sul-Americana de Futebol', region: 'América do Sul', wiki: 'CONMEBOL', color: '#0a7d4f' },
  { code: 'CONCACAF', full_name: 'Confederação de Futebol da América do Norte, Central e Caribe', region: 'América do Norte, Central e Caribe', wiki: 'CONCACAF', color: '#c8102e' },
  { code: 'UEFA', full_name: 'União das Associações Europeias de Futebol', region: 'Europa', wiki: 'UEFA', color: '#1b3f94' },
  { code: 'AFC', full_name: 'Confederação Asiática de Futebol', region: 'Ásia', wiki: 'Asian Football Confederation', color: '#e4002b' },
  { code: 'CAF', full_name: 'Confederação Africana de Futebol', region: 'África', wiki: 'Confederation of African Football', color: '#0b7a3b' },
  { code: 'OFC', full_name: 'Confederação de Futebol da Oceania', region: 'Oceania', wiki: 'Oceania Football Confederation', color: '#00539f' },
];

/** Nome do artigo na Wikipédia → nome em português. Preenchido em meta-names.mjs. */
export { NAME_PT } from './meta-names.mjs';

/** Casos em que o Ranking FIFA usa um nome diferente do artigo da seleção. */
export const RANKING_ALIASES = {
  'United States': 'USA',
  'United States Virgin Islands': 'US Virgin Islands',
  'Saint Kitts and Nevis': 'St Kitts and Nevis',
  'Saint Lucia': 'St Lucia',
  'Saint Vincent and the Grenadines': 'St Vincent and the Grenadines',
  'Czech Republic': 'Czechia',
  'Republic of Ireland': 'Republic of Ireland',
  'New Zealand': 'Aotearoa New Zealand',
  Iran: 'IR Iran',
  China: 'China PR',
  'South Korea': 'Korea Republic',
  'North Korea': 'Korea DPR',
  Brunei: 'Brunei Darussalam',
  Kyrgyzstan: 'Kyrgyz Republic',
  'Ivory Coast': "Côte d'Ivoire",
  'DR Congo': 'Congo DR',
  'Cape Verde': 'Cabo Verde',
  Gambia: 'The Gambia',
};
