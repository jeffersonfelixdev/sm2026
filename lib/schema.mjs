/**
 * Tabelas da fase de Eliminatórias e do loop por Data FIFA.
 *
 * Ficam separadas do resto do schema porque são as únicas que crescem DEPOIS do seed:
 * cada carreira gera as suas (~900 partidas — o mundo inteiro disputando a Copa). O seed
 * cria as tabelas junto com o banco, e o servidor roda o mesmo SQL na subida para que um
 * banco antigo ganhe as tabelas novas sem precisar refazer a coleta.
 */
export const QUALIFIER_SCHEMA = `
-- Uma fase de uma competição dentro de uma carreira (grupos da UEFA, quarta fase da AFC…).
CREATE TABLE IF NOT EXISTS stages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  career_id     INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  confederation TEXT,                        -- NULL na repescagem intercontinental
  ord           INTEGER NOT NULL,            -- ordem cronológica dentro da carreira
  key           TEXT NOT NULL,               -- afc_r3, uefa_groups, icpo_final…
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('groups','knockout')),
  legs          INTEGER NOT NULL DEFAULT 1,
  neutral       INTEGER NOT NULL DEFAULT 0,
  tiebreak      TEXT NOT NULL DEFAULT 'fifa',
  matchdays     INTEGER NOT NULL,
  -- Linhas de corte do grupo: até "advance" a seleção passa direto; da posição seguinte até
  -- "playoff" ela ainda tem uma segunda chance (repescagem ou fase extra). Iguais = não há
  -- segunda chance. É o que a tabela na tela pinta de verde e de âmbar.
  advance       INTEGER,
  playoff       INTEGER,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done'))
);
CREATE INDEX IF NOT EXISTS idx_stages_career ON stages(career_id, ord);

CREATE TABLE IF NOT EXISTS groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_stage ON groups(stage_id);

CREATE TABLE IF NOT EXISTS group_teams (
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code),
  pot          INTEGER,
  PRIMARY KEY (group_id, country_code)
);

-- Um confronto de mata-mata; em ida e volta ele agrupa as duas partidas.
CREATE TABLE IF NOT EXISTS ties (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  home     TEXT NOT NULL REFERENCES countries(code),  -- mandante do jogo único ou da ida
  away     TEXT NOT NULL REFERENCES countries(code)
);
CREATE INDEX IF NOT EXISTS idx_ties_stage ON ties(stage_id);

CREATE TABLE IF NOT EXISTS matches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  career_id  INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  stage_id   INTEGER NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  group_id   INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  tie_id     INTEGER REFERENCES ties(id) ON DELETE CASCADE,
  matchday   INTEGER NOT NULL,
  leg        INTEGER NOT NULL DEFAULT 1,
  home       TEXT NOT NULL REFERENCES countries(code),
  away       TEXT NOT NULL REFERENCES countries(code),
  neutral    INTEGER NOT NULL DEFAULT 0,
  home_goals INTEGER,
  away_goals INTEGER,
  home_pens  INTEGER,                        -- só quando a decisão foi nos pênaltis
  away_pens  INTEGER,
  extra_time INTEGER NOT NULL DEFAULT 0,
  played     INTEGER NOT NULL DEFAULT 0,
  date       TEXT,                           -- ISO YYYY-MM-DD (Data FIFA / Copa)
  kickoff    TEXT                            -- HH:MM (Copa: um jogo por horário; MD3 = mesmo kickoff)
);
CREATE INDEX IF NOT EXISTS idx_matches_stage ON matches(stage_id, matchday);
CREATE INDEX IF NOT EXISTS idx_matches_career ON matches(career_id);

-- As 48 seleções da Copa, à medida que vão se classificando.
CREATE TABLE IF NOT EXISTS qualified (
  career_id    INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code),
  route        TEXT NOT NULL,                -- host | UEFA | CAF | … | playoff
  note         TEXT,                         -- "anfitrião", "1º do Grupo C", "repescagem"…
  PRIMARY KEY (career_id, country_code)
);

-- Janelas do International Match Calendar para esta carreira.
CREATE TABLE IF NOT EXISTS fifa_windows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  career_id  INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  label      TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  UNIQUE (career_id, ord)
);

-- Convocações das seleções da CPU (a do jogador fica em call_ups).
CREATE TABLE IF NOT EXISTS team_call_ups (
  career_id    INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  shirt        INTEGER,
  PRIMARY KEY (career_id, country_code, player_id)
);
CREATE INDEX IF NOT EXISTS idx_team_call_ups_career ON team_call_ups(career_id, country_code);

-- Eventos minutados de uma partida.
CREATE TABLE IF NOT EXISTS match_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  minute     INTEGER NOT NULL,
  stoppage   INTEGER NOT NULL DEFAULT 0,
  type       TEXT NOT NULL,
  team       TEXT,
  player_id  INTEGER REFERENCES players(id),
  assist_id  INTEGER REFERENCES players(id),
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS idx_match_events_match ON match_events(match_id);

-- Escalação de uma partida.
CREATE TABLE IF NOT EXISTS lineups (
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  is_starter   INTEGER NOT NULL DEFAULT 0,
  position_slot TEXT,
  PRIMARY KEY (match_id, player_id)
);

-- Suspensões, lesões e última atuação por carreira.
CREATE TABLE IF NOT EXISTS player_availability (
  career_id      INTEGER NOT NULL REFERENCES careers(id) ON DELETE CASCADE,
  player_id      INTEGER NOT NULL REFERENCES players(id),
  yellows        INTEGER NOT NULL DEFAULT 0,
  suspended_until TEXT,
  injured_until  TEXT,
  injury_note    TEXT,
  last_rating    REAL,
  PRIMARY KEY (career_id, player_id)
);
`;

/** Migrações leves para bancos criados antes das colunas novas. */
export function migrateSchema(db) {
  const cols = (table) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    } catch {
      return [];
    }
  };

  const matchCols = cols('matches');
  if (matchCols.length && !matchCols.includes('date')) {
    db.exec('ALTER TABLE matches ADD COLUMN date TEXT');
  }
  if (matchCols.length && !matchCols.includes('kickoff')) {
    db.exec('ALTER TABLE matches ADD COLUMN kickoff TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(career_id, date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(career_id, date, kickoff)');

  const careerCols = cols('careers');
  if (careerCols.length) {
    if (!careerCols.includes('sim_date')) {
      db.exec('ALTER TABLE careers ADD COLUMN sim_date TEXT');
    }
    if (!careerCols.includes('window_ord')) {
      db.exec('ALTER TABLE careers ADD COLUMN window_ord INTEGER NOT NULL DEFAULT 0');
    }
    if (!careerCols.includes('callup_done')) {
      db.exec('ALTER TABLE careers ADD COLUMN callup_done INTEGER NOT NULL DEFAULT 0');
    }
  }
}
