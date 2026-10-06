#!/usr/bin/env python3
# A animação do fim de uma fase do pomodoro no Linux: a mesma do macOS
# (`overlay.swift`), em GTK 3 e cairo -- o que o GNOME (Ubuntu, Zorin, Fedora…)
# já traz instalado, sem nada pra compilar.
#
# Uma janela transparente por monitor, por cima de tudo, que não pega o teclado:
# quem está digitando noutro app continua digitando. O clique fica preso nela e
# não fecha: ela some sozinha no fim do tempo, pra pausa ser pausa.
#
# No X11 (e no XWayland, que o plugin escolhe com `GDK_BACKEND=x11` quando há um
# `DISPLAY`) a janela é um popup fora do gerenciador de janelas: fica acima de
# todas e nunca recebe foco. Num Wayland puro, sem XWayland, cai numa janela em
# tela cheia que pede pra não receber foco -- quem decide é o compositor.
#
#   overlay_linux.py --title "hora do foco" --subtitle "25 min" --color "#F07A83" \
#                    --emoji "🧠" --seconds 4.5 --confetti 1

import math
import random
import sys
import time

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("PangoCairo", "1.0")
# A ponte do cairo com o GTK (o `python3-gi-cairo`). Sem ela a janela abriria e
# não conseguiria desenhar nada: uma tela preta travando o clique. Aqui, antes
# de qualquer janela, ela falta com um erro e o plugin fica sabendo.
gi.require_foreign("cairo")
from gi.repository import Gdk, GLib, Gtk, Pango, PangoCairo  # noqa: E402


def parse():
    o = {"title": "hora do foco", "subtitle": "", "color": "#F07A83", "emoji": "⏰", "seconds": 4.5, "confetti": "1"}
    args = sys.argv[1:]
    for key, value in zip(args[::2], args[1::2]):
        k = key.lstrip("-")
        if k == "seconds":
            try:
                o[k] = max(1.5, float(value))
            except ValueError:
                pass
        elif k in o:
            o[k] = value
    return o


def rgb(hex_):
    h = hex_.lstrip("#")
    if len(h) != 6:
        return (0.94, 0.48, 0.51)
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def ease_out(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def spring(t):
    """De 0,55 a 1 com um pulinho depois, como o CASpringAnimation do macOS."""
    if t <= 0:
        return 0.55
    return 1 - 0.45 * math.exp(-6.5 * t) * math.cos(11 * t)


OPTS = parse()
COLOR = rgb(OPTS["color"])
START = time.monotonic()
RADIUS = 104


class Piece:
    """Um confete: sai do anel pra fora e cai com a gravidade."""

    COLORS = [COLOR, COLOR, (1, 1, 1), (0.95, 0.8, 0.45)]

    def __init__(self):
        a = random.uniform(0, 2 * math.pi)
        self.x = math.cos(a) * 60
        self.y = math.sin(a) * 60
        speed = random.uniform(260, 780)
        d = random.uniform(0, 2 * math.pi)
        self.vx = math.cos(d) * speed
        self.vy = math.sin(d) * speed
        self.round = random.random() < 0.5
        self.w, self.h = (9, 9) if self.round else (7, 13)
        self.s = random.uniform(0.4, 1.4)
        self.spin = random.uniform(-8, 8) + 3
        self.color = random.choice(self.COLORS)

    def draw(self, cr, t):
        if t > 3.2:
            return
        x = self.x + self.vx * t
        y = self.y + self.vy * t + 0.5 * 620 * t * t
        alpha = max(0.0, 1 - 0.28 * t)
        cr.save()
        cr.translate(x, y)
        cr.rotate(self.spin * t)
        cr.scale(self.s, self.s)
        cr.set_source_rgba(*self.color, alpha)
        if self.round:
            cr.arc(0, 0, self.w / 2, 0, 2 * math.pi)
        else:
            cr.rectangle(-self.w / 2, -self.h / 2, self.w, self.h)
        cr.fill()
        cr.restore()


PIECES = [Piece() for _ in range(110)] if OPTS["confetti"] != "0" else []


def text_layout(cr, text, font, alpha):
    layout = PangoCairo.create_layout(cr)
    layout.set_font_description(Pango.FontDescription.from_string(font))
    layout.set_text(text, -1)
    return layout, alpha


def draw(widget, cr):
    try:
        paint(widget, cr)
    except Exception as e:  # noqa: BLE001
        # Um erro no meio do desenho deixaria a tela coberta sem nada: sai já.
        print(f"a animação não desenhou: {e}", file=sys.stderr)
        Gtk.main_quit()
    return False


def paint(widget, cr):
    w = widget.get_allocated_width()
    h = widget.get_allocated_height()
    t = time.monotonic() - START
    left = OPTS["seconds"] - t
    out = min(1.0, max(0.0, left / 0.4))  # o sumiço no fim

    # Limpa pra transparente, e o fundo escurece de leve.
    cr.set_operator(cairo.OPERATOR_CLEAR)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    cr.push_group()
    cr.set_source_rgba(0, 0, 0, 0.62 * ease_out(t / 0.3))
    cr.paint()

    cx, cy = w / 2, h / 2 - 50

    # As ondas que saem do anel, três vezes.
    for i in range(3):
        wt = (t - 0.35 - i * 0.45) / 1.6
        if 0 <= wt <= 1:
            k = ease_out(wt)
            cr.set_source_rgba(*COLOR, 0.7 * (1 - k))
            cr.set_line_width(3)
            cr.arc(cx, cy, RADIUS * (1 + 1.4 * k), 0, 2 * math.pi)
            cr.stroke()

    # O anel: desenha a volta inteira e dá um pulo, com brilho na cor da fase.
    cr.save()
    cr.translate(cx, cy)
    s = spring(t)
    cr.scale(s, s)
    appear = min(1.0, t / 0.2)
    cr.set_line_cap(cairo.LINE_CAP_ROUND)
    cr.set_source_rgba(1, 1, 1, 0.12 * appear)
    cr.set_line_width(12)
    cr.arc(0, 0, RADIUS, 0, 2 * math.pi)
    cr.stroke()
    end = -math.pi / 2 + 2 * math.pi * ease_out(t / 0.9)
    for glow in (44, 32, 22):  # o brilho: o mesmo traço, largo e fraco
        cr.set_source_rgba(*COLOR, 0.07 * appear)
        cr.set_line_width(glow)
        cr.arc(0, 0, RADIUS, -math.pi / 2, end)
        cr.stroke()
    cr.set_source_rgba(*COLOR, appear)
    cr.set_line_width(12)
    cr.arc(0, 0, RADIUS, -math.pi / 2, end)
    cr.stroke()
    cr.restore()

    # O desenho da fase no meio do anel.
    et = t - 0.12
    if et > 0:
        layout, _ = text_layout(cr, OPTS["emoji"], "Noto Color Emoji 60", 1)
        _, logical = layout.get_pixel_extents()
        cr.save()
        cr.translate(cx, cy)
        s = spring(et)
        cr.scale(s, s)
        cr.move_to(-logical.width / 2, -logical.height / 2)
        cr.push_group()
        PangoCairo.show_layout(cr, layout)
        cr.pop_group_to_source()
        cr.paint_with_alpha(min(1.0, et / 0.2))
        cr.restore()

    # O título e a linha de baixo, subindo.
    def line(text, font, alpha, y, delay):
        lt = t - delay
        if lt <= 0 or not text:
            return
        layout, _ = text_layout(cr, text, font, alpha)
        _, logical = layout.get_pixel_extents()
        rise = 18 * (1 - ease_out(lt / 0.5))
        cr.move_to(cx - logical.width / 2, y + rise)
        cr.set_source_rgba(1, 1, 1, alpha * min(1.0, lt / 0.4))
        PangoCairo.show_layout(cr, layout)

    line(OPTS["title"], "Sans Bold 44", 1, cy + RADIUS + 36, 0.25)
    line(OPTS["subtitle"], "Sans 16", 0.72, cy + RADIUS + 110, 0.38)

    # O confete, por cima de tudo.
    cr.save()
    cr.translate(cx, cy)
    for p in PIECES:
        p.draw(cr, t)
    cr.restore()

    cr.pop_group_to_source()
    cr.paint_with_alpha(out)


def window_for(monitor, popup):
    geo = monitor.get_geometry()
    win = Gtk.Window(type=Gtk.WindowType.POPUP if popup else Gtk.WindowType.TOPLEVEL)
    screen = win.get_screen()
    visual = screen.get_rgba_visual()
    if visual is not None and screen.is_composited():
        win.set_visual(visual)
    win.set_app_paintable(True)
    win.set_decorated(False)
    win.set_skip_taskbar_hint(True)
    win.set_skip_pager_hint(True)
    win.set_keep_above(True)
    win.set_accept_focus(False)
    win.set_focus_on_map(False)
    win.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)
    win.move(geo.x, geo.y)
    win.set_default_size(geo.width, geo.height)
    win.resize(geo.width, geo.height)
    # O clique fica aqui e não fecha nada: nem some com a animação, nem
    # atravessa pro app de baixo enquanto ela está no ar.
    win.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
    win.connect("button-press-event", lambda *_: True)
    area = Gtk.DrawingArea()
    area.connect("draw", draw)
    win.add(area)
    return win, area


def main():
    display = Gdk.Display.get_default()
    if display is None:
        sys.exit("sem tela pra desenhar (nem DISPLAY nem WAYLAND_DISPLAY)")
    # Popup (fora do gerenciador de janelas) só no X11: no Wayland ele precisa
    # de uma janela-mãe.
    popup = type(display).__name__.startswith("X11")
    areas = []
    for i in range(display.get_n_monitors()):
        win, area = window_for(display.get_monitor(i), popup)
        win.show_all()
        if not popup:
            win.fullscreen_on_monitor(win.get_screen(), i)
        areas.append(area)

    def tick():
        for a in areas:
            a.queue_draw()
        return time.monotonic() - START < OPTS["seconds"]

    GLib.timeout_add(16, tick)
    GLib.timeout_add(int(OPTS["seconds"] * 1000) + 50, Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
