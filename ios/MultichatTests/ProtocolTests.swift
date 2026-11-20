import XCTest
@testable import Multichat

@MainActor
final class ProtocolTests: XCTestCase {
    func testParseLinkText() throws {
        let pub = B64U.encode(try X25519.publicKey(fromPrivate: X25519.generatePrivate()))
        let parsed = try XCTUnwrap(AppModel.parseLinkText("multichat-link:l_abc:\(pub)\n"))
        XCTAssertEqual(parsed.id, "l_abc")
        XCTAssertEqual(parsed.pub, pub)
        XCTAssertNil(AppModel.parseLinkText("multichat-link:l_abc"))
        XCTAssertNil(AppModel.parseLinkText("otra-cosa:l_abc:\(pub)"))
        XCTAssertNil(AppModel.parseLinkText("multichat-link:l_abc:corta"))
    }

    func testPatchContactEncodesExplicitNullAlias() throws {
        let clear = try JSONSerialization.jsonObject(with: JSONEncoder().encode(APIClient.PatchContact(alias: .some(nil)))) as? [String: Any]
        XCTAssertEqual(clear?.count, 1)
        XCTAssertTrue(clear?["alias"] is NSNull)
        let read = try JSONSerialization.jsonObject(with: JSONEncoder().encode(APIClient.PatchContact(read: true))) as? [String: Any]
        XCTAssertEqual(read?["read"] as? Bool, true)
        XCTAssertNil(read?["alias"])
    }

    func testPushBodyRemoveSendsNullKind() throws {
        let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(APIClient.PushBody(kind: nil))) as? [String: Any]
        XCTAssertTrue(obj?["kind"] is NSNull)
    }

    func testDecodeContactAndMessageThroughEnvelope() throws {
        let priv = X25519.generatePrivate()
        let pub = B64U.encode(try X25519.publicKey(fromPrivate: priv))
        let profile = try Envelope.sealJSON(ContactProfile(name: "Ana", username: "ana_99", phone: nil, platform: "telegram"), toB64U: pub)
        let json = """
        {"id":"c_1","integrationId":"i_1","kind":"direct","status":"pending","profile":"\(profile)","alias":null,
         "muted":false,"hidePreview":false,"unread":2,"lastMessageAt":1700000000000,"lastInboundAt":null,"seq":7,
         "createdAt":1,"updatedAt":2}
        """
        let c = try JSONDecoder().decode(Contact.self, from: Data(json.utf8))
        XCTAssertEqual(try Envelope.openJSON(ContactProfile.self, c.profile, privateKey: priv).name, "Ana")

        let payloadJSON = #"{"v":1,"kind":"image","text":"pie","senderName":null,"location":null,"attachment":{"blobId":"b_1","fileKey":"AAAA","mime":"image/jpeg","name":"foto.jpg","size":12345}}"#
        let env = B64U.encode(try Envelope.seal(Data(payloadJSON.utf8), to: B64U.decode(pub)!))
        let p = try Envelope.openJSON(MessagePayload.self, env, privateKey: priv)
        XCTAssertEqual(p.attachment?.blobId, "b_1")
        XCTAssertEqual(p.previewText, "📷 Foto: pie")
    }

    func testJSONValueIntegrationInfo() throws {
        let json = ##"{"id":"i_1","type":"discord","name":"Bot","color":"#3b82f6","enabled":true,"status":"connected","statusDetail":null,"credentialHint":"a1B2","info":{"botId":"123","username":"bot","inviteUrl":"https://x"},"config":{"channelIds":["1","2"],"allowDMs":true},"webhookUrl":null,"createdAt":1,"updatedAt":2}"##
        let i = try JSONDecoder().decode(Integration.self, from: Data(json.utf8))
        XCTAssertEqual(i.type, .discord)
        XCTAssertEqual(i.config?["channelIds"]?.stringArray, ["1", "2"])
        XCTAssertEqual(i.config?["allowDMs"]?.bool, true)
        XCTAssertEqual(i.info?["inviteUrl"]?.string, "https://x")
    }

    func testMultipartBody() throws {
        let src = FileManager.default.temporaryDirectory.appendingPathComponent("mp-src.txt")
        try Data("hola".utf8).write(to: src)
        let out = try Multipart.write(boundary: "B", fields: [("clientId", "u1"), ("kind", "file")], fileField: "file",
                                      fileURL: src, fileName: "a.txt", mime: "text/plain")
        let body = try XCTUnwrap(String(data: Data(contentsOf: out), encoding: .utf8))
        XCTAssertTrue(body.contains("name=\"clientId\"\r\n\r\nu1\r\n"))
        XCTAssertTrue(body.contains("name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nhola\r\n--B--\r\n"))
    }
}
