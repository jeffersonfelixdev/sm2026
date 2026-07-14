# SM2026 — Rumo à Copa do Mundo

Simulador de carreira de treinador: você assume **uma das 211 seleções filiadas à FIFA**, disputa
as **Eliminatórias** da sua confederação e, se passar, joga a **Copa do Mundo de 2026**. 
Ou pode ir direto para a Copa do Mundo 2026, e escolher uma das 48 seleções classificadas da vida real.

HTML/CSS/JS puros no navegador, Node + SQLite no servidor, **zero dependências** (usa o
`node:sqlite`, embutido no Node 22.5+).

## Preparando .env

Copie o arquivo .env.example para .env:

```bash
cp .env.example .env
```

E adicione sua chave do GPT para geração de crônicas de partida.

## Rodando

```bash
npm run build   # coleta os dados públicos e monta db/sm2026.db (leva ~5 min na primeira vez)
npm start       # http://localhost:3000
```

`npm run build` = `fetch` (baixa dados e imagens) + `seed` (monta o banco). O wikitexto fica em
cache em `data/cache/`, então reexecutar é rápido. Para refazer a coleta do zero, apague essa pasta.


## Fontes de dados (todas públicas)

| Dado | Fonte |
| --- | --- |
| As 211 seleções, por confederação | Wikipédia — *List of men's national association football teams* |
| Código FIFA de 3 letras | Wikipédia — *List of FIFA country codes* |
| Ranking FIFA (posição e pontos) | Wikipédia — *Module:SportsRankings/data/FIFA World Rankings* |
| Elenco, convocados recentes e técnico | Wikipédia — artigo de cada seleção |
| Bandeiras | Wikimedia Commons |
| Logos das confederações | Wikimedia / Wikipédia |
| Escudos das federações nacionais | TheSportsDB |

> **Os atributos de jogo são derivados, não oficiais.** Overall e atributos (ritmo, finalização,
> passe, drible, defesa, físico, goleiro) são calculados em `scripts/seed.mjs` a partir de dados
> reais — Ranking FIFA da seleção, jogos e gols do jogador, idade e posição — com uma variação
> determinística por jogador. Nenhuma dessas notas vem de fonte oficial.
