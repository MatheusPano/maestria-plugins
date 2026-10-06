// Pomodoro: foco, pausa curta e, a cada tantos focos, a pausa longa. Dois
// lugares pro mesmo relógio: um painel pequeno que flutua por cima da janela
// (`float.show`, que a Maestria arrasta e guarda onde você largou) e a aba da
// lateral, com o relógio grande e os tempos pra ajustar.
//
// É o `pomodoro/main.js` em Dart, compilado num binário nativo (`./build.sh`):
// quem usa não precisa do node nem do Dart. A interface (`ui/*.rfwtxt`) e a
// animação (`overlay/`) são as mesmas do plugin em node.
//
// O relógio é uma hora de fim (`endsAt`) e não um contador: guardada no disco,
// ela sobrevive ao app fechar -- o foco que você começou antes de reiniciar a
// Maestria continua contando, e o que acabou enquanto ela estava fechada é dado
// como feito na volta.
//
// Os tempos moram aqui, no `state.json`, e não nas configurações da Maestria:
// quem os muda é a aba, com o − e o +, e o plugin não escreve nas configurações.
//
// Numa Maestria sem o flutuante (o `floats` do initialize), o painel pequeno
// abre numa janela comum.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'maestria.dart' as mx;

const floatId = 'timer';
const floatSize = {'width': 228, 'height': 58};
const phases = {'focus': 'foco', 'short': 'pausa curta', 'long': 'pausa longa'};
const glass = '/System/Library/Sounds/Glass.aiff';
// O som do fim da fase no Linux: o tema de sons do freedesktop, que o GNOME
// traz, tocado pelo primeiro destes que existir (PipeWire, PulseAudio, libcanberra).
const linuxSound = '/usr/share/sounds/freedesktop/stereo/complete.oga';
const linuxPlayers = [
  ('pw-play', [linuxSound]),
  ('paplay', [linuxSound]),
  ('canberra-gtk-play', ['-i', 'complete']),
];

// A animação de cada fase que começa: o título fixo, e o desenho e a cor que
// você escolhe na aba, entre estes.
const titles = {'focus': 'hora do foco', 'short': 'hora da pausa', 'long': 'pausa longa'};

typedef Icon = ({String id, String label, String emoji, String symbol});
typedef Color = ({String id, String label, String hex});
typedef Scene = ({String title, Icon icon, Color color});

// Cada desenho é um SF Symbol no macOS (pintado na cor da fase) e um emoji no
// Linux, que não tem os símbolos da Apple. A aba mostra o emoji nos dois.
const List<Icon> icons = [
  (id: 'brain', label: 'cérebro', emoji: '🧠', symbol: 'brain.head.profile'),
  (id: 'flame', label: 'fogo', emoji: '🔥', symbol: 'flame.fill'),
  (id: 'target', label: 'alvo', emoji: '🎯', symbol: 'target'),
  (id: 'laptop', label: 'computador', emoji: '💻', symbol: 'laptopcomputer'),
  (id: 'alarm', label: 'despertador', emoji: '⏰', symbol: 'alarm.fill'),
  (id: 'sparkles', label: 'brilho', emoji: '✨', symbol: 'sparkles'),
  (id: 'coffee', label: 'café', emoji: '☕', symbol: 'cup.and.saucer.fill'),
  (id: 'leaf', label: 'folha', emoji: '🌿', symbol: 'leaf.fill'),
  (id: 'walk', label: 'caminhada', emoji: '🚶', symbol: 'figure.walk'),
  (id: 'meditate', label: 'meditação', emoji: '🧘', symbol: 'figure.mind.and.body'),
  (id: 'sun', label: 'sol', emoji: '☀️', symbol: 'sun.max.fill'),
  (id: 'moon', label: 'lua', emoji: '🌙', symbol: 'moon.fill'),
];
const List<Color> colors = [
  (id: 'red', label: 'vermelho', hex: '#F07A83'),
  (id: 'orange', label: 'laranja', hex: '#F2A65A'),
  (id: 'yellow', label: 'amarelo', hex: '#F2CD73'),
  (id: 'green', label: 'verde', hex: '#8BD88B'),
  (id: 'teal', label: 'turquesa', hex: '#5EE3C1'),
  (id: 'blue', label: 'azul', hex: '#72B6F2'),
  (id: 'purple', label: 'roxo', hex: '#B69CF5'),
  (id: 'pink', label: 'rosa', hex: '#F5A3D0'),
];
const sceneDefaults = {
  'focus': (icon: 'brain', color: 'red'),
  'short': (icon: 'coffee', color: 'green'),
  'long': (icon: 'walk', color: 'blue'),
};

/// A cena de [phase] como você a deixou.
Scene sceneOf(String phase) {
  final scenes = s.config['scenes'];
  final mine = scenes is Map && scenes[phase] is Map ? scenes[phase] as Map : const {};
  final def = sceneDefaults[phase]!;
  return (
    title: titles[phase]!,
    icon: icons.firstWhere(
      (i) => i.id == mine['icon'],
      orElse: () => icons.firstWhere((i) => i.id == def.icon),
    ),
    color: colors.firstWhere(
      (c) => c.id == mine['color'],
      orElse: () => colors.firstWhere((c) => c.id == def.color),
    ),
  );
}

/// Uma cor `#RRGGBB` como o rfw lê: um inteiro 0xAARRGGBB.
int argb(String hex) => 0xff000000 + int.parse(hex.substring(1), radix: 16);

// O que falta, por sistema, quando a animação não sobe: vai no recado.
const overlayNeeds = {
  'macos': 'a animação precisa do swiftc (as Command Line Tools do Xcode)',
  'linux': 'a animação precisa do python3 com GTK: sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0',
};

// Os tempos ajustáveis: o passo do − e do +, e até onde vão.
const steps = {
  'focus': (label: 'foco', unit: 'min', step: 5, min: 5, max: 120),
  'short': (label: 'pausa curta', unit: 'min', step: 1, min: 1, max: 30),
  'long': (label: 'pausa longa', unit: 'min', step: 5, min: 5, max: 60),
  'longEvery': (label: 'pausa longa a cada', unit: 'focos', step: 1, min: 2, max: 8),
};
const presets = [
  (id: '25-5', focus: 25, short: 5),
  (id: '50-10', focus: 50, short: 10),
  (id: '90-20', focus: 90, short: 20),
];
final toggles = [
  (id: 'autoStart', label: 'começar a próxima sozinho', hint: 'desligado, a fase nova espera o play'),
  (id: 'notify', label: 'notificação', hint: null),
  (id: 'overlay', label: 'animação na tela', hint: 'por cima de tudo, mesmo com outro app na frente'),
  (id: 'sound', label: 'som', hint: Platform.isMacOS ? 'o Glass do macOS' : 'o "complete" do sistema'),
];
const panel = (id: 'visible', label: 'painel flutuante', hint: 'o pequeno, por cima da janela; arraste pra onde quiser');
const defaults = <String, Object>{
  'focus': 25,
  'short': 5,
  'long': 15,
  'longEvery': 4,
  'autoStart': false,
  'notify': true,
  'sound': true,
  'overlay': true,
  'confetti': true,
};

/// O jeito de rodar a animação neste sistema, com os argumentos de cada cena.
typedef Runner = ({
  String cmd,
  List<String> Function(Scene scene, String subtitle) args,
  Map<String, String>? environment,
});

class Env {
  String dataDir = Platform.environment['MAESTRIA_PLUGIN_DATA'] ?? '';
  // A pasta do plugin: o `run.sh` sobe o binário nela.
  String pluginDir = Directory.current.path;
  bool floats = false; // a Maestria tem o flutuante
  late final String float = File('$pluginDir/ui/float.rfwtxt').readAsStringSync();
  late final String side = File('$pluginDir/ui/sidebar.rfwtxt').readAsStringSync();
  bool shown = false; // o painel já foi com a biblioteca
  bool sidebar = false; // a aba está na tela
  bool sideSent = false; // a biblioteca da aba já foi
  bool badgeCleared = false; // já mandou o `badge: null`
  String? overlay; // o executável da animação, depois de compilado
  Future<String?>? compiling; // a compilação em andamento
  Future<Runner?>? linux; // a conferência do GTK, feita uma vez
  String editing = 'focus'; // a fase cuja animação a aba está mostrando pra editar
  bool ready = false; // o initialize já voltou: antes dele a janela não conversa
}

final env = Env();

class Today {
  Today(this.day, this.count);

  String day;
  int count;
}

// O que vai pro disco. `round` é quantos focos o ciclo já teve (volta a zero
// depois da pausa longa); `left` é o que sobrou de uma fase pausada no meio.
class PomodoroState {
  String phase = 'focus';
  bool running = false;
  int? endsAt;
  int? left;
  int round = 0;
  Today today = Today('', 0);
  bool visible = true;
  Map<String, dynamic> config = {...defaults};

  Map<String, Object?> toJson() => {
    'phase': phase,
    'running': running,
    'endsAt': endsAt,
    'left': left,
    'round': round,
    'today': {'day': today.day, 'count': today.count},
    'visible': visible,
    'config': config,
  };
}

var s = PomodoroState();

Timer? ticker;

// --- o relógio ----------------------------------------------------------------

Object cfg(String id) {
  final v = s.config[id];
  final def = defaults[id]!;
  if (def is bool) return v is bool ? v : def;
  return v is num && v.isFinite && v > 0 ? v : def;
}

bool flag(String id) => cfg(id) as bool;

num value(String id) => cfg(id) as num;

int duration(String phase) => (value(phase) * 60000).round();

int now() => DateTime.now().millisecondsSinceEpoch;

int remaining() {
  if (s.running) return max(0, s.endsAt! - now());
  return s.left ?? duration(s.phase);
}

String dayKey() {
  final d = DateTime.now();
  String p(int n) => '$n'.padLeft(2, '0');
  return '${d.year}-${p(d.month)}-${p(d.day)}';
}

int today() {
  if (s.today.day != dayKey()) s.today = Today(dayKey(), 0);
  return s.today.count;
}

void start() {
  if (s.running) return;
  s.endsAt = now() + remaining();
  s.left = null;
  s.running = true;
  changed();
}

void pause() {
  if (!s.running) return;
  s.left = remaining();
  s.running = false;
  s.endsAt = null;
  changed();
}

void toggle() {
  if (s.running) {
    pause();
  } else {
    start();
  }
}

/// A fase depois desta. Terminar o foco conta pro dia; pular não.
void advance({required bool finished, bool quiet = false}) {
  final was = s.phase;
  if (was == 'focus') {
    s.round += 1;
    if (finished) {
      today();
      s.today.count += 1;
    }
    s.phase = s.round >= value('longEvery') ? 'long' : 'short';
  } else {
    if (was == 'long') s.round = 0;
    s.phase = 'focus';
  }
  s.left = null;
  s.running = finished && !quiet && flag('autoStart');
  s.endsAt = s.running ? now() + duration(s.phase) : null;
  if (finished && !quiet) announce(was);
  changed();
}

void reset() {
  s
    ..phase = 'focus'
    ..running = false
    ..endsAt = null
    ..left = null
    ..round = 0;
  changed();
}

void jump(String phase) {
  if (s.phase == phase && !s.running && s.left == null) return;
  s
    ..phase = phase
    ..running = false
    ..endsAt = null
    ..left = null;
  changed();
}

/// Um tempo ajustado na aba. A fase que não começou pega o tempo novo; a que
/// está rodando ou pausada no meio termina com o que tinha.
void setConfig(Map<String, Object?> patch) {
  s.config = {...s.config, ...patch};
  changed();
}

/// O desenho ou a cor da fase em edição. Guarda só os ids.
void setScene(Map<String, String> patch) {
  final cur = sceneOf(env.editing);
  final scenes = s.config['scenes'];
  setConfig({
    'scenes': {
      if (scenes is Map) ...scenes,
      env.editing: {'icon': cur.icon.id, 'color': cur.color.id, ...patch},
    },
  });
}

void step(String? id, int dir) {
  final st = steps[id];
  if (st == null) return;
  final v = value(id!);
  // Um valor fora do passo (um 25 com passo de 10) vai pro passo mais perto
  // naquela direção, em vez de andar do lugar torto.
  final next = dir > 0
      ? (v / st.step).floor() * st.step + st.step
      : (v / st.step).ceil() * st.step - st.step;
  setConfig({id: min(st.max, max(st.min, next))});
}

/// O fim de uma fase: a notificação, o som e a animação.
void announce(String was) {
  final next = '${s.phase == 'focus' ? 'o' : 'a'} ${phases[s.phase]} de ${cfg(s.phase)} min';
  final then = s.running ? 'começou $next' : 'aperte o play pra começar $next';
  final body = was == 'focus'
      ? 'foco feito (${today()} hoje). Agora $then.'
      : 'a ${phases[was]} acabou. Agora $then.';
  if (flag('notify')) {
    mx
        .request('window.notify', {'title': 'Pomodoro', 'body': body})
        .then<void>((_) {}, onError: (Object e) => mx.log('notify: $e'));
  }
  if (flag('sound')) playSound();
  if (flag('overlay')) overlay(was);
}

void playSound() {
  if (Platform.isMacOS) {
    if (File(glass).existsSync()) play([('afplay', [glass])]);
  } else if (Platform.isLinux) {
    play(File(linuxSound).existsSync() ? linuxPlayers : linuxPlayers.sublist(2));
  }
}

/// Toca com o primeiro tocador que existir: o que falta (ou falha) passa a vez.
void play(List<(String, List<String>)> players) {
  if (players.isEmpty) return;
  final (cmd, args) = players.first;
  final rest = players.sublist(1);
  Process.start(cmd, args).then((p) {
    p.stdout.drain<void>();
    p.stderr.drain<void>();
    p.exitCode.then((code) {
      if (code != 0) play(rest);
    });
  }, onError: (Object _) => play(rest));
}

// --- a animação -----------------------------------------------------------------
//
// Um programa à parte, porque é o único jeito de aparecer por cima de outro app
// sem trazer a Maestria pra frente e roubar o teclado de quem está digitando.
//
// No macOS, `overlay/overlay.swift`: compilado com o `swiftc` na primeira vez, e
// de novo só quando o código muda -- o nome do executável leva a impressão
// digital dele. No Linux, `overlay/overlay_linux.py`, em GTK 3: nada pra
// compilar, só conferir uma vez que o python3 tem o GTK.

String get overlaySrc => '${env.pluginDir}/overlay/overlay.swift';

String get overlayLinux => '${env.pluginDir}/overlay/overlay_linux.py';

/// Uma impressão digital curta de [bytes] (FNV-1a de 64 bits): só pra saber
/// quando o código da animação mudou, sem puxar o package:crypto.
String fingerprint(List<int> bytes) {
  var h = 0xcbf29ce484222325;
  for (final b in bytes) {
    h ^= b;
    h *= 0x100000001b3;
  }
  // O int do Dart tem sinal: as duas metades, cada uma como número positivo.
  String half(int v) => (v & 0xffffffff).toRadixString(16).padLeft(8, '0');
  return '${half(h >> 32)}${half(h)}'.substring(0, 10);
}

String? overlayBinary() {
  if (!Platform.isMacOS || env.dataDir.isEmpty || !File(overlaySrc).existsSync()) return null;
  return '${env.dataDir}/overlay-${fingerprint(File(overlaySrc).readAsBytesSync())}';
}

Future<Runner?> buildOverlay() async {
  if (Platform.isLinux) return linuxOverlay();
  final bin = await swiftOverlay();
  if (bin == null) return null;
  return (
    cmd: bin,
    args: (Scene scene, String subtitle) => [
      ...['--title', scene.title, '--subtitle', subtitle, '--color', scene.color.hex],
      ...['--symbol', scene.icon.symbol, '--seconds', '4.5', '--confetti', flag('confetti') ? '1' : '0'],
    ],
    environment: null,
  );
}

Future<Runner?> linuxOverlay() => env.linux ??= _probeLinux();

Future<Runner?> _probeLinux() async {
  // O GTK e a ponte dele com o cairo (`python3-gi-cairo`): sem ela a janela abre
  // e não desenha.
  const probe =
      "import cairo, gi; gi.require_version('Gtk', '3.0'); gi.require_foreign('cairo'); from gi.repository import Gtk";
  var ok = false;
  String why;
  try {
    final r = await Process.run('python3', ['-c', probe]);
    ok = r.exitCode == 0;
    why = '${r.stderr}'.trim().split('\n').last;
  } on ProcessException catch (e) {
    why = e.message;
  }
  if (!ok) {
    mx.log('${overlayNeeds['linux']} ($why)');
    env.overlay = null;
    return null;
  }
  env.overlay = 'python3';
  return (
    cmd: 'python3',
    args: (Scene scene, String subtitle) => [
      overlayLinux,
      ...['--title', scene.title, '--subtitle', subtitle, '--color', scene.color.hex],
      ...['--emoji', scene.icon.emoji, '--seconds', '4.5', '--confetti', flag('confetti') ? '1' : '0'],
    ],
    // No XWayland quando há um: lá a janela pode ser um popup por cima de
    // todas, e num Wayland puro o compositor decide se ela vem pra frente.
    environment: Platform.environment['DISPLAY'] != null ? {'GDK_BACKEND': 'x11'} : null,
  );
}

Future<String?> swiftOverlay() {
  if (env.overlay != null) return Future.value(env.overlay);
  if (env.compiling != null) return env.compiling!;
  final bin = overlayBinary();
  if (bin == null) return Future.value(null);
  if (File(bin).existsSync()) return Future.value(env.overlay = bin);
  return env.compiling = _compileOverlay(bin).whenComplete(() {
    env.compiling = null;
  });
}

Future<String?> _compileOverlay(String bin) async {
  Directory(env.dataDir).createSync(recursive: true);
  final tmp = '$bin.$pid.tmp';
  final ProcessResult r;
  try {
    r = await Process.run('swiftc', ['-O', overlaySrc, '-o', tmp]);
  } on ProcessException catch (e) {
    mx.log('sem o swiftc, a animação fica de fora (instale as Command Line Tools do Xcode): ${e.message}');
    return null;
  }
  if (r.exitCode != 0) {
    mx.log('a animação não compilou (${r.exitCode}): ${'${r.stderr}'.trim()}');
    return null;
  }
  File(tmp).renameSync(bin);
  // As versões antigas, de antes do código mudar.
  for (final f in Directory(env.dataDir).listSync()) {
    final name = f.uri.pathSegments.last;
    if (name.startsWith('overlay-') && f.path != bin) {
      try {
        f.deleteSync();
      } on FileSystemException {
        // já foi
      }
    }
  }
  env.overlay = bin;
  mx.log('animação compilada: $bin');
  return bin;
}

/// A animação da fase [phase] que começa depois de [was].
Future<void> overlay(String was, [String? phase, bool? running]) async {
  phase ??= s.phase;
  running ??= s.running;
  final runner = await buildOverlay();
  if (runner == null) return;
  final scene = sceneOf(phase);
  final then = running ? 'já começou' : 'aperte o play pra começar';
  final every = value('longEvery');
  final subtitle = switch (phase) {
    'focus' =>
      '${was == 'long' ? 'ciclo novo · ' : ''}${cfg('focus')} min · '
          '${min((was == 'long' ? 0 : s.round) + 1, every)} de $every · $then',
    'short' => 'foco feito · ${focos(today())} hoje · ${cfg('short')} min pra respirar',
    _ => 'ciclo completo · ${cfg('long')} min longe da tela',
  };
  try {
    await Process.start(
      runner.cmd,
      runner.args(scene, subtitle),
      mode: ProcessStartMode.detached,
      environment: runner.environment,
    );
  } on ProcessException catch (e) {
    mx.log('animação: ${e.message}');
  }
}

/// Uma vez por segundo enquanto roda: é o que vê a fase acabar.
void schedule() {
  if (s.running && ticker == null) {
    ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!s.running) return schedule();
      if (remaining() <= 0) return advance(finished: true);
      render();
    });
  } else if (!s.running && ticker != null) {
    ticker!.cancel();
    ticker = null;
  }
}

void changed() {
  save();
  schedule();
  render();
}

// --- o que se desenha ---------------------------------------------------------

String clock(int ms) {
  final total = (ms / 1000).ceil();
  final m = total ~/ 60;
  return '${'$m'.padLeft(2, '0')}:${'${total % 60}'.padLeft(2, '0')}';
}

bool fresh() => !s.running && s.left == null;

String label() {
  final every = value('longEvery');
  var text = phases[s.phase]!;
  if (s.phase == 'focus') text += ' · ${min(s.round + 1, every)} de $every';
  if (!s.running && !fresh()) text += ' · pausado';
  return text;
}

Map<String, Object?> common() {
  // Longe de 0 e de 1: o rfw lê o `value` do anel como double, e um 0 ou um 1
  // que chegasse como int viraria o anel girando.
  final progress = min(0.9999, max(0.0001, 1 - remaining() / duration(s.phase)));
  return {
    'phase': s.phase,
    'running': s.running,
    'clock': clock(remaining()),
    'label': label(),
    'progress': progress,
    // A cor que você escolheu pra fase: o anel do painel e o da aba.
    'color': argb(sceneOf(s.phase).color.hex),
  };
}

String focos(int n) => '$n ${n == 1 ? 'foco' : 'focos'}';

Map<String, Object?> floatData() => {
  ...common(),
  'menu': [
    {'label': 'hoje: ${focos(today())}', 'icon': 'check', 'action': 'nada', 'disabled': true},
    {'divider': true},
    {'label': 'foco agora', 'icon': 'clock', 'action': 'fase:focus', 'disabled': s.phase == 'focus' && fresh()},
    {'label': 'pausa curta agora', 'icon': 'pause', 'action': 'fase:short', 'disabled': s.phase == 'short' && fresh()},
    {'label': 'pausa longa agora', 'icon': 'pause', 'action': 'fase:long', 'disabled': s.phase == 'long' && fresh()},
    {'label': 'zerar o ciclo', 'icon': 'restart', 'action': 'zerar'},
    {'divider': true},
    {'label': 'esconder o painel', 'icon': 'remove', 'action': 'esconder'},
  ],
};

Map<String, Object?> sideData() {
  final every = value('longEvery').toInt();
  return {
    ...common(),
    'today': 'hoje: ${focos(today())}',
    // As bolinhas do ciclo: os focos já feitos acesos.
    'dots': List.generate(every, (i) => i < s.round),
    'focusColor': argb(sceneOf('focus').color.hex),
    'phases': [
      for (final MapEntry(key: id, value: text) in phases.entries)
        {'id': id, 'label': text, 'active': s.phase == id},
    ],
    'presets': [
      for (final p in presets)
        {
          'id': p.id,
          'label': '${p.focus} · ${p.short}',
          'active': value('focus') == p.focus && value('short') == p.short,
        },
    ],
    'steppers': [
      for (final MapEntry(key: id, value: st) in steps.entries)
        {
          'id': id,
          'label': st.label,
          'value': '${cfg(id)} ${st.unit}',
          'atMin': value(id) <= st.min,
          'atMax': value(id) >= st.max,
        },
    ],
    'toggles': [
      for (final t in toggles)
        {'id': t.id, 'label': t.label, 'hint': [?t.hint], 'on': flag(t.id)},
    ],
    'panel': [
      {'id': panel.id, 'label': panel.label, 'hint': [panel.hint], 'on': s.visible},
    ],
    'anim': animData(),
  };
}

/// A seção "animação" da aba: a fase em edição, os desenhos e as cores dela.
Map<String, Object?> animData() {
  final scene = sceneOf(env.editing);
  return {
    'phases': [
      for (final MapEntry(key: id, value: text) in phases.entries)
        {'id': id, 'label': text, 'active': env.editing == id},
    ],
    'icons': [
      for (final i in icons)
        {'id': i.id, 'label': i.label, 'emoji': i.emoji, 'active': i.id == scene.icon.id},
    ],
    'colors': [
      for (final c in colors)
        {'id': c.id, 'label': c.label, 'value': argb(c.hex), 'active': c.id == scene.color.id},
    ],
    'color': argb(scene.color.hex),
    'toggles': [
      {'id': 'confetti', 'label': 'confete', 'hint': <String>[], 'on': flag('confetti')},
    ],
    'test': 'ver a animação de ${phases[env.editing]}',
  };
}

Future<void> render() async {
  if (!env.ready) return;
  await Future.wait([renderFloat(), renderSide()]);
}

Future<void> renderSide() async {
  try {
    if (env.sidebar) {
      final params = <String, Object?>{'data': sideData()};
      if (!env.sideSent) params['rfw'] = {'library': env.side};
      // Sem selo no ícone da faixa. O `null` tira o de uma versão anterior, que
      // a Maestria guarda enquanto está aberta.
      if (!env.badgeCleared) params['badge'] = null;
      await mx.request('sidebar.update', params);
      env.sideSent = true;
      env.badgeCleared = true;
    } else if (!env.badgeCleared) {
      await mx.request('sidebar.update', {'badge': null});
      env.badgeCleared = true;
    }
  } catch (e) {
    mx.log('aba: $e');
  }
}

Future<void> renderFloat() async {
  if (!s.visible) return;
  try {
    if (!env.floats) {
      if (!env.shown) {
        await mx.request('view.open', {
          'viewId': floatId,
          'title': 'pomodoro',
          'rfw': {'library': env.float},
          'data': floatData(),
        });
        env.shown = true;
      } else {
        final r = await mx.request('view.update', {'viewId': floatId, 'data': floatData()});
        if (!(r is Map && r['open'] == true)) {
          // Você fechou a janela: é o mesmo que esconder.
          env.shown = false;
          s.visible = false;
          save();
        }
      }
      return;
    }
    if (env.shown) {
      final r = await mx.request('float.update', {'id': floatId, 'data': floatData()});
      if (r is Map && r['shown'] == true) return;
    }
    await mx.request('float.show', {
      'id': floatId,
      ...floatSize,
      'corner': 'bottomRight',
      'rfw': {'library': env.float},
      'data': floatData(),
    });
    env.shown = true;
  } catch (e) {
    mx.log('painel: $e');
  }
}

Future<void> setVisible(bool on) async {
  s.visible = on;
  save();
  if (!on) {
    env.shown = false;
    try {
      await mx.request(
        env.floats ? 'float.hide' : 'view.close',
        env.floats ? {'id': floatId} : {'viewId': floatId},
      );
    } catch (_) {
      // já estava fechado
    }
  }
  render();
}

Future<void> act(String? a, [String? id]) async {
  if (a == 'alternar') {
    toggle();
  } else if (a == 'pular') {
    advance(finished: false);
  } else if (a == 'zerar') {
    reset();
  } else if (a == 'esconder') {
    await setVisible(false);
  } else if (a == 'fase' && phases.containsKey(id)) {
    jump(id!);
  } else if (a != null && a.startsWith('fase:') && phases.containsKey(a.substring(5))) {
    jump(a.substring(5));
  } else if (a == 'mais') {
    step(id, 1);
  } else if (a == 'menos') {
    step(id, -1);
  } else if (a == 'preset') {
    for (final p in presets) {
      if (p.id == id) setConfig({'focus': p.focus, 'short': p.short});
    }
  } else if (a == 'cena' && phases.containsKey(id)) {
    env.editing = id!;
    render();
  } else if (a == 'icone' && icons.any((i) => i.id == id)) {
    setScene({'icon': id!});
  } else if (a == 'cor' && colors.any((c) => c.id == id)) {
    setScene({'color': id!});
  } else if (a == 'testar') {
    // A da fase em edição na aba, como se ela começasse agora.
    final phase = env.editing;
    await overlay(phase == 'focus' ? 'short' : 'focus', phase, flag('autoStart'));
    if (env.overlay == null) {
      await mx.request('window.showBanner', {
        'text': overlayNeeds[Platform.operatingSystem] ?? 'a animação só existe no macOS e no Linux',
      });
    }
  } else if (a == 'toggle') {
    if (id == 'visible') {
      await setVisible(!s.visible);
    } else if (defaults[id] is bool) {
      setConfig({id!: !flag(id)});
    }
  }
}

// --- o disco ------------------------------------------------------------------

File? stateFile() => env.dataDir.isEmpty ? null : File('${env.dataDir}/state.json');

void load() {
  final file = stateFile();
  if (file == null || !file.existsSync()) return;
  try {
    final saved = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    final phase = saved['phase'];
    s.phase = phase is String && phases.containsKey(phase) ? phase : 'focus';
    s.running = saved['running'] == true;
    s.endsAt = (saved['endsAt'] as num?)?.toInt();
    s.left = (saved['left'] as num?)?.toInt();
    s.round = (saved['round'] as num?)?.toInt() ?? 0;
    final today = saved['today'];
    if (today is Map) {
      s.today = Today(today['day'] as String? ?? '', (today['count'] as num?)?.toInt() ?? 0);
    }
    s.visible = saved['visible'] != false;
    final config = saved['config'];
    s.config = {...defaults, if (config is Map) ...config.cast<String, dynamic>()};
  } catch (e) {
    mx.log('state.json não leu, começando do zero: $e');
  }
}

void save() {
  final file = stateFile();
  if (file == null) return;
  try {
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(s.toJson()));
  } catch (e) {
    mx.log('não gravou o estado: $e');
  }
}

// --- o protocolo --------------------------------------------------------------

String? str(Object? v) => v is String && v.isNotEmpty ? v : null;

void main() {
  mx.onRequest('initialize', (p) {
    env.floats = (p['floats'] is num ? p['floats'] as num : 0) >= 1;
    if (str(p['dataDir']) case final dir?) env.dataDir = dir;
    if (str(p['pluginDir']) case final dir?) env.pluginDir = dir;
    load();
    // Prepara a animação já, em segundo plano (compila no macOS, confere o GTK no
    // Linux): a primeira fase que acabar não espera.
    if (flag('overlay')) buildOverlay();
    // A fase que acabou com o app fechado: feita, sem tocar nada agora, e a
    // próxima espera o play.
    if (s.running && (s.endsAt ?? 0) <= now()) advance(finished: true, quiet: true);
    // Depois da resposta do initialize: antes dela a janela ainda não conversa.
    Timer.run(() {
      env.ready = true;
      schedule();
      render();
    });
    if (!env.floats) mx.log('esta Maestria não tem o flutuante (floats); o pomodoro abre numa janela');
    return <String, Object?>{};
  });

  mx.onRequest('command.invoke', (p) async {
    final command = str(p['command']);
    if (command == 'painel') {
      await setVisible(!s.visible);
    } else {
      await act(command);
      if (command == 'alternar' && !s.visible) {
        await mx.request('window.showBanner', {
          'text': s.running ? '${phases[s.phase]}: ${clock(remaining())}' : 'pausado em ${clock(remaining())}',
        });
      }
    }
    return null;
  });

  mx.onNotification('event', (e) {
    if (e['type'] == 'sidebar.shown') {
      env.sidebar = true;
      renderSide();
    } else if (e['type'] == 'sidebar.hidden') {
      env.sidebar = false;
    }
  });

  mx.onNotification('view.action', (p) async {
    final viewId = p['viewId'];
    if (viewId != floatId && viewId != 'sidebar') return;
    final v = p['values'] is Map ? p['values'] as Map : const {};
    // Do menu a escolha vem em `action`; dos botões, em `a`.
    await act(str(v['action']) ?? str(v['a']) ?? str(p['action']), str(v['id']));
  });

  mx.onNotification('shutdown', (_) {
    save();
    exit(0);
  });

  mx.start();
}
