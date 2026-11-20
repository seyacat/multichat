import CryptoKit
import Foundation

// Cifrado v1 de Multichat (docs/crypto.md). Código compartido entre la app y la extensión.

enum CryptoError: Error, Equatable {
    case invalidEnvelope
    case invalidKey
    case invalidBlob
    case truncatedBlob
}

/// base64url sin relleno.
enum B64U {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ string: String) -> Data? {
        var s = string.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem == 1 { return nil }
        if rem > 0 { s += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: s)
    }
}

enum X25519 {
    static func generatePrivate() -> Data {
        Curve25519.KeyAgreement.PrivateKey().rawRepresentation
    }

    static func publicKey(fromPrivate raw: Data) throws -> Data {
        guard raw.count == 32 else { throw CryptoError.invalidKey }
        return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw).publicKey.rawRepresentation
    }
}

/// Sobre sellado: 0x01 ‖ e.pub(32) ‖ nonce(12) ‖ ct ‖ tag(16).
enum Envelope {
    static let version: UInt8 = 0x01
    static let info = Data("multichat/v1/envelope".utf8)
    static let headerSize = 1 + 32 + 12
    static let tagSize = 16

    private static func deriveKey(_ shared: SharedSecret, ephPub: Data, recipientPub: Data) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: ephPub + recipientPub,
            sharedInfo: info,
            outputByteCount: 32
        )
    }

    static func seal(_ plaintext: Data, to recipientPub: Data, ephemeralPrivateKey: Data? = nil, nonce: Data? = nil) throws -> Data {
        guard recipientPub.count == 32 else { throw CryptoError.invalidKey }
        let eph: Curve25519.KeyAgreement.PrivateKey
        if let raw = ephemeralPrivateKey {
            eph = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
        } else {
            eph = Curve25519.KeyAgreement.PrivateKey()
        }
        let rpub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: recipientPub)
        let ephPub = eph.publicKey.rawRepresentation
        let key = deriveKey(try eph.sharedSecretFromKeyAgreement(with: rpub), ephPub: ephPub, recipientPub: recipientPub)
        let n = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: key, nonce: n)
        var out = Data([version])
        out.append(ephPub)
        out.append(n.withUnsafeBytes { Data($0) })
        out.append(box.ciphertext)
        out.append(box.tag)
        return out
    }

    static func open(_ envelope: Data, privateKey: Data) throws -> Data {
        let env = Data(envelope)
        guard env.count >= headerSize + tagSize, env[0] == version else { throw CryptoError.invalidEnvelope }
        guard privateKey.count == 32 else { throw CryptoError.invalidKey }
        let ephPub = env.subdata(in: 1..<33)
        let nonce = env.subdata(in: 33..<45)
        let ct = env.subdata(in: 45..<(env.count - tagSize))
        let tag = env.subdata(in: (env.count - tagSize)..<env.count)
        let priv = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        let shared = try priv.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: ephPub))
        let key = deriveKey(shared, ephPub: ephPub, recipientPub: priv.publicKey.rawRepresentation)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct, tag: tag)
        return try AES.GCM.open(box, using: key)
    }

    // Atajos en b64u + JSON.

    static func sealJSON<T: Encodable>(_ value: T, toB64U recipientPub: String) throws -> String {
        guard let pub = B64U.decode(recipientPub) else { throw CryptoError.invalidKey }
        let data = try JSONEncoder().encode(value)
        return B64U.encode(try seal(data, to: pub))
    }

    static func openJSON<T: Decodable>(_ type: T.Type, _ envelopeB64U: String, privateKey: Data) throws -> T {
        guard let env = B64U.decode(envelopeB64U) else { throw CryptoError.invalidEnvelope }
        return try JSONDecoder().decode(T.self, from: open(env, privateKey: privateKey))
    }
}

/// Blobs de media MCB1: "MCB1" ‖ baseNonce(12) ‖ trozos AES-GCM de 64 KiB.
enum MCBlob {
    static let magic = Data("MCB1".utf8)
    static let chunkSize = 65536
    static let tagSize = 16
    static let encChunkSize = chunkSize + tagSize
    static let headerSize = 16

    static func chunkNonce(_ base: Data, _ index: UInt32) throws -> AES.GCM.Nonce {
        var n = [UInt8](base)
        guard n.count == 12 else { throw CryptoError.invalidBlob }
        let tail = (UInt32(n[8]) << 24 | UInt32(n[9]) << 16 | UInt32(n[10]) << 8 | UInt32(n[11])) ^ index
        n[8] = UInt8(truncatingIfNeeded: tail >> 24)
        n[9] = UInt8(truncatingIfNeeded: tail >> 16)
        n[10] = UInt8(truncatingIfNeeded: tail >> 8)
        n[11] = UInt8(truncatingIfNeeded: tail)
        return try AES.GCM.Nonce(data: n)
    }

    private static func encChunk(_ key: SymmetricKey, _ base: Data, _ i: UInt32, _ data: Data, last: Bool) throws -> Data {
        let box = try AES.GCM.seal(data, using: key, nonce: chunkNonce(base, i), authenticating: Data([last ? 1 : 0]))
        return box.ciphertext + box.tag
    }

    private static func decChunk(_ key: SymmetricKey, _ base: Data, _ i: UInt32, _ data: Data, last: Bool) throws -> Data {
        guard data.count >= tagSize else { throw CryptoError.truncatedBlob }
        let d = Data(data)
        let box = try AES.GCM.SealedBox(
            nonce: chunkNonce(base, i),
            ciphertext: d.subdata(in: 0..<(d.count - tagSize)),
            tag: d.subdata(in: (d.count - tagSize)..<d.count)
        )
        return try AES.GCM.open(box, using: key, authenticating: Data([last ? 1 : 0]))
    }

    static func encrypt(_ plain: Data, fileKey: Data, baseNonce: Data? = nil) throws -> Data {
        guard fileKey.count == 32 else { throw CryptoError.invalidKey }
        let key = SymmetricKey(data: fileKey)
        let base = baseNonce ?? Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let p = Data(plain)
        var out = magic + base
        var i: UInt32 = 0
        var off = 0
        repeat {
            let end = min(off + chunkSize, p.count)
            out.append(try encChunk(key, base, i, p.subdata(in: off..<end), last: end >= p.count))
            i += 1
            off = end
        } while off < p.count
        return out
    }

    static func decrypt(_ blob: Data, fileKey: Data) throws -> Data {
        guard fileKey.count == 32 else { throw CryptoError.invalidKey }
        let b = Data(blob)
        guard b.count >= headerSize + tagSize, b.prefix(4) == magic else { throw CryptoError.invalidBlob }
        let key = SymmetricKey(data: fileKey)
        let base = b.subdata(in: 4..<16)
        let body = b.subdata(in: 16..<b.count)
        var out = Data()
        out.reserveCapacity(body.count)
        var i: UInt32 = 0
        var off = 0
        while true {
            let end = min(off + encChunkSize, body.count)
            let last = end >= body.count
            out.append(try decChunk(key, base, i, body.subdata(in: off..<end), last: last))
            if last { break }
            i += 1
            off = end
        }
        return out
    }

    /// Descifra un archivo MCB1 a otro archivo sin cargarlo entero en memoria.
    static func decryptFile(at src: URL, to dst: URL, fileKey: Data) throws {
        guard fileKey.count == 32 else { throw CryptoError.invalidKey }
        let key = SymmetricKey(data: fileKey)
        let total = (try FileManager.default.attributesOfItem(atPath: src.path)[.size] as? NSNumber)?.intValue ?? 0
        guard total >= headerSize + tagSize else { throw CryptoError.invalidBlob }
        let input = try FileHandle(forReadingFrom: src)
        defer { try? input.close() }
        let header = try input.read(upToCount: headerSize) ?? Data()
        guard header.count == headerSize, header.prefix(4) == magic else { throw CryptoError.invalidBlob }
        let base = header.subdata(in: 4..<16)
        FileManager.default.createFile(atPath: dst.path, contents: nil)
        let output = try FileHandle(forWritingTo: dst)
        defer { try? output.close() }
        var remaining = total - headerSize
        var i: UInt32 = 0
        while true {
            let n = min(encChunkSize, remaining)
            let chunk = try input.read(upToCount: n) ?? Data()
            guard chunk.count == n else { throw CryptoError.truncatedBlob }
            remaining -= n
            let last = remaining == 0
            try output.write(contentsOf: try decChunk(key, base, i, chunk, last: last))
            if last { break }
            i += 1
        }
    }
}
