package dev.callmeclaude

import org.junit.Assert.assertEquals
import org.junit.Test

class WarningsTest {
    private val allBad = Health(
        pairingInvalid = false,
        connected = false,
        localNetwork = LocalNetworkAccess.DENIED,
        notificationsEnabled = false,
        fullScreenIntentAllowed = false,
        ignoringBatteryOptimizations = false,
    )

    @Test
    fun `healthy phone shows nothing`() {
        assertEquals(emptyList<Warning>(), warnings(Health(connected = true)))
        assertEquals(emptyList<Warning>(), homeWarnings(Health(connected = true)))
    }

    @Test
    fun `everything wrong is listed most serious first`() {
        assertEquals(
            listOf(Warning.LOCAL_NETWORK, Warning.NOTIFICATIONS, Warning.FULL_SCREEN_INTENT, Warning.BATTERY),
            warnings(allBad),
        )
    }

    @Test
    fun `home shows only the top two`() {
        assertEquals(listOf(Warning.LOCAL_NETWORK, Warning.NOTIFICATIONS), homeWarnings(allBad))
        assertEquals(2, HOME_MAX_WARNINGS)
    }

    @Test
    fun `invalid pairing hides every other card`() {
        val h = allBad.copy(pairingInvalid = true)
        assertEquals(listOf(Warning.PAIRING_INVALID), warnings(h))
        assertEquals(listOf(Warning.PAIRING_INVALID), homeWarnings(h))
    }

    @Test
    fun `local network card only while not connected and only when the permission applies`() {
        assertEquals(emptyList<Warning>(), warnings(Health(connected = true, localNetwork = LocalNetworkAccess.DENIED)))
        assertEquals(listOf(Warning.LOCAL_NETWORK), warnings(Health(connected = false, localNetwork = LocalNetworkAccess.BLOCKED)))
        assertEquals(emptyList<Warning>(), warnings(Health(connected = false, localNetwork = LocalNetworkAccess.NOT_REQUIRED)))
        assertEquals(emptyList<Warning>(), warnings(Health(connected = false, localNetwork = LocalNetworkAccess.GRANTED)))
    }

    @Test
    fun `full-screen intent outranks battery`() {
        val h = Health(connected = true, fullScreenIntentAllowed = false, ignoringBatteryOptimizations = false)
        assertEquals(listOf(Warning.FULL_SCREEN_INTENT, Warning.BATTERY), homeWarnings(h))
    }

    @Test
    fun `dismissed battery card leaves home but stays in settings`() {
        val h = Health(connected = true, ignoringBatteryOptimizations = false, batteryCardDismissed = true)
        assertEquals(emptyList<Warning>(), homeWarnings(h))
        assertEquals(listOf(Warning.BATTERY), warnings(h))
        // A dismissed battery card frees its slot for the next one.
        val h2 = allBad.copy(batteryCardDismissed = true, connected = true)
        assertEquals(listOf(Warning.NOTIFICATIONS, Warning.FULL_SCREEN_INTENT), homeWarnings(h2))
    }

    @Test
    fun `unreachable computer suggests pairing again`() {
        assertEquals(listOf(Warning.UNREACHABLE), warnings(Health(unreachable = true)))
        // Connected again (e.g. over Tailscale) or missing permission: the more precise answer wins.
        assertEquals(emptyList<Warning>(), warnings(Health(unreachable = true, connected = true)))
        assertEquals(listOf(Warning.LOCAL_NETWORK), warnings(Health(unreachable = true, localNetwork = LocalNetworkAccess.DENIED)))
        assertEquals(listOf(Warning.PAIRING_INVALID), warnings(Health(unreachable = true, pairingInvalid = true)))
    }
}
