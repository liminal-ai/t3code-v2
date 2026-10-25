# Building T3 Code Lim for iOS with a free Apple ID

T3 Code Lim is this fork's own build of the mobile app. It installs beside the App Store
"T3 Code" on the same phone, under its own bundle id `ai.liminal.t3code.lim.mobile` and URL
scheme `t3code-lim`. It has no T3 Connect, no Clerk sign-in, no relay and no over-the-air
updates. It reaches a server only through a pairing URL.

The build is signed by a Personal Team, the free tier of any Apple ID, so it omits what a
Personal Team cannot sign: push notifications, Sign in with Apple, app groups, the widgets
and the share extension. The app config does this when `APP_VARIANT=lim` and
`T3CODE_IOS_PERSONAL_TEAM=1`, which the `ios:lim` script sets.

## What you need on the Mac

- Xcode, with its iOS platform downloaded, and your Apple ID added under Xcode, Settings,
  Accounts. Agree to the developer agreement once at developer.apple.com.
- CocoaPods on your `PATH`. See [CocoaPods without Homebrew](#cocoapods-without-homebrew).
- An Apple Development signing certificate for that Apple ID. See
  [Signing certificate](#signing-certificate).
- Node 24 and `vp` (see the [root README](../../README.md)).
- The phone on a USB cable. On the phone, turn on Settings, Privacy & Security, Developer
  Mode, and restart when it asks.

### CocoaPods without Homebrew

`expo prebuild` runs `pod install`. When `pod` is not on the `PATH`, Expo tries `gem install`,
then `sudo gem install`, then Homebrew. With the Ruby that ships with macOS, the first two
need an administrator password, and the third needs Homebrew. Install CocoaPods for your user
with that Ruby instead. This needs no administrator password.

```sh
gem install --user-install cocoapods
echo 'export PATH="$(ruby -e "puts Gem.user_dir")/bin:$PATH"' >> ~/.zprofile
source ~/.zprofile
pod --version
```

The macOS Ruby is old. If `gem` stops with "The last version of NAME to support your Ruby &
RubyGems was VERSION", install that version first and then run the CocoaPods install again:

```sh
gem install --user-install NAME -v VERSION
gem install --user-install cocoapods
```

Repeat this for each gem that `gem` names. If `/usr/bin/ruby` is not on the Mac, this path
does not work. Homebrew (`brew install cocoapods`) is the other path. Installing Homebrew
needs Lee's administrator password, so that decision is his.

### Signing certificate

Adding an Apple ID to Xcode does not always create a development certificate on the Mac.
Without one, `vp run ios:lim` stops with "No code signing certificates are available to use"
before it asks which team signs the app.

Create the certificate in Xcode. Open Settings, Accounts, select the Apple ID, and click
Manage Certificates. Click the add button and choose Apple Development.

Then confirm that the Mac has the certificate:

```sh
security find-identity -v -p codesigning
```

The output must list an identity that starts with `"Apple Development:`. If it does not, run
`vp run ios:lim` once so that it generates `apps/mobile/ios`. Open the `.xcworkspace` file
in that folder in Xcode. Select the app target, open Signing & Capabilities, and select the
Personal Team. Xcode then creates the certificate. Run the `security` command again to check.

## First build and install

From the repository root:

```sh
vp i
cd apps/mobile
vp run ios:lim
```

The script runs `expo prebuild` for the `lim` variant and then `expo run:ios --device
--configuration Release --no-bundler`. It asks which device to install on. The first run also
asks which development team signs the app. Pick the Personal Team. To skip that question,
set `T3CODE_APPLE_TEAM_ID` to your team id from Xcode, Settings, Accounts, in the repository
root `.env.local`.

A Release configuration embeds the JavaScript bundle, so the phone needs no Metro server
afterwards.

When the app first opens, iOS refuses to run it until you trust the developer: Settings,
General, VPN & Device Management, tap your Apple ID under Developer App, then Trust.

Then open the app and pair it with a server from a pairing URL or QR code, as for any other
T3 Code client.

## Keeping it running

A Personal Team provisioning profile lasts seven days. When it expires the app refuses to
open until it is signed again. Plug the phone in and run the same command. A rebuild after a
code change is the same command.

```sh
cd apps/mobile
vp run ios:lim
```

A free Apple ID can hold three sideloaded apps at a time and register ten app ids a week.
Each `vp run ios:lim` reuses the same app id, so one Lim build counts once.

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
