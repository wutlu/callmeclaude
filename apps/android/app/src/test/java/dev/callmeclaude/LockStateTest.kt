package dev.callmeclaude

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LockReportTest {
    private val sent = mutableListOf<Boolean>()
    private val r = LockReport { sent += it }

    @Test
    fun `connect sends the current state, read fresh`() {
        r.observed(true)
        r.connected(fresh = false)
        assertEquals(listOf(false), sent)
        assertEquals(false, r.last)
    }

    @Test
    fun `connect without a fresh reading sends the last one`() {
        r.observed(true)
        r.connected(fresh = null)
        assertEquals(listOf(true), sent)
    }

    @Test
    fun `connect before any reading sends nothing, the first reading then goes out`() {
        r.connected(fresh = null)
        assertEquals(emptyList<Boolean>(), sent)
        r.observed(false)
        assertEquals(listOf(false), sent)
    }

    @Test
    fun `every reconnect sends the state again even when it did not change`() {
        r.connected(fresh = false)
        r.disconnected()
        r.connected(fresh = false)
        r.disconnected()
        r.connected(fresh = false)
        assertEquals(listOf(false, false, false), sent)
    }

    @Test
    fun `changes are sent, repeats of the same state are not`() {
        r.connected(fresh = false)
        assertTrue(r.observed(true))
        assertFalse(r.observed(true))
        assertFalse(r.observed(true))
        assertTrue(r.observed(false))
        assertFalse(r.observed(false))
        assertEquals(listOf(false, true, false), sent)
    }

    @Test
    fun `a change while offline goes out on the next connect`() {
        r.connected(fresh = false)
        r.disconnected()
        assertTrue(r.observed(true)) // remembered, not sent: no connection
        assertEquals(listOf(false), sent)
        r.connected(fresh = null)
        assertEquals(listOf(false, true), sent)
    }
}

class LockSignalsTest {
    private var secure = true
    private var keyguard = false
    private var screen = true
    private var clock = 0L
    private val timers = mutableListOf<Pair<Long, () -> Unit>>()
    private val reports = mutableListOf<Pair<Boolean, String>>()

    private val s = LockSignals(
        secure = { secure },
        keyguardLocked = { keyguard },
        interactive = { screen },
        now = { clock },
        schedule = { ms, block -> timers += (clock + ms) to block },
        report = { l, why -> reports += l to why },
    )

    /** Advance the fake clock, running due timers in order. */
    private fun advance(ms: Long) {
        val end = clock + ms
        while (true) {
            val next = timers.filter { it.first <= end }.minByOrNull { it.first } ?: break
            timers.remove(next)
            clock = next.first
            next.second()
        }
        clock = end
    }

    @Test
    fun `screen off counts as locked at once when a lock is set`() {
        s.screenOff()
        assertEquals(listOf(true to "screen off"), reports)
    }

    @Test
    fun `no PIN or pattern means never locked`() {
        secure = false
        keyguard = true
        s.screenOff()
        s.screenOn()
        assertEquals(listOf(false, false), reports.map { it.first })
    }

    @Test
    fun `unlock without a user-present broadcast is still seen by the re-check`() {
        // Screen comes on at the lock screen: SCREEN_ON arrives before the unlock.
        keyguard = true
        s.screenOn()
        assertEquals(true to "screen on", reports.last())
        assertTrue(s.rechecking)
        advance(LockSignals.RECHECK_MS * 3)
        assertEquals(true, reports.last().first)
        // Face / fingerprint unlock, and no USER_PRESENT reaches the app.
        keyguard = false
        advance(LockSignals.RECHECK_MS)
        assertEquals(false to "re-check", reports.last())
        assertFalse(s.rechecking)
        val n = reports.size
        advance(LockSignals.RECHECK_MS * 10)
        assertEquals("no more readings once unlocked", n, reports.size)
    }

    @Test
    fun `user present stops the re-check and reports unlocked`() {
        keyguard = true
        s.screenOn()
        s.userPresent()
        assertEquals(false to "user present", reports.last())
        assertFalse(s.rechecking)
        val n = reports.size
        advance(LockSignals.RECHECK_MS * 5)
        assertEquals(n, reports.size)
    }

    @Test
    fun `screen off stops the re-check`() {
        keyguard = true
        s.screenOn()
        screen = false
        s.screenOff()
        val n = reports.size
        advance(LockSignals.RECHECK_MS * 5)
        assertEquals(n, reports.size)
        assertFalse(s.rechecking)
    }

    @Test
    fun `re-check gives up after its limit if the lock screen stays lit`() {
        keyguard = true
        s.screenOn()
        advance(LockSignals.RECHECK_MAX_MS + LockSignals.RECHECK_MS * 2)
        assertFalse(s.rechecking)
        val n = reports.size
        advance(LockSignals.RECHECK_MS * 5)
        assertEquals(n, reports.size)
    }

    @Test
    fun `a second screen-on does not start a second loop`() {
        keyguard = true
        s.screenOn()
        s.screenOn()
        s.check("app opened")
        assertEquals(1, timers.size)
    }

    @Test
    fun `check while the screen is off reads but does not loop`() {
        keyguard = true
        screen = false
        s.check("start")
        assertEquals(listOf(true to "start"), reports)
        assertFalse(s.rechecking)
    }

    @Test
    fun `lock, unlock, lock again restarts the re-check`() {
        keyguard = true
        s.screenOn()
        s.userPresent()
        keyguard = false
        s.screenOff()
        keyguard = true
        s.screenOn()
        assertTrue(s.rechecking)
        keyguard = false
        advance(LockSignals.RECHECK_MS)
        assertEquals(listOf(true, false, true, true, false), reports.map { it.first })
    }
}
