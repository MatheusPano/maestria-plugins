// A animação do fim de uma fase do pomodoro, por cima de tudo: um painel
// transparente em cada tela, acima até de app em tela cheia, que não rouba o
// foco -- quem está digitando noutro app continua digitando. Some sozinho no
// fim do tempo, e só: o clique não fecha, pra pausa ser pausa.
//
// O plugin compila isto com o `swiftc` na primeira vez (ver `main.js`) e roda:
//
//   overlay --title "hora do foco" --subtitle "25 min" --color "#F07A83" \
//           --symbol "brain.head.profile" --seconds 4.5 --confetti 1

import AppKit
import QuartzCore

struct Options {
  var title = "hora do foco"
  var subtitle = ""
  var color = NSColor(red: 0.94, green: 0.48, blue: 0.51, alpha: 1)
  var symbol = "timer"
  var seconds = 4.5
  var confetti = true
}

func parseOptions() -> Options {
  var o = Options()
  var args = CommandLine.arguments.dropFirst().makeIterator()
  while let key = args.next() {
    guard let value = args.next() else { break }
    switch key {
    case "--title": o.title = value
    case "--subtitle": o.subtitle = value
    case "--symbol": o.symbol = value
    case "--seconds": o.seconds = max(1.5, Double(value) ?? o.seconds)
    case "--confetti": o.confetti = value != "0"
    case "--color":
      let hex = value.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
      if hex.count == 6, let n = UInt32(hex, radix: 16) {
        o.color = NSColor(
          red: CGFloat((n >> 16) & 0xFF) / 255,
          green: CGFloat((n >> 8) & 0xFF) / 255,
          blue: CGFloat(n & 0xFF) / 255,
          alpha: 1)
      }
    default: break
    }
  }
  return o
}

/// Nunca vira a janela principal: é o que deixa o app da frente com o teclado.
final class OverlayPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class OverlayView: NSView {
  let options: Options
  let scale: CGFloat

  init(frame: NSRect, options: Options, scale: CGFloat) {
    self.options = options
    self.scale = scale
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { fatalError() }

  // O clique fica aqui e não fecha nada: nem some com a animação, nem atravessa
  // pro app de baixo enquanto ela está no ar.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) {}

  private var cg: CGColor { options.color.cgColor }

  func play() {
    guard let root = layer else { return }
    let center = CGPoint(x: bounds.midX, y: bounds.midY + 50)
    let radius: CGFloat = 104

    // O fundo escurece de leve, sem esconder o que está atrás.
    let dim = CALayer()
    dim.frame = bounds
    dim.backgroundColor = NSColor.black.withAlphaComponent(0.62).cgColor
    root.addSublayer(dim)
    fade(dim, from: 0, to: 1, duration: 0.3)

    // As ondas que saem do anel, três vezes.
    for i in 0..<3 {
      let wave = ring(center: center, radius: radius, width: 3)
      wave.opacity = 0
      root.addSublayer(wave)
      let grow = CABasicAnimation(keyPath: "transform.scale")
      grow.fromValue = 1
      grow.toValue = 2.4
      let vanish = CABasicAnimation(keyPath: "opacity")
      vanish.fromValue = 0.7
      vanish.toValue = 0
      let group = CAAnimationGroup()
      group.animations = [grow, vanish]
      group.duration = 1.6
      group.beginTime = CACurrentMediaTime() + 0.35 + Double(i) * 0.45
      group.timingFunction = CAMediaTimingFunction(name: .easeOut)
      group.fillMode = .backwards
      wave.add(group, forKey: "wave")
    }

    // O anel: desenha a volta inteira e dá um pulo, com brilho na cor da fase.
    let track = ring(center: center, radius: radius, width: 12)
    track.strokeColor = NSColor.white.withAlphaComponent(0.12).cgColor
    root.addSublayer(track)
    let main = ring(center: center, radius: radius, width: 12)
    main.shadowColor = cg
    main.shadowRadius = 28
    main.shadowOpacity = 0.95
    main.shadowOffset = .zero
    root.addSublayer(main)
    let draw = CABasicAnimation(keyPath: "strokeEnd")
    draw.fromValue = 0
    draw.toValue = 1
    draw.duration = 0.9
    draw.timingFunction = CAMediaTimingFunction(name: .easeOut)
    main.add(draw, forKey: "draw")
    for l in [track, main] { pop(l, delay: 0) }

    // O desenho da fase no meio do anel: um SF Symbol usado de máscara, pintado
    // na cor da fase.
    if let image = NSImage(systemSymbolName: options.symbol, accessibilityDescription: nil)?
      .withSymbolConfiguration(.init(pointSize: 84, weight: .semibold)),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    {
      let size = image.size
      let glyph = CALayer()
      glyph.frame = CGRect(
        x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
      glyph.backgroundColor = cg
      let mask = CALayer()
      mask.frame = glyph.bounds
      mask.contents = cgImage
      mask.contentsGravity = .resizeAspect
      mask.contentsScale = scale
      glyph.mask = mask
      root.addSublayer(glyph)
      pop(glyph, delay: 0.12)
    }

    // O título e a linha de baixo.
    let title = text(options.title, size: 58, weight: .bold, alpha: 1)
    title.frame = CGRect(x: 0, y: center.y - radius - 110, width: bounds.width, height: 74)
    root.addSublayer(title)
    rise(title, delay: 0.25)
    if !options.subtitle.isEmpty {
      let sub = text(options.subtitle, size: 21, weight: .medium, alpha: 0.72)
      sub.frame = CGRect(x: 0, y: center.y - radius - 150, width: bounds.width, height: 30)
      root.addSublayer(sub)
      rise(sub, delay: 0.38)
    }

    if options.confetti { confetti(at: center, into: root) }
  }

  // --- as peças -------------------------------------------------------------------

  private func ring(center: CGPoint, radius: CGFloat, width: CGFloat) -> CAShapeLayer {
    let l = CAShapeLayer()
    l.frame = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    // Começa no topo e anda no sentido do relógio, como o anel do painel.
    let path = CGMutablePath()
    path.addArc(
      center: CGPoint(x: radius, y: radius), radius: radius, startAngle: .pi / 2,
      endAngle: .pi / 2 - 2 * .pi, clockwise: true)
    l.path = path
    l.fillColor = nil
    l.strokeColor = cg
    l.lineWidth = width
    l.lineCap = .round
    l.contentsScale = scale
    return l
  }

  private func text(_ s: String, size: CGFloat, weight: NSFont.Weight, alpha: CGFloat) -> CATextLayer {
    let l = CATextLayer()
    l.string = NSAttributedString(
      string: s,
      attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: NSColor.white.withAlphaComponent(alpha),
      ])
    l.alignmentMode = .center
    l.contentsScale = scale
    l.shadowColor = NSColor.black.cgColor
    l.shadowOpacity = 0.35
    l.shadowRadius = 8
    l.shadowOffset = .zero
    return l
  }

  private func pop(_ l: CALayer, delay: Double) {
    let spring = CASpringAnimation(keyPath: "transform.scale")
    spring.fromValue = 0.55
    spring.toValue = 1
    spring.damping = 11
    spring.stiffness = 170
    spring.initialVelocity = 6
    spring.duration = spring.settlingDuration
    spring.beginTime = CACurrentMediaTime() + delay
    spring.fillMode = .backwards
    l.add(spring, forKey: "pop")
    fade(l, from: 0, to: 1, duration: 0.2, delay: delay)
  }

  private func rise(_ l: CALayer, delay: Double) {
    let move = CABasicAnimation(keyPath: "position.y")
    move.fromValue = l.position.y - 18
    move.toValue = l.position.y
    move.duration = 0.5
    move.beginTime = CACurrentMediaTime() + delay
    move.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
    move.fillMode = .backwards
    l.add(move, forKey: "rise")
    fade(l, from: 0, to: 1, duration: 0.4, delay: delay)
  }

  private func fade(_ l: CALayer, from: Float, to: Float, duration: Double, delay: Double = 0) {
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = from
    a.toValue = to
    a.duration = duration
    a.beginTime = CACurrentMediaTime() + delay
    a.fillMode = .backwards
    l.add(a, forKey: "fade")
  }

  /// Uma explosão de confete na cor da fase, em branco e em amarelo, que cai
  /// com a gravidade.
  private func confetti(at center: CGPoint, into root: CALayer) {
    let emitter = CAEmitterLayer()
    emitter.frame = bounds
    emitter.emitterPosition = center
    emitter.emitterShape = .circle
    emitter.emitterSize = CGSize(width: 120, height: 120)
    emitter.emitterMode = .outline
    let colors: [NSColor] = [
      options.color, options.color, .white, NSColor(red: 0.95, green: 0.8, blue: 0.45, alpha: 1),
    ]
    emitter.emitterCells = colors.enumerated().map { i, color in
      let cell = CAEmitterCell()
      cell.contents = piece(round: i % 2 == 0)
      cell.color = color.cgColor
      cell.birthRate = 90
      cell.lifetime = 3.2
      cell.velocity = 520
      cell.velocityRange = 260
      cell.emissionRange = 2 * .pi
      cell.yAcceleration = -620
      cell.spin = 3
      cell.spinRange = 8
      cell.scale = 0.9
      cell.scaleRange = 0.5
      cell.alphaSpeed = -0.28
      return cell
    }
    root.addSublayer(emitter)
    // Uma rajada só: liga, e desliga logo depois.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { emitter.birthRate = 0 }
  }

  private func piece(round: Bool) -> CGImage? {
    let size = CGSize(width: round ? 9 : 7, height: round ? 9 : 13)
    let image = NSImage(size: size, flipped: false) { rect in
      NSColor.white.setFill()
      (round ? NSBezierPath(ovalIn: rect) : NSBezierPath(roundedRect: rect, xRadius: 1.5, yRadius: 1.5)).fill()
      return true
    }
    return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
  }
}

final class Controller: NSObject, NSApplicationDelegate {
  let options = parseOptions()
  var windows: [NSWindow] = []
  var leaving = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    for screen in NSScreen.screens { show(on: screen) }
    DispatchQueue.main.asyncAfter(deadline: .now() + options.seconds) { self.dismiss() }
  }

  func show(on screen: NSScreen) {
    let panel = OverlayPanel(
      contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.setFrame(screen.frame, display: false)
    panel.level = .screenSaver
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    let view = OverlayView(
      frame: NSRect(origin: .zero, size: screen.frame.size), options: options,
      scale: screen.backingScaleFactor)
    panel.contentView = view
    panel.orderFrontRegardless()
    view.play()
    windows.append(panel)
  }

  func dismiss() {
    guard !leaving else { return }
    leaving = true
    NSAnimationContext.runAnimationGroup(
      { ctx in
        ctx.duration = 0.4
        for w in windows { w.animator().alphaValue = 0 }
      }, completionHandler: { NSApp.terminate(nil) })
  }
}

let app = NSApplication.shared
// Sem ícone no dock e sem tomar a frente: só as janelas por cima.
app.setActivationPolicy(.accessory)
let controller = Controller()
app.delegate = controller
app.run()
