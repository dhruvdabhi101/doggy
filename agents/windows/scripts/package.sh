#!/usr/bin/env bash
# Builds the distributable Windows tray app:
#   <repo>/dist/windows/Doggy-windows.exe  (self-contained, single file, win-x64)
# Works on macOS/Linux/Windows (Git Bash) with the .NET 10 SDK installed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/dist/windows"

# Regenerate the icon if it is missing and we're on macOS (needs sips).
if [[ ! -f "$HERE/Assets/doggy.ico" ]] && command -v sips >/dev/null; then
  "$HERE/scripts/make-icon.sh"
fi

rm -rf "$OUT"
dotnet publish "$HERE/DoggyAgent.csproj" -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true \
  -o "$OUT"

mv -f "$OUT/doggy-agent.exe" "$OUT/Doggy-windows.exe"
rm -f "$OUT"/*.pdb
echo
echo "Built: $OUT/Doggy-windows.exe"
ls -la "$OUT"
