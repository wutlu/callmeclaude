package dev.callmeclaude.ui

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class FormatTest {
    private val now = Instant.parse("2026-11-03T12:00:00Z")

    @Test fun relativeTimes() {
        assertEquals("30 sec. ago", relative("2026-11-03T11:59:30.000Z", now))
        assertEquals("5 min. ago", relative("2026-11-03T11:55:00Z", now))
        assertEquals("2 hr. ago", relative("2026-11-03T10:00:00Z", now))
        assertEquals("1 day ago", relative("2026-11-02T11:00:00Z", now))
        assertEquals("0 sec. ago", relative("2026-11-03T12:00:02Z", now))
        assertEquals("", relative("garbage", now))
    }

    @Test fun stateLabelsMatchIos() {
        assertEquals("Waiting for you", stateLabel("waiting_input"))
        assertEquals("Stuck", stateLabel("blocked"))
        assertEquals("whatever", stateLabel("whatever"))
    }

    @Test fun sessionsThatNeedYouComeFirst() {
        data class S(val id: String, val state: String, val at: String)
        val list = listOf(
            S("old-done", "done", "2026-11-02T06:00:00Z"),
            S("run", "running", "2026-11-03T11:55:00Z"),
            S("done", "done", "2026-11-03T11:00:00Z"),
            S("ask", "waiting_input", "2026-11-02T16:00:00Z"),
        )
        val (recent, earlier) = orderSessions(list, { it.state }, { it.at }, now)
        assertEquals(listOf("ask", "run", "done"), recent.map { it.id })
        assertEquals(listOf("old-done"), earlier.map { it.id })
        assertEquals("24 min", timeLeft("2026-11-03T12:23:12Z", now))
        assertEquals("40 s", timeLeft("2026-11-03T12:00:40Z", now))
    }
}
