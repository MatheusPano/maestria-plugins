// node --test escritorio/test/*.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chat = require('../chat');

/** Uma transcrição de mentira, no formato do Claude Code: uma entrada json por linha. */
function transcript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escritorio-chat-'));
  const file = path.join(dir, 'sessao.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });

test('a conversa: pedidos, respostas e as ferramentas de um trecho numa linha só', () => {
  const file = transcript([
    { type: 'custom-title', title: 'x' },
    user('corrige o login'),
    assistant([{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Vou olhar o login.' }]),
    assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/r/lib/login.dart' } }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    assistant([{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/lib/login.dart' } }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'flutter test' } }]),
    user([{ type: 'tool_result', content: 'ok' }]),
    assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'token' } }]),
    assistant([{ type: 'text', text: 'Pronto, o login voltou.' }]),
    user('valeu', { isSidechain: true }),
    user('<command-name>/compact</command-name>\n<command-args></command-args>'),
    user('<local-command-stdout>Compacted</local-command-stdout>'),
    user([{ type: 'text', text: 'olha esse print' }, { type: 'image', source: {} }]),
  ]);
  const items = chat.conversation(file);
  assert.deepStrictEqual(
    items.map((m) => [m.who, m.text]),
    [
      ['you', 'corrige o login'],
      ['claude', 'Vou olhar o login.'],
      ['tool', '› editando login.dart · $ flutter test · procurando token · +1'],
      ['claude', 'Pronto, o login voltou.'],
      ['cmd', '/compact'],
      ['you', 'olha esse print\n[imagem]'],
    ],
  );
});

test('o pedido sai sem o que a Maestria e o Claude Code põem em volta', () => {
  assert.deepStrictEqual(chat.cleanPrompt('faz isso<system-reminder>não mostre</system-reminder>'), { text: 'faz isso' });
  assert.deepStrictEqual(chat.cleanPrompt('olha:\n<pasted_content id="a">muito texto</pasted_content id="a">'), {
    text: 'olha:\n[texto colado]',
  });
  assert.strictEqual(chat.cleanPrompt('Caveat: The messages below were generated'), null);
  assert.deepStrictEqual(chat.cleanPrompt('<command-name>/model</command-name><command-args>opus</command-args>'), {
    cmd: '/model opus',
  });
});

test('o arquivo vem do hook, ou do sessionId e da pasta da sessão', () => {
  const file = transcript([user('oi')]);
  assert.strictEqual(chat.transcriptOf({ transcript: file }), file);
  assert.strictEqual(chat.transcriptOf({ transcript: '/nao/existe.jsonl' }), null);
  assert.match(chat.projectDir('/Volumes/Dev/repo_x.y'), /-Volumes-Dev-repo-x-y$/);
});

test('só o fim de um arquivo grande é lido, e a linha cortada do começo some', () => {
  const big = [];
  for (let i = 0; i < 4000; i++) big.push(user(`pedido ${i} ${'x'.repeat(300)}`));
  const file = transcript(big);
  const items = chat.conversation(file, { limit: 5 });
  assert.strictEqual(items.length, 5);
  assert.match(items[4].text, /^pedido 3999 /);
});

test('a pergunta do AskUserQuestion aparece com as opções, e depois com a escolha marcada', () => {
  const ask = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Qual banco?',
          header: 'Banco',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'o de sempre' },
            { label: 'SQLite', description: '' },
          ],
        },
      ],
    },
  };
  const open = chat.conversation(transcript([user('cria a tabela'), assistant([ask])]));
  const q = open[open.length - 1];
  assert.strictEqual(q.who, 'ask');
  assert.strictEqual(q.open, true);
  assert.strictEqual(q.questions[0].text, 'Qual banco?');
  assert.deepStrictEqual(
    q.questions[0].options.map((o) => [o.n, o.label, o.chosen]),
    [
      ['1.', 'Postgres', false],
      ['2.', 'SQLite', false],
    ],
  );

  const answered = chat.conversation(
    transcript([
      user('cria a tabela'),
      assistant([ask]),
      user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'answered' }], {
        toolUseResult: { answers: { 'Qual banco?': 'SQLite' } },
      }),
      assistant([{ type: 'text', text: 'Vai de SQLite.' }]),
    ]),
  );
  const a = answered.find((m) => m.who === 'ask');
  assert.strictEqual(a.open, false);
  assert.strictEqual(a.state, 'respondida');
  assert.deepStrictEqual(
    a.questions[0].options.map((o) => o.chosen),
    [false, true],
  );
  assert.strictEqual(answered[answered.length - 1].text, 'Vai de SQLite.');

  // Uma resposta escrita à mão (o "Other") e uma pergunta recusada.
  const other = chat.conversation(
    transcript([
      assistant([ask]),
      user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }], { toolUseResult: { answers: { 'Qual banco?': 'MySQL' } } }),
    ]),
  ).find((m) => m.who === 'ask');
  assert.deepStrictEqual(other.questions[0].other, { on: true, text: 'MySQL' });
  const declined = chat.conversation(
    transcript([assistant([ask]), user([{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'no' }])]),
  ).find((m) => m.who === 'ask');
  assert.strictEqual(declined.state, 'recusada');
});

test('uma resposta longa do claude vem inteira, sem cortar no meio', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Parágrafo ${i + 1}: ${'texto '.repeat(20)}`).join('\n\n');
  const items = chat.conversation(transcript([user('explica tudo'), assistant([{ type: 'text', text: long }])]));
  assert.strictEqual(items[items.length - 1].text, long.trim());
});
