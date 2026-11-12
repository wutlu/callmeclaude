# CallMeClaude iOS

SwiftUI + CallKit + PushKit + AVAudioEngine (voice processing). iOS 17+.

| Dosya | Görev |
|---|---|
| `App.swift` | Uygulama girişi, PushKit kaydı, Siri/Shortcuts ("CallMeClaude ara") |
| `CallManager.swift` | CallKit: gelen/giden arama, interkom/Bluetooth cevap tuşu, Mac'e ulaşılamazsa yerel sesli uyarı |
| `AudioIO.swift` | Mikrofon → PCM16 16 kHz → Hub; Hub → PCM16 24 kHz → hoparlör/kask; barge-in flush |
| `HubClient.swift` | WebSocket (Tailscale/LAN), eşleştirme URL'lerini sırayla dener, otomatik yeniden bağlanır |
| `Views.swift` | Ana ekran (oturumlar, bekleyen kararlar, mod, panik), arama ekranı (altyazı), QR eşleştirme |

## Derleme ve USB ile kurulum

En kolayı: kök dizinde `./scripts/ios-install.sh` (Team ID ve bundle id'yi bir kez sorar, derler, kurar, açar). Elle:

```bash
brew install xcodegen
cp Config/Local.example.xcconfig Config/Local.xcconfig   # kendi Team ID ve benzersiz bundle id'n
xcodegen generate
xcodebuild -project CallMeClaude.xcodeproj -scheme CallMeClaude -configuration Debug \
  -destination 'platform=iOS,name=<iPhone adın>' -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl list devices
xcrun devicectl device install app --device <cihaz-id> build/Build/Products/Debug-iphoneos/CallMeClaude.app
```

VoIP push için **ücretli Apple Developer hesabı** gerekir (Xcode'da hesabın ekli olmalı; `-allowProvisioningUpdates` push yetkili profili otomatik üretir). Xcode'dan kurulan sürüm APNs **sandbox** ortamını kullanır → Hub'da `apns.environment = development`.

İlk açılışta: mikrofon, kamera (QR) ve yerel ağ izinlerini ver. Ayarlar → CallMeClaude → "Siri ve Arama" açık olsun.

Aramanın nerede çalacağı uygulamanın Settings → **When Claude needs you** bölümünden seçilir: **This phone**, **The Mac** (masaüstü uygulaması çalar; açık değilse telefon çalar) ya da **Don't call**. Masaüstü uygulamasındaki ayarın aynısıdır.
