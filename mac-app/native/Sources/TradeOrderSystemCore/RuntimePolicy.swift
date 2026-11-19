import CryptoKit
import Foundation

public struct LocalServiceIdentity: Equatable, Sendable {
    public let port: Int
    public let apiToken: String
    public let instanceNonce: String

    public init(port: Int, apiToken: String, instanceNonce: String) {
        self.port = port
        self.apiToken = apiToken
        self.instanceNonce = instanceNonce
    }

    public static let portRange = 49_152...65_535

    public static func random() -> LocalServiceIdentity {
        LocalServiceIdentity(
            port: Int.random(in: portRange),
            apiToken: randomHexIdentifier() + randomHexIdentifier(),
            instanceNonce: randomHexIdentifier()
        )
    }

    /// Reuses the port of the last healthy launch when it is a valid ephemeral port. The page's
    /// origin includes the port, so a new port every launch wiped its localStorage (theme, accent,
    /// notification read state). Token and nonce stay fresh on every launch.
    public static func random(preferredPort: Int?) -> LocalServiceIdentity {
        let fresh = random()
        guard let preferredPort, portRange.contains(preferredPort) else { return fresh }
        return LocalServiceIdentity(port: preferredPort, apiToken: fresh.apiToken, instanceNonce: fresh.instanceNonce)
    }

    private static func randomHexIdentifier() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

/// How the host recognises the server it started without handing the API token to whatever listens on
/// the port: it sends a fresh challenge to /api/health without the token, and only a process that holds
/// the token can answer with HMAC-SHA256(token, "ots-health-v1:<nonce>:<challenge>") (server: request-guard.js).
public enum HealthProof {
    public static func newChallenge() -> String {
        (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static func expected(apiToken: String, instanceNonce: String, challenge: String) -> String {
        let key = SymmetricKey(data: Data(apiToken.utf8))
        let message = Data("ots-health-v1:\(instanceNonce):\(challenge)".utf8)
        return HMAC<SHA256>.authenticationCode(for: message, using: key).map { String(format: "%02x", $0) }.joined()
    }

    public static func matches(_ proof: String?, apiToken: String, instanceNonce: String, challenge: String) -> Bool {
        guard let proof else { return false }
        let wanted = Array(expected(apiToken: apiToken, instanceNonce: instanceNonce, challenge: challenge).utf8)
        let given = Array(proof.utf8)
        guard given.count == wanted.count else { return false }
        return zip(given, wanted).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

public struct LocalOriginPolicy: Equatable, Sendable {
    public let port: Int

    public init(port: Int) {
        self.port = port
    }

    public func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http"
            && url.host?.lowercased() == "127.0.0.1"
            && url.port == port
    }

    public func mayOpenExternally(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host != nil
    }
}
