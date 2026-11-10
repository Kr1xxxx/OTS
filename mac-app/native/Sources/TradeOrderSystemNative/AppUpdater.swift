import Cocoa
import CryptoKit
import Foundation
import TradeOrderSystemCore

/// Bytes so far, archive size and recent speed; the page shows them in the button's tooltip
/// and warns once when the download will take minutes.
struct DownloadStats: Sendable {
    let received: Int64
    let total: Int64
    let bytesPerSecond: Double
}

/// Checks GitHub Releases, downloads the archive for this Mac, verifies it, then hands
/// a detached installer script the swap: wait for this process to quit, replace the
/// bundle in place, relaunch. User data lives in Application Support, not the bundle.
/// Progress shown on the sidebar 更新 button; the page renders it, no native dialogs.
enum UpdateStatus {
    case checking
    case latest(String)
    case available(String)
    case downloading(String, Double, DownloadStats?)
    case verifying
    case saving
    case restarting
    case failed(String)

    var payload: [String: Any] {
        switch self {
        case .checking: return ["state": "checking"]
        case .latest(let version): return ["state": "latest", "version": version]
        case .available(let version): return ["state": "available", "version": version]
        case .downloading(let version, let progress, let stats):
            var payload: [String: Any] = ["state": "downloading", "version": version, "progress": progress]
            if let stats {
                payload["received"] = stats.received
                payload["total"] = stats.total
                payload["speed"] = Int(stats.bytesPerSecond.rounded())
            }
            return payload
        case .verifying: return ["state": "verifying"]
        case .saving: return ["state": "saving"]
        case .restarting: return ["state": "restarting"]
        case .failed(let message): return ["state": "error", "message": message]
        }
    }
}

/// Checks GitHub Releases, downloads the archive for this Mac, verifies it, then hands
/// a detached installer script the swap: wait for this process to quit, replace the
/// bundle in place, relaunch, delete the download. User data lives in Application Support.
@MainActor
final class AppUpdater {
    private let policy = UpdatePolicy(owner: "Kr1xxxx", repository: "OTS")
    private let prepareToQuit: @MainActor (@escaping @MainActor (String?) -> Void) -> Void
    private let quit: @MainActor () -> Void
    private let report: @MainActor (UpdateStatus) -> Void
    private let confirmInstall: @MainActor (String, String) async -> Bool
    private let unsavedFormsBlocker: @MainActor () async -> String?
    private var busy = false
    /// A click while a check is already running is answered once that check ends, not dropped.
    private var pendingUserCheck = false
    /// Newest version seen; re-sent to the page after every load (a reload used to lose the 有更新 mark).
    private var lastAvailable: String?
    /// A version that failed to start and was rolled back is not offered again during this run.
    private var skippedVersion: AppVersion?
    private var lastCompletedCheck: Date?
    /// Automatic checks run at most this often; a failed one is retried by the next scheduled tick.
    static let automaticCheckInterval: TimeInterval = 6 * 3600
    /// Download (~2 MB, or ~40 MB when the Node runtime changed) + unpacked copy (~120 MB) + the old app kept until the new one starts.
    private static let requiredFreeBytes: Int64 = 400_000_000
    private static let stagingDefaultsKey = "PendingUpdateStaging"

    /// prepareToQuit flushes pending saves and backs up the database; it hands back nil when
    /// it is safe to quit, otherwise the reason the update has to stop.
    init(prepareToQuit: @escaping @MainActor (@escaping @MainActor (String?) -> Void) -> Void,
         quit: @escaping @MainActor () -> Void,
         report: @escaping @MainActor (UpdateStatus) -> Void,
         confirmInstall: @escaping @MainActor (String, String) async -> Bool,
         unsavedFormsBlocker: @escaping @MainActor () async -> String?) {
        self.prepareToQuit = prepareToQuit
        self.quit = quit
        self.report = report
        self.confirmInstall = confirmInstall
        self.unsavedFormsBlocker = unsavedFormsBlocker
    }

    /// Where the app keeps its data; the installer script and the new version meet here.
    nonisolated static var supportDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["TRADE_APP_DATA_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: custom, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/TradeOrderSystem", isDirectory: true)
    }

    /// Called once at launch: removes a download left behind when the app quit mid-download.
    /// A folder that already holds the installer script belongs to a running install; it is left alone.
    func cleanupInterruptedDownload() {
        guard let path = UserDefaults.standard.string(forKey: Self.stagingDefaultsKey) else { return }
        UserDefaults.standard.removeObject(forKey: Self.stagingDefaultsKey)
        let staging = URL(fileURLWithPath: path, isDirectory: true)
        guard !FileManager.default.fileExists(atPath: staging.appendingPathComponent("install-update.sh").path) else { return }
        try? FileManager.default.removeItem(at: staging)
    }

    /// Called after every page load:
    /// - the first load after an update tells the installer script the new version works;
    /// - a rollback by the script is explained once, and that version is not offered again this run;
    /// - a known newer version is shown on the button again.
    func pageDidLoad() {
        let support = Self.supportDirectory
        let manager = FileManager.default
        if let current = currentVersion {
            let pending = support.appendingPathComponent("update-pending-\(current)")
            if manager.fileExists(atPath: pending.path) {
                try? Data().write(to: support.appendingPathComponent("update-ok-\(current)"))
                try? manager.removeItem(at: pending)
            }
        }
        let rolledBack = support.appendingPathComponent("update-rolled-back")
        if let text = try? String(contentsOf: rolledBack, encoding: .utf8) {
            try? manager.removeItem(at: rolledBack)
            let lines = text.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespaces) }
            let failed = lines.count > 0 ? lines[0] : ""
            let restored = lines.count > 1 ? lines[1] : ""
            let stage = lines.count > 2 ? lines[2] : ""
            if let version = AppVersion(failed) { skippedVersion = version }
            if lastAvailable == failed { lastAvailable = nil }
            let what = stage == "install" ? "没能装进“应用程序”文件夹" : "没能正常启动"
            report(.failed("新版本 V\(failed) \(what)，已自动恢复到 V\(restored)。这次运行期间不再提示这个版本；详细记录在 ~/Library/Logs/TradeOrderSystem-update.log。"))
            return
        }
        if !busy, let lastAvailable { report(.available(lastAvailable)) }
    }

    private var currentVersion: AppVersion? {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String).flatMap(AppVersion.init)
    }

    private static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    /// userInitiated: a click (button or menu) asks before installing; automatic checks only flag
    /// the button, and run at most every `automaticCheckInterval` unless the last one failed.
    func checkForUpdates(userInitiated: Bool) {
        guard !busy else {
            if userInitiated { pendingUserCheck = true }
            return
        }
        if !userInitiated, let last = lastCompletedCheck,
           Date().timeIntervalSince(last) < Self.automaticCheckInterval {
            return
        }
        busy = true
        if userInitiated { report(.checking) }
        Task { @MainActor in
            var installing = false
            defer { if !installing { self.finishCheck() } }
            do {
                guard let current = currentVersion else { throw UpdateError.message("无法读取当前版本号。") }
                let found = try await latestRelease(current: current)
                let latest = found.version
                lastCompletedCheck = Date()

                guard latest > current else {
                    lastAvailable = nil
                    if userInitiated { report(.latest("\(current)")) }
                    return
                }
                guard let asset = found.asset else {
                    throw UpdateError.message("V\(latest) 没有适用于这台 Mac（\(Self.architecture)）的安装包。")
                }
                guard userInitiated else {
                    if latest != skippedVersion {
                        lastAvailable = "\(latest)"
                        report(.available("\(latest)"))
                    }
                    return
                }
                lastAvailable = "\(latest)"
                try preflightInstallLocation()
                // Unsaved forms stop the update before anything is downloaded, not after.
                if let blocker = await unsavedFormsBlocker() { throw UpdateError.message(blocker) }
                guard await confirmInstall("\(latest)", found.notes) else {
                    report(.available("\(latest)"))
                    return
                }
                try checkFreeSpace()
                installing = true
                await install(asset, lite: found.lite, version: latest)
            } catch {
                if userInitiated { report(.failed(error.localizedDescription)) }
            }
        }
    }

    private func finishCheck() {
        busy = false
        if pendingUserCheck {
            pendingUserCheck = false
            checkForUpdates(userInitiated: true)
        }
    }

    private func checkFreeSpace() throws {
        let folder = Bundle.main.bundleURL.resolvingSymlinksInPath().deletingLastPathComponent()
        guard let values = try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
              let free = values.volumeAvailableCapacityForImportantUsage else { return }
        if free < Self.requiredFreeBytes {
            throw UpdateError.message("磁盘空间不足：更新需要约 \(Self.requiredFreeBytes / 1_000_000) MB，现在只剩 \(max(0, free) / 1_000_000) MB。请清理后再试。")
        }
    }

    private func userAgent(_ current: AppVersion) -> String { "TradeOrderSystem/\(current)" }

    /// Version checks skip the system proxy/VPN: a proxy exit IP is shared by many people,
    /// so GitHub's anonymous API quota (60 per hour per IP) is often already spent there.
    /// Short timeout, because if direct access fails we still go through the proxy.
    private static let directSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [
            "HTTPEnable": 0,
            "HTTPSEnable": 0,
            "SOCKSEnable": 0,
            "ProxyAutoConfigEnable": 0,
            "ProxyAutoDiscoveryEnable": 0
        ]
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 15
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    /// Direct first, then the system proxy as configured.
    private static var checkSessions: [URLSession] { [directSession, .shared] }

    /// API first (it carries asset digests), direct then via proxy. If every API attempt is
    /// refused or unreachable, read the version from the public release page, which has no quota.
    private func latestRelease(current: AppVersion) async throws -> (version: AppVersion, asset: UpdateAsset?, lite: UpdateAsset?, notes: String) {
        var request = URLRequest(url: policy.latestReleaseURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue(userAgent(current), forHTTPHeaderField: "User-Agent")
        var status = 0
        for session in Self.checkSessions {
            do {
                let (data, response) = try await session.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if code == 404 { throw UpdateError.message("还没有发布任何版本。") }
                if (200...299).contains(code) {
                    guard let release = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let tag = release["tag_name"] as? String,
                          let latest = AppVersion(tag) else { throw UpdateError.message("无法读取最新版本信息。") }
                    let notes = release["body"] as? String ?? ""
                    return (latest, policy.selectAsset(fromRelease: release, architecture: Self.architecture)?.asset,
                            policy.selectLiteAsset(fromRelease: release, architecture: Self.architecture), notes)
                }
                status = code
            } catch let error as UpdateError {
                throw error
            } catch {
                // Unreachable this way (or unreadable reply): try the next route.
            }
        }
        for session in Self.checkSessions {
            if let fallback = try? await latestFromReleasePage(current: current, session: session) {
                return (fallback.version, fallback.asset,
                        policy.liteAsset(besides: fallback.asset, version: fallback.version, architecture: Self.architecture), "")
            }
        }
        throw UpdateError.message(status == 0 ? "连不上 GitHub，请检查网络后再试。" : UpdatePolicy.checkFailureMessage(status: status))
    }

    private func latestFromReleasePage(current: AppVersion, session: URLSession) async throws -> (version: AppVersion, asset: UpdateAsset) {
        var request = URLRequest(url: policy.latestReleasePageURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "HEAD"
        request.setValue(userAgent(current), forHTTPHeaderField: "User-Agent")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let finalURL = http.url,
              let found = policy.releaseFromPage(finalURL, architecture: Self.architecture) else {
            throw UpdateError.message("无法读取最新版本信息。")
        }
        return found
    }

    private func preflightInstallLocation() throws {
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let parent = bundle.deletingLastPathComponent().path
        if let blocker = UpdatePolicy.installBlocker(
            bundlePath: bundle.path,
            parentWritable: FileManager.default.isWritableFile(atPath: parent)
        ) {
            throw UpdateError.message(blocker)
        }
    }

    /// The small archive (app without its Node runtime, ~2 MB) is tried first and the running
    /// app's own runtime is copied in; the full ~39 MB archive is only fetched when that runtime
    /// differs from the new one or anything about the small route fails.
    private func install(_ asset: UpdateAsset, lite: UpdateAsset?, version: AppVersion) async {
        let label = "\(version)"
        report(.downloading(label, 0, nil))
        var staging: URL?
        do {
            let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
            // Same volume as the installed app, so the final swap is a rename.
            let workDir = try FileManager.default.url(
                for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: bundle, create: true
            )
            staging = workDir
            // Recorded so the next launch can remove a half download if the app quits now.
            UserDefaults.standard.set(workDir.path, forKey: Self.stagingDefaultsKey)
            var assembled: URL?
            if let lite { assembled = await prepareFromLite(lite, label: label, workDir: workDir) }
            let newApp: URL
            if let assembled {
                newApp = assembled
            } else {
                report(.downloading(label, 0, nil))
                let archive = workDir.appendingPathComponent(asset.name)
                try await download(asset, to: archive, label: label)
                report(.verifying)
                let expected = try await expectedChecksum(for: asset)
                newApp = try await Task.detached(priority: .userInitiated) {
                    try AppUpdater.verifyAndExtract(archive: archive, into: workDir, sha256: expected, nodeRuntime: nil)
                }.value
            }
            try Self.checkBundle(newApp, version: version, bundleIdentifier: Bundle.main.bundleIdentifier)

            report(.saving)
            let previous = currentVersion.map { "\($0)" } ?? ""
            prepareToQuit { [weak self] blocker in
                guard let self else { return }
                if let blocker {
                    self.fail(blocker, cleaning: workDir)
                    return
                }
                do {
                    // The script keeps the old app until the new one reports a loaded page, then
                    // deletes workDir; otherwise it puts the old app back and reopens it.
                    try AppUpdater.launchInstaller(newApp: newApp, target: bundle, staging: workDir,
                                                   newVersion: label, previousVersion: previous)
                    UserDefaults.standard.removeObject(forKey: Self.stagingDefaultsKey)
                    self.report(.restarting)
                    self.quit()
                } catch {
                    self.fail(error.localizedDescription, cleaning: workDir)
                }
            }
        } catch {
            fail(error.localizedDescription, cleaning: staging)
        }
    }

    private func download(_ asset: UpdateAsset, to archive: URL, label: String) async throws {
        let transfer = ProgressDownload(destination: archive) { [weak self] progress, stats in
            Task { @MainActor in self?.report(.downloading(label, progress, stats)) }
        }
        try await transfer.run(asset.downloadURL)
    }

    /// nil means "use the full archive": no small archive in this release, a different Node
    /// runtime, or any download/verification problem on this route.
    private func prepareFromLite(_ lite: UpdateAsset, label: String, workDir: URL) async -> URL? {
        guard let runtime = Bundle.main.resourceURL?.appendingPathComponent("node-runtime"),
              FileManager.default.isReadableFile(atPath: runtime.path) else { return nil }
        let liteDir = workDir.appendingPathComponent("lite", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: liteDir, withIntermediateDirectories: true)
            let archive = liteDir.appendingPathComponent(lite.name)
            try await download(lite, to: archive, label: label)
            report(.verifying)
            let expected = try await expectedChecksum(for: lite)
            return try await Task.detached(priority: .userInitiated) {
                try AppUpdater.verifyAndExtract(archive: archive, into: liteDir, sha256: expected, nodeRuntime: runtime)
            }.value
        } catch {
            NSLog("OTS update: small package not usable (%@); downloading the full package", error.localizedDescription)
            try? FileManager.default.removeItem(at: liteDir)
            return nil
        }
    }

    private func fail(_ message: String, cleaning staging: URL?) {
        if let staging { try? FileManager.default.removeItem(at: staging) }
        UserDefaults.standard.removeObject(forKey: Self.stagingDefaultsKey)
        busy = false
        pendingUserCheck = false
        report(.failed(message))
    }

    private func expectedChecksum(for asset: UpdateAsset) async throws -> String {
        if let sha = asset.sha256 { return sha }
        // Older GitHub responses lack `digest`; the workflow also uploads <asset>.sha256.
        let sidecar = URL(string: asset.downloadURL.absoluteString + ".sha256")!
        var request = URLRequest(url: sidecar, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.setValue("TradeOrderSystem", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200,
              let sha = UpdatePolicy.sha256(fromDigest: String(data: data, encoding: .utf8)) else {
            throw UpdateError.message("找不到安装包的校验值，已取消更新。")
        }
        return sha
    }

    nonisolated private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// With `nodeRuntime`, the archive is the small one: the running app's runtime goes into
    /// the new bundle only if its SHA-256 equals the new Info.plist's, and the bundle seal
    /// (codesign --verify --deep --strict) then covers it like any other file.
    nonisolated private static func verifyAndExtract(archive: URL, into staging: URL, sha256 expected: String, nodeRuntime: URL?) throws -> URL {
        let actual = try sha256(of: archive)
        guard actual == expected else { throw UpdateError.message("安装包校验失败（文件可能不完整），已取消更新。") }

        let unpacked = staging.appendingPathComponent("unpacked", isDirectory: true)
        try? FileManager.default.removeItem(at: unpacked)
        try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
        try run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path], failure: "解压安装包失败。")
        let app = unpacked.appendingPathComponent("TradeOrderSystem.app", isDirectory: true)
        guard FileManager.default.fileExists(atPath: app.path) else { throw UpdateError.message("安装包里没有找到应用。") }
        if let nodeRuntime {
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
            guard let wanted = UpdatePolicy.sha256(fromDigest: info?[UpdatePolicy.nodeRuntimeDigestKey] as? String) else {
                throw UpdateError.message("小更新包没有标明运行环境。")
            }
            guard try sha256(of: nodeRuntime) == wanted else {
                throw UpdateError.message("新版本换了运行环境，需要下载完整安装包。")
            }
            let target = app.appendingPathComponent("Contents/Resources/node-runtime")
            try run("/usr/bin/ditto", ["--noextattr", "--norsrc", nodeRuntime.path, target.path], failure: "复制运行环境失败。")
        }
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path], failure: "新版本签名校验失败，已取消更新。")
        return app
    }

    private static func checkBundle(_ app: URL, version: AppVersion, bundleIdentifier: String?) throws {
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let identifier = info["CFBundleIdentifier"] as? String,
              identifier == bundleIdentifier,
              let raw = info["CFBundleShortVersionString"] as? String,
              AppVersion(raw) == version else {
            throw UpdateError.message("安装包信息与发布版本不一致，已取消更新。")
        }
        let localSettings = supportDirectory.appendingPathComponent("feishu-settings.json")
        if let blocker = UpdatePolicy.notificationConfigBlocker(
            localConfigurationExists: FileManager.default.fileExists(atPath: localSettings.path),
            incomingConfigurationVersion: (info["OTSFeishuSettingsVersion"] as? NSNumber)?.intValue ?? 0
        ) {
            throw UpdateError.message(blocker)
        }
    }

    /// The tool's own error text is added to the message ("No space left on device" used to
    /// surface only as 解压安装包失败).
    nonisolated private static func run(_ tool: String, _ arguments: [String], failure: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let errorPipe = Pipe()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errorPipe
        try process.run()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = (String(data: errorData, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !detail.isEmpty else { throw UpdateError.message(failure) }
            let hint = detail.lowercased().contains("no space") ? "磁盘空间不足。" : ""
            throw UpdateError.message("\(failure)\(hint)（\(String(detail.suffix(200)))）")
        }
    }

    /// Paths reach the script as arguments, never interpolated into its text.
    private static func launchInstaller(newApp: URL, target: URL, staging: URL,
                                        newVersion: String, previousVersion: String) throws {
        let script = staging.appendingPathComponent("install-update.sh")
        try installerScript.write(to: script, atomically: true, encoding: .utf8)
        let support = supportDirectory
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/TradeOrderSystem-update.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier), newApp.path, target.path,
                             staging.path, support.path, newVersion, previousVersion]
        let output = try FileHandle(forWritingTo: log)
        process.standardOutput = output
        process.standardError = output
        try process.run()
    }

    /// Swap, relaunch, then wait for the new version to load its page (it writes update-ok-<version>).
    /// No word within 120 s: stop it, put the old app back, reopen it and leave update-rolled-back,
    /// which the old version explains on its next page load. The old app is only deleted after the
    /// new one has reported in. scripts/test-mac-app-v3136.js runs this text under bash with stubs.
    private static let installerScript = """
    #!/bin/zsh
    set -u
    PID="$1"; NEW_APP="$2"; TARGET="$3"; STAGING="$4"; MARKERS="$5"; NEW_VERSION="$6"; OLD_VERSION="$7"
    OK="$MARKERS/update-ok-$NEW_VERSION"
    PENDING="$MARKERS/update-pending-$NEW_VERSION"
    ROLLED_BACK="$MARKERS/update-rolled-back"
    WAIT_SECONDS="${OTS_UPDATE_CONFIRM_SECONDS:-120}"
    echo "[$(date)] waiting for $PID to quit"
    for _ in {1..600}; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "app did not quit; update aborted"; rm -rf "$STAGING"; exit 1
    fi
    BACKUP="$STAGING/previous.app"
    rm -rf "$BACKUP"
    if ! mv "$TARGET" "$BACKUP"; then
      echo "cannot move old app aside"; rm -rf "$STAGING"; open "$TARGET"; exit 1
    fi
    if ! mv "$NEW_APP" "$TARGET"; then
      echo "cannot install new app; restoring"
      printf '%s\\n%s\\n%s\\n' "$NEW_VERSION" "$OLD_VERSION" "install" > "$ROLLED_BACK"
      mv "$BACKUP" "$TARGET" && rm -rf "$STAGING"
      open "$TARGET"; exit 1
    fi
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
    rm -f "$OK"
    echo "$OLD_VERSION" > "$PENDING"
    echo "[$(date)] installed V$NEW_VERSION; relaunching and waiting up to ${WAIT_SECONDS}s for it to load"
    open "$TARGET"
    for _ in $(seq 1 $(( WAIT_SECONDS * 2 ))); do
      [ -f "$OK" ] && break
      sleep 0.5
    done
    if [ -f "$OK" ]; then
      echo "[$(date)] V$NEW_VERSION started; removing the previous version"
      rm -f "$OK" "$PENDING"
      rm -rf "$STAGING"
      exit 0
    fi
    echo "[$(date)] V$NEW_VERSION did not report a loaded page; rolling back to V$OLD_VERSION"
    pkill -f "$TARGET/Contents/" 2>/dev/null
    for _ in {1..100}; do
      pgrep -f "$TARGET/Contents/" >/dev/null 2>&1 || break
      sleep 0.1
    done
    pkill -9 -f "$TARGET/Contents/" 2>/dev/null && sleep 1
    rm -rf "$STAGING/failed.app"
    if mv "$TARGET" "$STAGING/failed.app" && mv "$BACKUP" "$TARGET"; then
      printf '%s\\n%s\\n%s\\n' "$NEW_VERSION" "$OLD_VERSION" "started" > "$ROLLED_BACK"
      rm -f "$PENDING"
      open "$TARGET"
      rm -rf "$STAGING"
      echo "[$(date)] restored V$OLD_VERSION"
      exit 1
    fi
    echo "[$(date)] rollback failed; the previous version is kept at $BACKUP"
    exit 1
    """
}

private enum UpdateError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}

/// URLSession download with byte progress, speed, and resume: a connection that goes quiet
/// for 30 s is dropped and continued from where it stopped (HTTP Range via resume data), up to
/// four tries, instead of sitting on the same percentage. The file is moved out before the
/// delegate returns.
private final class ProgressDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private static let attempts = 4
    private static let stallSeconds: TimeInterval = 30

    private let destination: URL
    private let onProgress: @Sendable (Double, DownloadStats) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var lastPercent = -1
    private var lastReport = Date.distantPast
    /// (time, total bytes) over the last few seconds, for the speed shown to the user.
    private var samples: [(Date, Int64)] = []

    init(destination: URL, onProgress: @escaping @Sendable (Double, DownloadStats) -> Void) {
        self.destination = destination
        self.onProgress = onProgress
    }

    func run(_ url: URL) async throws {
        var resumeData: Data?
        for attempt in 1...Self.attempts {
            do {
                try await runOnce(url, resumeData: resumeData)
                return
            } catch let error as DownloadFailure {
                // A resumed request against an expired CDN link answers 4xx: start over from GitHub.
                if case .status(let code) = error, resumeData != nil, (400...499).contains(code), attempt < Self.attempts {
                    resumeData = nil
                    continue
                }
                throw UpdateError.message(error.message)
            } catch {
                let nsError = error as NSError
                let retryable = nsError.domain == NSURLErrorDomain && [
                    NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorCannotConnectToHost,
                    NSURLErrorNotConnectedToInternet, NSURLErrorDNSLookupFailed, NSURLErrorCannotFindHost,
                    NSURLErrorSecureConnectionFailed, NSURLErrorResourceUnavailable, NSURLErrorCannotLoadFromNetwork
                ].contains(nsError.code)
                guard retryable, attempt < Self.attempts else {
                    if nsError.code == NSURLErrorTimedOut {
                        throw UpdateError.message("下载连续 \(Int(Self.stallSeconds)) 秒没有进展，重试 \(Self.attempts) 次后放弃。请检查网络或代理后再点「更新」。")
                    }
                    throw error
                }
                resumeData = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data ?? resumeData
                try await Task.sleep(nanoseconds: UInt64(attempt) * 2_000_000_000)
            }
        }
    }

    private func runOnce(_ url: URL, resumeData: Data?) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = Self.stallSeconds
            config.httpAdditionalHeaders = ["User-Agent": "TradeOrderSystem"]
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: url)
            task.resume()
            session.finishTasksAndInvalidate()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let fraction = min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        let percent = Int(fraction * 100)
        let now = Date()
        lock.lock()
        samples.append((now, totalBytesWritten))
        samples.removeAll { now.timeIntervalSince($0.0) > 5 }
        let first = samples.first!
        let elapsed = now.timeIntervalSince(first.0)
        let speed = elapsed > 0.5 ? Double(totalBytesWritten - first.1) / elapsed : 0
        // Every percent, and at least once a second so a slow download still shows its speed.
        let due = percent != lastPercent || now.timeIntervalSince(lastReport) >= 1
        if due {
            lastPercent = percent
            lastReport = now
        }
        lock.unlock()
        if due {
            onProgress(fraction, DownloadStats(received: totalBytesWritten, total: totalBytesExpectedToWrite, bytesPerSecond: max(0, speed)))
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            finish(DownloadFailure.status(status))
            return
        }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            finish(nil)
        } catch {
            finish(error)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error ?? DownloadFailure.incomplete)
    }

    /// Only the first outcome counts; didComplete always follows didFinishDownloading.
    private func finish(_ error: Error?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        if let error { pending?.resume(throwing: error) } else { pending?.resume() }
    }
}

private enum DownloadFailure: Error {
    case status(Int)
    case incomplete

    var message: String {
        switch self {
        case .status(let code): return "下载失败（状态 \(code)）。"
        case .incomplete: return "下载没有完成。"
        }
    }
}
