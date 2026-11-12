package dev.callmeclaude

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Samples follow HubToApp / Snapshot in packages/protocol/src/index.ts. */
class HubMessageTest {
    private val snapshotJson = """
        {
          "mode": "away",
          "language": "tr-TR",
          "paused": false,
          "hubVersion": "0.3.0",
          "sessions": [
            {"id":"s1","project":"acme-web","cwd":"/tmp/acme-web","state":"waiting_input",
             "summary":"Asks whether to submit the form","updatedAt":"2026-11-03T10:00:00.000Z",
             "controllable":["hold","tmux"]},
            {"id":"s2","project":"api","cwd":"/x/api","state":"running","summary":"Running tests",
             "updatedAt":"2026-11-03T10:01:00.000Z","controllable":[]}
          ],
          "pending": [
            {"id":"p_1","sessionId":"s1","project":"acme-web","kind":"stop","summary":"Submit the form?",
             "risk":"high","createdAt":"2026-11-03T10:00:00.000Z","deadline":"2026-11-03T10:00:20.000Z"}
          ]
        }
    """

    @Test fun parsesHelloWithSnapshot() {
        val m = HubMessage.parse("""{"type":"hello","v":1,"snapshot":$snapshotJson}""") as HubMessage.Hello
        assertEquals(1, m.v)
        val s = m.snapshot!!
        assertEquals("away", s.mode)
        assertEquals("tr-TR", s.language)
        assertFalse(s.paused)
        assertEquals("0.3.0", s.hubVersion)
        assertEquals(listOf("s1", "s2"), s.sessions.map { it.id })
        assertEquals("waiting_input", s.sessions[0].state)
        assertEquals("/tmp/acme-web", s.sessions[0].cwd)
        assertEquals("2026-11-03T10:01:00.000Z", s.sessions[1].updatedAt)
        val p = s.pending.single()
        assertEquals("p_1", p.id)
        assertEquals("s1", p.sessionId)
        assertEquals("stop", p.kind)
        assertEquals("high", p.risk)
        assertEquals("2026-11-03T10:00:20.000Z", p.deadline)
    }

    @Test fun parsesSnapshotUpdate() {
        val paused = JSONObject(snapshotJson).put("paused", true).put("sessions", org.json.JSONArray()).toString()
        val m = HubMessage.parse("""{"type":"snapshot","snapshot":$paused}""") as HubMessage.SnapshotUpdate
        assertTrue(m.snapshot!!.paused)
        assertTrue(m.snapshot.sessions.isEmpty())
        assertEquals(1, m.snapshot.pending.size)
    }

    @Test fun languageIsOptionalLikeOnIos() {
        val noLang = JSONObject(snapshotJson).apply { remove("language") }.toString()
        val m = HubMessage.parse("""{"type":"snapshot","snapshot":$noLang}""") as HubMessage.SnapshotUpdate
        assertNull(m.snapshot!!.language)
    }

    @Test fun malformedSnapshotIsDroppedButHelloStillCounts() {
        val m = HubMessage.parse("""{"type":"hello","v":1,"snapshot":{"sessions":[]}}""") as HubMessage.Hello
        assertNull(m.snapshot)
    }

    @Test fun parsesTheOtherHubMessages() {
        assertEquals(HubMessage.Heartbeat("2026-11-03T10:00:00Z"), HubMessage.parse("""{"type":"heartbeat","ts":"2026-11-03T10:00:00Z"}"""))
        assertEquals(HubMessage.Error("bad"), HubMessage.parse("""{"type":"error","message":"bad"}"""))
        assertEquals(HubMessage.CallIncoming("c_1", "Claude"), HubMessage.parse("""{"type":"call.incoming","callId":"c_1","title":"Claude"}"""))
        assertEquals(HubMessage.CallReady("c_1"), HubMessage.parse("""{"type":"call.ready","callId":"c_1"}"""))
        assertEquals(HubMessage.CallEnded("c_1", "hangup"), HubMessage.parse("""{"type":"call.ended","callId":"c_1","reason":"hangup"}"""))
        assertEquals(HubMessage.AudioFlush, HubMessage.parse("""{"type":"audio.flush"}"""))
        assertEquals(HubMessage.Transcript("assistant", "hi", true), HubMessage.parse("""{"type":"transcript","role":"assistant","text":"hi","final":true}"""))
        assertEquals(HubMessage.Unknown("future.thing"), HubMessage.parse("""{"type":"future.thing"}"""))
    }

    @Test fun ignoresGarbage() {
        assertNull(HubMessage.parse("nope"))
        assertNull(HubMessage.parse("[]"))
        assertNull(HubMessage.parse("""{"no":"type"}"""))
        assertNull(HubMessage.parse("""{"type":3}"""))
    }

    @Test fun buildsAppMessages() {
        val auth = JSONObject(AppMessages.auth("tok", "Galaxy S25"))
        assertEquals("auth", auth.getString("type"))
        assertEquals("tok", auth.getString("token"))
        assertEquals("Galaxy S25", auth.getString("device"))
        assertEquals(1, auth.getInt("v"))

        val r = JSONObject(AppMessages.resolve("p_1", Decision.RELEASE))
        assertEquals("pending.resolve", r.getString("type"))
        assertEquals("p_1", r.getString("pendingId"))
        assertEquals("release", r.getString("decision"))
        assertFalse(r.has("note"))
        assertEquals("ok", JSONObject(AppMessages.resolve("p_1", Decision.APPROVE, "ok")).getString("note"))

        assertEquals("away", JSONObject(AppMessages.modeSet("away")).getString("mode"))
        assertEquals("tr-TR", JSONObject(AppMessages.languageSet("tr-TR")).getString("language"))
        assertEquals("panic", JSONObject(AppMessages.panic()).getString("type"))
        assertEquals("resume", JSONObject(AppMessages.resume()).getString("type"))
    }

    @Test fun parsesAnnounceAndDoneAlert() {
        val a = HubMessage.parse("""{"type":"announce","text":"acme projesi görevi tamamlandı.","language":"tr-TR"}""")
        assertEquals(HubMessage.Announce("acme projesi görevi tamamlandı.", "tr-TR"), a)
        val withAlert = JSONObject(snapshotJson).put("doneAlert", "phone")
        assertEquals("phone", (HubMessage.parse("""{"type":"snapshot","snapshot":$withAlert}""") as HubMessage.SnapshotUpdate).snapshot!!.doneAlert)
        assertNull((HubMessage.parse("""{"type":"snapshot","snapshot":$snapshotJson}""") as HubMessage.SnapshotUpdate).snapshot!!.doneAlert)
        val set = JSONObject(AppMessages.alertSet("computer"))
        assertEquals("alert.set", set.getString("type"))
        assertEquals("computer", set.getString("target"))
    }

    @Test fun parsesRingTargetAndBuildsRingSet() {
        for (t in listOf("computer", "phone", "off")) {
            val withRing = JSONObject(snapshotJson).put("ringTarget", t)
            assertEquals(t, (HubMessage.parse("""{"type":"hello","v":1,"snapshot":$withRing}""") as HubMessage.Hello).snapshot!!.ringTarget)
            assertEquals(t, (HubMessage.parse("""{"type":"snapshot","snapshot":$withRing}""") as HubMessage.SnapshotUpdate).snapshot!!.ringTarget)
        }
        // Older hubs send no ringTarget: the setting stays hidden.
        assertNull((HubMessage.parse("""{"type":"snapshot","snapshot":$snapshotJson}""") as HubMessage.SnapshotUpdate).snapshot!!.ringTarget)
        val set = JSONObject(AppMessages.ringSet("computer"))
        assertEquals("ring.set", set.getString("type"))
        assertEquals("computer", set.getString("target"))
        assertEquals(setOf("type", "target"), set.keys().asSequence().toSet())
    }
}
