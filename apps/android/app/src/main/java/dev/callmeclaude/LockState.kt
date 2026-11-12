package dev.callmeclaude

/**
 * What the hub knows about the phone's lock screen, and when to tell it (`device.lock`). Pure; the
 * caller confines it to one thread (HubClient's hub thread).
 *
 * The hub keeps the lock state per connection and starts every new connection at "unknown"
 * (protocol: absent = unknown, treated as unlocked). So:
 *  - [connected] always sends the current state, read fresh when a reading is available, even if it
 *    is the same as before the reconnect;
 *  - [observed] sends a reading only when it differs from the last one, and only while connected; a
 *    change made while offline goes out with the next [connected].
 */
class LockReport(private val send: (Boolean) -> Unit) {
    /** Last reading (null until the first one). */
    var last: Boolean? = null
        private set

    private var online = false

    /** A new reading. Returns true if it is a change (sent now, or on the next connect). */
    fun observed(locked: Boolean): Boolean {
        if (locked == last) return false
        last = locked
        if (online) send(locked)
        return true
    }

    /** After every hello. [fresh] is a reading taken right now, if there is one. */
    fun connected(fresh: Boolean?) {
        online = true
        val v = fresh ?: last ?: return
        last = v
        send(v)
    }

    fun disconnected() {
        online = false
    }
}

/**
 * Turns screen and keyguard signals into lock readings for [report]. Pure: the keyguard, the screen
 * and the timer are passed in, so tests can drive it. Main thread.
 *
 *  - screen off: locked right away if a PIN/pattern/password is set (the keyguard itself may only
 *    engage a few seconds later);
 *  - user present (keyguard dismissed): unlocked;
 *  - screen on, app opened, any other check: read the keyguard;
 *  - while the screen is on and the keyguard is up, read it again every [RECHECK_MS] (for at most
 *    [RECHECK_MAX_MS]) until it goes away. An unlock does not always come with a broadcast we get
 *    (face unlock that stays on the lock screen, Smart Lock, a broadcast delayed in the system
 *    queue), and SCREEN_ON arrives while the lock screen is still up, so without this the hub would
 *    keep the phone "locked" until the screen next goes off and on.
 */
class LockSignals(
    private val secure: () -> Boolean,
    private val keyguardLocked: () -> Boolean,
    private val interactive: () -> Boolean,
    private val now: () -> Long,
    private val schedule: (delayMs: Long, block: () -> Unit) -> Unit,
    private val report: (locked: Boolean, why: String) -> Unit,
) {
    /** Bumped to cancel a running re-check loop (scheduled blocks of an older generation do nothing). */
    private var generation = 0
    private var recheckUntil = 0L

    /** True while a re-check loop is running (for tests and logs). */
    var rechecking = false
        private set

    fun lockedNow(): Boolean = secure() && keyguardLocked()

    fun screenOff() {
        stopRecheck()
        report(secure(), "screen off")
    }

    fun userPresent() {
        stopRecheck()
        report(false, "user present")
    }

    fun screenOn() = check("screen on")

    /** Read the keyguard now (screen on, app opened, …); keep re-reading while it stays up on a lit screen. */
    fun check(why: String) {
        val locked = lockedNow()
        report(locked, why)
        if (locked && interactive()) startRecheck() else if (!locked) stopRecheck()
    }

    private fun startRecheck() {
        recheckUntil = now() + RECHECK_MAX_MS
        if (rechecking) return
        rechecking = true
        val gen = ++generation
        schedule(RECHECK_MS) { recheck(gen) }
    }

    private fun recheck(gen: Int) {
        if (gen != generation) return
        if (!interactive() || now() >= recheckUntil) return stopRecheck()
        val locked = lockedNow()
        report(locked, "re-check")
        if (!locked) return stopRecheck()
        schedule(RECHECK_MS) { recheck(gen) }
    }

    private fun stopRecheck() {
        if (!rechecking) return
        rechecking = false
        generation++
    }

    companion object {
        /** Keyguard re-read interval while the lock screen is lit: an unlock reaches the hub within a second. */
        const val RECHECK_MS = 1_000L

        /** A lit lock screen times out long before this; it only bounds the loop if the screen stays on. */
        const val RECHECK_MAX_MS = 5 * 60_000L
    }
}
