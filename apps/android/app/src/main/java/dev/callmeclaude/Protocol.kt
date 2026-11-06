package dev.callmeclaude

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

// Mirrors packages/protocol/src/index.ts (protocol v1) and apps/ios/CallMeClaude/Models.swift.

const val PROTOCOL_VERSION = 1

data class PairingInfo(
    val v: Int,
    val name: String,
    val urls: List<String>,
    val token: String,
) {
    fun toJson(): String = JSONObject()
        .put("v", v)
        .put("name", name)
        .put("urls", JSONArray(urls))
        .put("token", token)
        .toString()

    companion object {
        const val INVALID = "That isn't a valid pairing code."

        /** Parses and validates the text from `cmc pair` (QR or pasted). */
        fun parse(text: String): PairingResult {
            val o = try {
                JSONObject(text.trim())
            } catch (_: JSONException) {
                return PairingResult.Invalid(INVALID)
            }
            val v = o.opt("v")
            if (v !is Int) return PairingResult.Invalid(INVALID)
            if (v != PROTOCOL_VERSION) {
                return PairingResult.Invalid(
                    "This pairing code uses protocol v$v, but this app speaks v$PROTOCOL_VERSION. " +
                        "Update the app or the hub so they match."
                )
            }
            val name = o.opt("name") as? String ?: return PairingResult.Invalid(INVALID)
            val token = (o.opt("token") as? String)?.takeIf { it.isNotEmpty() }
                ?: return PairingResult.Invalid(INVALID)
            val arr = o.opt("urls") as? JSONArray ?: return PairingResult.Invalid(INVALID)
            val urls = (0 until arr.length()).map { arr.opt(it) as? String ?: return PairingResult.Invalid(INVALID) }
            if (urls.isEmpty() || urls.any { !(it.startsWith("ws://") || it.startsWith("wss://")) }) {
                return PairingResult.Invalid(INVALID)
            }
            return PairingResult.Ok(PairingInfo(v, name, urls, token))
        }
    }
}

sealed interface PairingResult {
    data class Ok(val info: PairingInfo) : PairingResult
    data class Invalid(val message: String) : PairingResult
}

data class SessionCard(
    val id: String,
    val project: String,
    val cwd: String,
    val state: String,
    val summary: String,
    val updatedAt: String,
)

data class PendingCard(
    val id: String,
    val sessionId: String,
    val project: String,
    val kind: String,
    val summary: String,
    val risk: String,
    val createdAt: String,
    val deadline: String,
)

data class Snapshot(
    val mode: String,
    val language: String?,
    val paused: Boolean,
    val hubVersion: String,
    val sessions: List<SessionCard>,
    val pending: List<PendingCard>,
) {
    companion object {
        fun fromJson(o: JSONObject): Snapshot = Snapshot(
            mode = o.getString("mode"),
            language = o.optString("language").ifEmpty { null },
            paused = o.optBoolean("paused", false),
            hubVersion = o.optString("hubVersion"),
            sessions = o.optJSONArray("sessions").objects().map {
                SessionCard(
                    id = it.getString("id"),
                    project = it.optString("project"),
                    cwd = it.optString("cwd"),
                    state = it.optString("state"),
                    summary = it.optString("summary"),
                    updatedAt = it.optString("updatedAt"),
                )
            },
            pending = o.optJSONArray("pending").objects().map {
                PendingCard(
                    id = it.getString("id"),
                    sessionId = it.optString("sessionId"),
                    project = it.optString("project"),
                    kind = it.optString("kind"),
                    summary = it.optString("summary"),
                    risk = it.optString("risk"),
                    createdAt = it.optString("createdAt"),
                    deadline = it.optString("deadline"),
                )
            },
        )

        private fun JSONArray?.objects(): List<JSONObject> =
            if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    }
}

/** Hub -> App text frames. Binary frames (audio) never reach this parser. */
sealed interface HubMessage {
    /** [urls]: the hub's current addresses (newer hubs); replace the saved ones, see [mergedUrls]. */
    data class Hello(val v: Int, val snapshot: Snapshot?, val urls: List<String>? = null) : HubMessage
    data class SnapshotUpdate(val snapshot: Snapshot?) : HubMessage
    data class Heartbeat(val ts: String) : HubMessage
    data class CallIncoming(val callId: String, val title: String) : HubMessage
    data class CallReady(val callId: String) : HubMessage
    data class CallEnded(val callId: String, val reason: String) : HubMessage
    data object AudioFlush : HubMessage
    data class Transcript(val role: String, val text: String, val final: Boolean) : HubMessage
    data class Error(val message: String) : HubMessage
    data class Unknown(val type: String) : HubMessage

    companion object {
        /** Returns null for anything that isn't a JSON object with a string `type`. */
        fun parse(text: String): HubMessage? {
            val o = try {
                JSONObject(text)
            } catch (_: JSONException) {
                return null
            }
            val type = o.opt("type") as? String ?: return null
            return when (type) {
                "hello" -> Hello(
                    o.optInt("v", 0),
                    snapshotOf(o),
                    (o.opt("urls") as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } },
                )
                "snapshot" -> SnapshotUpdate(snapshotOf(o))
                "heartbeat" -> Heartbeat(o.optString("ts"))
                "call.incoming" -> CallIncoming(o.optString("callId"), o.optString("title", "Claude"))
                "call.ready" -> CallReady(o.optString("callId"))
                "call.ended" -> CallEnded(o.optString("callId"), o.optString("reason"))
                "audio.flush" -> AudioFlush
                "transcript" -> Transcript(o.optString("role"), o.optString("text"), o.optBoolean("final"))
                "error" -> Error(o.optString("message", "?"))
                else -> Unknown(type)
            }
        }

        /** Like the iOS decoder: a malformed snapshot is dropped, the message itself still counts. */
        private fun snapshotOf(o: JSONObject): Snapshot? = try {
            o.optJSONObject("snapshot")?.let(Snapshot::fromJson)
        } catch (_: JSONException) {
            null
        }
    }
}

/** App -> Hub messages. */
object AppMessages {
    fun auth(token: String, device: String): String =
        JSONObject().put("type", "auth").put("token", token).put("device", device).put("v", PROTOCOL_VERSION).toString()

    fun modeSet(mode: String): String = JSONObject().put("type", "mode.set").put("mode", mode).toString()
    fun languageSet(code: String): String = JSONObject().put("type", "language.set").put("language", code).toString()
    fun panic(): String = JSONObject().put("type", "panic").toString()
    fun resume(): String = JSONObject().put("type", "resume").toString()
    fun ping(): String = JSONObject().put("type", "ping").toString()

    /** The secure lock screen is showing: the hub then refuses voice actions that change anything. */
    fun deviceLock(locked: Boolean): String = JSONObject().put("type", "device.lock").put("locked", locked).toString()

    /** Diagnostics for the hub's app log (packages/protocol: `{ type: 'log'; lines: string[] }`). */
    fun log(lines: List<String>): String = JSONObject().put("type", "log").put("lines", JSONArray(lines)).toString()

    /** [direction] is from the hub's point of view: "outbound" = the hub called us, "inbound" = we called it. */
    fun callStart(callId: String, direction: String): String =
        JSONObject().put("type", "call.start").put("callId", callId).put("direction", direction).toString()

    fun callEnd(callId: String): String = JSONObject().put("type", "call.end").put("callId", callId).toString()

    fun resolve(pendingId: String, decision: Decision, note: String? = null): String {
        val o = JSONObject().put("type", "pending.resolve").put("pendingId", pendingId).put("decision", decision.wire)
        if (note != null) o.put("note", note)
        return o.toString()
    }
}

enum class Decision(val wire: String) { APPROVE("approve"), DENY("deny"), RELEASE("release") }

/**
 * The hub's addresses from hello replace the saved ones, so a new Wi-Fi or IP needs no re-pairing.
 * Only ws:// / wss:// and at most 12; null = keep the saved list (nothing new or nothing usable).
 */
fun mergedUrls(saved: List<String>, fromHub: List<String>?): List<String>? {
    val valid = fromHub.orEmpty().filter { (it.startsWith("ws://") || it.startsWith("wss://")) && it.length < 300 }.take(12)
    return if (valid.isEmpty() || valid == saved) null else valid
}
