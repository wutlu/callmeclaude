package dev.callmeclaude

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * WebSocket connection to the hub. JSON text frames = control, binary frames = audio.
 *
 * Port of apps/ios/CallMeClaude/HubClient.swift. Connecting races all pairing URLs (Tailscale IP,
 * MagicDNS name, LAN IP) in parallel; the first one that answers wins and the others are cancelled.
 *
 * This class does not know about Activities. Anything that needs the link up (the UI, the
 * foreground service, a live call) calls [setActive] with its own reason; the client keeps
 * reconnecting while at least one reason is active.
 */
class HubClient(
    private val store: PairingStore,
    private val deviceName: String,
) {
    private val _connected = MutableStateFlow(false)
    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    private val _lastSeen = MutableStateFlow<Long?>(null)
    private val _status = MutableStateFlow("Not connected")
    private val _pairing = MutableStateFlow(store.load())
    private val _pairingInvalid = MutableStateFlow(false)
    private val _unreachable = MutableStateFlow(false)

    val connected: StateFlow<Boolean> = _connected.asStateFlow()
    val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()
    val lastSeen: StateFlow<Long?> = _lastSeen.asStateFlow()
    val status: StateFlow<String> = _status.asStateFlow()
    val pairing: StateFlow<PairingInfo?> = _pairing.asStateFlow()

    /** The hub refused the stored token (close code 4003). Cleared by [setPairing]. */
    val pairingInvalid: StateFlow<Boolean> = _pairingInvalid.asStateFlow()

    /** No saved address answered the last attempt; the home screen suggests pairing again. Cleared by hello / [setPairing]. */
    val unreachable: StateFlow<Boolean> = _unreachable.asStateFlow()

    /** Binary frames (assistant audio). Called on OkHttp's reader thread. */
    @Volatile var onBinary: ((ByteString) -> Unit)? = null

    /** Messages the client doesn't handle itself (call.*, audio.flush, transcript, error…). Called on the hub thread. */
    @Volatile var onMessage: ((HubMessage) -> Unit)? = null

    /** Fired after every successful (re)connection + hello. Called on the hub thread. */
    @Volatile var onConnected: (() -> Unit)? = null

    /** Fired when an established connection is lost or closed. Called on the hub thread. */
    @Volatile var onDisconnected: (() -> Unit)? = null

    // Everything below is confined to the single hub thread (the `q` of the iOS version).
    private val q = Executors.newSingleThreadExecutor { r -> Thread(r, "cmc.hub").apply { isDaemon = true } }
        .asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + q)
    private val main = Handler(Looper.getMainLooper())

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        // WebSocket ping every 8 s keeps NAT mappings alive and detects dead links: OkHttp fails the
        // socket when a pong hasn't arrived by the next ping.
        .pingInterval(8, TimeUnit.SECONDS)
        .build()

    @Volatile private var task: WebSocket? = null          // the winning connection
    private val candidates = mutableListOf<WebSocket>()    // racing connections
    private var isConnected = false
    private var generation = 0
    private val helloWaiters = mutableListOf<(Boolean) -> Unit>()
    private var waiterDeadline: Job? = null
    private val activeReasons = mutableSetOf<String>()
    private val policy = LinkPolicy()
    private var retryJob: Job? = null
    private var ticker: Job? = null

    /** Last frame of any kind from the hub (elapsedRealtime); written on OkHttp's reader thread. */
    @Volatile private var lastReceived = 0L

    private val remote = RemoteLog(SystemClock::elapsedRealtime)
    private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    init {
        remote.setSecrets(RemoteLog.secretsOf(_pairing.value, deviceName))
        AppLog.sink = { level, tag, msg ->
            val time = synchronized(clock) { clock.format(Date()) }
            post { if (remote.add(level, tag, msg, time)) flushLogs() }
        }
    }

    private fun post(block: () -> Unit) {
        scope.launch { block() }
    }

    // region connection

    /** Keep the link up while [reason] is active (e.g. "ui" while the app is in the foreground). */
    fun setActive(reason: String, active: Boolean) = post {
        if (active) activeReasons += reason else activeReasons -= reason
        val inCall = REASON_CALL in activeReasons
        if (inCall != policy.inCall) {
            policy.callChanged(inCall)
            ticker?.cancel()
            ticker = if (inCall) scope.launch { tickLoop() } else null
        }
        if (active) ensureConnectedLocked(null)
    }

    /** Connect (if needed) and call back on the main thread once the hub said hello (or gave up). */
    fun ensureConnected(done: ((Boolean) -> Unit)? = null) = post { ensureConnectedLocked(done) }

    private fun ensureConnectedLocked(done: ((Boolean) -> Unit)?) {
        if (isConnected) {
            done?.let { main.post { it(true) } }
            return
        }
        done?.let { addWaiter(it) }
        apply("requested", policy.connectRequested())
    }

    private val shouldStayConnected: Boolean
        get() = _pairing.value != null && !policy.rejected && (activeReasons.isNotEmpty() || helloWaiters.isNotEmpty())

    /** From [NetworkWatcher] (any thread). */
    fun networkChanged(change: NetworkWatcher.Change) = post {
        when (change) {
            is NetworkWatcher.Change.Available -> apply("network ${change.kind}", policy.networkAvailable(change.id))
            NetworkWatcher.Change.Lost -> apply("network lost", policy.networkLost())
        }
    }

    /** Carries out [LinkPolicy]'s decisions. Hub thread only. */
    private fun apply(why: String, effects: List<LinkPolicy.Effect>) {
        if (effects.isNotEmpty() && effects != listOf(LinkPolicy.Effect.Ping)) {
            AppLog.d(TAG, "link: $why → $effects (inCall=${policy.inCall})")
        }
        for (e in effects) {
            when (e) {
                is LinkPolicy.Effect.Connect -> if (shouldStayConnected) open(e.timeoutMs) else policy.stopped()
                LinkPolicy.Effect.Close -> close("$why")
                is LinkPolicy.Effect.RetryIn -> {
                    retryJob?.cancel()
                    retryJob = scope.launch {
                        delay(e.ms)
                        retryJob = null
                        apply("retry", policy.retryFired())
                    }
                }
                LinkPolicy.Effect.CancelRetry -> {
                    retryJob?.cancel()
                    retryJob = null
                }
                LinkPolicy.Effect.Ping -> task?.send(AppMessages.ping())
            }
        }
    }

    /** Race every pairing address; the first one whose hub says hello wins. */
    private fun open(timeoutMs: Long) {
        val p = _pairing.value
        if (p == null || p.urls.isEmpty()) {
            _status.value = "Not paired"
            flushWaiters(false)
            policy.stopped()
            return
        }
        // A new race replaces a running one (e.g. it started on a network that is gone now).
        candidates.forEach { it.cancel() }
        candidates.clear()
        generation += 1
        val gen = generation
        _status.value = if (policy.inCall && !isConnected) "Reconnecting…" else "Connecting…"
        AppLog.i(TAG, "connecting: racing ${p.urls.size} addresses (timeout ${timeoutMs}ms)")
        val auth = AppMessages.auth(p.token, deviceName)
        p.urls.forEachIndexed { i, s ->
            val req = try {
                Request.Builder().url(s).build()
            } catch (_: IllegalArgumentException) {
                return@forEachIndexed
            }
            candidates += http.newWebSocket(req, Listener(gen, i, req.url.host, auth))
        }
        if (candidates.isEmpty()) {
            apply("no valid address", policy.attemptTimedOut())
            return
        }
        scope.launch {
            delay(timeoutMs)
            if (gen != generation || isConnected) return@launch
            AppLog.i(TAG, "connect: no address answered within ${timeoutMs}ms")
            candidates.forEach { it.cancel() }
            candidates.clear()
            task?.cancel()
            task = null
            _status.value = "Can't reach your computer"
            _unreachable.value = true
            apply("attempt timed out", policy.attemptTimedOut())
        }
    }

    private inner class Listener(
        private val gen: Int,
        private val index: Int,
        private val host: String,
        private val auth: String,
    ) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(auth)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            lastReceived = SystemClock.elapsedRealtime()
            post {
                if (task == null) {
                    // Still racing: the first answer wins.
                    if (gen != generation || webSocket !in candidates) {
                        webSocket.cancel()
                        return@post
                    }
                    task = webSocket
                    candidates.filter { it !== webSocket }.forEach { it.cancel() }
                    candidates.clear()
                    AppLog.i(TAG, "connected via #$index $host")
                    handle(text)
                } else if (task === webSocket) {
                    handle(text)
                } else {
                    webSocket.cancel()
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // Audio. Delivered straight from the reader thread, like the iOS client does.
            if (task === webSocket) {
                lastReceived = SystemClock.elapsedRealtime()
                onBinary?.invoke(bytes)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            if (code == LinkPolicy.BAD_TOKEN) rejected(webSocket) else ended(webSocket, "closed by hub: $code $reason")
        }

        /** The hub refused our token: give up instead of retrying forever. */
        private fun rejected(webSocket: WebSocket) = post {
            if (gen != generation || (task !== webSocket && webSocket !in candidates)) return@post
            AppLog.w(TAG, "hub refused the pairing token (4003): pairing is no longer valid")
            candidates.forEach { if (it !== webSocket) it.cancel() }
            candidates.clear()
            val effects = policy.tokenRejected()
            if (task != null) close("token refused")
            apply("token refused", effects - LinkPolicy.Effect.Close)
            generation += 1
            _pairingInvalid.value = true
            _status.value = PAIRING_INVALID
            flushWaiters(false)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            ended(webSocket, t.message ?: t.javaClass.simpleName)
        }

        private fun ended(webSocket: WebSocket, why: String) = post {
            if (task == null && candidates.remove(webSocket)) {
                AppLog.i(TAG, "address #$index $host failed: $why")
                if (candidates.isEmpty() && gen == generation) apply("all addresses failed", policy.allAddressesFailed())
            } else if (task === webSocket && gen == generation) {
                close("receive: $why")
                apply("dropped", policy.dropped())
            }
        }
    }

    /** Tear down the established connection (dead, or on a network that is gone). */
    private fun close(why: String) {
        AppLog.i(TAG, "connection lost: $why")
        task?.cancel()
        task = null
        generation += 1
        if (isConnected) {
            setConnected(false)
            onDisconnected?.invoke()
        }
        _status.value = "Connection lost, reconnecting…"
    }

    private suspend fun tickLoop() {
        while (true) {
            delay(LinkPolicy.CALL_TICK_MS)
            apply("tick", policy.tick(SystemClock.elapsedRealtime(), lastReceived))
        }
    }

    private fun setConnected(v: Boolean) {
        isConnected = v
        _connected.value = v
        if (!v) synchronized(lock) { lock.disconnected() }
    }

    /** Waiters give up after the idle race timeout (iOS: 7 s), however many races run meanwhile. */
    private fun addWaiter(w: (Boolean) -> Unit) {
        helloWaiters += w
        if (waiterDeadline == null) {
            waiterDeadline = scope.launch {
                delay(LinkPolicy.IDLE.attemptTimeoutMs)
                waiterDeadline = null
                if (!isConnected) flushWaiters(false)
            }
        }
    }

    private fun flushWaiters(ok: Boolean) {
        waiterDeadline?.cancel()
        waiterDeadline = null
        val ws = helloWaiters.toList()
        helloWaiters.clear()
        if (ws.isNotEmpty()) main.post { ws.forEach { it(ok) } }
    }

    /** Hub thread; after a successful auth, so only the paired hub can change the addresses. */
    private fun updateUrls(fromHub: List<String>?) {
        val p = _pairing.value ?: return
        val fresh = mergedUrls(p.urls, fromHub) ?: return
        val updated = p.copy(urls = fresh)
        store.save(updated)
        _pairing.value = updated
        remote.setSecrets(RemoteLog.secretsOf(updated, deviceName))
        AppLog.i(TAG, "hub addresses updated: ${fresh.size}")
    }

    fun setPairing(p: PairingInfo?) = post {
        store.save(p)
        _pairing.value = p
        _pairingInvalid.value = false
        _unreachable.value = false
        policy.paired()
        remote.setSecrets(RemoteLog.secretsOf(p, deviceName))
        if (p == null) _snapshot.value = null
        generation += 1
        task?.close(1000, null)
        task = null
        candidates.forEach { it.close(1000, null) }
        candidates.clear()
        if (isConnected) onDisconnected?.invoke()
        setConnected(false)
        policy.stopped()
        if (p != null) apply("paired", policy.connectRequested()) else _status.value = "Not paired"
    }

    // endregion

    // region messages

    private fun handle(text: String) {
        val msg = HubMessage.parse(text) ?: return
        _lastSeen.value = System.currentTimeMillis()
        when (msg) {
            is HubMessage.Hello -> {
                msg.snapshot?.let { _snapshot.value = it }
                _unreachable.value = false
                updateUrls(msg.urls)
                setConnected(true)
                apply("hello", policy.connected())
                _status.value = "Connected to ${_pairing.value?.name ?: "computer"}"
                flushWaiters(true)
                flushLogs()
                // A new connection starts "unknown" on the hub: always tell it, read fresh.
                val fresh = runCatching { lockProbe?.invoke() }.getOrNull()
                synchronized(lock) { lock.connected(fresh) }
                onConnected?.invoke()
            }
            is HubMessage.SnapshotUpdate -> msg.snapshot?.let { _snapshot.value = it }
            is HubMessage.Heartbeat -> Unit
            is HubMessage.Error -> {
                AppLog.i(TAG, "hub error: ${msg.message}")
                onMessage?.invoke(msg)
            }
            else -> onMessage?.invoke(msg)
        }
    }

    // endregion

    // region send

    /** Hub thread only. Like iOS: everything buffered goes out right after hello and then as it comes. */
    private fun flushLogs() {
        if (!isConnected || remote.pending == 0) return
        val t = task ?: return
        t.send(AppMessages.log(remote.drain()))
    }

    fun sendJSON(text: String) {
        task?.send(text)
    }

    /**
     * Lock state reporting (see [LockReport]); guarded by itself. Sent on the caller's thread, not
     * posted: a quick call from the lock screen reports the lock right before `call.start`, and the
     * hub must get them in that order.
     */
    private val lock = LockReport { v -> task?.send(AppMessages.deviceLock(v)) }

    /** A fresh lock reading for the hello of a new connection (set by the app, see [LockWatcher]). Any thread. */
    @Volatile var lockProbe: (() -> Boolean)? = null

    /** A lock reading (see [LockWatcher]); sent if it changed. Any thread. */
    fun setLocked(value: Boolean, why: String) {
        val changed = synchronized(lock) { lock.observed(value) }
        if (changed) AppLog.i(TAG, "lock: $value ($why)${if (_connected.value) "" else ", sent on connect"}")
    }

    /** Microphone audio. Thread-safe; dropped while there is no connection (the hub keeps the call 20 s). */
    fun sendBinary(bytes: ByteArray) {
        task?.send(bytes.toByteString())
    }

    fun setMode(mode: String) = sendJSON(AppMessages.modeSet(mode))
    fun setLanguage(code: String) = sendJSON(AppMessages.languageSet(code))
    fun setDoneAlert(target: String) = sendJSON(AppMessages.alertSet(target))
    fun panic() = sendJSON(AppMessages.panic())
    fun resume() = sendJSON(AppMessages.resume())
    fun resolve(pendingId: String, decision: Decision, note: String? = null) =
        sendJSON(AppMessages.resolve(pendingId, decision, note))

    // endregion

    companion object {
        private const val TAG = "cmc.hub"
        /** The [setActive] reason of a live call: reconnect faster while it is set. */
        const val REASON_CALL = "call"
        const val PAIRING_INVALID = "Pairing is no longer valid"
    }
}
