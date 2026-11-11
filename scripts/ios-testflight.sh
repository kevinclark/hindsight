#!/bin/sh
# Builds the iPhone app for the App Store, signed with the team's Apple Distribution certificate and App Store profile,
# and (UPLOAD=1) uploads it to TestFlight with the App Store Connect API key. CI runs it on each release; on a Mac it
# makes the same .ipa without uploading (UPLOAD=0, the default).
#
# Reads: IOS_DIST_P12 (base64 .p12), IOS_DIST_P12_PASSWORD, IOS_APPSTORE_PROFILE (base64 .mobileprovision); for the
# upload APPLE_API_KEY_P8 (the key's text), APPLE_API_KEY_ID, APPLE_API_ISSUER. Build number = the commit count (the
# release's own number), version 0.1.<count>. Signing material goes into a throwaway keychain and a temp folder, both
# removed at the end, and is never printed.
set -eu
cd "$(dirname "$0")/.."
TEAM=W4MBZ59CH2
BUNDLE=io.github.kevinclark.hindsight
N=$(git rev-list --count HEAD)
WORK=$(mktemp -d)
KC="$WORK/signing.keychain-db"
KCPASS=$(openssl rand -hex 16)
cleanup() { security delete-keychain "$KC" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# The signing identity, in its own keychain on the search list for this run.
printf %s "$IOS_DIST_P12" | base64 --decode > "$WORK/dist.p12"
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import "$WORK/dist.p12" -k "$KC" -P "$IOS_DIST_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPASS" "$KC" >/dev/null
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')

# The App Store profile, where Xcode looks for profiles.
printf %s "$IOS_APPSTORE_PROFILE" | base64 --decode > "$WORK/appstore.mobileprovision"
PROFILE=$(security cms -D -i "$WORK/appstore.mobileprovision" | plutil -extract Name raw -o - -)
UUID=$(security cms -D -i "$WORK/appstore.mobileprovision" | plutil -extract UUID raw -o - -)
for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
  mkdir -p "$dir" && cp "$WORK/appstore.mobileprovision" "$dir/$UUID.mobileprovision"
done

# The page and the icon, then the archive.
sh scripts/ios-icon.sh
npm run build:phone
npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS \
  -archivePath "$WORK/App.xcarchive" archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=$TEAM CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE" OTHER_CODE_SIGN_FLAGS="--keychain $KC" \
  MARKETING_VERSION="0.1.$N" CURRENT_PROJECT_VERSION="$N" | tail -3

cat > "$WORK/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE</key><string>$PROFILE</string></dict>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$WORK/App.xcarchive" -exportOptionsPlist "$WORK/export.plist" -exportPath "$WORK/out" | tail -2
IPA=$(ls "$WORK"/out/*.ipa)
echo "built $(basename "$IPA"): version 0.1.$N ($N), $(du -h "$IPA" | cut -f1)"
codesign -dvv "$WORK/App.xcarchive/Products/Applications/App.app" 2>&1 | grep -E '^Authority=Apple Distribution|^TeamIdentifier'

if [ "${UPLOAD:-0}" = 1 ]; then
  mkdir -p "$WORK/private_keys"
  printf %s "$APPLE_API_KEY_P8" > "$WORK/private_keys/AuthKey_$APPLE_API_KEY_ID.p8"
  # altool looks for the key in ./private_keys (relative to the working directory).
  (cd "$WORK" && xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER" --output-format normal)
  echo "uploaded 0.1.$N ($N) to TestFlight"
else
  echo "UPLOAD=0: not uploaded"
fi
