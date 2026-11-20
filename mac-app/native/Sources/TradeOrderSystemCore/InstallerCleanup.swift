import Foundation

/// Old OTS installers the user downloaded by hand (the dmg for a first install, a zip from the
/// release page) pile up in Downloads. The app keeps the files of the newest `keep` versions and
/// of the version that is running, and moves the rest to the Trash (the user asked, 2026-11-20).
/// Only names the release workflow publishes are matched, plus the " (1)" or "-2" a browser adds
/// to a second download of the same file; anything else in the folder is never touched.
public enum InstallerCleanup {
    public static let keepVersions = 3

    /// TradeOrderSystem-<version>-mac-<arch>[-lite].<dmg|zip>[.sha256]
    public static func version(ofInstaller name: String) -> AppVersion? {
        let pattern = #"^TradeOrderSystem-([0-9]+(?:\.[0-9]+){1,3})-mac-[A-Za-z0-9_]+(?:-lite)?(?: \([0-9]+\)|-[0-9]+)?\.(?:dmg|zip)(?:\.sha256)?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
              let range = Range(match.range(at: 1), in: name) else { return nil }
        return AppVersion(String(name[range]))
    }

    /// Names to move to the Trash: installers whose version is neither among the newest `keep`
    /// versions found nor the running one.
    public static func namesToRemove(_ names: [String], running: AppVersion?, keep: Int = keepVersions) -> [String] {
        let found: [(name: String, version: AppVersion)] = names.compactMap { name in
            guard let parsed = version(ofInstaller: name) else { return nil }
            return (name: name, version: parsed)
        }
        var newest: [AppVersion] = []
        for item in found.sorted(by: { $1.version < $0.version }) where !newest.contains(item.version) {
            if newest.count == keep { break }
            newest.append(item.version)
        }
        return found
            .filter { !newest.contains($0.version) && $0.version != running }
            .map { $0.name }
            .sorted()
    }
}
