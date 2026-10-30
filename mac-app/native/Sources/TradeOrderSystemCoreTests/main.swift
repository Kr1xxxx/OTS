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

    try verify(AppVersion("v3.90")! > AppVersion("3.89")!, "3.90 must be newer than 3.89")
    try verify(AppVersion("3.100")! > AppVersion("3.99")!, "minor versions must compare numerically")
    try verify(AppVersion("3.89")! == AppVersion("3.89.0")!, "trailing zero must not count as newer")
    try verify(!(AppVersion("3.89")! > AppVersion("3.89")!), "same version must not be newer")
    try verify(AppVersion("3.89-beta") == nil, "suffixes must be rejected")
    try verify(AppVersion("") == nil && AppVersion("3..1") == nil, "malformed versions must be rejected")

    let updates = UpdatePolicy(owner: "Kr1xxxx", repository: "OTS")
    let goodURL = "https://github.com/Kr1xxxx/OTS/releases/download/v3.90/TradeOrderSystem-3.90-mac-arm64.zip"
    let digest = String(repeating: "ab", count: 32)
    let release: [String: Any] = [
        "tag_name": "v3.90",
        "assets": [
            ["name": "TradeOrderSystem-3.90-mac-x86_64.zip", "browser_download_url": goodURL.replacingOccurrences(of: "arm64", with: "x86_64")],
            ["name": "TradeOrderSystem-3.90-mac-arm64.zip", "browser_download_url": goodURL, "digest": "sha256:\(digest.uppercased())"]
        ]
    ]
    let selected = updates.selectAsset(fromRelease: release, architecture: "arm64")
    try verify(selected?.version == AppVersion("3.90"), "release version was not parsed")
    try verify(selected?.asset.downloadURL.absoluteString == goodURL, "wrong architecture asset was selected")
    try verify(selected?.asset.sha256 == digest, "GitHub digest was not normalized")
    try verify(updates.selectAsset(fromRelease: release, architecture: "ppc") == nil, "missing architecture must not fall back")
    var foreign = release
    foreign["assets"] = [["name": "TradeOrderSystem-3.90-mac-arm64.zip", "browser_download_url": "https://github.com/evil/OTS/releases/download/v3.90/TradeOrderSystem-3.90-mac-arm64.zip"]]
    try verify(updates.selectAsset(fromRelease: foreign, architecture: "arm64") == nil, "another repository's asset was trusted")
    try verify(!updates.isTrustedDownload(URL(string: "http://github.com/Kr1xxxx/OTS/releases/download/v1/a.zip")!), "plain HTTP download was trusted")
    try verify(UpdatePolicy.sha256(fromDigest: "\(digest)  TradeOrderSystem.zip") == digest, "shasum line was not parsed")
    try verify(UpdatePolicy.sha256(fromDigest: "sha256:1234") == nil, "short digest was accepted")
    try verify(UpdatePolicy.installBlocker(bundlePath: "/Applications/TradeOrderSystem.app", parentWritable: true) == nil, "/Applications install was blocked")
    try verify(UpdatePolicy.installBlocker(bundlePath: "/private/var/folders/x/AppTranslocation/y/d/TradeOrderSystem.app", parentWritable: true) != nil, "translocated copy was not blocked")
    try verify(UpdatePolicy.installBlocker(bundlePath: "/Volumes/OTS/TradeOrderSystem.app", parentWritable: false) != nil, "DMG copy was not blocked")

    print("Native runtime policy tests passed.")
} catch {
    FileHandle.standardError.write(Data("Native runtime policy test failed: \(error)\n".utf8))
    exit(1)
}
