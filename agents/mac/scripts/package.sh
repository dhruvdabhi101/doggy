#!/bin/bash
# Builds Doggy.app (menu bar app) and Doggy-mac.dmg into <repo>/dist/mac/.
# SwiftPM only (no Xcode). Builds for the host architecture (arm64 on Apple silicon); not a universal binary.
# Ad-hoc signed: fine for local use, NOT notarized. See README for Gatekeeper notes.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$PKG_DIR/../.." && pwd)"
OUT="$REPO_DIR/dist/mac"
APP="$OUT/Doggy.app"
DMG="$OUT/Doggy-mac.dmg"
ICON_SVG="$REPO_DIR/web/public/icon.svg"
VERSION="0.1.0"
BUILD_NUMBER="${BUILD_NUMBER:-1}"

echo "==> swift build -c release --product DoggyApp"
cd "$PKG_DIR"
swift build -c release --product DoggyApp
BIN="$(swift build -c release --product DoggyApp --show-bin-path)/DoggyApp"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Doggy"

# ---- icon -----------------------------------------------------------------
ICON_KEY=""
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PNG="$TMP/icon-1024.png"
if [ -f "$ICON_SVG" ]; then
  if ! sips -s format png -z 1024 1024 "$ICON_SVG" --out "$PNG" >/dev/null 2>&1 || [ ! -s "$PNG" ]; then
    rm -f "$PNG"
    qlmanage -t -s 1024 -o "$TMP" "$ICON_SVG" >/dev/null 2>&1 || true
    [ -s "$TMP/icon.svg.png" ] && mv "$TMP/icon.svg.png" "$PNG"
  fi
fi
if [ -s "$PNG" ]; then
  SET="$TMP/AppIcon.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$PNG" --out "$SET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z $d $d "$PNG" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  if iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"; then
    ICON_KEY="<key>CFBundleIconFile</key><string>AppIcon</string>"
    echo "    icon: AppIcon.icns"
  fi
else
  echo "    warning: could not render $ICON_SVG; building without an icon"
fi

# ---- Info.plist -----------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Doggy</string>
  <key>CFBundleIdentifier</key><string>world.ruv.doggy</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Doggy</string>
  <key>CFBundleDisplayName</key><string>Doggy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
  $ICON_KEY
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright © $(date +%Y) Doggy. All rights reserved.</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> ad-hoc signing"
codesign --force --deep -s - "$APP"
codesign --verify --verbose=1 "$APP"

echo "==> building $DMG"
STAGE="$TMP/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Doggy" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

echo
echo "Built:"
echo "  $APP  ($(lipo -archs "$APP/Contents/MacOS/Doggy"))"
echo "  $DMG  ($(du -h "$DMG" | cut -f1))"
