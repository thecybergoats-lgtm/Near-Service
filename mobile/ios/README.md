# iOS target — Near Service (Flutter)

Created by the Phase 3 integrator (2026-11-17). **This target has never
been built: there is no macOS / Xcode in this Linux VM, so nothing here
is verified — configure only.** The first build must happen on a Mac
with Xcode + Flutter installed.

## What is configured

- **Bundle ID:** `com.nearservice.app` — matches the Android
  `applicationId` in `android/app/build.gradle`. Display name
  "Near Service", version from `pubspec.yaml` via `FLUTTER_BUILD_NAME` /
  `FLUTTER_BUILD_NUMBER`.
- **Deployment target:** iOS 12.0 (Flutter 3.22 minimum).
- **Permissions** (`Runner/Info.plist`): location when-in-use + always
  (nearby providers, live tracking), camera (provider verification
  selfie + CNIC photo), microphone (on-device voice search), photo
  library read + add (attach a photo of the problem). Every usage
  string is user-facing — iOS shows it in the permission prompt.
- **Entry point:** `Runner/AppDelegate.swift` (`@main`, registers
  plugins via `GeneratedPluginRegistrant`).
- **Assets:** `AppIcon.appiconset` / `LaunchImage.imageset` manifests
  only — **no icon PNGs are bundled yet**; add the icon files (or run
  `flutter_launcher_icons`) before the first Archive, or Xcode will
  warn about the missing AppIcon.
- **Podfile:** standard Flutter Podfile, iOS 12.0, `flutter_ios_podfile_setup`.

## Signing — placeholders (fill in on a Mac)

- `DEVELOPMENT_TEAM` is empty (`""`) in all three target
  configurations (Debug / Profile / Release). Set it in Xcode:
  Runner target → Signing & Capabilities → Team → your Apple
  Developer Program team. Or set `DEVELOPMENT_TEAM=<Team ID>` in the
  target build settings.
- Code signing style is Xcode Automatic (the default when no
  `CODE_SIGN_STYLE` is set). For a store build, use Automatic signing
  with the team above, or switch to Manual with a distribution
  certificate + the `com.nearservice.app` App ID / provisioning profile.
- No provisioning profile, certificate, or Team ID is stored in this
  repo — never commit those.

## First build (on a Mac)

```sh
cd mobile
flutter pub get        # regenerates ios/Flutter/Generated.xcconfig
                       # and ios/Runner/GeneratedPluginRegistrant.*
cd ios && pod install  # needs CocoaPods
cd .. && flutter build ios --release
```

If anything in `ios/` looks off, the safe regeneration is
`flutter create --platforms ios .` from `mobile/` on a Mac (it keeps
`lib/` and `pubspec.yaml` and rewrites the iOS runner); re-apply the
bundle ID and the Info.plist permission strings afterwards.

## Known gaps (not verified here)

- Never compiled with Xcode; `project.pbxproj` was hand-authored from
  the standard Flutter template and only structurally checked.
- No AppIcon PNGs, no `RunnerTests` target, no fastlane / CI lane.
- `Generated.xcconfig` is a stub — Flutter regenerates it on first build.
