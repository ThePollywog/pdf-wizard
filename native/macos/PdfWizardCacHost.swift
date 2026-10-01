// PDF Wizard CAC helper for macOS: a Chrome/Edge native messaging host that signs SHA-256 digests with
// the private keys on a smart card (CAC / PIV), through CryptoTokenKit and the keychain.
//
// The PIN is never seen here: macOS shows its own PIN prompt when the card's key is used.
// Only keys on hardware tokens are listed (kSecAttrAccessGroupToken).
//
// Protocol (native messaging: 4-byte little-endian length + UTF-8 JSON, both directions):
//   {"type":"status"}                                  → {"ok":true,"result":{"helper":true,"version":"1.0.0"}}
//   {"type":"list"}                                    → {"ok":true,"result":{"certificates":[{"id","label","der","chain":[…],"hardware":true}]}}
//   {"type":"sign","certId":"…","digest":"<b64>","hash":"sha256"} → {"ok":true,"result":{"signature":"<b64>","format":"pkcs1"|"ecdsa-der"}}
//   errors                                             → {"ok":false,"error":"…"}
//
// Build: swiftc -O -o pdfwizard-cac-host PdfWizardCacHost.swift   (see install.sh)
import CryptoKit
import Foundation
import Security

let version = "1.0.0"

// MARK: - native messaging I/O

func readExactly(_ n: Int) -> Data? {
    var data = Data()
    while data.count < n {
        let chunk = FileHandle.standardInput.readData(ofLength: n - data.count)
        if chunk.isEmpty { return nil }
        data.append(chunk)
    }
    return data
}

func readMessage() -> [String: Any]? {
    guard let header = readExactly(4) else { return nil }
    let len = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
    guard len > 0, len < 1 << 20, let body = readExactly(Int(len)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func send(_ obj: [String: Any]) {
    guard let body = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var len = UInt32(body.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &len, count: 4))
    FileHandle.standardOutput.write(body)
}

struct HelperError: Error { let message: String }

// MARK: - keychain

struct CardIdentity {
    let id: String
    let label: String
    let der: Data
    let identity: SecIdentity
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

func cardIdentities() -> [CardIdentity] {
    let query: [String: Any] = [
        kSecClass as String: kSecClassIdentity,
        kSecMatchLimit as String: kSecMatchLimitAll,
        kSecReturnRef as String: true,
        kSecAttrAccessGroup as String: kSecAttrAccessGroupToken,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let items = out as? [SecIdentity] else { return [] }
    var result: [CardIdentity] = []
    var seen = Set<String>()
    for identity in items {
        var cert: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &cert) == errSecSuccess, let cert else { continue }
        let der = SecCertificateCopyData(cert) as Data
        let id = hex(Data(SHA256.hash(data: der)))
        if seen.contains(id) { continue }
        seen.insert(id)
        let label = (SecCertificateCopySubjectSummary(cert) as String?) ?? "Certificate"
        result.append(CardIdentity(id: id, label: label, der: der, identity: identity))
    }
    return result
}

/// Issuing CA certificates the system can find for `der` (leaf excluded).
func chain(for der: Data) -> [Data] {
    guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { return [] }
    var trust: SecTrust?
    guard SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &trust) == errSecSuccess, let trust else { return [] }
    _ = SecTrustEvaluateWithError(trust, nil)
    guard let certs = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else { return [] }
    return certs.dropFirst().map { SecCertificateCopyData($0) as Data }
}

func sign(certId: String, digest: Data) throws -> (Data, String) {
    guard digest.count == 32 else { throw HelperError(message: "Expected a SHA-256 digest.") }
    guard let card = cardIdentities().first(where: { $0.id == certId }) else {
        throw HelperError(message: "The certificate isn’t available. Is the card still in the reader?")
    }
    var key: SecKey?
    guard SecIdentityCopyPrivateKey(card.identity, &key) == errSecSuccess, let key else {
        throw HelperError(message: "The card’s private key couldn’t be opened.")
    }
    let attrs = SecKeyCopyAttributes(key) as? [String: Any]
    let isEC = (attrs?[kSecAttrKeyType as String] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String)
    let algorithm: SecKeyAlgorithm = isEC ? .ecdsaSignatureDigestX962SHA256 : .rsaSignatureDigestPKCS1v15SHA256
    guard SecKeyIsAlgorithmSupported(key, .sign, algorithm) else { throw HelperError(message: "The card can’t make this kind of signature.") }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, algorithm, digest as CFData, &error) as Data? else {
        let e = error?.takeRetainedValue()
        let code = e.map { CFErrorGetCode($0) } ?? 0
        // -128 / errSecUserCanceled: the PIN prompt was cancelled.
        if code == -128 || code == Int(errSecUserCanceled) { throw HelperError(message: "Signing was cancelled.") }
        throw HelperError(message: "The card refused to sign\(e.map { ": \(CFErrorCopyDescription($0) as String)" } ?? ".")")
    }
    return (sig, isEC ? "ecdsa-der" : "pkcs1")
}

// MARK: - main loop

func handle(_ msg: [String: Any]) -> [String: Any] {
    do {
        switch msg["type"] as? String {
        case "status":
            return ["ok": true, "result": ["helper": true, "version": version]]
        case "list":
            let certs = cardIdentities().map { c -> [String: Any] in
                ["id": c.id, "label": c.label, "der": c.der.base64EncodedString(), "chain": chain(for: c.der).map { $0.base64EncodedString() }, "hardware": true]
            }
            return ["ok": true, "result": ["certificates": certs]]
        case "sign":
            guard let certId = msg["certId"] as? String, let b64 = msg["digest"] as? String, let digest = Data(base64Encoded: b64) else {
                throw HelperError(message: "Malformed signing request.")
            }
            if let hash = msg["hash"] as? String, hash != "sha256" { throw HelperError(message: "Only SHA-256 is supported.") }
            let (sig, format) = try sign(certId: certId, digest: digest)
            return ["ok": true, "result": ["signature": sig.base64EncodedString(), "format": format]]
        default:
            throw HelperError(message: "Unknown request.")
        }
    } catch let e as HelperError {
        return ["ok": false, "error": e.message]
    } catch {
        return ["ok": false, "error": "\(error)"]
    }
}

if CommandLine.arguments.contains("--list") {
    // Diagnostics: print the card certificates (no PIN needed).
    for c in cardIdentities() { print("\(c.label)\t\(c.id)\tchain: \(chain(for: c.der).count)") }
    exit(0)
}

while let msg = readMessage() {
    send(handle(msg))
}
