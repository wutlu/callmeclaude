# Hub ↔ App Protokolü (v1)

- Taşıma: tek WebSocket, `ws://<tailscale-adı|ip|lan-ip>:47801`. Tailscale içinde WireGuard ile şifreli; evde LAN üzerinden token ile.
- **Metin çerçeveleri:** JSON kontrol mesajları. **İkili çerçeveler:** ses.
  - App → Hub: PCM16 LE, mono, 16 kHz (mikrofon)
  - Hub → App: PCM16 LE, mono, 24 kHz (asistan sesi)
- İlk mesaj `auth` olmalı (5 sn içinde), aksi halde bağlantı `4001/4003` ile kapanır.
- Tip tanımları: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts) · Swift karşılığı: `apps/ios/CallMeClaude/Models.swift`

## App → Hub
| type | alanlar | |
|---|---|---|
| `auth` | `token`, `device`, `v`, `kind?` | Eşleştirmedeki token. `kind`: `phone` (varsayılan) · `desktop` (tepsi uygulaması) |
| `push.register` | `token`, `kind:"voip"` | PushKit token |
| `call.start` | `direction`, `callId?` | `outbound` = Hub'ın aramasını cevapladım; `inbound` = ben arıyorum |
| `call.end` | `callId` | Kapat / reddet |
| `mode.set` | `mode` | desk · away · ride · sleep |
| `ring.set` | `target` | Arama nereye: `computer` (masaüstü uygulaması; açık değilse telefon) · `phone` · `off` (aranmaz, güncellemeler bir sonraki konuşmada) |
| `pending.resolve` | `pendingId`, `decision`, `note?` | Ekrandan onay/ret/bırak |
| `device.lock` | `locked` | Kilit ekranı açık mı; bağlanınca ve her değişimde. Kilitliyken sesli asistan yalnızca sorulara cevap verir, değişiklik yapamaz |
| `panic` / `resume` / `ping` | | |

## Hub → App
| type | alanlar | |
|---|---|---|
| `hello` | `v`, `snapshot` | Auth başarılı |
| `snapshot` | `snapshot` | Oturum/karar listesi değişti. `ringTarget` ve çalan/süren arama (`call: {callId, state, on, title}`) da burada |
| `heartbeat` | `ts` | 15 sn'de bir |
| `call.incoming` | `callId`, `title` | Yalnızca çalan tarafa (`ringTarget`'a göre masaüstü ya da telefon); telefonda push'a ek olarak |
| `call.ready` / `call.ended` | `callId`, `reason?` | |
| `audio.flush` | | Kullanıcı araya girdi, kuyruktaki sesi at |
| `transcript` | `role`, `text`, `final` | Altyazı |
| `error` | `message` | |

## VoIP push (APNs, `apns-push-type: voip`, topic `<bundle>.voip`)
```json
{ "cmc": { "v": 1, "callId": "c_ab12cd", "title": "acme: engel", "priority": "P1" } }
```
İçerik minimal; ayrıntı her zaman WebSocket üzerinden çekilir.

## Eşleştirme QR'ı (`cmc pair`)
```json
{ "v": 1, "name": "MacBook-Pro", "urls": ["ws://mac.tailnet.ts.net:47801", "ws://100.x.y.z:47801", "ws://192.168.1.20:47801"], "token": "…" }
```
