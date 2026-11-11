import AVFoundation
import SwiftUI

// MARK: Theme

enum Theme {
    static let accent = Color(red: 0.85, green: 0.47, blue: 0.34) // Claude orange
    static let bg = Color(red: 0.07, green: 0.07, blue: 0.08)
    static let card = Color.white.opacity(0.06)
    static let stroke = Color.white.opacity(0.08)
    static let callGreen = Color(red: 0.20, green: 0.78, blue: 0.35)

    static func stateColor(_ s: String) -> Color {
        switch s {
        case "running": return .blue
        case "blocked", "errored": return .red
        case "waiting_permission", "waiting_input": return .orange
        case "done": return .green
        default: return .gray
        }
    }
}

struct Card<Content: View>: View {
    var tint: Color? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(tint?.opacity(0.6) ?? Theme.stroke, lineWidth: 1))
    }
}

// MARK: Root

struct RootView: View {
    @EnvironmentObject var hub: HubClient
    @EnvironmentObject var calls: CallManager

    var body: some View {
        Group {
            if hub.pairing == nil { PairingView() } else { HomeView() }
        }
        .overlay {
            if calls.active != nil { CallOverlay().transition(.move(edge: .bottom)) }
        }
        .animation(.easeInOut, value: calls.active != nil)
        .preferredColorScheme(.dark)
        .tint(Theme.accent)
    }
}

// MARK: Home

struct HomeView: View {
    @EnvironmentObject var hub: HubClient
    @EnvironmentObject var calls: CallManager
    @State private var showSettings = false
    @State private var confirmPanic = false
    @State private var showRepair = false
    @State private var showEarlier = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    ConnectionPill()
                    if hub.unreachable && !hub.connected { RepairCard { showRepair = true } }
                    if hub.snapshot?.paused == true { PausedBanner() }
                    // A held decision is why the app was opened: it comes first.
                    if let pend = hub.snapshot?.pending, !pend.isEmpty {
                        SectionHeader(title: "Needs your decision", count: pend.count)
                        ForEach(pend) { PendingCardView(p: $0) }
                    }
                    CallHero()
                    ModePicker()
                    SectionHeader(title: "Sessions", count: hub.snapshot?.sessions.count ?? 0)
                    let list = orderSessions(hub.snapshot?.sessions ?? [])
                    if list.recent.isEmpty && list.earlier.isEmpty {
                        Card {
                            Text(hub.connected ? "No open Claude Code sessions." : "Waiting for your Mac…")
                                .foregroundStyle(.secondary)
                        }
                    }
                    ForEach(list.recent) { SessionCardView(s: $0) }
                    if !list.earlier.isEmpty {
                        Button {
                            withAnimation { showEarlier.toggle() }
                        } label: {
                            Label(showEarlier ? "Hide earlier" : "Earlier (\(list.earlier.count))", systemImage: showEarlier ? "chevron.up" : "chevron.down")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if showEarlier { ForEach(list.earlier) { SessionCardView(s: $0) } }
                    }
                    if hub.snapshot?.paused != true {
                        Button(role: .destructive) { confirmPanic = true } label: {
                            Label("Stop everything", systemImage: "stop.circle.fill")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .padding(.top, 8)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 32)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("CallMeClaude")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .refreshable { hub.ensureConnected() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showRepair) { PairingView() }
            .confirmationDialog("Interrupt all sessions and pause automation?", isPresented: $confirmPanic, titleVisibility: .visible) {
                Button("Stop everything", role: .destructive) { hub.panic() }
            }
        }
        .onAppear { hub.ensureConnected() }
    }
}

/// Shown when no saved address answers (typically the Mac moved to another network): point to re-pairing.
struct RepairCard: View {
    var onPair: () -> Void
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Label("Can't reach your Mac", systemImage: "wifi.exclamationmark").font(.headline)
                Text("Please try pairing again: run **cmc pair** on your Mac and scan the new code. Your sessions and settings stay as they are.")
                    .font(.callout).foregroundStyle(.secondary)
                Button(action: onPair) {
                    Label("Pair again", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity, minHeight: 40)
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

struct ConnectionPill: View {
    @EnvironmentObject var hub: HubClient
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(hub.connected ? Color.green : Color.red).frame(width: 8, height: 8)
            Text(hub.connected ? "Connected to \(hub.pairing?.name ?? "Mac")" : hub.status)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.card, in: Capsule())
    }
}

struct CallHero: View {
    @EnvironmentObject var calls: CallManager
    var body: some View {
        VStack(spacing: 12) {
            Button { calls.startOutgoing() } label: {
                Image(systemName: "phone.fill")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 92, height: 92)
                    .background(Theme.callGreen, in: Circle())
                    .shadow(color: Theme.callGreen.opacity(0.45), radius: 18, y: 6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Call Claude")
            Text("Call Claude").font(.title3.weight(.semibold))
            Text("or say “Hey Siri, call CallMeClaude”").font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 18)
    }
}

struct ModePicker: View {
    @EnvironmentObject var hub: HubClient
    static let modes: [(id: String, label: String, icon: String, hint: String)] = [
        ("desk", "Desk", "desktopcomputer", "At the computer. No calls."),
        ("away", "Away", "figure.walk", "Calls when a session is stuck or done."),
        ("ride", "Ride", "steeringwheel", "Like Away, extra short sentences."),
        ("sleep", "Sleep", "moon.zzz.fill", "Emergencies only."),
    ]

    var body: some View {
        let current = hub.snapshot?.mode ?? "away"
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ForEach(Self.modes, id: \.id) { m in
                    Button { hub.setMode(m.id) } label: {
                        VStack(spacing: 6) {
                            Image(systemName: m.icon).font(.system(size: 18))
                            Text(m.label).font(.caption.weight(.medium))
                        }
                        .frame(maxWidth: .infinity, minHeight: 58)
                        .background(current == m.id ? Theme.accent.opacity(0.22) : Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(current == m.id ? Theme.accent : Theme.stroke, lineWidth: 1))
                        .foregroundStyle(current == m.id ? Theme.accent : .primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text(Self.modes.first { $0.id == current }?.hint ?? "").font(.caption).foregroundStyle(.secondary).padding(.leading, 4)
        }
    }
}

struct PausedBanner: View {
    @EnvironmentObject var hub: HubClient
    var body: some View {
        Card(tint: .orange) {
            HStack {
                Image(systemName: "pause.circle.fill").foregroundStyle(.orange).font(.title2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Automation paused").font(.subheadline.weight(.semibold))
                    Text("Nothing is approved or held automatically.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Resume") { hub.resume() }.buttonStyle(.borderedProminent)
            }
        }
    }
}

struct SectionHeader: View {
    let title: String
    let count: Int
    var body: some View {
        HStack {
            Text(title).font(.headline)
            if count > 0 {
                Text("\(count)").font(.caption.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2).background(Theme.card, in: Capsule())
            }
            Spacer()
        }
        .padding(.top, 6)
    }
}

struct SessionCardView: View {
    let s: SessionCard
    @State private var open = false
    var body: some View {
        Card {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: SessionStateUI.symbol(s.state)).foregroundStyle(Theme.stateColor(s.state))
                Text(s.project).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                Text(SessionStateUI.label(s.state)).font(.caption.weight(.medium)).foregroundStyle(Theme.stateColor(s.state))
            }
            Text(s.summary).font(.callout).foregroundStyle(open ? .primary : .secondary).lineLimit(open ? nil : 3)
                .textSelection(.enabled)
            if let subs = s.subagents, !subs.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(subs.prefix(6)) { a in
                        HStack(spacing: 5) {
                            Image(systemName: a.state == "running" ? "circle.dotted" : "checkmark.circle.fill")
                                .font(.caption2)
                                .foregroundStyle(a.state == "running" ? Theme.accent : .secondary)
                            Text(a.type).font(.caption.weight(.medium))
                            Text(a.state == "running" ? "working" : "done")
                                .font(.caption2).foregroundStyle(.secondary)
                            if let summary = a.summary {
                                Text(summary).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            Text(relative(s.updatedAt)).font(.caption2).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { open.toggle() } }
        .accessibilityHint(open ? "Shows less" : "Shows the whole summary")
    }
}

struct PendingCardView: View {
    let p: PendingCard
    @EnvironmentObject var hub: HubClient
    @State private var reply = ""
    private var hot: Bool { p.risk == "high" || p.risk == "critical" }
    private var ask: Bool { p.kind == "permission" }

    var body: some View {
        Card(tint: hot ? .red : .orange) {
            HStack {
                Text(p.project).font(.subheadline.weight(.semibold))
                Spacer()
                Text(ask ? p.risk.uppercased() : "QUESTION")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(hot ? Color.red.opacity(0.3) : Theme.card, in: Capsule())
            }
            Text(p.summary).font(.callout)
            Label("Waits \(timeLeft(p.deadline)) more, then goes back to the Mac.", systemImage: "clock")
                .font(.caption).foregroundStyle(.secondary)
            if ask {
                HStack(spacing: 8) {
                    Button("Approve") { hub.resolve(p.id, "approve") }.buttonStyle(.borderedProminent).tint(.green)
                    Button("Deny") { hub.resolve(p.id, "deny") }.buttonStyle(.bordered)
                    Button("Let it stop") { hub.resolve(p.id, "release") }.buttonStyle(.bordered)
                }
                .font(.footnote)
            } else {
                // The session asked something or finished: it needs words, not a bare yes.
                TextField("Reply to Claude…", text: $reply, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit(send)
                HStack(spacing: 8) {
                    Button("Send", action: send).buttonStyle(.borderedProminent).disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Let it stop") { hub.resolve(p.id, "release") }.buttonStyle(.bordered)
                }
                .font(.footnote)
            }
        }
    }

    private func send() {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        hub.resolve(p.id, "approve", note: text)
        reply = ""
    }
}

/// Sessions that need you first, then working ones, then the rest, newest first; finished ones older than 6 h go to `earlier`.
func orderSessions(_ list: [SessionCard], now: Date = Date()) -> (recent: [SessionCard], earlier: [SessionCard]) {
    func rank(_ s: SessionCard) -> Int {
        switch s.state {
        case "waiting_permission", "waiting_input", "blocked", "errored": return 0
        case "running": return 1
        default: return 2
        }
    }
    let sorted = list.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.updatedAt > $1.updatedAt }
    func old(_ s: SessionCard) -> Bool {
        guard rank(s) == 2, let d = parseISO(s.updatedAt) else { return false }
        return now.timeIntervalSince(d) > 6 * 3600
    }
    return (sorted.filter { !old($0) }, sorted.filter(old))
}

/// "24 min" left on a held decision.
func timeLeft(_ deadline: String, now: Date = Date()) -> String {
    guard let d = parseISO(deadline) else { return "" }
    let s = max(0, Int(d.timeIntervalSince(now).rounded()))
    return s >= 60 ? "\((s + 59) / 60) min" : "\(s) s"
}

func parseISO(_ iso: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: iso) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: iso)
}

func relative(_ iso: String) -> String {
    guard let d = parseISO(iso) else { return "" }
    let r = RelativeDateTimeFormatter()
    r.locale = Locale(identifier: "en_US")
    r.unitsStyle = .short
    return r.localizedString(for: d, relativeTo: Date())
}

// MARK: Settings

struct SettingsView: View {
    @EnvironmentObject var hub: HubClient
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false

    /// Voice languages (BCP-47). The app UI stays in English; this is what Claude speaks on calls.
    static let languages: [(code: String, name: String)] = [
        ("en-US", "English (US)"), ("en-GB", "English (UK)"), ("tr-TR", "Türkçe"), ("de-DE", "Deutsch"),
        ("fr-FR", "Français"), ("es-ES", "Español"), ("it-IT", "Italiano"), ("pt-BR", "Português (Brasil)"),
        ("nl-NL", "Nederlands"), ("pl-PL", "Polski"), ("ru-RU", "Русский"), ("ar-SA", "العربية"),
        ("hi-IN", "हिन्दी"), ("ja-JP", "日本語"), ("ko-KR", "한국어"), ("zh-CN", "中文 (简体)"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Voice language", selection: Binding(get: { hub.snapshot?.language ?? "en-US" }, set: { hub.setLanguage($0) })) {
                        ForEach(Self.languages, id: \.code) { Text($0.name).tag($0.code) }
                    }
                } header: {
                    Text("Conversation")
                } footer: {
                    Text("Claude speaks this language on calls and writes session summaries in it. Takes full effect from the next call.")
                }

                if let current = hub.snapshot?.doneAlert {
                    Section {
                        Picker("Spoken alert", selection: Binding(get: { current }, set: { hub.setDoneAlert($0) })) {
                            Text("On this phone").tag("phone")
                            Text("On the Mac").tag("computer")
                            Text("Off").tag("off")
                        }
                    } header: {
                        Text("When a session finishes")
                    } footer: {
                        Text("Says “<project>: task complete.” in the voice language when a Claude Code session finishes. On this phone it plays while the app is open and connected.")
                    }
                }

                Section("Mac") {
                    LabeledContent("Name", value: hub.pairing?.name ?? "—")
                    LabeledContent("Status", value: hub.connected ? "Connected" : "Offline")
                    if let seen = hub.lastSeen {
                        LabeledContent("Last seen", value: seen.formatted(date: .omitted, time: .shortened))
                    }
                    Button("Unpair this Mac", role: .destructive) { confirmUnpair = true }
                }

                Section("Tips") {
                    Label("Answer calls with your headset or helmet intercom button.", systemImage: "headphones")
                    Label("Say “Hey Siri, call CallMeClaude” to call hands-free.", systemImage: "mic.fill")
                    Label("Use Ride mode on the road for shorter answers.", systemImage: "steeringwheel")
                }
                .font(.footnote)

                Section("About") {
                    LabeledContent("App version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—")
                    LabeledContent("Hub version", value: hub.snapshot?.hubVersion ?? "—")
                    Link("Source code (MIT)", destination: URL(string: "https://github.com/wutlu/callmeclaude")!)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Unpair this Mac?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    hub.setPairing(nil)
                    dismiss()
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: Call screen (classic phone UI)

struct CallOverlay: View {
    @EnvironmentObject var calls: CallManager
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var status: String {
        guard let a = calls.active else { return "" }
        if let t = a.connectedAt {
            let s = Int(now.timeIntervalSince(t))
            return String(format: "%02d:%02d", s / 60, s % 60)
        }
        if a.direction == "outbound" && !a.answered { return "Incoming call…" }
        return a.direction == "inbound" ? "Calling…" : "Connecting…"
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer().frame(height: 90)
            ZStack {
                Circle().fill(Theme.accent).frame(width: 128, height: 128)
                Text("C").font(.system(size: 64, weight: .semibold, design: .rounded)).foregroundStyle(.white)
            }
            Text("Claude").font(.system(size: 34, weight: .regular)).padding(.top, 22)
            Text(status).font(.title3).monospacedDigit().foregroundStyle(.secondary).padding(.top, 6)
            Spacer()
            HStack(spacing: 56) {
                CallKey(symbol: calls.muted ? "mic.slash.fill" : "mic.fill", label: "Mute", on: calls.muted) { calls.muted.toggle() }
                CallKey(symbol: "speaker.wave.3.fill", label: "Speaker", on: calls.speaker) { calls.speaker.toggle() }
            }
            Button { calls.hangUp() } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 78, height: 78)
                    .background(Color.red, in: Circle())
            }
            .accessibilityLabel("End call")
            .padding(.top, 44)
            .padding(.bottom, 70)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(colors: [Color(white: 0.16), Color(white: 0.05)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        )
        .onReceive(tick) { now = $0 }
    }
}

struct CallKey: View {
    let symbol: String
    let label: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 28))
                    .frame(width: 76, height: 76)
                    .background(on ? Color.white : Color.white.opacity(0.18), in: Circle())
                    .foregroundStyle(on ? Color.black : Color.white)
                Text(label).font(.footnote).foregroundStyle(.white)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: Pairing

struct PairingView: View {
    @EnvironmentObject var hub: HubClient
    @Environment(\.dismiss) private var dismiss
    @State private var manual = ""
    @State private var error: String?
    @State private var scanning = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 6) {
                        Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 40)).foregroundStyle(Theme.accent)
                        Text("Pair with your Mac").font(.title2.weight(.semibold))
                        Text("Run **cmc pair** on your Mac and scan the QR code.").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }
                    .padding(.top, 12)
                    if scanning {
                        QRScanner { code in accept(code) }
                            .frame(height: 300)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.accent.opacity(0.6), lineWidth: 2))
                    }
                    Text("Or paste the pairing text").font(.footnote).foregroundStyle(.secondary)
                    TextField("{\"v\":1,…}", text: $manual, axis: .vertical)
                        .lineLimit(3...6)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Button("Pair") { accept(manual) }.buttonStyle(.borderedProminent).disabled(manual.isEmpty)
                    if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                .padding(.horizontal, 20)
            }
            .background(Theme.bg.ignoresSafeArea())
        }
    }

    func accept(_ s: String) {
        guard let d = s.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let p = try? JSONDecoder().decode(PairingInfo.self, from: d), !p.urls.isEmpty else {
            error = "That isn't a valid pairing code."
            return
        }
        scanning = false
        hub.setPairing(p)
        dismiss()  // re-pairing sheet; a no-op on the first-run screen
    }
}

struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerVC {
        let vc = ScannerVC()
        vc.onCode = onCode
        return vc
    }

    func updateUIViewController(_ vc: ScannerVC, context: Context) {}

    final class ScannerVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var done = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            AVCaptureDevice.requestAccess(for: .video) { ok in
                guard ok else { return }
                DispatchQueue.main.async { self.setup() }
            }
        }

        private func setup() {
            guard let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else { return }
            session.addInput(input)
            let out = AVCaptureMetadataOutput()
            guard session.canAddOutput(out) else { return }
            session.addOutput(out)
            out.setMetadataObjectsDelegate(self, queue: .main)
            out.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.addSublayer(layer)
            DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            view.layer.sublayers?.first?.frame = view.bounds
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            session.stopRunning()
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !done, let s = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            done = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            session.stopRunning()
            onCode?(s)
        }
    }
}
