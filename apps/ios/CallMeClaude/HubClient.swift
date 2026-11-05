import Foundation
import UIKit

/// WebSocket connection to the Mac hub. JSON text frames = control, binary frames = audio.
///
/// Connecting races all pairing URLs (Tailscale IP, MagicDNS name, LAN IP) in parallel; the first
/// one that answers with `hello` wins and the others are cancelled. No sequential timeouts.
final class HubClient: NSObject, ObservableObject {
    static let shared = HubClient()

    @Published private(set) var connected = false
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var lastSeen: Date?
    @Published private(set) var status = "Not connected"
    @Published var pairing: PairingInfo? = PairingStore.load()

    // Callbacks (may be invoked off the main thread)
    var onAudio: ((Data) -> Void)?
    var onFlush: (() -> Void)?
    var onIncoming: ((String, String) -> Void)?
    var onCallReady: ((String) -> Void)?
    var onCallEnded: ((String, String) -> Void)?
    /// Fired after every successful (re)connection + hello.
    var onConnected: (() -> Void)?

    /// Set by CallManager: keep reconnecting while a call is up, even in the background.
    let callActive = AtomicFlag()
    var voipToken: String? { didSet { q.async { self.registerPush() } } }

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?            // the winning connection
    private var candidates: [URLSessionWebSocketTask] = [] // racing connections
    private var isConnected = false                        // q-confined mirror of `connected`
    private var generation = 0
    private var helloWaiters: [(Bool) -> Void] = []
    private var reconnectScheduled = false
    private var pingTimer: DispatchSourceTimer?
    private var logBuffer: [String] = []
    private let appActive = AtomicFlag()
    private let q = DispatchQueue(label: "cmc.hub")

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 8
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: nil, delegateQueue: nil)
        appActive.value = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
            self?.appActive.value = true
            self?.ensureConnected()
        }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            self?.appActive.value = false
        }
        // Lock screen: with a passcode, protected data goes away shortly after locking and comes back on unlock.
        // While locked the hub lets the voice agent answer questions but not change anything.
        nc.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: nil) { [weak self] _ in
            self?.setLocked(true)
        }
        nc.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: nil) { [weak self] _ in
            self?.setLocked(false)
        }
        DispatchQueue.main.async { self.setLocked(!UIApplication.shared.isProtectedDataAvailable) }
    }

    /// Last known lock state (q-confined); re-sent after every hello.
    private var locked: Bool?

    private func setLocked(_ value: Bool) {
        q.async {
            guard self.locked != value else { return }
            self.locked = value
            Log.d("lock: \(value)")
            if self.isConnected { self.sendJSON(["type": "device.lock", "locked": value]) }
        }
    }

    // MARK: connection

    /// Connect (if needed) and call back on the main thread once the hub said hello (or gave up).
    func ensureConnected(_ done: ((Bool) -> Void)? = nil) {
        q.async {
            if self.isConnected {
                if let done { DispatchQueue.main.async { done(true) } }
                return
            }
            if let done { self.helloWaiters.append(done) }
            if self.task == nil, self.candidates.isEmpty { self.open() }
        }
    }

    private var shouldStayConnected: Bool {
        pairing != nil && (appActive.value || callActive.value || !helloWaiters.isEmpty)
    }

    private func open() {
        guard let p = pairing, !p.urls.isEmpty else {
            setStatus("Not paired")
            flushWaiters(false)
            return
        }
        generation += 1
        let gen = generation
        setStatus("Connecting…")
        Log.d("connecting: racing \(p.urls.count) addresses")
        let auth: [String: Any] = ["type": "auth", "token": p.token, "device": UIDevice.current.name, "v": 1]
        let authText = String(data: try! JSONSerialization.data(withJSONObject: auth), encoding: .utf8)!
        for (i, s) in p.urls.enumerated() {
            guard let url = URL(string: s) else { continue }
            let t = session.webSocketTask(with: url)
            t.maximumMessageSize = 4 << 20
            candidates.append(t)
            t.resume()
            t.send(.string(authText)) { _ in }
            raceReceive(t, gen, i, url.host ?? s)
        }
        q.asyncAfter(deadline: .now() + 7) { [weak self] in
            guard let self, gen == self.generation, !self.isConnected else { return }
            Log.d("connect: no address answered within 7s")
            self.candidates.forEach { $0.cancel(with: .goingAway, reason: nil) }
            self.candidates = []
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.setStatus("Can't reach your Mac")
            self.flushWaiters(false)
            self.scheduleReconnect(after: 3)
        }
    }

    private func raceReceive(_ t: URLSessionWebSocketTask, _ gen: Int, _ index: Int, _ host: String) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.q.async {
                guard gen == self.generation, self.task == nil else {
                    if self.task !== t { t.cancel(with: .goingAway, reason: nil) }
                    return
                }
                switch result {
                case .failure(let e):
                    self.candidates.removeAll { $0 === t }
                    Log.d("address #\(index) \(host) failed: \(e.localizedDescription)")
                case .success(let msg):
                    // First answer wins.
                    self.task = t
                    self.candidates.filter { $0 !== t }.forEach { $0.cancel(with: .goingAway, reason: nil) }
                    self.candidates = []
                    Log.d("connected via #\(index) \(host)")
                    if case .string(let s) = msg { self.handle(s) }
                    self.receive(t, gen)
                }
            }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let e):
                self.q.async { if gen == self.generation, self.task === t { self.drop("receive: \(e.localizedDescription)") } }
            case .success(let msg):
                switch msg {
                case .data(let d): self.onAudio?(d)
                case .string(let s): self.handle(s)
                @unknown default: break
                }
                self.receive(t, gen)
            }
        }
    }

    /// The established connection died.
    private func drop(_ why: String) {
        Log.d("connection lost: \(why)")
        stopPing()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        generation += 1
        setConnected(false)
        setStatus("Connection lost, reconnecting…")
        scheduleReconnect(after: 0.5)
    }

    private func scheduleReconnect(after s: Double) {
        guard !reconnectScheduled else { return }
        reconnectScheduled = true
        q.asyncAfter(deadline: .now() + s) { [weak self] in
            guard let self else { return }
            self.reconnectScheduled = false
            guard self.task == nil, self.candidates.isEmpty else { return }
            if self.shouldStayConnected { self.open() }
        }
    }

    private func setConnected(_ v: Bool) {
        isConnected = v
        DispatchQueue.main.async { self.connected = v }
    }

    private func flushWaiters(_ ok: Bool) {
        let ws = helloWaiters
        helloWaiters = []
        DispatchQueue.main.async { ws.forEach { $0(ok) } }
    }

    func setPairing(_ p: PairingInfo?) {
        PairingStore.save(p)
        DispatchQueue.main.async { self.pairing = p }
        q.async {
            self.generation += 1
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.task = nil
            self.candidates.forEach { $0.cancel(with: .normalClosure, reason: nil) }
            self.candidates = []
            self.setConnected(false)
            if p != nil { self.open() }
        }
    }

    // MARK: keepalive + remote logs

    /// WebSocket ping every 8 s: keeps cellular NAT mappings alive and detects dead links fast.
    private func startPing() {
        stopPing()
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 8, repeating: 8)
        let gen = generation
        t.setEventHandler { [weak self] in
            guard let self, gen == self.generation, let task = self.task else { return }
            var answered = false
            task.sendPing { err in
                self.q.async {
                    answered = true
                    if let err, gen == self.generation { self.drop("ping: \(err.localizedDescription)") }
                }
            }
            self.q.asyncAfter(deadline: .now() + 6) {
                if !answered, gen == self.generation { self.drop("ping timeout") }
            }
        }
        t.resume()
        pingTimer = t
    }

    private func stopPing() {
        pingTimer?.cancel()
        pingTimer = nil
    }

    func remoteLog(_ line: String) {
        q.async {
            self.logBuffer.append(line)
            if self.logBuffer.count > 400 { self.logBuffer.removeFirst(self.logBuffer.count - 400) }
            if self.isConnected { self.flushLogs() }
        }
    }

    private func flushLogs() {
        guard isConnected, !logBuffer.isEmpty else { return }
        let lines = logBuffer
        logBuffer = []
        sendJSON(["type": "log", "lines": lines])
    }

    // MARK: messages

    private func handle(_ s: String) {
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        DispatchQueue.main.async { self.lastSeen = Date() }
        switch type {
        case "hello", "snapshot":
            if let snapObj = obj["snapshot"], let sd = try? JSONSerialization.data(withJSONObject: snapObj),
               let snap = try? JSONDecoder().decode(Snapshot.self, from: sd) {
                DispatchQueue.main.async { self.snapshot = snap }
            }
            if type == "hello" {
                q.async {
                    self.setConnected(true)
                    self.setStatus("Connected to \(self.pairing?.name ?? "Mac")")
                    self.flushWaiters(true)
                    self.registerPush()
                    self.flushLogs()
                    if let l = self.locked { self.sendJSON(["type": "device.lock", "locked": l]) }
                    self.startPing()
                    self.onConnected?()
                }
            }
        case "call.incoming":
            onIncoming?(obj["callId"] as? String ?? "", obj["title"] as? String ?? "Claude")
        case "call.ready":
            onCallReady?(obj["callId"] as? String ?? "")
        case "call.ended":
            onCallEnded?(obj["callId"] as? String ?? "", obj["reason"] as? String ?? "")
        case "audio.flush":
            onFlush?()
        case "error":
            Log.d("hub error: \(obj["message"] as? String ?? "?")")
        default: break
        }
    }

    private func setStatus(_ s: String) { DispatchQueue.main.async { self.status = s } }

    private func registerPush() {
        guard isConnected, let t = voipToken else { return }
        sendJSON(["type": "push.register", "token": t, "kind": "voip"])
    }

    // MARK: send

    func sendJSON(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        task?.send(.string(s)) { _ in }
    }

    func sendAudio(_ d: Data) {
        guard let t = task else { return }
        t.send(.data(d)) { _ in }
    }

    func setMode(_ m: String) { sendJSON(["type": "mode.set", "mode": m]) }
    func setLanguage(_ code: String) { sendJSON(["type": "language.set", "language": code]) }
    func panic() { sendJSON(["type": "panic"]) }
    func resume() { sendJSON(["type": "resume"]) }
    func resolve(_ pendingId: String, _ decision: String, note: String? = nil) {
        var o: [String: Any] = ["type": "pending.resolve", "pendingId": pendingId, "decision": decision]
        if let note { o["note"] = note }
        sendJSON(o)
    }
}
