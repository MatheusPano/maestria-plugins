// Um cliente mínimo do protocolo de plugins da Maestria, sem dependências: o
// `maestria.js` em Dart.
//
// Copie este arquivo pro seu plugin. O protocolo é JSON-RPC 2.0, uma
// mensagem json por linha no stdin/stdout -- veja docs/plugins.md. Nunca
// escreva no stdout por conta própria (print): é o canal do protocolo.
// Use `log()` daqui, ou o stderr, que vai pro log do plugin.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

typedef Params = Map<String, dynamic>;

final _requests = <String, FutureOr<Object?> Function(Params)>{};
final _notifications = <String, FutureOr<void> Function(Params)>{};
final _pending = <String, Completer<dynamic>>{};
var _nextId = 1;

/// O erro que a janela mandou em resposta a um pedido.
class RpcError implements Exception {
  RpcError(this.message);

  final String message;

  @override
  String toString() => message;
}

void _send(Map<String, Object?> message) {
  stdout.writeln(jsonEncode({'jsonrpc': '2.0', ...message}));
}

/// Pede algo à janela e espera a resposta. Falha com o erro que ela mandar.
Future<dynamic> request(String method, [Params? params]) {
  final id = 'p${_nextId++}';
  final waiting = Completer<dynamic>();
  _pending[id] = waiting;
  _send({'id': id, 'method': method, 'params': ?params});
  return waiting.future;
}

/// Avisa a janela sem esperar resposta.
void notify(String method, [Params? params]) {
  _send({'method': method, 'params': ?params});
}

/// Escreve no log do plugin (configurações → plugins → log).
void log(String message) {
  notify('log', {'message': message});
}

/// Atende um pedido da janela: `initialize`, `command.invoke`.
void onRequest(String method, FutureOr<Object?> Function(Params) fn) {
  _requests[method] = fn;
}

/// Escuta uma notificação da janela: `event`, `view.action`, `shutdown`.
void onNotification(String method, FutureOr<void> Function(Params) fn) {
  _notifications[method] = fn;
}

Params _params(Map<String, dynamic> msg) {
  final p = msg['params'];
  return p is Map ? p.cast<String, dynamic>() : {};
}

Future<void> _dispatch(Map<String, dynamic> msg) async {
  final method = msg['method'];
  final id = msg['id'];
  if (method is String && id != null) {
    final fn = _requests[method];
    if (fn == null) {
      _send({
        'id': id,
        'error': {'code': -32601, 'message': 'método desconhecido: $method'},
      });
      return;
    }
    try {
      final result = await fn(_params(msg));
      _send({'id': id, 'result': result});
    } catch (e) {
      _send({
        'id': id,
        'error': {'code': -32603, 'message': '$e'},
      });
    }
    return;
  }
  if (method is String) {
    final fn = _notifications[method];
    if (fn == null) return;
    try {
      await fn(_params(msg));
    } catch (e, st) {
      log('erro em $method: $e\n$st');
    }
    return;
  }
  final waiting = _pending.remove(id);
  if (waiting == null) return;
  final error = msg['error'];
  if (error != null) {
    waiting.completeError(RpcError('${error is Map ? error['message'] : error}'));
  } else {
    waiting.complete(msg['result']);
  }
}

/// Começa a ouvir. Chame depois de registrar os handlers.
void start() {
  _requests.putIfAbsent('initialize', () => (_) => <String, Object?>{});
  _notifications.putIfAbsent('shutdown', () => (_) => exit(0));
  // Um erro que escapou de algum handler vai pro log, em vez de derrubar o
  // processo.
  runZonedGuarded(() {
    stdin
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
          (line) {
            if (line.trim().isEmpty) return;
            Object? msg;
            try {
              msg = jsonDecode(line);
            } catch (_) {
              return;
            }
            if (msg is Map<String, dynamic>) _dispatch(msg);
          },
          // stdin fechado é a janela indo embora.
          onDone: () => exit(0),
        );
  }, (e, st) => log('erro: $e\n$st'));
}
