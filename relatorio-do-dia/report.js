// O relatório do dia: o material levantado aqui, a prosa pedida ao Claude.
//
// Tradução direta do `DailyReport` que morava no app (lib/services/report.dart).
// A divisão é o desenho inteiro: tudo que é fato — quais commits, quais
// worktrees estão sujas, quais painéis rodaram e o que escreveram — é coletado
// aqui, de forma determinística. O Claude só transforma esse material no texto
// que se lê às 18h e se repete na daily da manhã.
//
// De hoje há tudo: os painéis da janela, com o que cada sessão pediu e mexeu, e
// o que está sem commitar agora. De um dia que já passou há os commits daquele
// dia e as conversas arquivadas, e mais nada — o material diz isso em vez de
// calar.

'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 4 * 60 * 1000;
// Os tetos de um dia; um período ganha mais, até o triplo — uma semana de
// commits não cabe nos quarenta de um dia, e um material sem teto nenhum
// estouraria o prompt.
const MAX_COMMITS = 40;
const MAX_DIRTY_FILES = 12;
const MAX_TOUCHED = 25;
const MAX_CHATS = 25;
const scaled = (max, days) => Math.min(max * 3, Math.round(max * Math.max(1, days / 2)));

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

const two = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const hhmm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const dayMonth = (d) => `${two(d.getDate())}/${two(d.getMonth() + 1)}`;
const longDate = (d) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// Pela aritmética do calendário e não por 24 horas: no domingo em que o horário
// de verão entra as duas contas divergem.
const dayBefore = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
const oneLine = (value, max) => {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

const shortDate = (d, now) => (d.getFullYear() === now.getFullYear() ? dayMonth(d) : `${dayMonth(d)}/${d.getFullYear()}`);

/** Quantos dias o período tem, contando os dois. */
function spanDays(from, to) {
  return Math.round((new Date(to.getFullYear(), to.getMonth(), to.getDate()) - new Date(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000) + 1;
}

/** Os dias do período, um por um. */
function eachDay(from, to) {
  const out = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(d);
  }
  return out;
}

/**
 * Como o período se chama num título: "do dia", "de ontem", "de 22/09", ou
 * "de 15/09 a 19/09" quando é mais de um dia.
 */
function label(from, to = from, now = new Date()) {
  if (!sameDay(from, to)) return `de ${shortDate(from, now)} a ${shortDate(to, now)}`;
  if (sameDay(from, now)) return 'do dia';
  if (sameDay(from, dayBefore(now))) return 'de ontem';
  return `de ${shortDate(from, now)}`;
}

/** O período por extenso, pro cabeçalho do material e pro prompt. */
function longSpan(from, to) {
  return sameDay(from, to) ? longDate(from) : `${longDate(from)} a ${longDate(to)}`;
}

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function commitsOn(root, email, from, to) {
  const single = sameDay(from, to);
  const max = scaled(MAX_COMMITS, spanDays(from, to));
  const args = [
    'log', '--all', '--source', '--no-merges',
    `--since=${ymd(from)} 00:00:00`,
    `--until=${ymd(to)} 23:59:59`,
    // Num período cada commit leva o dia: "19/09 14:02".
    single ? '--date=format:%H:%M' : '--date=format:%d/%m %H:%M',
    '--pretty=format:%h§%ad§%S§%s',
  ];
  if (email) args.push(`--author=${email}`);
  const out = await git(args, root);
  if (!out) return [];
  const commits = [];
  for (const line of out.split('\n')) {
    const parts = line.split('§');
    if (parts.length < 4) continue;
    commits.push({
      hash: parts[0],
      time: parts[1],
      ref: parts[2].replace('refs/heads/', '').replace('refs/remotes/', ''),
      subject: parts.slice(3).join('§'),
    });
    if (commits.length >= max) break;
  }
  return commits;
}

async function benchOf(dir, label, branch) {
  const out = await git(['status', '--porcelain'], dir);
  if (!out) return null;
  const files = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!files.length) return null;
  return { label: branch ? `${label} · ${branch}` : label, path: dir, files };
}

async function folderSection(f, from, to, today) {
  const single = sameDay(from, to);
  let out = `### ${f.name} (${f.root})`;
  if (f.branch) out += ` — checkout principal em ${f.branch}`;
  out += '\n';
  if (!f.isRepo) return out + 'não é um repositório git — não há commits pra contar aqui.\n\n';

  const email = ((await git(['config', 'user.email'], f.root)) || '').trim();
  const commits = await commitsOn(f.root, email, from, to);
  const when = !single
    ? `de ${dayMonth(from)} a ${dayMonth(to)}`
    : today
      ? 'de hoje'
      : `de ${dayMonth(from)}`;
  out += email
    ? `commits ${when}, de ${email}:\n`
    : `commits ${when} (autor não filtrado — o repo não tem user.email configurado):\n`;
  out += commits.length
    ? commits.map((c) => `- ${c.time} · ${c.hash} · ${c.ref} · ${c.subject}`).join('\n') + '\n'
    : '- nenhum.\n';

  // A bancada é uma pergunta sobre agora: num relatório de outro dia ela não é
  // coletada — e o material diz isso, porque ausência leria como bancada limpa.
  if (!today) return out + 'trabalho não commitado: não dá pra saber — o git só conhece o estado de agora.\n\n';

  const trees = (f.worktrees || []).filter((w) => !w.prunable);
  const benches = (await Promise.all(
    trees.map((w) => benchOf(w.path, w.isMain ? f.name : w.label, w.branch)),
  )).filter(Boolean);
  if (!benches.length) {
    out += 'sem trabalho pendente: todas as checkouts estão limpas.\n';
  } else {
    out += 'trabalho ainda não commitado:\n';
    for (const b of benches) {
      out += `- ${b.label} (${b.path}): ${b.files.length} arquivo(s)\n`;
      for (const file of b.files.slice(0, MAX_DIRTY_FILES)) out += `  · ${file}\n`;
      if (b.files.length > MAX_DIRTY_FILES) out += `  · … e mais ${b.files.length - MAX_DIRTY_FILES}\n`;
    }
  }
  return out + '\n';
}

function sessionLine(s) {
  const a = s.activity || {};
  let out = `- [${s.kind === 'claude' ? 'claude' : s.launcher || 'shell'}] ${s.title}`;
  if (s.project) out += ` · projeto ${s.project}`;
  out += ` · pasta ${s.folderName}`;
  if (s.branch && s.branch !== '(detached)') out += ` · branch ${s.branch}`;
  out += ` · aberta ${hhmm(new Date(s.startedAt))} · ${s.exited ? 'encerrada' : s.statusLabel}`;
  if (a.prompts > 0 || a.tools > 0) out += ` · ${a.prompts || 0} pedido(s), ${a.tools || 0} ferramenta(s)`;
  if (a.lastPrompt && a.lastPrompt.trim()) out += `\n  último pedido: ${oneLine(a.lastPrompt, 240)}`;
  if (a.lastMessage && a.lastMessage.trim()) out += `\n  última resposta: ${oneLine(a.lastMessage, 400)}`;
  if (a.touched && a.touched.length) {
    const shown = a.touched.slice(0, MAX_TOUCHED).join(', ');
    const rest = a.touched.length > MAX_TOUCHED ? ` … +${a.touched.length - MAX_TOUCHED}` : '';
    out += `\n  mexeu em: ${shown}${rest}`;
  }
  return out;
}

/**
 * Tudo que o relatório é feito, em markdown, antes de o Claude ver.
 * `folders`, `projects`, `sessions` e `chats` vêm da API da Maestria.
 */
/**
 * Tudo que o relatório é feito, em markdown, antes de o Claude ver.
 *
 * `today` quer dizer que o período termina hoje: aí entram os painéis desta
 * janela e o que está sem commitar agora. `chats` são as conversas arquivadas
 * dos outros dias do período.
 */
async function material({ folders, projects, sessions, chats = [], from, to = from, day, now = new Date() }) {
  if (day && !from) from = to = day;
  const single = sameDay(from, to);
  const today = sameDay(to, now);
  const maxChats = scaled(MAX_CHATS, spanDays(from, to));
  let out = single && today
    ? `# material do dia — ${longDate(from)}, ${hhmm(now)}\n\n`
    : `# material de ${longSpan(from, to)}\n\n`;
  if (!single) {
    out +=
      `levantado em ${longDate(now)}, às ${hhmm(now)}. Um período de ${spanDays(from, to)} dias: ` +
      'os commits de todos eles e as conversas arquivadas' +
      (today ? ', mais os painéis abertos hoje e o que está sem commitar agora.\n\n' : '. O que ficou sem commitar em cada dia não se sabe mais.\n\n');
  } else if (!today) {
    out +=
      `levantado em ${longDate(now)}, às ${hhmm(now)}. De um dia que já passou o que ` +
      'existe é isto: os commits daquele dia e as conversas arquivadas. O que estava ' +
      'sem commitar naquele dia não se sabe mais.\n\n';
  }

  const gathered = await Promise.all(folders.map((f) => folderSection(f, from, to, today)));
  out += '## pastas\n\n';
  out += gathered.length ? gathered.join('') : 'nenhuma pasta cadastrada no cockpit.\n\n';

  if (projects.length) {
    out += '## projetos\n\n';
    for (const p of projects) {
      const panels = sessions.filter((s) => s.project === p.name).length;
      const where = folders.some((f) => f.root === p.folder) ? `pasta ${p.folder.split('/').pop()}` : 'avulsos';
      out += today ? `- ${p.name} (${where}) — ${panels} painel(éis)\n` : `- ${p.name} (${where})\n`;
      if (p.brief && p.brief.trim()) out += `  briefing: ${oneLine(p.brief, 300)}\n`;
    }
    out += '\n';
  }

  out += '## sessões\n\n';
  if (!sessions.length) {
    out += today
      ? 'nenhuma sessão aberta hoje.\n'
      : 'nenhum painel desta janela é desse período — painéis não atravessam o dia. O que rodou está nas conversas.\n';
  } else {
    out += sessions.map(sessionLine).join('\n') + '\n';
  }
  out += '\n';

  if (chats.length) {
    out +=
      (single ? '## conversas daquele dia\n\n' : '## conversas do período\n\n') +
      'do arquivo do próprio Claude Code, não desta janela. Dizem em que assunto ' +
      (single ? 'o dia foi gasto' : 'os dias foram gastos') + '; o que foi entregue está nos commits.\n\n';
    for (const c of chats.slice(0, maxChats)) {
      const at = new Date(c.at);
      out += `- ${c.title} · pasta ${c.folder} · último movimento ${single ? '' : `${dayMonth(at)} `}${hhmm(at)}`;
      out += c.size ? ` · ${c.size}\n` : '\n';
    }
    if (chats.length > maxChats) out += `- … e mais ${chats.length - maxChats}\n`;
    out += '\n';
  }
  return out;
}

/** O pedido ao Claude. Junto do material porque os dois são um prompt só. */
function promptFor(materialText, { from, to = from, day, now = new Date() }) {
  if (day && !from) from = to = day;
  if (!sameDay(from, to)) return periodPrompt(materialText, { from, to, now });
  day = from;
  const today = sameDay(day, now);
  const yesterday = sameDay(day, dayBefore(now));
  const which = today ? 'de hoje' : `de ${longDate(day)}`;
  const sources = today
    ? 'commits, trabalho não commitado e as sessões que rodaram'
    : 'os commits daquele dia e as conversas arquivadas';
  const occasion = today
    ? 'Ele lê isso no fim do expediente e repete de manhã na daily'
    : yesterday
      ? 'Ele vai repetir isso na daily de hoje, em minutos'
      : 'Ele está olhando pra trás pra lembrar o que fez nesse dia';
  const loose = today
    ? 'o que ficou sem commit, as sessões paradas esperando resposta, e o próximo passo que o material sugere'
    : 'o que o material daquele dia deixa em aberto — conversa que parou no meio, entrega que os commits ' +
      'mostram pela metade. Nada de trabalho não commitado: isso não foi coletado';
  return `Você é o assistente do maestria, o cockpit onde este usuário toca as sessões de
Claude Code do dia dele. Abaixo vai o material bruto ${which}, coletado pelo
próprio app: ${sources}.

Escreva o relatório desse dia, em português do Brasil e em markdown.
${occasion} — então escreva o que ele vai *falar*, na ordem em que ele falaria.

- comece com uma frase só, dizendo como foi o dia;
- depois uma seção \`##\` por frente de trabalho (o projeto quando houver, senão a
  pasta);
- dentro de cada seção, uma lista de bullets. Um bullet por coisa entregue, do
  jeito que se diz numa daily: uma linha, no passado, dizendo o que passou a
  funcionar (ou a parar de quebrar) — não o nome do arquivo que mudou;
- embaixo de cada bullet, indentado com dois espaços, um sub-bullet com a
  explicação curta: como foi feito, ou por que precisava ser feito. Uma linha,
  no máximo 25 palavras, e é aqui que entram nomes de arquivo, endpoint ou
  classe quando ajudarem;
- agrupe: commits que são a mesma entrega viram um bullet só, e no máximo seis
  bullets por frente. Nunca repita a lista de commits linha a linha;
- termine com uma seção \`## em aberto\`, na mesma forma: ${loose};
- só o que está no material. Não invente tarefa, decisão nem resultado, e se o
  dia foi vazio diga isso em uma linha e pare;
- sem preâmbulo, sem "aqui está o relatório", sem fechamento genérico, sem
  perguntar se ele quer mais alguma coisa. No máximo 500 palavras.

A forma, exatamente:

## learning-app-lms
- Notificação de reação chegou no app.
  - Novo tipo \`message_reaction\` no serviço de notificações, com cinco testes
    cobrindo o texto de quem reagiu.
- Badge de não-lidas parou de teimar quando a conversa é lida em outra sessão.
  - O eco do próprio \`markRead\` apagava o badge; agora só zera quando a leitura
    cobre a última mensagem.

---

${materialText}
`;
}

/**
 * O pedido de um período: outra ocasião — uma retro, um status semanal, um
 * 1:1 —, e por isso outra forma. O que se conta de uma semana é a entrega, não
 * o dia a dia; então as frentes ficam, mas os bullets agrupam por resultado, e
 * o fecho é o que continua aberto no fim dela.
 */
function periodPrompt(materialText, { from, to, now = new Date() }) {
  const today = sameDay(to, now);
  const days = spanDays(from, to);
  const loose = today
    ? 'o que ficou sem commit agora, as sessões paradas esperando resposta, e o próximo passo que o material sugere'
    : 'o que o material do período deixa em aberto — entrega pela metade, conversa que parou no meio. Nada de ' +
      'trabalho não commitado: isso não foi coletado';
  return `Você é o assistente do maestria, o cockpit onde este usuário toca as sessões de
Claude Code dele. Abaixo vai o material bruto de ${longSpan(from, to)} (${days} dias),
coletado pelo próprio app: os commits do período, as conversas arquivadas${today ? ', os painéis de hoje e o trabalho não commitado' : ''}.

Escreva o relatório desse período, em português do Brasil e em markdown. Ele vai
usar isso pra contar o que fez nesses dias — numa retro, num status semanal, num
1:1 —, então escreva o que ele vai *falar*, do mais importante pro menos.

- comece com duas frases no máximo, dizendo o que o período entregou;
- depois uma seção \`##\` por frente de trabalho (o projeto quando houver, senão a
  pasta), da que mais andou pra que menos andou;
- dentro de cada seção, bullets por resultado, no passado: o que passou a
  funcionar ou parou de quebrar. Junte o trabalho de vários dias que é a mesma
  entrega num bullet só; no máximo oito bullets por frente;
- embaixo de cada bullet, indentado com dois espaços, um sub-bullet curto (até
  25 palavras) com o como ou o porquê — aqui entram arquivo, endpoint ou classe;
- quando a data ajudar a contar (virou o jogo na quarta, ficou pronto na sexta),
  diga; não faça cronologia dia a dia;
- termine com \`## em aberto\`, na mesma forma: ${loose};
- só o que está no material. Não invente tarefa, decisão nem resultado, e se o
  período foi vazio diga isso em uma linha e pare;
- sem preâmbulo, sem fechamento genérico. No máximo 800 palavras.

---

${materialText}
`;
}

/**
 * Um `claude -p` sem cabeça, e mais nada. O prompt vai por arquivo, nunca pela
 * linha de comando: ele carrega assuntos de commit e pedidos que o usuário
 * escreveu, e nada disso é pra um shell reler como sintaxe.
 */
async function ask(materialText, { from, to, day, now = new Date() }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestria-relatorio-'));
  const file = path.join(temp, 'prompt.md');
  fs.writeFileSync(file, promptFor(materialText, { from, to, day, now }));
  try {
    return await new Promise((resolve) => {
      const child = spawn('/bin/zsh', ['-lc', `claude -p --output-format text < '${file.replace(/'/g, `'\\''`)}'`], {
        cwd: os.homedir(),
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, text: `o claude passou de ${TIMEOUT_MS / 60000} minutos e foi encerrado.` });
      }, TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, text: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const text = stdout.trim();
        if (code !== 0 || !text) {
          const why = stderr.trim();
          resolve({ ok: false, text: why || `o claude saiu com ${code} e não escreveu nada.` });
        } else {
          resolve({ ok: true, text });
        }
      });
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { material, promptFor, ask, label, sameDay, ymd, longDate, dayBefore, spanDays, eachDay };
