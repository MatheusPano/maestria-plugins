#!/bin/sh
# Sobe o plugin: o binário desta plataforma, que o ./build.sh deixa em build/.
# O exec troca o shell pelo binário, então quem conversa com a Maestria é ele.
cd "$(dirname "$0")" || exit 1
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
bin="build/pomodoro-$os-$arch"
if [ ! -x "$bin" ]; then
  echo "falta o $bin: rode o ./build.sh na pasta do plugin" >&2
  exit 1
fi
exec "./$bin"
