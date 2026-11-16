// A conversa de uma sessão, lida do transcript do Claude Code
// (`~/.claude/projects/<cwd>/<sessionId>.jsonl`) e passada pro celular em itens
// simples: o que você escreveu, o texto do claude, cada ferramenta numa linha
// (`Bash(npm test)`) e o resultado dela. O pensamento, os subagentes e as linhas
// internas do Claude Code ficam de fora.
//
// O arquivo cresce enquanto a sessão trabalha: quem acompanha guarda o `end`
// (até onde leu) e pede só o que veio depois com [readRange].

import 'dart:convert';
import 'dart:io';

/// Até onde se lê do fim do arquivo ao abrir a conversa, e por página de "mais antigas".
const pageBytes = 2 * 1024 * 1024;

/// O resultado de uma ferramenta vai cortado: o celular mostra um trecho.
const resultChars = 1200;

final _home = Platform.environment['HOME'] ?? '';

/// Onde as imagens das mensagens (que o transcript guarda em base64) viram
/// arquivo, uma vez cada, pra o celular buscar por `/media/<nome>`.
String? mediaDir;

const _extensions = {'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp'};

/// A imagem [b] (um bloco `image` do transcript) num arquivo; volta o nome dele.
String? _media(String key, Map b) {
  final dir = mediaDir;
  final src = b['source'];
  if (dir == null || src is! Map || src['type'] != 'base64' || src['data'] is! String) return null;
  final name = '${key.replaceAll(RegExp(r'[^\w-]'), '-')}.${_extensions[src['media_type']] ?? 'jpg'}';
  final file = File('$dir/$name');
  if (!file.existsSync()) {
    try {
      file.parent.createSync(recursive: true);
      file.writeAsBytesSync(base64.decode(src['data'] as String));
    } catch (_) {
      return null;
    }
  }
  return name;
}
final _found = <String, String>{};

String _slug(String cwd) => cwd.replaceAll(RegExp(r'[^a-zA-Z0-9]'), '-');

/// O arquivo da conversa [sessionId], ou `null` enquanto ele não existe.
String? transcriptOf(String sessionId, String? cwd) {
  final projects = '$_home/.claude/projects';
  final name = '$sessionId.jsonl';
  if (cwd != null) {
    final guess = '$projects/${_slug(cwd)}/$name';
    if (File(guess).existsSync()) return guess;
  }
  final was = _found[sessionId];
  if (was != null && File(was).existsSync()) return was;
  try {
    for (final dir in Directory(projects).listSync().whereType<Directory>()) {
      final p = '${dir.path}/$name';
      if (File(p).existsSync()) return _found[sessionId] = p;
    }
  } catch (_) {}
  return null;
}

class Chunk {
  Chunk(this.items, this.start, this.end);

  final List<Map<String, Object?>> items;

  /// O começo da primeira linha lida: o `before` da próxima página.
  final int start;

  /// O fim da última linha inteira: de onde segue a leitura.
  final int end;
}

/// As linhas inteiras entre [from] e [to]. Quando [from] cai no meio de uma
/// linha (a página de cima), a parte cortada é pulada; com [aligned], [from] é
/// o começo de uma linha (o `end` da leitura anterior) e nada é pulado.
Chunk readRange(String file, int from, int to, {bool aligned = false}) {
  final raf = File(file).openSync();
  try {
    final size = raf.lengthSync();
    to = to > size ? size : to;
    from = from < 0 ? 0 : from;
    if (to <= from) return Chunk([], from, from);
    raf.setPositionSync(from);
    final bytes = raf.readSync(to - from);
    var a = 0;
    if (from > 0 && !aligned) {
      final nl = bytes.indexOf(10);
      if (nl < 0) return Chunk([], to, to);
      a = nl + 1;
    }
    final b = bytes.lastIndexOf(10) + 1;
    if (b <= a) return Chunk([], from + a, from + a);
    final text = utf8.decode(bytes.sublist(a, b), allowMalformed: true);
    final items = <Map<String, Object?>>[];
    for (final line in const LineSplitter().convert(text)) {
      if (line.isEmpty) continue;
      try {
        final j = jsonDecode(line);
        if (j is Map<String, dynamic>) items.addAll(itemsOf(j));
      } catch (_) {}
    }
    return Chunk(items, from + a, from + b);
  } finally {
    raf.closeSync();
  }
}

/// A última página do arquivo: o que o celular mostra ao abrir a conversa.
Chunk readTail(String file) {
  final size = File(file).lengthSync();
  return readRange(file, size - pageBytes, size);
}

final _reminder = RegExp(r'<system-reminder>[\s\S]*?</system-reminder>');
final _tag = RegExp(r'<(command-name|command-args|local-command-stdout|command-message)>([\s\S]*?)</\1>');

/// Os itens de uma linha do transcript (uma linha do assistente é um bloco só,
/// mas a do usuário pode ter texto e resultados juntos).
List<Map<String, Object?>> itemsOf(Map<String, dynamic> j) {
  final type = j['type'];
  if (type != 'user' && type != 'assistant') return const [];
  if (j['isSidechain'] == true || j['isMeta'] == true) return const [];
  final message = j['message'];
  if (message is! Map) return const [];
  final id = '${j['uuid'] ?? ''}';
  final at = j['timestamp'];
  final content = message['content'];
  final blocks = content is String ? [{'type': 'text', 'text': content}] : (content is List ? content : const []);
  final out = <Map<String, Object?>>[];
  var n = 0;
  for (final b in blocks) {
    if (b is! Map) continue;
    final key = '$id:${n++}';
    switch (b['type']) {
      case 'text':
        final raw = '${b['text'] ?? ''}';
        if (type == 'assistant') {
          if (raw.trim().isNotEmpty) out.add({'id': key, 'kind': 'text', 'text': raw, 'at': at});
          continue;
        }
        final item = _userItem(raw);
        if (item != null) out.add({'id': key, ...item, 'at': at});
      case 'image':
        if (type != 'user') continue;
        final name = _media(key, b);
        out.add(name == null ? {'id': key, 'kind': 'user', 'text': '[imagem]', 'at': at} : {'id': key, 'kind': 'image', 'url': '/media/$name', 'at': at});
      case 'tool_use':
        final name = '${b['name'] ?? ''}';
        final input = b['input'] is Map ? (b['input'] as Map).cast<String, dynamic>() : <String, dynamic>{};
        out.add({
          'id': key,
          'kind': 'tool',
          'toolId': b['id'],
          'name': name,
          'summary': describe(name, input),
          if (name == 'Edit' || name == 'Write' || name == 'Bash' || name == 'TodoWrite') 'detail': _detail(name, input),
          'at': at,
        });
      case 'tool_result':
        out.add({
          'id': key,
          'kind': 'result',
          'toolId': b['tool_use_id'],
          'error': b['is_error'] == true,
          'text': _clip(_resultText(b['content'])),
          'at': at,
        });
    }
  }
  return out;
}

/// O que você escreveu, sem os lembretes que o Claude Code junta. Um comando
/// (`/compact`) vira um item próprio; a saída dele, também.
final _imageTag = RegExp(r'\[Image #\d+\]|\[Image: source: [^\]]*\]');

Map<String, Object?>? _userItem(String raw) {
  final text = raw.replaceAll(_reminder, '').replaceAll(_imageTag, '').trim();
  if (text.isEmpty) return null;
  if (text.startsWith('[Request interrupted')) return {'kind': 'note', 'text': 'interrompido'};
  if (text.startsWith('<')) {
    final tags = {for (final m in _tag.allMatches(text)) m.group(1)!: m.group(2)!.trim()};
    if (tags.containsKey('local-command-stdout')) {
      final out = tags['local-command-stdout']!;
      return out.isEmpty ? null : {'kind': 'note', 'text': _clip(out)};
    }
    if (tags.containsKey('command-name')) {
      return {'kind': 'command', 'text': [tags['command-name'], tags['command-args']].where((s) => s != null && s.isNotEmpty).join(' ')};
    }
    if (text.startsWith('<task-notification>') || text.startsWith('<bash-')) return null;
  }
  return {'kind': 'user', 'text': text};
}

String _resultText(Object? content) {
  if (content is String) return content;
  if (content is List) {
    return content.map((c) => c is Map && c['type'] == 'text' ? '${c['text']}' : (c is Map && c['type'] == 'image' ? '[imagem]' : '')).join('\n');
  }
  return '';
}

String _clip(String s) => s.length > resultChars ? '${s.substring(0, resultChars)}…' : s;

String _base(Object? p) => '${p ?? ''}'.split('/').last;

/// A ferramenta numa linha, como o terminal do Claude Code a mostra.
String describe(String name, Map<String, dynamic> input) {
  String s(String k) => '${input[k] ?? ''}';
  final v = switch (name) {
    'Bash' => s('command'),
    'Read' || 'Edit' || 'Write' || 'NotebookEdit' => _base(input['file_path'] ?? input['notebook_path']),
    'Grep' => s('pattern'),
    'Glob' => s('pattern'),
    'WebFetch' => s('url'),
    'WebSearch' => s('query'),
    'Task' || 'Agent' => s('description'),
    'TodoWrite' => '${(input['todos'] as List?)?.length ?? 0} tarefas',
    'AskUserQuestion' => (input['questions'] as List?)?.map((q) => q is Map ? q['question'] : '').join(' · ') ?? '',
    'ExitPlanMode' => 'plano',
    'Skill' => s('skill'),
    _ => input.values.whereType<String>().firstOrNull ?? '',
  };
  final one = v.replaceAll(RegExp(r'\s+'), ' ').trim();
  return one.length > 160 ? '${one.substring(0, 160)}…' : one;
}

/// O que dá pra ler embaixo da linha: o comando inteiro, o trecho trocado, a lista.
String _detail(String name, Map<String, dynamic> input) {
  final d = switch (name) {
    'Bash' => '${input['command'] ?? ''}',
    'Edit' => '- ${input['old_string'] ?? ''}\n+ ${input['new_string'] ?? ''}',
    'Write' => '${input['content'] ?? ''}',
    'TodoWrite' => ((input['todos'] as List?) ?? const [])
        .map((t) => t is Map ? '${t['status'] == 'completed' ? '✓' : (t['status'] == 'in_progress' ? '›' : '·')} ${t['content']}' : '')
        .join('\n'),
    _ => '',
  };
  return d.length > 2000 ? '${d.substring(0, 2000)}…' : d;
}
