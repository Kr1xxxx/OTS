import Foundation
import TradeOrderSystemCore

private struct VerificationFailure: Error, CustomStringConvertible {
    let description: String
}

private func verify(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw VerificationFailure(description: message) }
}

do {
    let identity = LocalServiceIdentity.random()
    try verify((49_152...65_535).contains(identity.port), "identity port is outside the ephemeral range")
    try verify(identity.apiToken.count == 64, "API token does not have 256 bits of UUID entropy")
    try verify(identity.instanceNonce.count == 32, "instance nonce does not have 128 bits of UUID entropy")
    try verify(identity.apiToken != identity.instanceNonce, "API token and instance nonce must differ")
    try verify(identity.apiToken.allSatisfy(\.isHexDigit), "API token is not hexadecimal")
    try verify(identity.instanceNonce.allSatisfy(\.isHexDigit), "instance nonce is not hexadecimal")

    let policy = LocalOriginPolicy(port: 51_234)
    try verify(policy.contains(URL(string: "http://127.0.0.1:51234/trade-order-system.html")!), "exact local origin was rejected")
    try verify(!policy.contains(URL(string: "http://localhost:51234/trade-order-system.html")!), "localhost alias must not be trusted")
    try verify(!policy.contains(URL(string: "http://127.0.0.1:51235/trade-order-system.html")!), "wrong local port was trusted")
    try verify(!policy.contains(URL(string: "https://127.0.0.1:51234/trade-order-system.html")!), "wrong local scheme was trusted")
    try verify(!policy.contains(URL(string: "http://127.0.0.1.evil.test:51234/")!), "lookalike host was trusted")
    try verify(policy.mayOpenExternally(URL(string: "https://www.dhl.com/track")!), "HTTPS external URL was rejected")
    try verify(!policy.mayOpenExternally(URL(string: "http://www.dhl.com/track")!), "HTTP external URL was accepted")
    try verify(!policy.mayOpenExternally(URL(fileURLWithPath: "/tmp/order.json")), "file URL was accepted")
    try verify(!policy.mayOpenExternally(URL(string: "javascript:alert(1)")!), "JavaScript URL was accepted")

    print("Native runtime policy tests passed.")
} catch {
    FileHandle.standardError.write(Data("Native runtime policy test failed: \(error)\n".utf8))
    exit(1)
}
