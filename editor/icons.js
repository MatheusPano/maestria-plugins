// Os ícones dos arquivos e das pastas, como os do VS Code: a cor e a marca de
// cada tipo, pra achar o arquivo pela forma antes de ler o nome. Cada um é um
// svg inteiro de 16×16, com as cores dele -- a Maestria desenha como veio (o
// `avatar.svg` de um item de lista, o `Svg` do rfw), sem pintar por cima.

'use strict';

const path = require('path');
const { CAP_HEIGHT, GLYPHS } = require('./glyphs');

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`;

// --- as formas ---------------------------------------------------------------------

/**
 * As letras em contornos (ver `glyphs.js`), centradas em `cx`, com a base em
 * `baseline` e a altura de uma maiúscula `cap`. Encolhem pra caber em `maxWidth`.
 */
function word(text, { cx = 8, baseline, cap, maxWidth = 12.4, fill }) {
  let s = cap / CAP_HEIGHT;
  const chars = [...text].filter((c) => GLYPHS[c]);
  const advance = chars.reduce((sum, c) => sum + GLYPHS[c][0], 0);
  if (advance * s > maxWidth) s = maxWidth / advance;
  let x = cx - (advance * s) / 2;
  let out = '';
  for (const c of chars) {
    const [w, d] = GLYPHS[c];
    out += `<path transform="translate(${x.toFixed(2)} ${baseline}) scale(${s.toFixed(5)} ${(-s).toFixed(5)})" d="${d}" fill="${fill}"/>`;
    x += w * s;
  }
  return out;
}

/** Um selo com letras: o JS amarelo, o TS azul. */
function badge(bg, fg, text) {
  const cap = text.length >= 3 ? 4.6 : text.length === 2 ? 5.6 : 7.4;
  return svg(
    `<rect x="1" y="1.5" width="14" height="13" rx="2.6" fill="${bg}"/>` +
      word(text, { baseline: 8 + cap / 2, cap, fill: fg }),
  );
}

/** Só as letras, sem selo: o `{}` do json, o `<>` do html. */
function letters(color, text) {
  return svg(word(text, { baseline: 12, cap: 8.6, maxWidth: 14.5, fill: color }));
}

/** A folha com a ponta dobrada, numa cor, com um traço de linhas dentro. */
function page(color, lines = true) {
  return svg(
    `<path d="M3.5 1h5.8L13 4.7V14a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="${color}"/>` +
      `<path d="M9.3 1v2.7a1 1 0 0 0 1 1H13z" fill="#000" fill-opacity=".25"/>` +
      (lines ? '<path d="M5 8h6M5 10.2h6M5 12.4h4" stroke="#fff" stroke-opacity=".75" stroke-width="1.1" stroke-linecap="round"/>' : ''),
  );
}

/** A folha com uma marca no lugar das linhas. */
function pageWith(color, mark) {
  return svg(
    `<path d="M3.5 1h5.8L13 4.7V14a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="${color}"/>` +
      `<path d="M9.3 1v2.7a1 1 0 0 0 1 1H13z" fill="#000" fill-opacity=".25"/>` +
      mark,
  );
}

const DART = svg(
  '<path d="M4.2 1.4 1.6 4l3.6 9.3 7.6.1 1.6-1.6V5.6L10 1.4z" fill="#0175C2"/>' +
    '<path d="M4.2 1.4 10 1.4l4.4 4.2v6.2L4.2 1.4z" fill="#40C4FF"/>' +
    '<path d="M1.6 4 12.8 13.4H5.4z" fill="#29B6F6" fill-opacity=".85"/>',
);

const GIT = svg(
  '<path d="M15.2 7.3 8.7.8a1 1 0 0 0-1.4 0L5.9 2.2l1.8 1.8a1.2 1.2 0 0 1 1.5 1.5L11 7.3a1.2 1.2 0 1 1-.7.7L8.6 6.3v4.4a1.2 1.2 0 1 1-1-.1V6.2a1.2 1.2 0 0 1-.6-1.6L5.2 2.9.8 7.3a1 1 0 0 0 0 1.4l6.5 6.5a1 1 0 0 0 1.4 0l6.5-6.5a1 1 0 0 0 0-1.4z" fill="#F05033"/>',
);

const IMAGE = svg(
  '<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#26A69A"/>' +
    '<circle cx="5.3" cy="6" r="1.4" fill="#fff" fill-opacity=".9"/>' +
    '<path d="m2.5 12.5 3.6-3.8 2.2 2.2 2.6-3.2 2.6 4.8z" fill="#fff" fill-opacity=".9"/>',
);

const LOCK = svg(
  '<rect x="3" y="7" width="10" height="8" rx="1.6" fill="#9E9E9E"/>' +
    '<path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" fill="none" stroke="#9E9E9E" stroke-width="1.6"/>' +
    '<circle cx="8" cy="10.8" r="1.2" fill="#fff" fill-opacity=".85"/>',
);

const GEAR = svg(
  '<path d="M9.2 1h-2.4l-.4 1.9a5.4 5.4 0 0 0-1.4.8L3.2 3l-1.2 2 1.4 1.3a5.6 5.6 0 0 0 0 1.6L2 9.1l1.2 2.1 1.8-.6c.4.3.9.6 1.4.8l.4 1.9h2.4l.4-1.9c.5-.2 1-.5 1.4-.8l1.8.6L14 9.1l-1.4-1.3a5.6 5.6 0 0 0 0-1.6L14 4.9 12.8 2.8l-1.8.6a5.4 5.4 0 0 0-1.4-.8z" fill="#8D9AA5"/>' +
    '<circle cx="8" cy="7.1" r="2.1" fill="#fff" fill-opacity=".85"/>',
);

const DATABASE = svg(
  '<ellipse cx="8" cy="3.6" rx="5.5" ry="2.1" fill="#FFCA28"/>' +
    '<path d="M2.5 3.6v8.8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1V3.6c0 1.2-2.5 2.1-5.5 2.1S2.5 4.8 2.5 3.6z" fill="#FFB300"/>' +
    '<path d="M2.5 8c0 1.2 2.5 2.1 5.5 2.1s5.5-.9 5.5-2.1" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width=".9"/>',
);

const TERMINAL = svg(
  '<rect x="1" y="2" width="14" height="12" rx="2.2" fill="#4CAF50"/>' +
    '<path d="m4 5.6 2.6 2.4L4 10.4M8 10.6h4" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
);

const DOCKER = svg(
  '<path d="M15.4 7.1c-.4-.3-1.3-.4-2-.3-.1-.7-.5-1.3-1-1.7l-.3-.2-.2.3c-.3.5-.4 1.3-.3 1.9 0 .2.1.5.3.8-.3.2-.9.3-1.6.3H.6l-.1.5c-.1 1.2.1 2.4.6 3.4.5 1 1.3 1.7 2.3 2 1.1.4 2.9.6 4.1.3 1.8-.4 3.3-1.2 4.4-2.8.9-1.3 1.3-2.7 1.5-3.6h.2c.8 0 1.3-.4 1.6-.7l.2-.3z" fill="#2396ED"/>' +
    '<path d="M2 6.6h1.6v1.5H2zM3.9 6.6h1.6v1.5H3.9zM5.8 6.6h1.6v1.5H5.8zM7.7 6.6h1.6v1.5H7.7zM3.9 4.8h1.6v1.5H3.9zM5.8 4.8h1.6v1.5H5.8zM7.7 4.8h1.6v1.5H7.7zM7.7 3h1.6v1.5H7.7zM9.6 6.6h1.6v1.5H9.6z" fill="#2396ED"/>',
);

const NODE = svg(
  '<path d="M8 .8 14.3 4.4v7.2L8 15.2 1.7 11.6V4.4z" fill="#8BC34A"/>' + word('JS', { baseline: 10.6, cap: 5.2, fill: '#fff' }),
);

const INFO = svg(
  '<circle cx="8" cy="8" r="6.8" fill="#42A5F5"/>' +
    '<path d="M8 7.2v4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="4.9" r="1.05" fill="#fff"/>',
);

const KEY = svg(
  '<circle cx="5.2" cy="10.8" r="3.4" fill="#FBC02D"/><circle cx="5.2" cy="10.8" r="1.2" fill="#fff" fill-opacity=".85"/>' +
    '<path d="m7.6 8.4 6-6M11.3 4.7l1.6 1.6M12.9 3.1l1.4 1.4" stroke="#FBC02D" stroke-width="1.8" stroke-linecap="round"/>',
);

const PDF = pageWith('#E53935', word('PDF', { cx: 7.75, baseline: 12.8, cap: 3.6, maxWidth: 8.4, fill: '#fff' }));
const ARCHIVE = pageWith('#8D6E63', '<path d="M7 2v1.2M8.2 3.2v1.2M7 4.4v1.2M8.2 5.6v1.2" stroke="#fff" stroke-opacity=".8" stroke-width="1.1"/><rect x="6.3" y="7.4" width="2.6" height="3.4" rx=".7" fill="#fff" fill-opacity=".85"/>');
const FONT = pageWith('#EF5350', word('A', { cx: 7.75, baseline: 13, cap: 5.6, fill: '#fff' }));
const AUDIO_VIDEO = pageWith('#AB47BC', '<path d="M6.2 8v5l4.2-2.5z" fill="#fff" fill-opacity=".9"/>');
const TEXT = page('#90A4AE');
const DEFAULT = page('#78909C', false);

// --- quem é quem -------------------------------------------------------------------

const BY_EXT = {
  dart: DART,
  js: badge('#F7DF1E', '#2B2B2B', 'JS'),
  mjs: badge('#F7DF1E', '#2B2B2B', 'JS'),
  cjs: badge('#F7DF1E', '#2B2B2B', 'JS'),
  jsx: badge('#61DAFB', '#20232A', 'JSX'),
  ts: badge('#3178C6', '#FFFFFF', 'TS'),
  mts: badge('#3178C6', '#FFFFFF', 'TS'),
  cts: badge('#3178C6', '#FFFFFF', 'TS'),
  tsx: badge('#3178C6', '#FFFFFF', 'TSX'),
  'd.ts': badge('#0288D1', '#FFFFFF', 'DTS'),
  json: letters('#FBC02D', '{}'),
  jsonc: letters('#FBC02D', '{}'),
  arb: letters('#40C4FF', '{}'),
  md: badge('#42A5F5', '#FFFFFF', 'MD'),
  mdx: badge('#F9AC00', '#FFFFFF', 'MDX'),
  markdown: badge('#42A5F5', '#FFFFFF', 'MD'),
  yaml: badge('#CB4B5A', '#FFFFFF', 'Y'),
  yml: badge('#CB4B5A', '#FFFFFF', 'Y'),
  toml: badge('#9C4221', '#FFFFFF', 'T'),
  ini: GEAR,
  cfg: GEAR,
  conf: GEAR,
  properties: GEAR,
  xml: letters('#FF8A65', '<>'),
  plist: letters('#FF8A65', '<>'),
  html: letters('#E44D26', '<>'),
  htm: letters('#E44D26', '<>'),
  vue: badge('#41B883', '#34495E', 'V'),
  svelte: badge('#FF3E00', '#FFFFFF', 'S'),
  css: badge('#2965F1', '#FFFFFF', '#'),
  scss: badge('#CD6799', '#FFFFFF', 'S'),
  sass: badge('#CD6799', '#FFFFFF', 'S'),
  less: badge('#1D365D', '#FFFFFF', 'L'),
  py: badge('#3776AB', '#FFD43B', 'PY'),
  rb: badge('#CC342D', '#FFFFFF', 'RB'),
  go: badge('#00ADD8', '#FFFFFF', 'GO'),
  rs: badge('#DEA584', '#2B2B2B', 'RS'),
  java: badge('#E76F00', '#FFFFFF', 'J'),
  kt: badge('#7F52FF', '#FFFFFF', 'K'),
  kts: badge('#7F52FF', '#FFFFFF', 'K'),
  swift: badge('#F05138', '#FFFFFF', 'S'),
  c: badge('#5C6BC0', '#FFFFFF', 'C'),
  h: badge('#8E24AA', '#FFFFFF', 'H'),
  cc: badge('#00599C', '#FFFFFF', 'C++'),
  cpp: badge('#00599C', '#FFFFFF', 'C++'),
  cxx: badge('#00599C', '#FFFFFF', 'C++'),
  hpp: badge('#8E24AA', '#FFFFFF', 'H++'),
  cs: badge('#68217A', '#FFFFFF', 'C#'),
  m: badge('#1E88E5', '#FFFFFF', 'M'),
  mm: badge('#1E88E5', '#FFFFFF', 'MM'),
  php: badge('#777BB4', '#FFFFFF', 'PHP'),
  lua: badge('#000080', '#FFFFFF', 'LUA'),
  ex: badge('#6E4A7E', '#FFFFFF', 'EX'),
  exs: badge('#6E4A7E', '#FFFFFF', 'EX'),
  scala: badge('#DC322F', '#FFFFFF', 'SC'),
  hs: badge('#5E5086', '#FFFFFF', 'HS'),
  r: badge('#276DC3', '#FFFFFF', 'R'),
  pl: badge('#39457E', '#FFFFFF', 'PL'),
  graphql: badge('#E10098', '#FFFFFF', 'GQL'),
  gql: badge('#E10098', '#FFFFFF', 'GQL'),
  proto: badge('#4285F4', '#FFFFFF', 'PB'),
  gradle: badge('#02303A', '#FFFFFF', 'G'),
  groovy: badge('#4298B8', '#FFFFFF', 'G'),
  sh: TERMINAL,
  bash: TERMINAL,
  zsh: TERMINAL,
  fish: TERMINAL,
  ps1: TERMINAL,
  bat: TERMINAL,
  sql: DATABASE,
  db: DATABASE,
  sqlite: DATABASE,
  lock: LOCK,
  env: KEY,
  pem: KEY,
  key: KEY,
  crt: KEY,
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, ico: IMAGE, icns: IMAGE, bmp: IMAGE, heic: IMAGE,
  svg: letters('#FFB13B', '<>'),
  pdf: PDF,
  zip: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, tar: ARCHIVE, rar: ARCHIVE, '7z': ARCHIVE, jar: ARCHIVE,
  ttf: FONT, otf: FONT, woff: FONT, woff2: FONT,
  mp3: AUDIO_VIDEO, wav: AUDIO_VIDEO, mp4: AUDIO_VIDEO, mov: AUDIO_VIDEO, webm: AUDIO_VIDEO,
  txt: TEXT,
  log: TEXT,
  csv: badge('#43A047', '#FFFFFF', 'CSV'),
  diff: badge('#7E57C2', '#FFFFFF', '±'),
  patch: badge('#7E57C2', '#FFFFFF', '±'),
  rfwtxt: badge('#02569B', '#FFFFFF', 'RFW'),
};

// Os nomes que dizem mais que a extensão.
const BY_NAME = {
  'package.json': NODE,
  'package-lock.json': LOCK,
  'yarn.lock': LOCK,
  'pnpm-lock.yaml': LOCK,
  'pubspec.yaml': DART,
  'pubspec.lock': LOCK,
  'analysis_options.yaml': DART,
  'tsconfig.json': badge('#3178C6', '#FFFFFF', 'TS'),
  'dockerfile': DOCKER,
  'docker-compose.yml': DOCKER,
  'docker-compose.yaml': DOCKER,
  'compose.yml': DOCKER,
  'compose.yaml': DOCKER,
  '.dockerignore': DOCKER,
  '.gitignore': GIT,
  '.gitattributes': GIT,
  '.gitmodules': GIT,
  '.gitkeep': GIT,
  'makefile': badge('#6D8086', '#FFFFFF', 'M'),
  'license': KEY,
  'license.md': KEY,
  'license.txt': KEY,
  'readme': INFO,
  'readme.md': INFO,
  'claude.md': badge('#D97757', '#FFFFFF', 'C'),
  'changelog.md': badge('#7CB342', '#FFFFFF', 'CL'),
  '.editorconfig': GEAR,
  '.prettierrc': GEAR,
  '.eslintrc': GEAR,
  '.npmrc': GEAR,
  '.nvmrc': GEAR,
  '.fvmrc': DART,
  'gemfile': badge('#CC342D', '#FFFFFF', 'RB'),
  'podfile': badge('#EE3322', '#FFFFFF', 'POD'),
};

/** O ícone de um arquivo pelo nome. */
function fileIcon(name) {
  const base = name.toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (base.startsWith('dockerfile') || base.endsWith('.dockerfile')) return DOCKER;
  if (base.startsWith('.env')) return KEY;
  if (base.endsWith('.d.ts')) return BY_EXT['d.ts'];
  if (/\.(test|spec)\.[jt]sx?$/.test(base) || base.endsWith('_test.dart')) {
    return badge('#22A06B', '#FFFFFF', 'T');
  }
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return BY_EXT[ext] || DEFAULT;
}

// --- as pastas ---------------------------------------------------------------------

// A cor de uma pasta pelo nome; as outras ficam no cinza-azulado de sempre.
const FOLDER_COLORS = {
  src: '#42A5F5', lib: '#42A5F5', app: '#42A5F5', source: '#42A5F5',
  test: '#26A69A', tests: '#26A69A', __tests__: '#26A69A', spec: '#26A69A', integration_test: '#26A69A', e2e: '#26A69A',
  assets: '#FFB300', images: '#FFB300', img: '#FFB300', icons: '#FFB300', public: '#FFB300', static: '#FFB300', fonts: '#FFB300', res: '#FFB300',
  docs: '#5C6BC0', doc: '#5C6BC0',
  scripts: '#66BB6A', bin: '#66BB6A', tools: '#66BB6A',
  config: '#8D9AA5', configs: '#8D9AA5', '.vscode': '#2196F3', '.idea': '#E040FB',
  '.github': '#9E9E9E', '.git': '#F05033', '.claude': '#D97757',
  node_modules: '#8BC34A',
  build: '#78909C', dist: '#78909C', out: '#78909C', '.dart_tool': '#78909C', coverage: '#78909C',
  components: '#FFA726', ui: '#FFA726', widgets: '#FFA726', views: '#FFA726', pages: '#FFA726', screens: '#FFA726',
  services: '#AB47BC', api: '#AB47BC', models: '#EF5350', utils: '#7E57C2', helpers: '#7E57C2', hooks: '#7E57C2',
  android: '#3DDC84', ios: '#A8A8A8', macos: '#A8A8A8', linux: '#F9A825', windows: '#00A4EF', web: '#E44D26',
  examples: '#FF7043', example: '#FF7043', plugins: '#EC407A', worktrees: '#EC407A', themes: '#EC407A',
};
const FOLDER_DEFAULT = '#8FA6B4';

const folderCache = new Map();

/** O ícone de uma pasta: a cor pelo nome, aberta ou fechada. */
function folderIcon(name, open) {
  const color = FOLDER_COLORS[name.toLowerCase()] || FOLDER_DEFAULT;
  const key = `${color}${open ? 1 : 0}`;
  if (!folderCache.has(key)) {
    folderCache.set(
      key,
      open
        ? svg(
            `<path d="M1.5 3.6a1.1 1.1 0 0 1 1.1-1.1h3.3l1.5 1.5h5.5a1.1 1.1 0 0 1 1.1 1.1v1.4H4.4a1.2 1.2 0 0 0-1.1.8L1.5 12z" fill="${color}"/>` +
              `<path d="M3.4 7.3a1 1 0 0 1 1-.8h10.2a.8.8 0 0 1 .8 1l-1.5 5.1a1 1 0 0 1-1 .8H1.9a.6.6 0 0 1-.6-.8z" fill="${color}"/>` +
              '<path d="M3.4 7.3a1 1 0 0 1 1-.8h10.2a.8.8 0 0 1 .8 1l-1.5 5.1a1 1 0 0 1-1 .8H1.9a.6.6 0 0 1-.6-.8z" fill="#fff" fill-opacity=".22"/>',
          )
        : svg(
            `<path d="M1.5 3.6a1.1 1.1 0 0 1 1.1-1.1h3.3l1.5 1.5h5.9a1.1 1.1 0 0 1 1.1 1.1v7.3a1.1 1.1 0 0 1-1.1 1.1H2.6a1.1 1.1 0 0 1-1.1-1.1z" fill="${color}"/>` +
              `<path d="M1.5 5.8h13v6.6a1.1 1.1 0 0 1-1.1 1.1H2.6a1.1 1.1 0 0 1-1.1-1.1z" fill="#fff" fill-opacity=".14"/>`,
          ),
    );
  }
  return folderCache.get(key);
}

/** O ícone de um caminho: pasta (aberta ou fechada) ou arquivo. */
function iconFor(p, { dir = false, open = false } = {}) {
  const name = path.basename(p);
  return dir ? folderIcon(name, open) : fileIcon(name);
}

module.exports = { fileIcon, folderIcon, iconFor };
