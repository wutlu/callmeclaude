package dev.callmeclaude

/**
 * Things that stop Claude from reaching the user, as cards on the home screen (and all of them in
 * Settings). Pure Kotlin so the choice is unit tested; the UI reads the platform state into [Health].
 */
enum class Warning {
    /** The hub refused the token (close code 4003). Nothing else matters until the user pairs again. */
    PAIRING_INVALID,

    /** Android 17+: no local network permission and not connected. */
    LOCAL_NETWORK,

    /** No saved address answered (typically the computer moved to another network): pair again. */
    UNREACHABLE,

    /** Notifications are off: no ringing UI, no status notification. */
    NOTIFICATIONS,

    /** Android 14+: the full-screen intent permission is off, so calls don't take over the lock screen. */
    FULL_SCREEN_INTENT,

    /** Battery optimisation (Doze, app standby, Samsung's sleeping apps) may cut the hub connection. */
    BATTERY,
}

data class Health(
    val pairingInvalid: Boolean = false,
    val connected: Boolean = false,
    /** The last connection attempt timed out on every saved address. */
    val unreachable: Boolean = false,
    val localNetwork: LocalNetworkAccess = LocalNetworkAccess.NOT_REQUIRED,
    val notificationsEnabled: Boolean = true,
    val fullScreenIntentAllowed: Boolean = true,
    val ignoringBatteryOptimizations: Boolean = true,
    /** The user tapped "Not now" on the battery card; it stays in Settings. */
    val batteryCardDismissed: Boolean = false,
)

/** Every problem, most serious first (the order the cards appear in). */
fun warnings(h: Health): List<Warning> {
    if (h.pairingInvalid) return listOf(Warning.PAIRING_INVALID)
    return buildList {
        // A live connection proves the LAN is reachable (or the hub is reached another way).
        if (!h.connected && (h.localNetwork == LocalNetworkAccess.DENIED || h.localNetwork == LocalNetworkAccess.BLOCKED)) {
            add(Warning.LOCAL_NETWORK)
        } else if (!h.connected && h.unreachable) {
            add(Warning.UNREACHABLE)
        }
        if (!h.notificationsEnabled) add(Warning.NOTIFICATIONS)
        if (!h.fullScreenIntentAllowed) add(Warning.FULL_SCREEN_INTENT)
        if (!h.ignoringBatteryOptimizations) add(Warning.BATTERY)
    }
}

/** The home screen shows at most [max] cards so the call button stays on screen; Settings lists all. */
fun homeWarnings(h: Health, max: Int = HOME_MAX_WARNINGS): List<Warning> =
    warnings(h).filterNot { it == Warning.BATTERY && h.batteryCardDismissed }.take(max)

const val HOME_MAX_WARNINGS = 2
