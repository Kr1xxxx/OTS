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

    public static func random() -> LocalServiceIdentity {
        LocalServiceIdentity(
            port: Int.random(in: 49_152...65_535),
            apiToken: randomHexIdentifier() + randomHexIdentifier(),
            instanceNonce: randomHexIdentifier()
        )
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
