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
