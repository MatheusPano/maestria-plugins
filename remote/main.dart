// Maestria Remote: as sessões da Maestria no celular. O plugin abre um servidor
// (HTTP + WebSocket) e o app `maestria-mobile` conversa com ele: a lista das
// sessões e das pastas, a conversa de cada uma, mandar mensagem, aprovar ou
// negar uma permissão, responder uma pergunta, abrir uma sessão nova, hibernar,
// acordar e fechar.
//
// O celular entra pelo pareamento: a aba da lateral (ou o comando "parear")
// mostra um código de 6 dígitos que vale 5 minutos; o app manda o código e
// recebe uma chave só dele, que fica no `state.json` da pasta de dados e pode
// ser revogada na aba. Sem a chave, o servidor não responde nada além do `/hello`.
//
// O servidor escuta em todas as interfaces, na porta das configurações: pela
// rede de casa ou, de fora, pela Tailscale. Com as duas Maestrias abertas (a
// Flutter e a rs), a segunda pega a porta seguinte.
//
// Como no `pomodoro_dart`, é Dart compilado num binário (`./build.sh`): quem usa
// não precisa do node nem do Dart.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'maestria.dart' as mx;
import 'transcript.dart';

const version = '1.2.0';
const pairMinutes = 5;
const pairTries = 5;
const portTries = 5;

final _random = Random.secure();

late String dataDir;
var appName = 'Maestria';
var settings = <String, dynamic>{};
var devices = <Map<String, dynamic>>[];

HttpServer? server;
int? boundPort;
String? serverError;

Pairing? pairing;
final clients = <Client>{};

/// As sessões do claude como o celular as vê (com o `pending`).
var sessions = <Map<String, dynamic>>[];

/// A última ferramenta que cada sessão pediu (o `PreToolUse`): é ela que
/// espera a permissão quando o status vira `waitingPermission`.
final lastTool = <String, Map<String, dynamic>>{};

/// A pergunta aberta de cada sessão (o `AskUserQuestion`).
final asks = <String, List<Map<String, dynamic>>>{};

/// Quem espera uma sessão hibernada acordar pra mandar a mensagem.
final wakers = <String, List<Completer<void>>>{};

/// Se cada sessão já esperava você, pra avisar o ntfy só na mudança.
final waiting = <String, bool>{};

var sidebarShown = false;

class Pairing {
  Pairing(this.code, this.until);

  final String code;
  final DateTime until;
  var tries = 0;

  bool get valid => DateTime.now().isBefore(until) && tries < pairTries;
}

class Sub {
  Sub(this.sessionId, this.file, this.end);

  String? sessionId;
  String? file;
  int end;
}

class Client {
  Client(this.ws, this.device);

  final WebSocket ws;
  final Map<String, dynamic> device;
  final subs = <String, Sub>{};

  void send(Map<String, Object?> m) {
    try {
      ws.add(jsonEncode(m));
    } catch (_) {}
  }
}

// --- o estado no disco ------------------------------------------------------------

File get _stateFile => File('$dataDir/state.json');

void loadState() {
  try {
    final j = jsonDecode(_stateFile.readAsStringSync());
    devices = ((j['devices'] as List?) ?? []).cast<Map>().map((d) => d.cast<String, dynamic>()).toList();
  } catch (_) {
    devices = [];
  }
}

void saveState() {
  try {
    Directory(dataDir).createSync(recursive: true);
    _stateFile.writeAsStringSync(const JsonEncoder.withIndent('  ').convert({'devices': devices}));
    // As chaves dão acesso às sessões: só o seu usuário lê.
    Process.runSync('chmod', ['600', _stateFile.path]);
  } catch (e) {
    mx.log('não deu pra gravar o state.json: $e');
  }
}

String _token() => base64Url.encode(List.generate(32, (_) => _random.nextInt(256))).replaceAll('=', '');

bool _same(String a, String b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}

Map<String, dynamic>? deviceOf(String? token) {
  if (token == null || token.isEmpty) return null;
  for (final d in devices) {
    if (_same('${d['token']}', token)) return d;
  }
  return null;
}

// --- o servidor ---------------------------------------------------------------------

int get configuredPort => (settings['port'] is num) ? (settings['port'] as num).toInt() : 7788;

Future<void> startServer() async {
  await server?.close(force: true);
  server = null;
  boundPort = null;
  serverError = null;
  final base = configuredPort;
  for (var p = base; p < base + portTries; p++) {
    try {
      server = await HttpServer.bind(InternetAddress.anyIPv4, p);
      boundPort = p;
      break;
    } on SocketException catch (e) {
      serverError = 'a porta $p está ocupada (${e.osError?.message ?? e.message})';
    }
  }
  final s = server;
  if (s == null) {
    mx.log('servidor não subiu: $serverError');
    renderSidebar();
    return;
  }
  serverError = null;
  mx.log('servidor em :$boundPort');
  renderSidebar();
  s.listen((req) => _serve(req).catchError((Object e) {
        mx.log('erro no pedido ${req.uri.path}: $e');
        try {
          req.response.statusCode = 500;
          req.response.close();
        } catch (_) {}
      }));
}

Future<void> _json(HttpRequest req, int status, Object body) async {
  req.response
    ..statusCode = status
    ..headers.contentType = ContentType.json
    ..write(jsonEncode(body));
  await req.response.close();
}

Future<void> _serve(HttpRequest req) async {
  final path = req.uri.path;
  if (path == '/hello') {
    return _json(req, 200, {'service': 'maestria-remote', 'version': version, 'app': appName, 'host': Platform.localHostname});
  }
  if (path == '/pair' && req.method == 'POST') return _pair(req);
  final auth = req.headers.value('authorization');
  final token = auth != null && auth.startsWith('Bearer ') ? auth.substring(7) : req.uri.queryParameters['token'];
  final device = deviceOf(token);
  if (device == null) return _json(req, 401, {'error': 'chave inválida: pareie o celular de novo'});
  if (path == '/upload' && req.method == 'POST') return _upload(req);
  if (path.startsWith('/media/')) return _serveMedia(req, path.substring(7));
  if (path == '/ws') {
    if (!WebSocketTransformer.isUpgradeRequest(req)) return _json(req, 400, {'error': 'esperava um websocket'});
    final ws = await WebSocketTransformer.upgrade(req);
    ws.pingInterval = const Duration(seconds: 20);
    _connected(Client(ws, device));
    return;
  }
  return _json(req, 404, {'error': 'não existe'});
}

// --- os anexos --------------------------------------------------------------------

/// O maior anexo aceito: um vídeo de alguns minutos.
const maxUpload = 300 * 1024 * 1024;

/// Recebe o corpo do pedido num arquivo, cortando no [maxUpload].
Future<File> _receive(HttpRequest req, File file) async {
  await file.parent.create(recursive: true);
  final sink = file.openWrite();
  var size = 0;
  try {
    await for (final chunk in req) {
      size += chunk.length;
      if (size > maxUpload) throw Exception('o arquivo passa de ${maxUpload ~/ (1024 * 1024)} MB');
      sink.add(chunk);
    }
  } finally {
    await sink.close();
  }
  if (size == 0) throw Exception('arquivo vazio');
  return file;
}

String _stamp() {
  final t = DateTime.now();
  return '${t.year}${_two(t.month)}${_two(t.day)}-${_two(t.hour)}${_two(t.minute)}${_two(t.second)}';
}

/// Uma foto, um vídeo ou outro arquivo do celular, guardado na pasta de dados
/// do plugin (`uploads/`). Volta o caminho, que o `send` cola no prompt.
Future<void> _upload(HttpRequest req) async {
  final raw = req.uri.queryParameters['name'] ?? 'anexo';
  final name = raw.split('/').last.replaceAll(RegExp(r'[^\w.\-]+'), '_');
  final file = File('$dataDir/uploads/${_stamp()}-${_token().substring(0, 6)}-${name.isEmpty ? 'anexo' : name}');
  try {
    await _receive(req, file);
  } catch (e) {
    if (file.existsSync()) file.deleteSync();
    return _json(req, 400, {'error': '$e'.replaceFirst('Exception: ', '')});
  }
  return _json(req, 200, {'path': file.path});
}

/// Uma imagem de mensagem que o [transcript] já tirou do base64.
Future<void> _serveMedia(HttpRequest req, String name) async {
  final file = File('$dataDir/media/$name');
  if (name.contains('/') || name.contains('..') || !file.existsSync()) return _json(req, 404, {'error': 'não existe'});
  final ext = name.split('.').last;
  req.response.headers
    ..contentType = ContentType('image', ext == 'jpg' ? 'jpeg' : ext)
    ..set('cache-control', 'private, max-age=86400');
  await req.response.addStream(file.openRead());
  await req.response.close();
}

Future<void> _pair(HttpRequest req) async {
  Map body;
  try {
    body = jsonDecode(await utf8.decodeStream(req)) as Map;
  } catch (_) {
    return _json(req, 400, {'error': 'pedido inválido'});
  }
  final p = pairing;
  if (p == null || !p.valid) {
    return _json(req, 403, {'error': 'nenhum pareamento aberto: clique em "parear um celular" na Maestria'});
  }
  final code = '${body['code'] ?? ''}'.replaceAll(RegExp(r'\D'), '');
  if (!_same(code, p.code)) {
    p.tries++;
    renderSidebar();
    return _json(req, 403, {'error': p.valid ? 'código errado' : 'código errado demais: gere outro na Maestria'});
  }
  final name = '${body['device'] ?? ''}'.trim();
  final device = <String, dynamic>{
    'id': _token().substring(0, 12),
    'name': name.isEmpty ? 'celular' : (name.length > 40 ? name.substring(0, 40) : name),
    'token': _token(),
    'createdAt': DateTime.now().toIso8601String(),
    'lastSeen': DateTime.now().toIso8601String(),
  };
  devices.add(device);
  saveState();
  pairing = null;
  mx.notify('view.close', {'viewId': 'pair'});
  mx.notify('window.showBanner', {'text': '${device['name']} pareado com a Maestria Remote'});
  renderSidebar();
  return _json(req, 200, {'token': device['token'], 'deviceId': device['id'], 'app': appName, 'host': Platform.localHostname});
}

void _connected(Client c) {
  clients.add(c);
  c.device['lastSeen'] = DateTime.now().toIso8601String();
  saveState();
  renderSidebar();
  c.ws.listen(
    (data) async {
      Map msg;
      try {
        msg = jsonDecode('$data') as Map;
      } catch (_) {
        return;
      }
      final id = msg['id'];
      final method = '${msg['method'] ?? ''}';
      final params = msg['params'] is Map ? (msg['params'] as Map).cast<String, dynamic>() : <String, dynamic>{};
      try {
        final result = await handle(c, method, params);
        c.send({'id': id, 'result': result});
      } catch (e) {
        c.send({'id': id, 'error': '$e'.replaceFirst('Exception: ', '')});
      }
    },
    onDone: () {
      clients.remove(c);
      c.device['lastSeen'] = DateTime.now().toIso8601String();
      saveState();
      renderSidebar();
    },
    onError: (_) {},
  );
}

void broadcast(Map<String, Object?> m) {
  for (final c in clients) {
    c.send(m);
  }
}

// --- o que o celular pede ---------------------------------------------------------

Map<String, dynamic> sessionOf(String? tabId) {
  final s = sessions.where((s) => s['id'] == tabId).firstOrNull;
  if (s == null) throw Exception('essa sessão não está mais aberta');
  return s;
}

Future<Object?> handle(Client c, String method, Map<String, dynamic> p) async {
  final tabId = p['tabId'] as String?;
  switch (method) {
    case 'state':
      await refreshSessions();
      return {
        'app': appName,
        'host': Platform.localHostname,
        'version': version,
        'sessions': sessions,
        'folders': await mx.request('folders.list'),
        'workspaces': await _maybe('workspaces.list'),
      };
    case 'folders':
      return mx.request('folders.list');
    case 'transcript.open':
      final s = sessionOf(tabId);
      final sid = s['sessionId'] as String?;
      final file = sid == null ? null : transcriptOf(sid, s['cwd'] as String?);
      if (file == null) {
        c.subs[tabId!] = Sub(sid, null, 0);
        return {'items': [], 'before': 0};
      }
      final chunk = readTail(file);
      c.subs[tabId!] = Sub(sid, file, chunk.end);
      return {'items': chunk.items, 'before': chunk.start};
    case 'transcript.more':
      final sub = c.subs[tabId];
      final before = (p['before'] as num?)?.toInt() ?? 0;
      if (sub?.file == null || before <= 0) return {'items': [], 'before': 0};
      final chunk = readRange(sub!.file!, before - pageBytes, before);
      return {'items': chunk.items, 'before': chunk.start};
    case 'transcript.close':
      c.subs.remove(tabId);
      return null;
    case 'send':
      return send(tabId!, '${p['text'] ?? ''}', [for (final f in (p['files'] as List?) ?? const []) if (f is Map) f.cast<String, dynamic>()]);
    case 'keys':
      await mx.request('terminal.sendKeys', {'tabId': tabId, 'keys': p['keys']});
      return null;
    case 'interrupt':
      await mx.request('terminal.sendKeys', {'tabId': tabId, 'keys': ['escape']});
      return null;
    case 'allow':
      _expect(tabId!, 'waitingPermission');
      await mx.request('terminal.sendKeys', {'tabId': tabId, 'keys': ['enter']});
      return null;
    case 'deny':
      _expect(tabId!, 'waitingPermission');
      await mx.request('terminal.sendKeys', {'tabId': tabId, 'keys': ['escape']});
      final instead = '${p['instead'] ?? ''}'.trim();
      if (instead.isNotEmpty) {
        // O esc volta pro prompt num instante; a instrução vai depois dele.
        await Future<void>.delayed(const Duration(milliseconds: 700));
        await mx.request('terminal.sendText', {'tabId': tabId, 'text': instead, 'submit': true});
      }
      return null;
    case 'answer':
      return answer(tabId!, p);
    case 'open':
      final cwd = '${p['cwd'] ?? ''}'.trim();
      if (cwd.isEmpty) throw Exception('escolha uma pasta');
      final prompt = '${p['prompt'] ?? ''}'.trim();
      final label = '${p['label'] ?? ''}'.trim();
      final r = await mx.request('session.openClaude', {
        'cwd': cwd,
        if (prompt.isNotEmpty) 'prompt': prompt,
        if (label.isNotEmpty) 'label': label,
        'background': true,
      });
      scheduleRefresh();
      return r;
    case 'wake':
      return mx.request('session.wake', {'tabId': tabId});
    case 'hibernate':
      return mx.request('session.hibernate', {'tabId': tabId});
    case 'close':
      await mx.request('session.close', {'tabId': tabId});
      return null;
    case 'rename':
      return mx.request('session.rename', {'tabId': tabId, 'title': '${p['title'] ?? ''}'});
    case 'focus':
      await mx.request('session.focus', {'tabId': tabId});
      return null;
  }
  throw Exception('pedido desconhecido: $method');
}

Future<Object?> _maybe(String method) async {
  try {
    return await mx.request(method);
  } catch (_) {
    return null;
  }
}

void _expect(String tabId, String status) {
  if (sessionOf(tabId)['status'] != status) throw Exception('isso já não está mais esperando você');
}

/// Manda [text] como se fosse digitado no terminal. Uma sessão hibernada acorda
/// antes; uma que espera permissão ou resposta recusa, pra o texto não cair no
/// lugar errado.
///
/// [files] são os anexos que o celular já mandou pelo `/upload` (`{ path, kind }`).
/// Cada imagem é colada sozinha antes do texto, como o arrastar-e-soltar de um
/// arquivo no terminal, que o Claude Code transforma em `[Image #1]`; os
/// outros (um vídeo) vão como caminho no fim do texto, pra ele abrir.
Future<Object?> send(String tabId, String text, [List<Map<String, dynamic>> files = const []]) async {
  text = text.trim();
  final uploads = '$dataDir/uploads/';
  files = files.where((f) => '${f['path']}'.startsWith(uploads) && File('${f['path']}').existsSync()).toList();
  final images = files.where((f) => f['kind'] == 'image').toList();
  final others = files.where((f) => f['kind'] != 'image').toList();
  if (others.isNotEmpty) {
    final list = others.map((f) => '- ${f['path']}${f['kind'] == 'video' ? ' (vídeo)' : ''}').join('\n');
    text = '$text\n\nAnexos que mandei pelo celular:\n$list'.trim();
  }
  if (text.isEmpty && images.isNotEmpty) text = 'Olha ${images.length == 1 ? 'essa imagem' : 'essas imagens'} que mandei pelo celular.';
  if (text.isEmpty) return null;
  final s = sessionOf(tabId);
  final status = s['status'];
  if (status == 'waitingPermission' || status == 'waitingAnswer') {
    throw Exception('a sessão espera você: responda a ${status == 'waitingAnswer' ? 'pergunta' : 'permissão'} antes');
  }
  if (s['hibernated'] == true) {
    final ready = Completer<void>();
    wakers.putIfAbsent(tabId, () => []).add(ready);
    await mx.request('session.wake', {'tabId': tabId});
    await ready.future.timeout(const Duration(seconds: 60), onTimeout: () => throw Exception('a sessão não acordou a tempo'));
    await Future<void>.delayed(const Duration(milliseconds: 600));
  }
  for (final f in images) {
    await mx.request('terminal.sendText', {'tabId': tabId, 'text': '${f['path']} ', 'submit': false});
    // O Claude Code lê o arquivo colado antes de aceitar a próxima colagem.
    await Future<void>.delayed(const Duration(milliseconds: 400));
  }
  await mx.request('terminal.sendText', {'tabId': tabId, 'text': text, 'submit': true});
  return null;
}

/// As teclas da resposta a um `AskUserQuestion`, como o `escritorio` faz: a seta
/// começa na primeira opção; numa de escolha única desce até a escolhida e dá
/// enter; numa de várias, o enter marca e, depois das opções, vem o "Type
/// something" e o "Submit". Com mais de uma pergunta (ou alguma de várias), no
/// fim vem a revisão, cujo primeiro botão manda as respostas. `other` é a
/// resposta escrita, numa pergunta só: a opção depois das dele.
Future<Object?> answer(String tabId, Map<String, dynamic> p) async {
  _expect(tabId, 'waitingAnswer');
  final qs = asks[tabId];
  if (qs == null) throw Exception('não sei que pergunta é essa: responda no computador');
  final keys = <Object>[];
  final other = '${p['other'] ?? ''}'.trim();
  if (other.isNotEmpty) {
    if (qs.length != 1) throw Exception('a resposta escrita só vale com uma pergunta');
    final n = (qs[0]['options'] as List).length;
    for (var k = 0; k < n; k++) {
      keys.add('down');
    }
    keys.addAll([
      {'text': other},
      'enter',
    ]);
  } else {
    final picks = (p['picks'] as List?) ?? const [];
    if (picks.length != qs.length) throw Exception('responda todas as perguntas');
    for (var i = 0; i < qs.length; i++) {
      final q = qs[i];
      final n = (q['options'] as List).length;
      if (q['multiSelect'] != true) {
        final pick = (picks[i] as num).toInt();
        for (var k = 0; k < pick; k++) {
          keys.add('down');
        }
        keys.add('enter');
        continue;
      }
      var at = 0;
      final marked = (picks[i] as List).map((x) => (x as num).toInt()).toList()..sort();
      for (final o in marked) {
        for (; at < o; at++) {
          keys.add('down');
        }
        keys.add('enter');
      }
      for (; at < n + 1; at++) {
        keys.add('down');
      }
      keys.add('enter');
    }
    if (qs.length > 1 || qs.any((q) => q['multiSelect'] == true)) keys.add('enter');
  }
  await mx.request('terminal.sendKeys', {'tabId': tabId, 'keys': keys});
  asks.remove(tabId);
  return null;
}

// --- as sessões e os eventos da janela ----------------------------------------------

Timer? _refresh;

void scheduleRefresh() {
  _refresh?.cancel();
  _refresh = Timer(const Duration(milliseconds: 200), () async {
    await refreshSessions();
    broadcast({'event': 'sessions', 'data': sessions});
  });
}

Future<void> refreshSessions() async {
  final list = await mx.request('sessions.list');
  if (list is! List) return;
  sessions = list
      .whereType<Map>()
      .map((s) => s.cast<String, dynamic>())
      .where((s) => s['kind'] == 'claude')
      .map((s) => {...s, 'pending': pendingOf(s), 'updatedAt': updatedAt(s)})
      .toList();
  _alert();
}

/// Quando a sessão mexeu pela última vez: a última escrita no transcript dela.
String? updatedAt(Map<String, dynamic> s) {
  final sid = s['sessionId'] as String?;
  final file = sid == null ? null : transcriptOf(sid, s['cwd'] as String?);
  if (file == null) return null;
  try {
    return File(file).lastModifiedSync().toIso8601String();
  } catch (_) {
    return null;
  }
}

/// O que a sessão espera de você, pro celular desenhar o cartão: a ferramenta
/// que pede permissão (com o comando, o trecho ou o plano) ou as perguntas.
Map<String, Object?>? pendingOf(Map<String, dynamic> s) {
  final tabId = s['id'] as String;
  switch (s['status']) {
    case 'waitingPermission':
      final t = lastTool[tabId];
      if (t == null) return {'kind': 'permission', 'tool': '', 'summary': '', 'detail': ''};
      final name = '${t['name']}';
      final input = (t['input'] as Map?)?.cast<String, dynamic>() ?? {};
      return {
        'kind': name == 'ExitPlanMode' ? 'plan' : 'permission',
        'tool': name,
        'summary': describe(name, input),
        'detail': switch (name) {
          'Bash' => '${input['command'] ?? ''}${input['description'] != null ? '\n\n# ${input['description']}' : ''}',
          'Edit' => '${input['file_path']}\n\n- ${input['old_string'] ?? ''}\n+ ${input['new_string'] ?? ''}',
          'Write' => '${input['file_path']}\n\n${input['content'] ?? ''}',
          'ExitPlanMode' => '${input['plan'] ?? ''}',
          _ => const JsonEncoder.withIndent('  ').convert(input),
        },
      };
    case 'waitingAnswer':
      final qs = asks[tabId];
      return {'kind': 'question', 'questions': qs ?? []};
  }
  return null;
}

void onEvent(Map<String, dynamic> e) {
  final type = e['type'];
  final tabId = e['tabId'] as String?;
  if (type == 'hook' && tabId != null) {
    final name = e['name'];
    final payload = e['payload'] is Map ? (e['payload'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    final tool = payload['tool_name'];
    switch (name) {
      case 'PreToolUse' || 'PermissionRequest':
        if (tool is String) lastTool[tabId] = {'name': tool, 'input': payload['tool_input']};
        if (tool == 'AskUserQuestion') {
          final qs = (payload['tool_input'] as Map?)?['questions'];
          if (qs is List) {
            asks[tabId] = qs.whereType<Map>().map((q) {
              final m = q.cast<String, dynamic>();
              return {
                'question': m['question'],
                'header': m['header'],
                'multiSelect': m['multiSelect'] == true,
                'options': ((m['options'] as List?) ?? const [])
                    .whereType<Map>()
                    .map((o) => {'label': o['label'], 'description': o['description']})
                    .toList(),
              };
            }).toList();
          }
        }
      case 'PostToolUse' || 'PostToolUseFailure':
        if (lastTool[tabId]?['name'] == tool) lastTool.remove(tabId);
        if (tool == 'AskUserQuestion') asks.remove(tabId);
      case 'UserPromptSubmit' || 'Stop' || 'SessionStart':
        lastTool.remove(tabId);
        asks.remove(tabId);
    }
    scheduleRefresh();
    return;
  }
  if (type == 'session.status' && tabId != null) {
    final status = e['status'];
    if (status != 'starting' && e['hibernated'] != true) {
      for (final w in wakers.remove(tabId) ?? const <Completer<void>>[]) {
        if (!w.isCompleted) w.complete();
      }
    }
  }
  if (type == 'session.closed' && tabId != null) {
    lastTool.remove(tabId);
    asks.remove(tabId);
    waiting.remove(tabId);
  }
  if ('$type'.startsWith('session.')) scheduleRefresh();
}

/// O ntfy (opcional): um aviso no celular quando uma sessão passa a esperar
/// você, mesmo com o app fechado. Só o nome da sessão e o motivo vão pro
/// servidor do ntfy, nunca a conversa.
void _alert() {
  final url = '${settings['ntfy'] ?? ''}'.trim();
  for (final s in sessions) {
    final id = s['id'] as String;
    final now = s['needsYou'] == true;
    final was = waiting[id] ?? false;
    waiting[id] = now;
    if (!now || was || url.isEmpty) continue;
    final reason = switch (s['status']) {
      'waitingPermission' => 'quer aprovação',
      'waitingAnswer' => 'te fez uma pergunta',
      _ => 'terminou e espera você',
    };
    _ntfy(url, '${s['title']}', reason);
  }
}

Future<void> _ntfy(String url, String title, String body) async {
  try {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    final req = await client.postUrl(Uri.parse(url));
    req.headers.set('Title', utf8.encode(title).length == title.length ? title : 'Maestria');
    req.headers.set('Tags', 'robot');
    req.add(utf8.encode('$title — $body'));
    await (await req.close()).drain<void>();
    client.close();
  } catch (e) {
    mx.log('ntfy falhou: $e');
  }
}

/// Segue as conversas abertas no celular: o que entrou no fim do arquivo vai
/// como `transcript`. Uma sessão que ainda não tinha arquivo (ou trocou de
/// conversa, depois de um /clear) recomeça com `reset`.
void pollTranscripts() {
  for (final c in clients) {
    for (final entry in c.subs.entries) {
      final tabId = entry.key;
      final sub = entry.value;
      final s = sessions.where((s) => s['id'] == tabId).firstOrNull;
      if (s == null) continue;
      final sid = s['sessionId'] as String?;
      if (sid != null && (sid != sub.sessionId || sub.file == null)) {
        final file = transcriptOf(sid, s['cwd'] as String?);
        if (file == null) continue;
        final chunk = readTail(file);
        sub
          ..sessionId = sid
          ..file = file
          ..end = chunk.end;
        c.send({
          'event': 'transcript',
          'data': {'tabId': tabId, 'reset': true, 'items': chunk.items, 'before': chunk.start},
        });
        continue;
      }
      final file = sub.file;
      if (file == null) continue;
      int size;
      try {
        size = File(file).lengthSync();
      } catch (_) {
        continue;
      }
      if (size <= sub.end) continue;
      final chunk = readRange(file, sub.end, size, aligned: true);
      if (chunk.end == sub.end) continue;
      sub.end = chunk.end;
      if (chunk.items.isEmpty) continue;
      c.send({
        'event': 'transcript',
        'data': {'tabId': tabId, 'items': chunk.items},
      });
    }
  }
}

// --- a aba da lateral ---------------------------------------------------------------

String _two(int n) => n.toString().padLeft(2, '0');

String _when(String? iso) {
  final t = iso == null ? null : DateTime.tryParse(iso);
  if (t == null) return '';
  final now = DateTime.now();
  final day = t.year == now.year && t.month == now.month && t.day == now.day ? 'hoje' : '${_two(t.day)}/${_two(t.month)}';
  return '$day às ${_two(t.hour)}:${_two(t.minute)}';
}

Future<List<Map<String, String>>> addresses() async {
  final out = <Map<String, String>>[];
  try {
    final ifaces = await NetworkInterface.list(type: InternetAddressType.IPv4);
    // A Tailscale primeiro: é o endereço que funciona de fora de casa.
    int rank(NetworkInterface i) => i.addresses.any((a) => a.address.startsWith('100.')) ? 0 : 1;
    ifaces.sort((a, b) => rank(a).compareTo(rank(b)));
    for (final i in ifaces) {
      if (i.name.startsWith('docker') || i.name.startsWith('br-') || i.name.startsWith('veth') || i.name.startsWith('virbr')) continue;
      for (final a in i.addresses) {
        final ts = a.address.startsWith('100.');
        out.add({'name': ts ? 'Tailscale' : i.name, 'address': a.address});
      }
    }
  } catch (_) {}
  return out;
}

Future<List<Map<String, Object?>>> pairBlocks() async {
  final p = pairing;
  final addrs = await addresses();
  if (p == null || !p.valid) {
    return [
      {'type': 'text', 'text': 'O código expirou ou foi tentado errado demais.', 'style': 'warning'},
      {'type': 'button', 'action': 'pair', 'label': 'gerar outro código', 'style': 'primary'},
    ];
  }
  final code = '${p.code.substring(0, 3)} ${p.code.substring(3)}';
  return [
    {'type': 'text', 'text': 'No app Maestria do celular, toque em "adicionar computador" e use:', 'style': 'dim'},
    {
      'type': 'kv',
      'items': [
        for (final a in addrs) {'key': a['name'], 'value': '${a['address']}:$boundPort'},
        {'key': 'código', 'value': code, 'tone': 'accent'},
      ],
    },
    {'type': 'text', 'text': 'vale até ${_two(p.until.hour)}:${_two(p.until.minute)}', 'style': 'faint'},
    {
      'type': 'row',
      'children': [
        {'type': 'button', 'action': 'pair.cancel', 'label': 'cancelar'},
      ],
    },
  ];
}

Future<void> renderSidebar() async {
  final online = clients.map((c) => c.device['id']).toSet();
  final addrs = boundPort == null ? <Map<String, String>>[] : await addresses();
  final p = pairing;
  final blocks = <Map<String, Object?>>[
    {
      'type': 'header',
      'title': 'Maestria Remote',
      'subtitle': server != null ? 'servidor na porta $boundPort' : (serverError ?? 'servidor parado'),
      'tone': server != null ? 'green' : 'red',
      'actions': [
        {'action': 'restart', 'icon': 'restart', 'tooltip': 'reiniciar o servidor'},
      ],
    },
    if (addrs.isNotEmpty) ...[
      {'type': 'section', 'text': 'endereços'},
      {
        'type': 'kv',
        'items': [for (final a in addrs) {'key': a['name'], 'value': '${a['address']}:$boundPort'}],
      },
    ],
    {'type': 'section', 'text': 'parear'},
    if (p != null && p.valid) ...await pairBlocks() else ...[
      {'type': 'text', 'text': 'Gere um código e digite no app do celular, junto com um dos endereços acima.', 'style': 'dim'},
      {'type': 'button', 'action': 'pair', 'label': 'parear um celular', 'style': 'primary', 'icon': 'device'},
    ],
    {'type': 'section', 'text': 'celulares', 'count': devices.length},
    {
      'type': 'list',
      'flat': true,
      'empty': 'nenhum celular pareado',
      'items': [
        for (final d in devices)
          {
            'title': d['name'],
            'subtitle': online.contains(d['id']) ? 'conectado agora' : 'visto ${_when(d['lastSeen'] as String?)}',
            'icon': 'device',
            'tone': online.contains(d['id']) ? 'green' : 'faint',
            'actions': [
              {'action': 'revoke:${d['id']}', 'icon': 'trash', 'tooltip': 'revogar', 'tone': 'red'},
            ],
          },
      ],
    },
  ];
  mx.notify('sidebar.update', {'blocks': blocks, 'badge': clients.isEmpty ? null : '${clients.length}'});
}

Future<void> startPairing({bool modal = false}) async {
  final code = List.generate(6, (_) => _random.nextInt(10)).join();
  pairing = Pairing(code, DateTime.now().add(const Duration(minutes: pairMinutes)));
  Timer(const Duration(minutes: pairMinutes, seconds: 1), () {
    if (pairing?.code == code) {
      pairing = null;
      mx.notify('view.close', {'viewId': 'pair'});
      renderSidebar();
    }
  });
  await renderSidebar();
  if (modal) {
    await mx.request('view.open', {'viewId': 'pair', 'title': 'parear um celular', 'modal': true, 'width': 420, 'blocks': await pairBlocks()});
  }
}

Future<void> onAction(Map<String, dynamic> p) async {
  final action = '${p['action'] ?? ''}';
  switch (action) {
    case 'pair':
      return startPairing(modal: p['viewId'] == 'pair');
    case 'pair.cancel':
      pairing = null;
      if (p['viewId'] == 'pair') mx.notify('view.close', {'viewId': 'pair'});
      return renderSidebar();
    case 'restart':
      return startServer();
  }
  if (action.startsWith('revoke:')) {
    final id = action.substring(7);
    final d = devices.where((d) => d['id'] == id).firstOrNull;
    if (d == null) return;
    final ok = await mx.request('window.form', {
      'title': 'revogar ${d['name']}?',
      'fields': [],
      'buttons': [
        {'action': 'cancel', 'label': 'cancelar'},
        {'action': 'revoke', 'label': 'revogar', 'style': 'danger'},
      ],
    });
    if (ok is! Map || ok['action'] != 'revoke') return;
    devices.remove(d);
    saveState();
    for (final c in clients.where((c) => c.device['id'] == id).toList()) {
      await c.ws.close(4001, 'revogado');
    }
    return renderSidebar();
  }
}

void main() {
  mx.onRequest('initialize', (p) {
    dataDir = '${p['dataDir']}';
    if ('${p['pluginDir']}$dataDir'.contains('.maestria-rs')) appName = 'Maestria rs';
    settings = (p['settings'] as Map?)?.cast<String, dynamic>() ?? {};
    loadState();
    mediaDir = '$dataDir/media';
    // Depois de responder o initialize: os pedidos à janela só valem dali.
    Timer.run(() async {
      await startServer();
      await refreshSessions();
      Timer.periodic(const Duration(milliseconds: 700), (_) => pollTranscripts());
    });
    return <String, Object?>{};
  });
  mx.onRequest('command.invoke', (p) async {
    if (p['command'] == 'parear') await startPairing(modal: true);
    return null;
  });
  mx.onNotification('event', (e) {
    final type = e['type'];
    if (type == 'sidebar.shown') {
      sidebarShown = true;
      renderSidebar();
      return;
    }
    if (type == 'sidebar.hidden') {
      sidebarShown = false;
      return;
    }
    onEvent(e);
  });
  mx.onNotification('view.action', onAction);
  mx.onNotification('settings.changed', (p) async {
    final old = configuredPort;
    settings = (p['settings'] as Map?)?.cast<String, dynamic>() ?? settings;
    if (configuredPort != old) await startServer();
  });
  mx.start();
}
