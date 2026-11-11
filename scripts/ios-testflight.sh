#!/bin/bash
# Builds the iPhone app for the App Store, signed with the team's Apple Distribution certificate and App Store profile.
# UPLOAD=1 uploads it to TestFlight with the App Store Connect API key; VALIDATE=1 only asks App Store Connect whether it
# would accept it (the key, its role, the app record, the build); neither, the default on a Mac, makes the .ipa only.
# BUILD_PAGE=0 skips the icon, page build and `cap sync` (CI does those in a step without secrets).
#
# Reads: IOS_DIST_P12 (base64 .p12), IOS_DIST_P12_PASSWORD, IOS_APPSTORE_PROFILE (base64 .mobileprovision); for upload or
# validate APPLE_API_KEY_P8 (the key's text), APPLE_API_KEY_ID, APPLE_API_ISSUER. Version 0.1 (fixed, so a new build of an
# approved version usually skips beta review), build number = the commit count. Signing material goes into a throwaway
# keychain, a temp folder and Xcode's profile folders, all removed at the end, and is never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
TEAM=W4MBZ59CH2
BUNDLE=io.github.kevinclark.hindsight
N=$(git rev-list --count HEAD)
WORK=$(mktemp -d)
KC="$WORK/signing.keychain-db"
KCPASS=$(openssl rand -hex 16)
PROFILE_COPIES=()
cleanup() {
  security delete-keychain "$KC" 2>/dev/null || true
  for f in "${PROFILE_COPIES[@]+"${PROFILE_COPIES[@]}"}"; do rm -f "$f"; done
  rm -rf "$WORK"
}
# A step's full output goes to a log; on failure its last 80 lines are shown.
run() { local name=$1; shift; "$@" > "$WORK/$name.log" 2>&1 || { echo "$name failed:"; tail -80 "$WORK/$name.log"; exit 1; }; }
trap cleanup EXIT

# The signing identity, in its own keychain on the search list for this run.
printf %s "$IOS_DIST_P12" | base64 --decode > "$WORK/dist.p12"
security create-keychain -p "$KCPASS" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KCPASS" "$KC"
security import "$WORK/dist.p12" -k "$KC" -P "$IOS_DIST_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPASS" "$KC" >/dev/null
# The search list as it is, one path a line (a path may hold spaces), with ours in front.
LIST=()
while IFS= read -r line; do line=${line#"${line%%[![:space:]]*}"}; line=${line#\"}; line=${line%\"}; [ -n "$line" ] && LIST+=("$line"); done < <(security list-keychains -d user)
security list-keychains -d user -s "$KC" "${LIST[@]}"

# The App Store profile, where Xcode looks for profiles.
printf %s "$IOS_APPSTORE_PROFILE" | base64 --decode > "$WORK/appstore.mobileprovision"
PROFILE=$(security cms -D -i "$WORK/appstore.mobileprovision" | plutil -extract Name raw -o - -)
UUID=$(security cms -D -i "$WORK/appstore.mobileprovision" | plutil -extract UUID raw -o - -)
for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
  mkdir -p "$dir"
  [ -f "$dir/$UUID.mobileprovision" ] || { cp "$WORK/appstore.mobileprovision" "$dir/$UUID.mobileprovision"; PROFILE_COPIES+=("$dir/$UUID.mobileprovision"); }
done

# The page and the icon (unless CI already made them), then the archive.
if [ "${BUILD_PAGE:-1}" = 1 ]; then sh scripts/ios-icon.sh; run page npm run build:phone; run sync npx cap sync ios; fi
run archive xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS \
  -archivePath "$WORK/App.xcarchive" archive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=$TEAM CODE_SIGN_IDENTITY="Apple Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE" OTHER_CODE_SIGN_FLAGS="--keychain $KC" \
  MARKETING_VERSION=0.1 CURRENT_PROJECT_VERSION="$N"

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
run export xcodebuild -exportArchive -archivePath "$WORK/App.xcarchive" -exportOptionsPlist "$WORK/export.plist" -exportPath "$WORK/out"
IPA=$(ls "$WORK"/out/*.ipa)
echo "built $(basename "$IPA"): version 0.1 ($N), $(du -h "$IPA" | cut -f1)"
codesign -dvv "$WORK/App.xcarchive/Products/Applications/App.app" 2>&1 | grep -E '^Authority=Apple Distribution|^TeamIdentifier'

ACTION=
[ "${VALIDATE:-0}" = 1 ] && ACTION=--validate-app
[ "${UPLOAD:-0}" = 1 ] && ACTION=--upload-app
if [ -n "$ACTION" ]; then
  mkdir -p "$WORK/private_keys"
  printf %s "$APPLE_API_KEY_P8" > "$WORK/private_keys/AuthKey_$APPLE_API_KEY_ID.p8"
  # altool looks for the key in ./private_keys (relative to the working directory).
  (cd "$WORK" && xcrun altool "$ACTION" -f "$IPA" -t ios --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER" --output-format normal)
  echo "${ACTION#--}: 0.1 ($N) accepted by App Store Connect"
else
  echo "neither UPLOAD nor VALIDATE: built only"
fi
