package dev.callmeclaude

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HubUrlsTest {
    @Test fun helloCarriesTheHubsCurrentAddresses() {
        val m = HubMessage.parse("""{"type":"hello","v":1,"urls":["ws://100.1.2.3:47801","ws://mac.local:47801",5]}""") as HubMessage.Hello
        assertEquals(listOf("ws://100.1.2.3:47801", "ws://mac.local:47801"), m.urls)
        assertNull((HubMessage.parse("""{"type":"hello","v":1}""") as HubMessage.Hello).urls)
    }

    @Test fun newAddressesReplaceStaleOnes() {
        val saved = listOf("ws://100.1.2.3:47801", "ws://192.168.1.3:47801", "ws://169.254.92.233:47801")
        val hub = listOf("ws://100.1.2.3:47801", "ws://192.168.8.114:47801", "ws://mac.local:47801")
        assertEquals(hub, mergedUrls(saved, hub))
    }

    @Test fun nothingUsableOrUnchangedKeepsTheSavedList() {
        val saved = listOf("ws://a:1")
        assertNull(mergedUrls(saved, null))
        assertNull(mergedUrls(saved, emptyList()))
        assertNull(mergedUrls(saved, listOf("http://evil:1", "javascript:x")))
        assertNull(mergedUrls(saved, listOf("ws://a:1")))
    }
}
