package dev.callmeclaude

import dev.callmeclaude.AlertPlanner.Plan
import dev.callmeclaude.AlertPlanner.Reason
import org.junit.Assert.assertEquals
import org.junit.Test

class AlertPlannerTest {
    private val hinted = mutableSetOf<String>()
    private val p = AlertPlanner(hintShown = { it in hinted }, rememberHint = { hinted += it })

    @Test
    fun `a voice for the language is used`() {
        assertEquals(Plan.Speak, p.plan("tr-TR", 0)) // LANG_AVAILABLE
        assertEquals(Plan.Speak, p.plan("tr-TR", 1)) // LANG_COUNTRY_AVAILABLE
        assertEquals(Plan.Speak, p.plan("en-US", 2)) // LANG_COUNTRY_VAR_AVAILABLE
        assertEquals(emptySet<String>(), hinted)
    }

    @Test
    fun `missing voice data never falls back to another voice`() {
        assertEquals(Plan.Notify(hint = true, reason = Reason.MISSING_DATA), p.plan("tr-TR", -1))
    }

    @Test
    fun `language the engine does not support is shown, not spoken`() {
        assertEquals(Plan.Notify(hint = true, reason = Reason.NOT_SUPPORTED), p.plan("tr-TR", -2))
    }

    @Test
    fun `no engine at all is shown, not dropped`() {
        assertEquals(Plan.Notify(hint = true, reason = Reason.NO_ENGINE), p.plan("tr-TR", null))
    }

    @Test
    fun `the how-to hint is shown once per language`() {
        assertEquals(Plan.Notify(true, Reason.MISSING_DATA), p.plan("tr-TR", -1))
        assertEquals(Plan.Notify(false, Reason.MISSING_DATA), p.plan("tr-TR", -1))
        assertEquals(Plan.Notify(false, Reason.MISSING_DATA), p.plan("tr", -1))
        assertEquals(Plan.Notify(true, Reason.MISSING_DATA), p.plan("de-DE", -1))
        assertEquals(setOf("tr", "de"), hinted)
    }

    @Test
    fun `hint key ignores the region and case`() {
        assertEquals("tr", AlertPlanner.key("tr-TR"))
        assertEquals("tr", AlertPlanner.key("TR"))
        assertEquals("pt", AlertPlanner.key("pt-BR"))
        assertEquals("und", AlertPlanner.key(""))
    }
}
