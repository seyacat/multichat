import CryptoKit
import XCTest
@testable import Multichat

/// Vectores de shared/crypto-vectors/vectors.json (docs/crypto.md).
final class CryptoVectorTests: XCTestCase {
    struct Vectors: Decodable {
        struct KeyPair: Decodable { let privateKey: String; let publicKey: String }
        struct Env: Decodable {
            let recipientPrivateKey: String
            let recipientPublicKey: String
            let ephemeralPrivateKey: String
            let nonce: String
            let plaintextUtf8: String
            let envelope: String
        }
        struct Blob: Decodable {
            let fileKey: String
            let baseNonce: String
            let plaintextSize: Int
            let plaintextSha256: String
            let plaintextHex: String?
            let plaintextRecipe: String
            let blob: String
        }
        let version: Int
        let x25519: [KeyPair]
        let envelope: [Env]
        let blob: [Blob]
    }

    private func loadVectors() throws -> Vectors {
        let url = try XCTUnwrap(Bundle(for: CryptoVectorTests.self).url(forResource: "vectors", withExtension: "json"))
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func d(_ s: String) throws -> Data { try XCTUnwrap(B64U.decode(s), "b64u inválido: \(s.prefix(20))") }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// Receta: concatenar sha256("plain-<i>:" + n) para n = 0,1,2… y truncar a `size`.
    private func recipePlaintext(index: Int, size: Int) -> Data {
        var out = Data()
        var n = 0
        while out.count < size {
            out.append(contentsOf: SHA256.hash(data: Data("plain-\(index):\(n)".utf8)))
            n += 1
        }
        return out.prefix(size)
    }

    private func recipeIndex(_ recipe: String) throws -> Int {
        let r = try XCTUnwrap(recipe.range(of: "\"plain-"))
        let rest = recipe[r.upperBound...]
        let num = rest.prefix { $0.isNumber }
        return try XCTUnwrap(Int(num))
    }

    func testVectorsVersion() throws {
        XCTAssertEqual(try loadVectors().version, 1)
    }

    func testX25519PublicFromPrivate() throws {
        let v = try loadVectors()
        XCTAssertFalse(v.x25519.isEmpty)
        for kp in v.x25519 {
            XCTAssertEqual(B64U.encode(try X25519.publicKey(fromPrivate: try d(kp.privateKey))), kp.publicKey)
        }
    }

    func testEnvelopeOpen() throws {
        let v = try loadVectors()
        XCTAssertFalse(v.envelope.isEmpty)
        for e in v.envelope {
            XCTAssertEqual(B64U.encode(try X25519.publicKey(fromPrivate: try d(e.recipientPrivateKey))), e.recipientPublicKey)
            let plain = try Envelope.open(try d(e.envelope), privateKey: try d(e.recipientPrivateKey))
            XCTAssertEqual(String(data: plain, encoding: .utf8), e.plaintextUtf8)
        }
    }

    func testEnvelopeSealReproducesBytes() throws {
        for e in try loadVectors().envelope {
            let sealed = try Envelope.seal(
                Data(e.plaintextUtf8.utf8),
                to: try d(e.recipientPublicKey),
                ephemeralPrivateKey: try d(e.ephemeralPrivateKey),
                nonce: try d(e.nonce)
            )
            XCTAssertEqual(B64U.encode(sealed), e.envelope)
        }
    }

    func testEnvelopeTamperFails() throws {
        let e = try XCTUnwrap(try loadVectors().envelope.last)
        var env = try d(e.envelope)
        env[env.count - 1] ^= 0x01
        XCTAssertThrowsError(try Envelope.open(env, privateKey: try d(e.recipientPrivateKey)))
        var badVersion = try d(e.envelope)
        badVersion[0] = 0x02
        XCTAssertThrowsError(try Envelope.open(badVersion, privateKey: try d(e.recipientPrivateKey)))
    }

    func testEnvelopeRandomRoundTrip() throws {
        let priv = X25519.generatePrivate()
        let pub = try X25519.publicKey(fromPrivate: priv)
        let msg = Data("{\"name\":\"Ana\"}".utf8)
        XCTAssertEqual(try Envelope.open(try Envelope.seal(msg, to: pub), privateKey: priv), msg)
        // Vínculo de dispositivos: sealedKey son los 32 bytes de la privada.
        let account = X25519.generatePrivate()
        XCTAssertEqual(try Envelope.open(try Envelope.seal(account, to: pub), privateKey: priv), account)
    }

    func testBlobDecrypt() throws {
        let v = try loadVectors()
        XCTAssertFalse(v.blob.isEmpty)
        for b in v.blob {
            let plain = try MCBlob.decrypt(try d(b.blob), fileKey: try d(b.fileKey))
            XCTAssertEqual(plain.count, b.plaintextSize)
            XCTAssertEqual(hex(Data(SHA256.hash(data: plain))), b.plaintextSha256)
            if let h = b.plaintextHex { XCTAssertEqual(hex(plain), h) }
            let expected = recipePlaintext(index: try recipeIndex(b.plaintextRecipe), size: b.plaintextSize)
            XCTAssertEqual(plain, expected)
        }
    }

    func testBlobEncryptReproducesBytes() throws {
        for b in try loadVectors().blob {
            let plain: Data
            if let h = b.plaintextHex, h.count == b.plaintextSize * 2 {
                plain = Data(stride(from: 0, to: h.count, by: 2).map {
                    UInt8(h[h.index(h.startIndex, offsetBy: $0)..<h.index(h.startIndex, offsetBy: $0 + 2)], radix: 16)!
                })
            } else {
                plain = recipePlaintext(index: try recipeIndex(b.plaintextRecipe), size: b.plaintextSize)
            }
            XCTAssertEqual(hex(Data(SHA256.hash(data: plain))), b.plaintextSha256)
            let blob = try MCBlob.encrypt(plain, fileKey: try d(b.fileKey), baseNonce: try d(b.baseNonce))
            XCTAssertEqual(B64U.encode(blob), b.blob)
        }
    }

    func testBlobFileDecrypt() throws {
        let dir = FileManager.default.temporaryDirectory
        for (i, b) in try loadVectors().blob.enumerated() {
            let src = dir.appendingPathComponent("vec-\(i).mcb1")
            let dst = dir.appendingPathComponent("vec-\(i).bin")
            try d(b.blob).write(to: src)
            try MCBlob.decryptFile(at: src, to: dst, fileKey: try d(b.fileKey))
            XCTAssertEqual(hex(Data(SHA256.hash(data: try Data(contentsOf: dst)))), b.plaintextSha256)
        }
    }

    func testBlobTruncationDetected() throws {
        let b = try XCTUnwrap(try loadVectors().blob.first { $0.plaintextSize > 65536 })
        let blob = try d(b.blob)
        // Quitar el último trozo entero: el penúltimo no valida como último.
        let cut = blob.prefix(16 + 65552)
        XCTAssertThrowsError(try MCBlob.decrypt(Data(cut), fileKey: try d(b.fileKey)))
    }

    func testB64U() {
        XCTAssertEqual(B64U.encode(Data([0xfb, 0xff])), "-_8")
        XCTAssertEqual(B64U.decode("-_8"), Data([0xfb, 0xff]))
        XCTAssertNil(B64U.decode("a"))
    }
}
