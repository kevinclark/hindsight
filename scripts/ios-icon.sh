#!/bin/sh
# The iPhone app's icon, rendered from ios/App/AppIcon.svg (the repository keeps text only) into the asset catalog as the
# 1024 px PNG Xcode wants, with no alpha channel (App Store Connect refuses an icon with one). macOS's own sips renders
# SVG; run on a Mac (`npm run phone` does, and so does CI). Safe to run twice.
set -eu
cd "$(dirname "$0")/.."
out=ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
tmp=$(mktemp -d)
sips -s format png ios/App/AppIcon.svg --out "$tmp/icon.png" >/dev/null
# Through JPEG and back: drops the alpha channel (the icon is opaque, so nothing is lost but the channel).
sips -s format jpeg -s formatOptions best "$tmp/icon.png" --out "$tmp/icon.jpg" >/dev/null
sips -s format png "$tmp/icon.jpg" --out "$out" >/dev/null
rm -rf "$tmp"
sips -g pixelWidth -g hasAlpha "$out" | tail -2
