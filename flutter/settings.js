// As configurações do plugin, como a Maestria as manda: no `initialize` e a
// cada `settings.changed`. O formulário é da Maestria — o manifesto só diz o
// que existe (`contributes.settings`).

'use strict';

let current = {};

/** Os tipos de linha do console, e a cor padrão de cada um (igual ao manifesto). */
const CATEGORIES = {
  app: '',
  developer: '',
  native: 'dim',
  warning: 'yellow',
  error: 'red',
  success: 'green',
  tool: 'accent',
  build: 'faint',
};

function set(values) {
  current = values || {};
}

/**
 * A cor de uma categoria de linha: o hex ou o nome do tema que você escolheu,
 * ou null pra cor de texto do tema.
 */
function colorOf(category) {
  const key = `colors.${category}`;
  const value = key in current ? current[key] : CATEGORIES[category];
  return value ? String(value) : null;
}

module.exports = { set, colorOf, CATEGORIES };
