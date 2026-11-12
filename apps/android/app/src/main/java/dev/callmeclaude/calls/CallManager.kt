package dev.callmeclaude.calls

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import dev.callmeclaude.AppLog
import dev.callmeclaude.HubClient
import dev.callmeclaude.HubErrors
import dev.callmeclaude.Speaker
import dev.callmeclaude.HubMessage
import dev.callmeclaude.AppMessages
import dev.callmeclaude.HubService
import dev.callmeclaude.R
import dev.callmeclaude.calls.CallMachine.Effect
import dev.callmeclaude.calls.CallMachine.EndCause
import dev.callmeclaude.calls.CallMachine.Event
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Audio engine seam: the real one is [CallAudio]. */
interface CallAudioPort {
    fun start()
    fun stop()
    fun play(pcm24k: ByteArray)
    fun flush()
}

/**
 * Phone-call UX through a self-managed ConnectionService: lock-screen ringing, Bluetooth answer
 * buttons, audio routing by Telecom. Owns the [CallMachine]; everything runs on the main thread.
 */
class CallManager(
    private val context: Context,
    private val hub: HubClient,
    audioFactory: (CallManager) -> CallAudioPort,
) {
    /** What the UI and the notification show. */
    data class CallUi(
        val callId: String,
        val incoming: Boolean,
        val title: String,
        val answered: Boolean,
        val ready: Boolean,
        val connectedAt: Long?,
        /** Telecom said we may show our ringing UI (onShowIncomingCallUi). */
        val ringing: Boolean,
        val silenced: Boolean,
        /** Answered and talking, but the link to the hub dropped: we're reconnecting. */
        val reconnecting: Boolean = false,
        /** The hub's error that ended this attempt, as the hub sent it. The call itself is over. */
        val error: String? = null,
    )

    /** A hub error outside a call attempt, shown briefly on the home screen. */
    data class Notice(val id: Long, val message: String)

    data class Line(val role: String, val text: String, val final: Boolean)

    private val main = Handler(Looper.getMainLooper())
    private val machine = CallMachine(System::currentTimeMillis)
    private val telecom = context.getSystemService(TelecomManager::class.java)
    private val prefs = context.getSharedPreferences("cmc.calls", Context.MODE_PRIVATE)
    private val connections = mutableMapOf<String, CmcConnection>()
    private val audio: CallAudioPort = audioFactory(this)
    private var tts: TextToSpeech? = null
    private var ringingShownFor: String? = null
    private var silencedFor: String? = null
    private val errors = HubErrors(SystemClock::elapsedRealtime)
    private var noticeSeq = 0L

    val accountHandle = PhoneAccountHandle(ComponentName(context, CmcConnectionService::class.java), "claude")

    private val _ui = MutableStateFlow<CallUi?>(null)
    private val _muted = MutableStateFlow(false)
    private val _speaker = MutableStateFlow(prefs.getBoolean("speaker", false))
    private val _routes = MutableStateFlow(AudioRoutesUi.EMPTY)
    private val _transcript = MutableStateFlow<List<Line>>(emptyList())
    private val _notice = MutableStateFlow<Notice?>(null)
    val ui: StateFlow<CallUi?> = _ui.asStateFlow()
    val muted: StateFlow<Boolean> = _muted.asStateFlow()
    val speaker: StateFlow<Boolean> = _speaker.asStateFlow()
    /** Audio outputs Telecom offers for the live call, the active one marked (empty outside a call). */
    val routes: StateFlow<AudioRoutesUi> = _routes.asStateFlow()
    val transcript: StateFlow<List<Line>> = _transcript.asStateFlow()
    /** The latest hub error to show on the home screen; cleared once shown or after [NOTICE_MS]. */
    val notice: StateFlow<Notice?> = _notice.asStateFlow()

    /** Read by the mic thread: send silence instead of the microphone while true. */
    @Volatile var micMuted = false
        private set

    /** Read on OkHttp's reader thread. */
    @Volatile private var audioOn = false

    private val announcer = Speaker(context)

    /** Main thread. Frees the text-to-speech engine (the hub service stopped); the next alert starts it again. */
    fun releaseSpeech() = announcer.shutdown()

    init {
        registerAccount()
        hub.onMessage = { m -> main.post { onHub(m) } }
        hub.onConnected = { main.post { dispatch(Event.HubConnected) } }
        hub.onDisconnected = { main.post { dispatch(Event.HubDisconnected) } }
        hub.onBinary = { bytes -> if (audioOn) audio.play(bytes.toByteArray()) }
    }

    private fun registerAccount() {
        // CAPABILITY_SELF_MANAGED is deprecated in API 37 in favour of the transactional VoIP API
        // (TelecomManager.addCall, API 34+) or the Core Telecom Jetpack library. Neither fits:
        // minSdk is 29, and the project adds no dependencies. It still works on API 37.
        @Suppress("DEPRECATION")
        val account = PhoneAccount.builder(accountHandle, "CallMeClaude")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
            .setIcon(Icon.createWithResource(context, R.drawable.ic_stat_claude))
            .build()
        try {
            telecom.registerPhoneAccount(account)
        } catch (e: RuntimeException) {
            AppLog.w(TAG, "registerPhoneAccount failed: $e")
        }
    }

    // region entry points (main thread)

    /** "Call Claude". */
    fun placeCall() = dispatch(Event.Place(CallMachine.newCallId()))

    /** Answer from our own UI (notification action, call screen). */
    fun answer() {
        val a = machine.active ?: return
        if (!a.answered && a.direction == CallMachine.Direction.OUTBOUND) dispatch(Event.Begin(a.callId))
    }

    fun decline() {
        val a = machine.active ?: return
        if (!a.answered) dispatch(Event.Reject(a.callId)) else dispatch(Event.HangUp(a.callId))
    }

    fun hangUp() = dispatch(Event.HangUp())

    /** The home screen displayed [id]; don't show it again. */
    fun noticeShown(id: Long) {
        if (_notice.value?.id == id) _notice.value = null
    }

    fun setMuted(on: Boolean) {
        _muted.value = on
        micMuted = on
    }

    /** Loudspeaker shortcut. Off goes back to the route used before it (see [AudioRouter]). */
    fun setSpeaker(on: Boolean) {
        _speaker.value = on
        rememberSpeaker(on)
        activeConnection()?.speaker(on)
    }

    /** A route picked from the call screen's output list ([AudioRoute.id]). */
    fun selectRoute(id: String) {
        val c = activeConnection() ?: return
        c.routes.available.firstOrNull { it.id == id }?.let { rememberSpeaker(it.kind == AudioRoute.Kind.SPEAKER) }
        c.select(id)
    }

    private fun activeConnection() = machine.active?.let { connections[it.callId] }

    private fun rememberSpeaker(on: Boolean) {
        @SuppressLint("UseKtx") // no androidx.core dependency on purpose
        prefs.edit().putBoolean("speaker", on).apply()
    }

    // endregion

    // region ConnectionService callbacks (main thread)

    fun createIncoming(id: String?): CmcConnection? {
        val a = machine.active ?: return null
        val callId = id ?: a.callId.takeIf { it !in connections } ?: return null
        if (a.callId != callId || a.answered || a.direction != CallMachine.Direction.OUTBOUND) return null
        return CmcConnection(this, callId).also {
            it.setCallerDisplayName(displayName(a.title), TelecomManager.PRESENTATION_ALLOWED)
            it.setRinging()
            connections[callId] = it
        }
    }

    fun createOutgoing(id: String?): CmcConnection? {
        val a = machine.active ?: return null
        val callId = id ?: a.callId.takeIf { it !in connections } ?: return null
        if (a.callId != callId || a.direction != CallMachine.Direction.INBOUND) return null
        return CmcConnection(this, callId).also {
            it.setCallerDisplayName("Claude", TelecomManager.PRESENTATION_ALLOWED)
            it.setDialing()
            connections[callId] = it
            main.post { dispatch(Event.Begin(callId)) }
        }
    }

    fun connectionFailed(id: String?) {
        val callId = id ?: machine.active?.callId?.takeIf { it !in connections } ?: return
        dispatch(Event.TelecomFailed(callId))
    }

    fun showIncomingUi(callId: String) {
        ringingShownFor = callId
        publish()
    }

    fun silenceRinger(callId: String) {
        silencedFor = callId
        publish()
    }

    fun telecomAnswered(callId: String) = dispatch(Event.Begin(callId))
    fun telecomRejected(callId: String) = dispatch(Event.Reject(callId))
    fun telecomDisconnect(callId: String) = dispatch(Event.HangUp(callId))

    /** Mute toggled outside the app (e.g. a Bluetooth headset button). */
    fun telecomMute(on: Boolean) = setMuted(on)

    /** The audio route is known: apply the remembered loudspeaker choice once. */
    fun routeReady(conn: CmcConnection) {
        if (prefs.getBoolean("speaker", false)) conn.speaker(true)
    }

    /** Telecom changed the available or active routes (also when changed outside the app). */
    fun routesChanged(conn: CmcConnection) {
        if (conn.callId != machine.active?.callId) return
        val r = conn.routes
        _routes.value = r
        if (r.current != null) _speaker.value = r.speakerOn
    }

    // endregion

    private fun onHub(m: HubMessage) {
        when (m) {
            is HubMessage.CallIncoming -> dispatch(Event.Incoming(m.callId, m.title))
            is HubMessage.CallReady -> dispatch(Event.Ready(m.callId))
            is HubMessage.CallEnded -> dispatch(Event.HubEnded(m.callId, m.reason))
            HubMessage.AudioFlush -> audio.flush()
            is HubMessage.Transcript -> if (machine.active != null) addLine(Line(m.role, m.text, m.final))
            is HubMessage.Error -> if (errors.accept(m.message)) dispatch(Event.HubError(m.message))
            // Never over a call: Claude is already talking there.
            is HubMessage.Announce -> if (machine.active == null) announcer.say(m.text, m.language)
            else -> Unit
        }
    }

    /** Partial transcripts replace the open line of the same speaker; keep the last few lines. */
    private fun addLine(l: Line) {
        val lines = _transcript.value.toMutableList()
        val last = lines.lastOrNull()
        if (last != null && !last.final && last.role == l.role) lines[lines.lastIndex] = l else lines += l
        _transcript.value = lines.takeLast(6)
    }

    fun dispatch(e: Event) {
        // A new attempt may fail the same way as the last one: show that error again.
        if (e is Event.Place || e is Event.Incoming) errors.reset()
        val wasActive = machine.active != null
        val effects = machine.handle(e)
        if (effects.isNotEmpty() || e !is Event.HubConnected) AppLog.i(TAG, "$e → $effects")
        val nowActive = machine.active != null
        if (wasActive != nowActive) hub.setActive(HUB_REASON, nowActive)
        // Foreground service types first: the microphone type must be in place before AudioRecord starts.
        publish()
        effects.forEach(::run)
    }

    private fun publish() {
        val a = machine.active
        val ui = a?.let {
            CallUi(
                callId = it.callId,
                incoming = it.direction == CallMachine.Direction.OUTBOUND,
                title = it.title,
                answered = it.answered,
                ready = it.ready,
                connectedAt = it.connectedAt,
                ringing = ringingShownFor == it.callId,
                silenced = silencedFor == it.callId,
                reconnecting = machine.reconnecting,
                error = it.error,
            )
        }
        _ui.value = ui
        // A failed attempt only lingers on screen: Telecom and the microphone are already released.
        HubService.callChanged(context, ui?.takeIf { it.error == null })
    }

    // placeCall needs MANAGE_OWN_CALLS, an install-time permission; failures are caught below anyway.
    @SuppressLint("MissingPermission")
    private fun run(f: Effect) {
        when (f) {
            is Effect.ReportIncoming -> {
                val extras = Bundle().apply {
                    putString(EXTRA_CALL_ID, f.callId)
                    putString(EXTRA_TITLE, f.title)
                }
                try {
                    telecom.addNewIncomingCall(accountHandle, Bundle().apply { putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, extras) })
                } catch (e: RuntimeException) {
                    AppLog.w(TAG, "addNewIncomingCall failed: $e")
                    main.post { dispatch(Event.TelecomFailed(f.callId)) }
                }
            }
            is Effect.PlaceOutgoing -> {
                val extras = Bundle().apply {
                    putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, accountHandle)
                    putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, Bundle().apply { putString(EXTRA_CALL_ID, f.callId) })
                }
                try {
                    if (!telecom.isOutgoingCallPermitted(accountHandle)) error("another call is in progress")
                    telecom.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, "claude", null), extras)
                } catch (e: RuntimeException) {
                    AppLog.w(TAG, "placeCall failed: $e")
                    main.post { dispatch(Event.TelecomFailed(f.callId)) }
                }
            }
            is Effect.SendStart -> {
                AppLog.i(TAG, "call.start ${f.callId} ${f.direction.wire}")
                hub.sendJSON(AppMessages.callStart(f.callId, f.direction.wire))
            }
            is Effect.SendEnd -> hub.sendJSON(AppMessages.callEnd(f.callId))
            is Effect.EnsureConnected -> hub.ensureConnected { ok ->
                dispatch(if (ok) Event.HubConnected else Event.HubUnreachable(f.callId))
            }
            Effect.StartAudio -> {
                setMuted(false)
                _transcript.value = emptyList()
                audioOn = true
                audio.start()
            }
            Effect.StopAudio -> {
                audioOn = false
                audio.stop()
                tts?.stop()
            }
            is Effect.SetConnectionActive -> connections[f.callId]?.setActive()
            is Effect.EndConnection -> {
                connections.remove(f.callId)?.let {
                    it.setDisconnected(DisconnectCause(disconnectCode(f.cause)))
                    it.destroy()
                }
                setMuted(false)
                _routes.value = AudioRoutesUi.EMPTY
                _speaker.value = prefs.getBoolean("speaker", false)
                ringingShownFor = null
                silencedFor = null
                publish()
            }
            is Effect.Schedule -> main.postDelayed({ dispatch(f.event) }, f.delayMs)
            is Effect.Unreachable -> speakUnreachable()
            is Effect.Notice -> {
                val n = Notice(++noticeSeq, f.message)
                _notice.value = n
                main.postDelayed({ noticeShown(n.id) }, NOTICE_MS)
            }
        }
    }

    private fun disconnectCode(c: EndCause) = when (c) {
        EndCause.LOCAL -> DisconnectCause.LOCAL
        EndCause.REMOTE -> DisconnectCause.REMOTE
        EndCause.REJECTED -> DisconnectCause.REJECTED
        EndCause.MISSED -> DisconnectCause.MISSED
        EndCause.ERROR -> DisconnectCause.ERROR
    }

    /** The computer can't be reached: say so in the configured voice language, then hang up (scheduled by the machine). */
    private fun speakUnreachable() {
        AppLog.i(TAG, "hub unreachable for call")
        val lang = hub.snapshot.value?.language ?: "en-US"
        val text = unreachableText(lang)
        tts?.shutdown()
        var engine: TextToSpeech? = null
        engine = TextToSpeech(context) { status ->
            val t = engine ?: return@TextToSpeech
            if (status != TextToSpeech.SUCCESS) return@TextToSpeech
            val loc = Locale.forLanguageTag(lang)
            if (t.isLanguageAvailable(loc) >= TextToSpeech.LANG_AVAILABLE) t.language = loc else t.language = Locale.US
            t.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "unreachable")
        }
        tts = engine
    }

    companion object {
        private const val TAG = "cmc.call"
        private const val HUB_REASON = HubClient.REASON_CALL
        const val EXTRA_CALL_ID = "dev.callmeclaude.CALL_ID"
        const val EXTRA_TITLE = "dev.callmeclaude.TITLE"
        /** A notice nobody saw (app in the background) is dropped after this long. */
        const val NOTICE_MS = 10_000L

        fun displayName(title: String) = if (title.isEmpty() || title == "Claude") "Claude" else "Claude · $title"

        /** Spoken locally when the computer can't be reached (iOS CallManager.unreachableText, "Mac" → "computer"). */
        fun unreachableText(lang: String): String = when (lang.take(2)) {
            "tr" -> "Bilgisayarına ulaşılamıyor. Uygulamayı açıp tekrar eşleştirmeyi dene."
            "de" -> "Dein Computer ist nicht erreichbar. Öffne die App und kopple ihn erneut."
            "fr" -> "Ton ordinateur est injoignable. Ouvre l'app et refais le jumelage."
            "es" -> "No se puede contactar con tu ordenador. Abre la app y vuelve a emparejarlo."
            "it" -> "Il tuo computer non è raggiungibile. Apri l'app e prova ad abbinarlo di nuovo."
            "pt" -> "Não foi possível contactar o teu computador. Abre a app e emparelha-o de novo."
            else -> "Your computer can't be reached. Open the app and try pairing again."
        }
    }
}
