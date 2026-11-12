<p align="center">
  <img src="apps/ios/CallMeClaude/Assets.xcassets/AppIcon.appiconset/icon.png" width="96" alt="CallMeClaude simgesi">
</p>

<h1 align="center">CallMeClaude</h1>

<p align="center">
  <b>Claude Code ajanların takıldığında seni arar. Kaskından, arabandan ya da kanependen cevap verirsin.</b><br>
  Açık kaynak · self-hosted · <i>kendi</i> Claude aboneliğinle çalışır · SaaS yok, hesap yok, aracı sunucu yok
</p>

<p align="center">
  <a href="INSTALLATION.md">Kurulum</a> ·
  <a href="#desteklenen-platformlar">Platformlar</a> ·
  <a href="#nasıl-çalışır">Nasıl çalışır</a> ·
  <a href="docs/">Tasarım dokümanları</a> ·
  <a href="README.md">English</a>
</p>

<p align="center"><a href="docs/media/callmeclaude-demo.mp4"><img src="docs/media/callmeclaude-demo.gif" width="720" alt="CallMeClaude tanıtımı: takılan Claude Code oturumu telefonu arıyor, geliştirici sesle cevaplıyor, oturum devam ediyor"></a><br><a href="docs/media/callmeclaude-demo.mp4">▶ 30 saniyelik tanıtım videosu (MP4)</a></p>

---

Claude Code saatlerce kendi başına çalışabiliyor, ama bir izin istediğinde, *"bu formu senin onayın olmadan gönderemem"* dediğinde ya da işi bitirip yeni talimat beklediğinde durup seni bekliyor. Her seferinde klavyeye dönmen gerekiyor.

**CallMeClaude bu döngüden klavyeyi çıkarır.** Mac'indeki (ya da Linux bilgisayarındaki) küçük bir ajan, tüm Claude Code oturumlarını gerçek zamanlı izler. Bir oturum takılınca ya da bitince **iPhone'unu (ya da Android telefonunu) gerçek bir telefon gibi arar** ve ne olduğunu iki kısa cümleyle söyler. Motosiklet interkomundan, AirPods'tan ya da telefonun kendisinden cevap verir, ne yapılacağını söylersin:

> 📞 **Claude:** "acme-web: başvuru formu dolduruldu, onayını bekliyor. Göndereyim mi?"
> 🧑 **Sen:** "Gönder, tam yetkin var. Sonra e-posta taslağına geç."
> 📞 **Claude:** "Gönderildi, onay sayfası açık. Ajan e-postaya geçti."

İstediğin an Claude'u sen de arayabilirsin ("Hey Siri, CallMeClaude'u ara"). Durum sorabilir, yeni oturum başlatabilir, izinleri onaylayabilir ya da tarayıcıda bir şeyi Mac'e (veya Linux bilgisayarına) senin yerine tıklatabilirsin.

## Özellikler

- **Tüm Claude Code oturumlarını izler**: terminal, IDE ya da masaüstü uygulaması. Claude Code'un resmi HTTP hook'larını kullanır, hiçbir şeyi yamamaz.
- **Oturumun neden durduğunu anlar**: izin istemi, soru, "bunu yapamam", biten iş ya da API hatası. Sınıflandırmayı senin planınla Claude Haiku yapar.
- **Telefonunu gerçekten çaldırır**: PushKit ve CallKit ile. Kilit ekranında çalışır, Bluetooth ya da interkom cevap tuşu çalışır, aramalar Son Aramalar'da görünür. Android uygulaması, hub'a kendi kalıcı bağlantısı üzerinden Android'in Telecom altyapısıyla çalar (Google push servisi yok).
- **Doğal, sözü kesilebilen ses**: yaklaşık bir saniye gecikmeli Gemini Live sesten sese model. Telefon gibi konuşur: kısa cümleler, dosya yolu yok, her seferinde tek soru.
- **Senin dilini konuşur**: konuşma dilini uygulamada ya da `cmc setup --language` ile seç (`en-US`, `tr-TR`, `de-DE`, `es-ES`, …). Claude aramalarda bu dili konuşur ve oturum özetlerini bu dilde yazar. "Bundan sonra Almanca konuş" da diyebilirsin. Uygulama ve CLI'ın kendisi İngilizcedir.
- **Oturum bitince söyler** (isteğe bağlı): "acme web projesi görevi tamamlandı." cümlesini konuşma dilinde sesli okur; ya **bu bilgisayarda** (sistem sesi: macOS'ta `say`; Linux'ta speech-dispatcher'ın `spd-say`'i ya da robotik sesli espeak-ng) ya da **telefonunda** (uygulamanın kendi sesiyle, kulaklık ya da interkom üzerinden). 20 saniyeden kısa turlar sessiz geçer. Masaüstü panelinden ya da telefon uygulamasının ayarlarından seçilir.
- **Oturumları uzaktan açar**. Duran oturumu açık tutar ve sesli talimatınla devam ettirir (`Stop` hook'u `decision: block`). İzin istemlerini cevaplayabilir, tmux oturumlarına yazabilir, biten oturumları sürdürebilir ya da talimatı bir sonraki adım için kuyruğa koyabilir.
- **Ajan yapamadığında bilgisayarı senin yerine kullanır**: Claude in Chrome, [Peekaboo](https://github.com/steipete/Peekaboo) ve `cliclick` ile. Linux'ta Claude in Chrome ile masaüstünün ekran görüntüsü ve giriş araçlarını kullanır (bkz. [hangi ortamda ne çalışır](#hangi-ortamda-ne-çalışır)). Her zaman önce açık sesli onay ister.
- **Günlerce gözetimsiz çalışmak için**: launchd servisi (Linux'ta systemd `--user`), uyku önleme kontrolleri, hücresel erişim için Tailscale, yeniden bağlanmaya dayanan aramalar, panik anahtarı ve tam denetim kaydı.

## Nasıl çalışır

```
        Mac (stays at home)                                   iPhone (with you)
 ┌──────────────────────────────────────┐              ┌─────────────────────────┐
 │  Claude Code sessions                │              │  CallKit incoming call  │
 │        │ HTTP hooks (127.0.0.1)      │   VoIP push  │  (lock screen, Recents) │
 │        ▼                             │  ──────────▶ │           │             │
 │  Hub  (cmc, launchd service)         │  your APNs   │           ▼             │
 │   ├─ classifier  → Claude Haiku      │     key      │  Bluetooth HFP          │
 │   ├─ call scheduler                  │              │  → helmet intercom      │
 │   ├─ voice bridge → Gemini Live      │  ◀════════▶  │                         │
 │   └─ brain → Claude Agent SDK        │  PCM audio   │                         │
 │            + computer use            │  over        │                         │
 └──────────────────────────────────────┘  Tailscale   └─────────────────────────┘
```

- **Hub** (`apps/mac-agent`, TypeScript/Node): `cmc` CLI'ı olan bir launchd servisi. Claude Code hook'larını `127.0.0.1` üzerinden alır, oturum durumunu tutar, ne zaman arayacağına karar verir, telefonun sesini ses modeline köprüler ve araçları çalıştırır.
- **iOS uygulaması** (`apps/ios`, Swift): CallKit, PushKit ve ses işlemeli AVAudioEngine. İnce bir telefondur: çalar, ses taşır, oturumlarını listeler.
- **Android uygulaması** (`apps/android`, Kotlin): aynı ince telefon. Bir foreground service hub'a WebSocket'i açık tutar; hub push yerine bu bağlantı üzerinden çaldırır. Bkz. [apps/android/README.md](apps/android/README.md).
- **Linux**'ta hub aynı koddur: launchd yerine systemd `--user` servisi, Keychain yerine libsecret keyring'i. Bkz. [ADR-0006](docs/adr/0006-linux-hub.md) ve [ADR-0008](docs/adr/0008-linux-computer-use.md).
- **İki katmanlı ses**: konuşmayı hızlı bir sesten sese model yürütür. Önemli olan her şey hub araçları üzerinden **Claude**'a ve oturumlarına gider: talimatlar, onaylar, kodla ilgili sorular, bilgisayar kullanımı. Bkz. [ADR-0003](docs/adr/0003-two-layer-voice.md).

## Senin aboneliğin, senin makinen

CallMeClaude Claude kimlik bilgilerini hiçbir zaman görmez, saklamaz, iletmez. Claude'a yalnızca kendi Mac'ine (ya da Linux bilgisayarına) zaten kurup giriş yaptığın Claude Code üzerinden, Claude Agent SDK ile, kişisel ve yerel kullanım için ulaşır. Merkezi sunucu ve paylaşılan hesap yoktur. Her kurulum tek bir geliştiriciye hizmet eder ve kullanım senin plan limitlerinden düşer. Bkz. [ADR-0002](docs/adr/0002-subscription-auth.md) ve Anthropic'in [Agent SDK'yı Claude planınla kullanma rehberi](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Geri kalan her şey kendi anahtarınla ve doğrudan sağlayıcıyla çalışır: ses için bir **Gemini API anahtarı**, telefonu çaldırmak için **Apple APNs anahtarın**. Anahtarlar macOS Keychain'de saklanır. Linux'ta libsecret (`secret-tool`) ile keyring'ine gider. Android uygulaması APNs anahtarı ya da Google hesabı istemez.

## Desteklenen platformlar

| | Desteklenen |
|---|---|
| Hub (evde kalan bilgisayar) | **macOS** 15+ · **Linux**: Ubuntu 22.04+, Debian 12+, Fedora, Linux Mint 21+, Arch; X11 ve Wayland; GNOME, KDE ve wlroots tabanlı masaüstleri (Sway, Hyprland) |
| Telefon | **iPhone** (iOS 17+, [apps/ios](apps/ios/README.md)) · **Android** 10+ ([apps/android](apps/android/README.md)) |

Her telefon her hub'la çalışır: Android uygulaması macOS hub'ıyla da, iPhone uygulaması Linux hub'ıyla da çalışır.

### Hangi ortamda ne çalışır

| | macOS | Linux X11 | Linux Wayland, KDE | Linux Wayland, wlroots (Sway, Hyprland) | Linux Wayland, GNOME |
|---|---|---|---|---|---|
| Oturumları izleme, arama, ses | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bilgisayar kullanımı: tarayıcı (Claude in Chrome) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bilgisayar kullanımı: ekran görüntüsü | ✅ Peekaboo / `screencapture` | ✅ `scrot`, `import` ya da `maim` | ✅ `spectacle` | ✅ `grim` | ❌ desteklenmiyor |
| Bilgisayar kullanımı: fare ve klavye | ✅ Peekaboo / `cliclick` | ✅ `xdotool` | ⚙️ `ydotool` 1.x, isteğe bağlı | ⚙️ `ydotool` 1.x, isteğe bağlı | ❌ (kontrol edecek ekran görüntüsü yok) |
| Bilgisayar kullanımı: metin yazma (her klavye düzeninde) | ✅ Peekaboo | ✅ `xclip` ya da `xsel` ile yapıştırılır, pano geri konur | ✅ `wl-clipboard` ile yapıştırılır, pano geri konur | ✅ aynı | ❌ |
| Sesle başlatılan oturumlar | ✅ tmux içinde | ✅ tmux içinde, ya da tmux istemezsen headless (`claude -p`) | ✅ aynı | ✅ aynı | ✅ aynı |

| Telefon | Arka planda çalar mı | Gerekenler |
|---|---|---|
| iPhone | ✅ APNs anahtarınla (VoIP push); onsuz yalnızca uygulama açıkken | Ücretli Apple Developer hesabı |
| Android | ✅ uygulamanın hub'a kendi bağlantısıyla | Uygulama için pil optimizasyonu kapalı; Google servisleri gerekmez |

## Gereksinimler

| | |
|---|---|
| Mac | macOS 15+, Node 22.5+, pnpm, Homebrew, Xcode 16+ |
| Claude | Claude Code kurulu ve Pro/Max planında giriş yapılmış |
| Ses | Bir Gemini API anahtarı ([buradan al](https://aistudio.google.com/apikey)) |
| Telefon | iOS 17+ bir iPhone ve **ücretli Apple Developer hesabı** (VoIP push bunu gerektirir) |
| Yolda | Mac'te ve iPhone'da [Tailscale](https://tailscale.com) (kişisel kullanımda ücretsiz) |

Linux ve Android'de bunların yerine:

| | |
|---|---|
| Linux | Node 22.5+, pnpm, kilidi açık bir keyring ile `secret-tool` (libsecret) (KDE Plasma'da bunu KDE Wallet sağlar; diğerlerinde GNOME Keyring); isteğe bağlı: tmux, masaüstün için bilgisayar kullanımı araçları, `wl-clipboard` (Wayland) ya da `xclip` (X11) dahil; bunlar olmadan ajan metin yazamaz |
| Android | Android 10+; APK'yı derlemek için JDK 17 ve Android SDK. Android 17'de yerel ağ izni yalnızca LAN adresleri için gerekir; Tailscale onsuz da çalışır |

## Hızlı başlangıç

```bash
git clone https://github.com/wutlu/callmeclaude && cd callmeclaude
pnpm install
ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" /opt/homebrew/bin/cmc

cmc setup --gemini-key <GEMINI_ANAHTARI> --language tr-TR   # hook'lar + launchd servisi; anahtar → Keychain
./scripts/ios-install.sh              # iPhone uygulamasını USB ile derle ve kur
cmc pair                              # QR kodu uygulamada okut
cmc call-me                           # telefonun çalar
```

APNs ve Tailscale dahil tam rehber **[INSTALLATION.md](INSTALLATION.md)** dosyasında (İngilizce).

**Linux** (her dağıtım; dağıtıma göre paketler için [INSTALLATION.md › Linux hub](INSTALLATION.md#linux-hub)):

```bash
git clone https://github.com/wutlu/callmeclaude && cd callmeclaude
pnpm install
mkdir -p ~/.local/bin && ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" ~/.local/bin/cmc

read -rs -p 'Gemini API anahtarı: ' KEY; echo              # anahtarı kabuk geçmişinin dışında tutar
cmc setup --gemini-key "$KEY" --language tr-TR              # hook'lar + systemd --user servisi; tmux'u sorar; anahtar → keyring
unset KEY
cmc doctor                                                  # linger, uyku, proje kökleri ve bilgisayar kullanımı önerileri
cmc pair                                                    # QR kodu uygulamada okut
cmc call-me                                                 # telefonun çalar
```

Sesle başlattığın oturumlar yalnızca **proje köklerinin** içinde çalışır (Linux'ta varsayılan olarak `~/projects`, `~/Desktop/projects` ve var olan diğer yaygın klasörler). Değiştirmek için `~/.callmeclaude/config.json`'daki `projectRoots`'u düzenle, sonra `systemctl --user restart dev.callmeclaude.hub`; bkz. [INSTALLATION.md › L2](INSTALLATION.md#l2-install-the-hub). Bir Linux bilgisayarı yalnızca sen uzaktayken, `sudo` olmadan uyanık tutmak için: [INSTALLATION.md › L3](INSTALLATION.md#l3-keep-the-hub-running-linger-and-sleep).

**Android uygulaması:** APK'yı [apps/android/README.md](apps/android/README.md)'deki gibi derleyip kur, sonra `cmc pair` QR kodunu okut. macOS ve Linux hub'ıyla çalışır.

## Günlük kullanım

```bash
cmc status                                    # oturumlar ve bekleyen kararlar
cmc mode away                                 # desk | away | ride | sleep: hub ne zaman arayabilir
cmc run ~/code/app "fix the failing tests"    # hub'ın yazabilmesi için Claude Code'u tmux içinde başlat
cmc do "open the PR in Chrome and press Merge" # hub bilgisayarı kullansın
cmc ignore ~/code/private                     # yalnızca izle: durumu bildir, asla tutma ya da arama
cmc panic                                     # her şeyi durdur, otomasyonu duraklat (cmc resume)
cmc doctor                                    # tüm kurulumu kontrol et
```

Telefonda **Call Claude**'a dokun ya da *"Hey Siri, CallMeClaude'u ara"* de. Bilgisayarda tepsi simgesine tıkla ve **Talk to Claude**'a bas.

Bir oturum seni beklediğinde Claude'un seni nerede arayacağını tepsi simgesinden ya da telefon uygulamasında **Settings › When Claude needs you** bölümünden seçersin:

| Seçim | Ne olur |
|---|---|
| **Call this computer** | Tepsi uygulaması çalar (yeşil simge, bildirim) ve bilgisayarın mikrofonuyla konuşursun. Masa modunda da burada çalar. Tepsi uygulaması kapalıysa telefon çalar |
| **Call my phone** | Telefon her zamanki gibi çalar |
| **Don't call** | Hiçbir şey çalmaz; güncellemeler senin başlattığın bir sonraki konuşmayı bekler |

## Güvenlik

Bu yazılım bilgisayarını sesle yönetebilir. Varsayılanlar temkinlidir:

- Riskli eylemler açık sesli onay ister: ödeme, deploy, `git push`, silme, mesaj gönderme, bilgisayar kullanımı.
- Yıkıcı kabuk komutları ve hassas yollar (`~/.ssh`, Keychain, `.env`; Linux'ta keyring dosyaları da) hub'ın kendi ajanına kapalıdır.
- Linux'ta hub'ın ajanı metni yalnızca pano üzerinden yapıştırarak yazar ve sonra panonu geri koyar; hepsini seçme (Ctrl+A) ve kesme (Ctrl+X) ona kapalıdır, hataları yalnızca geri alma (Ctrl+Z) ile düzeltir.
- Web sayfası içeriği talimat değil, veri sayılır.
- Her şey `~/.callmeclaude/audit` altındaki yalnızca eklenebilen denetim kaydına yazılır.

Güvenmeden önce [docs/08-security.md](docs/08-security.md) ve [SECURITY.md](SECURITY.md) dosyalarını oku.

## Dürüst sınırlar

- **Wayland'de GNOME:** ekran görüntüsü yok, dolayısıyla masaüstü kontrolü yok; yalnızca tarayıcı yolu (Claude in Chrome) çalışır.
- **ydotool isteğe bağlıdır ve güvenlik bedeli vardır:** Wayland'de fare ve klavye için `/dev/uinput`'a yazma izni gerekir; o zaman kullanıcı hesabında çalışan her program sentetik giriş üretebilir. Sen kurana kadar kapalıdır ve yalnızca ydotool 1.x kullanılır.
- **Linux panosu:** ajan yazdıktan sonra panodaki metin geri konur; görsel gibi metin olmayan içerik geri konamaz, bu yüzden pano boşaltılır ve ajan bunu sana söyler.
- **Başsız Linux:** masaüstü girişi olmadan keyring kilitli kalabilir; hub anahtarlarını okuyamaz. Telefon o zaman anahtarın keyring'de olduğunu ve bilgisayarda oturum açınca kilidin açılacağını söyler.
- **Android'de push yok:** uygulama hub'a kalıcı bir bağlantı tutar. Android ya da üretici uygulamayı durdurursa hub onu çaldıramaz; pil ayarları bu yüzden önemlidir.
- **Akıllı saatler:** bazı saatler telefon kulaklığı olarak kaydolur ve arama sesini kendine çeker.

Ayrıntılar ve çözümler: [INSTALLATION.md › Honest limits](INSTALLATION.md#honest-limits).

## Proje yapısı

```
apps/mac-agent/     Hub: hook sunucusu, oturum durumu, sınıflandırıcı, aramalar, ses köprüsü, CLI
apps/ios/           iPhone uygulaması (XcodeGen projesi)
apps/android/       Android uygulaması (Gradle projesi)
packages/protocol/  Hub ↔ uygulama mesaj tipleri
scripts/            kurulum yardımcıları
docs/               tasarım dokümanları, araştırma ve ADR'ler (Türkçe)
```

## Durum

Erken aşamada, ama gerçek cihazlarda uçtan uca çalışıyor: hook'lar → sınıflandırma → VoIP araması → sesli konuşma → oturuma iletilen talimat. Pürüzler bekle. Issue ve PR'lar açık; bkz. [CONTRIBUTING.md](CONTRIBUTING.md).

## Lisans

[MIT](LICENSE)

CallMeClaude bağımsız bir açık kaynak projedir. Anthropic ya da Google ile bağlantılı değildir, onlar tarafından desteklenmez. "Claude", Anthropic'in ticari markasıdır.
