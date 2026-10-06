// O texto das tarefas vai e volta em HTML (o Wiboor desenha com o TipTap), e a
// janela da Maestria lê markdown. Aqui ficam as duas mãos: o HTML do TipTap em
// markdown pra ler, e o markdown simples que você digita em HTML pra gravar.
// Não é um parser de HTML: é o subconjunto que o editor do Wiboor produz.

'use strict';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/** O HTML do TipTap em markdown (GFM). */
function toMarkdown(html) {
  if (!html) return '';
  if (!/<[a-z]/i.test(html)) return decode(html).trim();
  const out = [];
  let line = '';
  const lists = []; // { type: 'ul'|'ol'|'task', n }
  let pre = false;
  let quote = 0;
  let link = null;

  // `**USUÁRIO: **` não é negrito em markdown: o espaço sai pra fora do marcador.
  const mark = (s, close) => {
    if (close && /\s$/.test(line)) line = `${line.replace(/\s+$/, '')}${s} `;
    else line += s;
  };
  const indent = () => '  '.repeat(Math.max(0, lists.length - 1));
  const prefix = () => '> '.repeat(quote);
  const flush = () => {
    if (line.trim()) out.push(prefix() + line.replace(/\s+$/, ''));
    line = '';
  };
  const blank = () => {
    flush();
    if (!lists.length && out.length && out[out.length - 1] !== '') out.push('');
  };

  const parts = html.split(/(<[^>]+>)/);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] !== '<') {
      let text = decode(part);
      if (!pre) text = text.replace(/\s+/g, ' ');
      if (pre) {
        const rows = text.split('\n');
        rows.forEach((r, i) => {
          if (i > 0) {
            out.push(line);
            line = '';
          }
          line += r;
        });
      } else {
        if (!line.trim()) text = text.replace(/^\s+/, '');
        line += text;
      }
      continue;
    }
    const m = part.match(/^<\s*(\/)?\s*([a-z0-9]+)/i);
    if (!m) continue;
    const close = !!m[1];
    const tag = m[2].toLowerCase();
    switch (tag) {
      case 'p':
      case 'div':
        if (lists.length) {
          if (close) flush();
        } else if (close) blank();
        else flush();
        break;
      case 'br':
        if (pre) {
          out.push(line);
          line = '';
        } else flush();
        break;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        if (close) blank();
        else {
          blank();
          line = `${'#'.repeat(Math.min(Number(tag[1]) + 1, 6))} `;
        }
        break;
      case 'strong':
      case 'b':
        mark('**', close);
        break;
      case 'em':
      case 'i':
        mark('_', close);
        break;
      case 's':
      case 'del':
        mark('~~', close);
        break;
      case 'code':
        if (!pre) line += '`';
        break;
      case 'pre':
        if (close) {
          flush();
          out.push('```');
          out.push('');
          pre = false;
        } else {
          blank();
          out.push('```');
          pre = true;
        }
        break;
      case 'blockquote':
        blank();
        quote += close ? -1 : 1;
        if (quote < 0) quote = 0;
        break;
      case 'ul':
      case 'ol':
        if (close) {
          flush();
          lists.pop();
          if (!lists.length) out.push('');
        } else {
          flush();
          const task = /data-type\s*=\s*["']?taskList/i.test(part);
          lists.push({ type: task ? 'task' : tag, n: 0 });
        }
        break;
      case 'li': {
        if (close) {
          flush();
          break;
        }
        flush();
        const l = lists[lists.length - 1] || { type: 'ul', n: 0 };
        l.n += 1;
        let bullet = '- ';
        if (l.type === 'ol') bullet = `${l.n}. `;
        else if (l.type === 'task') bullet = `- [${attr(part, 'data-checked') === 'true' ? 'x' : ' '}] `;
        line = indent() + bullet;
        break;
      }
      case 'a':
        if (close) {
          if (link) line += `](${link})`;
          link = null;
        } else {
          link = attr(part, 'href');
          if (link) line += '[';
        }
        break;
      case 'img': {
        // A imagem na própria linha, como no Wiboor: a janela desenha.
        const src = attr(part, 'src');
        if (src) {
          flush();
          out.push(`![${fileName(src, attr(part, 'alt')).replace(/[[\]]/g, '')}](${src.replace(/ /g, '%20')})`);
        }
        break;
      }
      case 'video':
      case 'audio':
      case 'source': {
        const src = attr(part, 'src');
        if (src) line += `[${tag === 'audio' ? '♪ áudio' : '▶ vídeo'}: ${fileName(src, attr(part, 'title'))}](${src})`;
        break;
      }
      case 'hr':
        blank();
        out.push('---');
        out.push('');
        break;
      default:
    }
  }
  flush();
  return out
    .join('\n')
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * O nome de um arquivo pela URL: o upload do Wiboor põe um hash na frente
 * (`becd0bde…-image.png`), e o `alt` genérico ("vídeo") não diz nada.
 */
function fileName(url, alt) {
  let last = '';
  try {
    last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    last = String(url).split('?')[0].split('/').pop() || '';
  }
  last = last.replace(/^[0-9a-f]{24,}-/i, '');
  const a = String(alt || '').trim();
  if (a && !/^(vídeo|video|áudio|audio|imagem|image)$/i.test(a)) return a;
  return last || a || 'arquivo';
}

// O que conta como arquivo num link: os uploads do Wiboor e da CEFIS, o anexo
// assinado da API, ou um caminho que termina numa extensão de arquivo.
const FILE_LINK = /(wiboor-uploads|cefiscdn\/media|api\.azzimuti\.com\.br\/attachments\/)|\.(png|jpe?g|gif|webp|heic|svg|pdf|zip|rar|7z|csv|xlsx?|docx?|pptx?|txt|log|json|mp4|mov|webm|mkv|mp3|m4a|wav|ogg|opus)(\?|$)/i;
const KIND_BY_EXT = [
  [/\.(png|jpe?g|gif|webp|heic|svg)(\?|$)/i, 'image'],
  [/\.(mp4|mov|webm|mkv)(\?|$)/i, 'video'],
  [/\.(mp3|m4a|wav|ogg|opus)(\?|$)/i, 'audio'],
];

/**
 * Os anexos de um HTML do TipTap: as imagens, os vídeos, os áudios e os links
 * pra arquivo. A API pública não tem anexo como coisa própria -- o que foi
 * colado ou subido na tarefa mora no texto dela, com a URL pública (ou
 * assinada, que abre sem chave).
 */
function media(source) {
  const out = [];
  for (const m of String(source || '').matchAll(/<(img|video|audio|source|a)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const url = attr(m[0], tag === 'a' ? 'href' : 'src');
    if (!url || !/^https?:/i.test(url)) continue;
    if (tag === 'a' && !FILE_LINK.test(url)) continue;
    let kind = { img: 'image', video: 'video', audio: 'audio' }[tag] || null;
    if (!kind) kind = (KIND_BY_EXT.find(([re]) => re.test(new URL(url).pathname)) || [null, 'file'])[1];
    out.push({ kind, url, name: fileName(url, attr(m[0], tag === 'img' ? 'alt' : 'title')) });
  }
  return out;
}

/** O texto de uma linha, sem tag nenhuma: o título de um cartão, um comentário numa linha só. */
function plain(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** O markdown do dia a dia (`**negrito**`, `` `código` ``, `_itálico_`) numa linha de HTML. */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
}

/**
 * O markdown simples que você digita em HTML do TipTap: um `<p>` por linha,
 * `- item` numa lista, `- [ ] passo` num checklist, `1. item` numa lista
 * numerada e `# título` num cabeçalho. HTML (começando com `<`) passa direto.
 */
function fromMarkdown(text) {
  text = String(text || '');
  if (text.trimStart().startsWith('<')) return text;
  const out = [];
  let list = null; // { type, items: [] }
  const flush = () => {
    if (!list) return;
    if (list.type === 'task') {
      out.push(
        `<ul data-type="taskList">${list.items
          .map(([on, x]) => `<li data-type="taskItem" data-checked="${on}"><p>${inline(x)}</p></li>`)
          .join('')}</ul>`,
      );
    } else {
      out.push(`<${list.type}>${list.items.map((x) => `<li><p>${inline(x)}</p></li>`).join('')}</${list.type}>`);
    }
    list = null;
  };
  const push = (type, item) => {
    if (list && list.type !== type) flush();
    if (!list) list = { type, items: [] };
    list.items.push(item);
  };
  let fence = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flush();
      fence = [];
      continue;
    }
    let m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (m) {
      push('task', [m[1].toLowerCase() === 'x', m[2]]);
      continue;
    }
    m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      push('ul', m[1]);
      continue;
    }
    m = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) {
      push('ol', m[1]);
      continue;
    }
    flush();
    m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flush();
  return out.join('') || '<p></p>';
}

module.exports = { toMarkdown, fromMarkdown, plain, media, fileName };
