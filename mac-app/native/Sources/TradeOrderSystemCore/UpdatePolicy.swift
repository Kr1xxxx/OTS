import Foundation

/// Numeric dotted version ("3.89", "v3.90", "3.90.1"). Components compare as integers,
/// so releases must bump the minor number monotonically (3.89 → 3.90, never 3.9).
public struct AppVersion: Comparable, CustomStringConvertible, Sendable {
    public let components: [Int]

    public init?(_ raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.first == "v" || text.first == "V" { text.removeFirst() }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 4 else { return nil }
        var values: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber),
                  let value = Int(part) else { return nil }
            values.append(value)
        }
        components = values
    }

    public var description: String {
        components.map(String.init).joined(separator: ".")
    }

    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let count = max(lhs.components.count, rhs.components.count)
        for index in 0..<count {
            let left = index < lhs.components.count ? lhs.components[index] : 0
            let right = index < rhs.components.count ? rhs.components[index] : 0
            if left != right { return left < right }
        }
        return false
    }

    public static func == (lhs: AppVersion, rhs: AppVersion) -> Bool {
        !(lhs < rhs) && !(rhs < lhs)
    }
}

public struct UpdateAsset: Equatable, Sendable {
    public let name: String
    public let downloadURL: URL
    public let sha256: String?

    public init(name: String, downloadURL: URL, sha256: String?) {
        self.name = name
        self.downloadURL = downloadURL
        self.sha256 = sha256
    }
}

public struct UpdatePolicy: Sendable {
    public let owner: String
    public let repository: String

    public init(owner: String, repository: String) {
        self.owner = owner
        self.repository = repository
    }

    public var latestReleaseURL: URL {
        URL(string: "https://api.github.com/repos/\(owner)/\(repository)/releases/latest")!
    }

    /// Release workflow publishes TradeOrderSystem-<version>-mac-<arch>.zip.
    public func assetName(version: AppVersion, architecture: String) -> String {
        "TradeOrderSystem-\(version)-mac-\(architecture).zip"
    }

    /// Only this repository's own release downloads are accepted; GitHub then
    /// redirects to its asset CDN over HTTPS.
    public func isTrustedDownload(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "github.com"
            && url.port == nil
            && url.path.hasPrefix("/\(owner)/\(repository)/releases/download/")
    }

    /// Picks the archive for this Mac from a GitHub release JSON object.
    /// The checksum comes from GitHub's asset digest ("sha256:<hex>") when present.
    public func selectAsset(fromRelease release: [String: Any], architecture: String) -> (version: AppVersion, asset: UpdateAsset)? {
        guard let tag = release["tag_name"] as? String,
              let version = AppVersion(tag),
              let assets = release["assets"] as? [[String: Any]] else { return nil }
        let wanted = assetName(version: version, architecture: architecture)
        guard let entry = assets.first(where: { $0["name"] as? String == wanted }),
              let rawURL = entry["browser_download_url"] as? String,
              let url = URL(string: rawURL),
              isTrustedDownload(url) else { return nil }
        return (version, UpdateAsset(name: wanted, downloadURL: url, sha256: Self.sha256(fromDigest: entry["digest"] as? String)))
    }

    /// Accepts "sha256:<64 hex>" (GitHub digest) or a `shasum -a 256` line.
    public static func sha256(fromDigest raw: String?) -> String? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if text.lowercased().hasPrefix("sha256:") { text.removeFirst("sha256:".count) }
        let hex = String(text.prefix(while: { !$0.isWhitespace })).lowercased()
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return nil }
        return hex
    }

    /// The running copy can only be replaced in place from a real, writable location.
    public static func installBlocker(bundlePath: String, parentWritable: Bool) -> String? {
        if bundlePath.contains("/AppTranslocation/") {
            return "应用正在从“下载”等临时位置运行。请先把它拖到“应用程序”文件夹，再从那里打开后更新。"
        }
        if bundlePath.hasPrefix("/Volumes/") {
            return "应用正在从安装盘（DMG）里运行。请先把它拖到“应用程序”文件夹，再从那里打开后更新。"
        }
        if !parentWritable {
            return "没有权限替换当前应用所在的文件夹。请把应用放到“应用程序”文件夹，或用管理员账户运行后再更新。"
        }
        return nil
    }
}
