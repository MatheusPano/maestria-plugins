#!/bin/sh
# Compila o plugin num binário nativo, em build/pomodoro-<sistema>-<arquitetura>.
# Sem argumento, só pra esta máquina; com --all, também pro Linux x64 e arm64
# (o Dart compila pro Linux de qualquer sistema; pro macOS, só num Mac).
#
# Precisa do Dart 3.8 ou mais novo: o `dart` do PATH, ou o que estiver em $DART.
set -e
cd "$(dirname "$0")"
dart=${DART:-dart}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
mkdir -p build
"$dart" compile exe main.dart -o "build/pomodoro-$os-$arch"
if [ "$1" = "--all" ]; then
  for target in x64 arm64; do
    [ "$os-$arch" = "linux-$target" ] && continue
    "$dart" compile exe main.dart --target-os linux --target-arch "$target" -o "build/pomodoro-linux-$target"
  done
fi
