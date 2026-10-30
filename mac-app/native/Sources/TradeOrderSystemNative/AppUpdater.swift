import Cocoa
import CryptoKit
import Foundation
import TradeOrderSystemCore

/// Checks GitHub Releases, downloads the archive for this Mac, verifies it, then hands
/// a detached installer script the swap: wait for this process to quit, replace the
/// bundle in place, relaunch. User data lives in Application Support, not the bundle.
/// Progress shown on the sidebar 更新 button; the page renders it, no native dialogs.
enum UpdateStatus {
    case checking
    case latest(String)
    case available(String)
    case downloading(String, Double)
    case verifying
    case saving
    case restarting
    case failed(String)

    var payload: [String: Any] {
        switch self {
        case .checking: return ["state": "checking"]
        case .latest(let version): return ["state": "latest", "version": version]
        case .available(let version): return ["state": "available", "version": version]
        case .downloading(let version, let progress): return ["state": "downloading", "version": version, "progress": progress]
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
    private let prepareToQuit: @MainActor (@escaping @MainActor (Bool) -> Void) -> Void
    private let quit: @MainActor () -> Void
    private let report: @MainActor (UpdateStatus) -> Void
    private var busy = false

    /// prepareToQuit flushes pending saves and reports whether it is safe to quit.
    init(prepareToQuit: @escaping @MainActor (@escaping @MainActor (Bool) -> Void) -> Void,
         quit: @escaping @MainActor () -> Void,
         report: @escaping @MainActor (UpdateStatus) -> Void) {
        self.prepareToQuit = prepareToQuit
        self.quit = quit
        self.report = report
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

    /// userInitiated: a click installs straight away; the launch check only flags the button.
    func checkForUpdates(userInitiated: Bool) {
        guard !busy else { return }
        busy = true
        if userInitiated { report(.checking) }
        Task { @MainActor in
            var installing = false
            defer { if !installing { self.busy = false } }
            do {
                guard let current = currentVersion else { throw UpdateError.message("无法读取当前版本号。") }
                var request = URLRequest(url: policy.latestReleaseURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
                request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
                request.setValue("TradeOrderSystem/\(current)", forHTTPHeaderField: "User-Agent")
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 404 { throw UpdateError.message("还没有发布任何版本。") }
                guard (200...299).contains(status) else { throw UpdateError.message("GitHub 返回状态 \(status)，请稍后再试。") }
                guard let release = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = release["tag_name"] as? String,
                      let latest = AppVersion(tag) else { throw UpdateError.message("无法读取最新版本信息。") }

                guard latest > current else {
                    if userInitiated { report(.latest("\(current)")) }
                    return
                }
                guard let selected = policy.selectAsset(fromRelease: release, architecture: Self.architecture) else {
                    throw UpdateError.message("V\(latest) 没有适用于这台 Mac（\(Self.architecture)）的安装包。")
                }
                guard userInitiated else {
                    report(.available("\(latest)"))
                    return
                }
                try preflightInstallLocation()
                installing = true
                await install(selected.asset, version: latest)
            } catch {
                if userInitiated { report(.failed(error.localizedDescription)) }
            }
        }
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

    private func install(_ asset: UpdateAsset, version: AppVersion) async {
        let label = "\(version)"
        report(.downloading(label, 0))
        var staging: URL?
        do {
            let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
            // Same volume as the installed app, so the final swap is a rename.
            let workDir = try FileManager.default.url(
                for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: bundle, create: true
            )
            staging = workDir
            let archive = workDir.appendingPathComponent(asset.name)
            let download = ProgressDownload(destination: archive) { [weak self] progress in
                Task { @MainActor in self?.report(.downloading(label, progress)) }
            }
            try await download.run(asset.downloadURL)

            report(.verifying)
            let expected = try await expectedChecksum(for: asset)
            let newApp = try await Task.detached(priority: .userInitiated) {
                try AppUpdater.verifyAndExtract(archive: archive, into: workDir, sha256: expected)
            }.value
            try Self.checkBundle(newApp, version: version, bundleIdentifier: Bundle.main.bundleIdentifier)

            report(.saving)
            prepareToQuit { [weak self] safe in
                guard let self else { return }
                guard safe else {
                    self.fail("数据还没确认保存，已取消本次更新，请稍后再试。", cleaning: workDir)
                    return
                }
                do {
                    // The script deletes workDir (download, unpacked copy, old app) after relaunch.
                    try AppUpdater.launchInstaller(newApp: newApp, target: bundle, staging: workDir)
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

    private func fail(_ message: String, cleaning staging: URL?) {
        if let staging { try? FileManager.default.removeItem(at: staging) }
        busy = false
        report(.failed(message))
    }

    private func expectedChecksum(for asset: UpdateAsset) async throws -> String {
        if let sha = asset.sha256 { return sha }
        // Older GitHub responses lack `digest`; the workflow also uploads <asset>.sha256.
        let sidecar = URL(string: asset.downloadURL.absoluteString + ".sha256")!
        let (data, response) = try await URLSession.shared.data(from: sidecar)
        guard ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200,
              let sha = UpdatePolicy.sha256(fromDigest: String(data: data, encoding: .utf8)) else {
            throw UpdateError.message("找不到安装包的校验值，已取消更新。")
        }
        return sha
    }

    nonisolated private static func verifyAndExtract(archive: URL, into staging: URL, sha256 expected: String) throws -> URL {
        let handle = try FileHandle(forReadingFrom: archive)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { throw UpdateError.message("安装包校验失败（文件可能不完整），已取消更新。") }

        let unpacked = staging.appendingPathComponent("unpacked", isDirectory: true)
        try? FileManager.default.removeItem(at: unpacked)
        try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
        try run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path], failure: "解压安装包失败。")
        let app = unpacked.appendingPathComponent("TradeOrderSystem.app", isDirectory: true)
        guard FileManager.default.fileExists(atPath: app.path) else { throw UpdateError.message("安装包里没有找到应用。") }
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
    }

    nonisolated private static func run(_ tool: String, _ arguments: [String], failure: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdateError.message(failure) }
    }

    /// Paths reach the script as arguments, never interpolated into its text.
    private static func launchInstaller(newApp: URL, target: URL, staging: URL) throws {
        let script = staging.appendingPathComponent("install-update.sh")
        try installerScript.write(to: script, atomically: true, encoding: .utf8)
        let log = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/TradeOrderSystem-update.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier), newApp.path, target.path, staging.path]
        let output = try FileHandle(forWritingTo: log)
        process.standardOutput = output
        process.standardError = output
        try process.run()
    }

    private static let installerScript = """
    #!/bin/zsh
    set -u
    PID="$1"; NEW_APP="$2"; TARGET="$3"; STAGING="$4"
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
      mv "$BACKUP" "$TARGET" && rm -rf "$STAGING"
      open "$TARGET"; exit 1
    fi
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
    echo "[$(date)] installed; relaunching"
    open "$TARGET"
    sleep 5
    rm -rf "$STAGING"
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

/// URLSession download with byte progress; the file is moved out before the delegate returns.
private final class ProgressDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let destination: URL
    private let onProgress: @Sendable (Double) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var lastPercent = -1

    init(destination: URL, onProgress: @escaping @Sendable (Double) -> Void) {
        self.destination = destination
        self.onProgress = onProgress
    }

    func run(_ url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
            session.downloadTask(with: url).resume()
            session.finishTasksAndInvalidate()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let fraction = min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        let percent = Int(fraction * 100)
        lock.lock()
        let changed = percent != lastPercent
        lastPercent = percent
        lock.unlock()
        if changed { onProgress(fraction) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            finish(UpdateError.message("下载失败（状态 \(status)）。"))
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
        finish(error ?? UpdateError.message("下载没有完成。"))
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
