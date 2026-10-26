# Building T3 Code Lim for iOS with a free Apple ID

T3 Code Lim is this fork's own build of the mobile app. It installs beside the App Store
"T3 Code" on the same phone, under its own bundle id `ai.liminal.t3code.lim.mobile` and URL
scheme `t3code-lim`. It has no T3 Connect, no Clerk sign-in, no relay and no over-the-air
updates. It reaches a server only through a pairing URL.

The build is signed by a Personal Team, the free tier of any Apple ID, so it omits what a
Personal Team cannot sign: push notifications, Sign in with Apple, app groups, the widgets
and the share extension. The app config does this when `APP_VARIANT=lim` and
`T3CODE_IOS_PERSONAL_TEAM=1`, which the build commands below set.

## What you need on the Mac

- Xcode, with its iOS platform downloaded, and your Apple ID added under Xcode, Settings,
  Apple Accounts. Agree to the developer agreement once at developer.apple.com.
- CocoaPods on your `PATH`. See [CocoaPods without Homebrew](#cocoapods-without-homebrew).
- An Apple Development signing certificate for that Apple ID. See
  [Signing certificate](#signing-certificate).
- Node 24 and `vp` (see the [root README](../../README.md)).
- The phone on a USB cable, paired with the Mac and in Developer Mode. See [The phone](#the-phone).

### CocoaPods without Homebrew

`expo prebuild` runs `pod install`. When `pod` is not on the `PATH`, Expo tries `gem install`,
then Homebrew. It runs non-interactively here, so it skips `sudo gem install`.

The Ruby that ships with macOS (2.6) cannot install CocoaPods, even with `--user-install`:

- CocoaPods needs `ffi`, and current `ffi` releases need Ruby 3.
- Older `ffi` releases compile from source. That fails on current Xcode, because the SDK's
  Ruby 2.6 headers lack `ruby/config.h`.

Use Homebrew's portable Ruby instead. It is a self-contained build that unpacks into your home
folder and needs no administrator password:

```sh
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -fsSLO https://github.com/Homebrew/homebrew-portable-ruby/releases/download/3.4.6/portable-ruby-3.4.6.arm64_big_sur.bottle.tar.gz
tar -xzf portable-ruby-3.4.6.arm64_big_sur.bottle.tar.gz && rm portable-ruby-3.4.6.arm64_big_sur.bottle.tar.gz
export GEM_HOME=~/.local/opt/gems GEM_PATH=~/.local/opt/gems
export PATH=~/.local/opt/gems/bin:~/.local/opt/portable-ruby/3.4.6/bin:$PATH
gem install --no-document cocoapods
pod --version
```

Put the two `export` lines in `~/.zprofile`, or in whatever runs the build, so later runs find
`pod`. Homebrew (`brew install cocoapods`) also works. Installing Homebrew needs an
administrator password.

### Signing certificate

Adding an Apple ID to Xcode does not always create a development certificate on the Mac.
Without one, the build stops with "No code signing certificates are available to use".

Create the certificate in Xcode. Open Settings, Apple Accounts, select the Apple ID, and click
Manage Certificates. Click the add button and choose Apple Development.

Then confirm that the Mac can sign with it:

```sh
security find-identity -v -p codesigning
```

The output must list a valid identity that starts with `"Apple Development:`. If
`security find-identity -p codesigning` (without `-v`) lists it but the valid count is 0, the
Mac lacks the intermediate certificate that issued it. Its issuer line reads
"Apple Worldwide Developer Relations Certification Authority, OU=G3". Add that intermediate to
the login keychain:

```sh
curl -fsSLO https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
security add-certificates -k ~/Library/Keychains/login.keychain-db AppleWWDRCAG3.cer
rm AppleWWDRCAG3.cer
```

### The phone

Plug the phone in and unlock it. Tap Trust on its "Trust This Computer?" prompt and enter the
passcode. `xcrun devicectl list devices` must show it as `connected` with its name and UDID. A
row with only an ECID means it is not paired yet. `xcrun devicectl manage pair --device <id>`
asks the phone again.

Then turn on Settings, Privacy & Security, Developer Mode on the phone, and restart it when it
asks. The setting appears only after the phone has connected to Xcode once.

## First build and install

`vp run ios:lim` runs `expo prebuild` and then `expo run:ios`. `expo run:ios` builds without
`-allowProvisioningUpdates`, so Xcode cannot create the Personal Team provisioning profile for
the new bundle id or a newly added phone. It stops with "No profiles for
'ai.liminal.t3code.lim.mobile' were found". Build with `xcodebuild` directly instead.

First set your team id, from Xcode, Settings, Apple Accounts, in the repository root
`.env.local`:

```sh
echo 'T3CODE_APPLE_TEAM_ID=<team id>' >> .env.local
```

Then, from the repository root, with the phone's UDID from `xcrun devicectl list devices`:

```sh
vp i
cd apps/mobile
export APP_VARIANT=lim T3CODE_IOS_PERSONAL_TEAM=1 \
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=ai.liminal.t3code.lim.mobile EXPO_NO_GIT_STATUS=1
npx expo prebuild --clean --platform ios
cd ios
xcodebuild -workspace T3CodeLim.xcworkspace -scheme T3CodeLim -configuration Release \
  -destination id=<udid> -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> build/Build/Products/Release-iphoneos/T3CodeLim.app
```

Run the build in a Terminal on the Mac's own screen, not over ssh. `codesign` reaches the
private key in the login keychain only from the GUI login session. Over ssh it fails with
`errSecInternalComponent`, after the whole compile. The first signing may ask to let `codesign`
use the key. Enter the Mac password and click Always Allow.

A Release configuration embeds the JavaScript bundle, so the phone needs no Metro server
afterwards.

When the app first opens, iOS refuses to run it until you trust the developer: Settings,
General, VPN & Device Management, tap your Apple ID under Developer App, then Trust.

Then open the app and pair it with a server from a pairing URL or QR code, as for any other
T3 Code client. Add environment can scan a QR code.

## Keeping it running

A Personal Team provisioning profile lasts seven days. When it expires the app refuses to
open until it is signed again. Plug the phone in and run the same build and install. A
rebuild after a code change is the same commands. Lee's M5 wraps them in
`bin/t3-v2-ios-reinstall` in lim-v2.

A free Apple ID can hold three sideloaded apps at a time and register ten app ids a week.
Each build reuses the same app id, so one Lim build counts once.

## Checking the configuration without a Mac

`vp run config:lim` in `apps/mobile` prints the resolved Expo config. Check the name, the
scheme, the bundle id, that `ios.associatedDomains` and `ios.appleTeamId` are absent, and
that `updates.enabled` is `false`.

```sh
cd apps/mobile
APP_VARIANT=lim T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=ai.liminal.t3code.lim.mobile \
npx expo prebuild --platform ios --no-install --clean
```

generates the native project on any platform. Its entitlements file must hold only
`keychain-access-groups`. Delete `apps/mobile/ios` afterwards. It is ignored by git.
