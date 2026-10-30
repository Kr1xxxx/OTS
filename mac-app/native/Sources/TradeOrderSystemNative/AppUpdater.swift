import Cocoa
import CryptoKit
import Foundation
import TradeOrderSystemCore

/// Checks GitHub Releases, downloads the archive for this Mac, verifies it, then hands
/// a detached installer script the swap: wait for this process to quit, replace the
/// bundle in place, relaunch. User data lives in Application Support, not the bundle.
@MainActor
final class AppUpdater {
    private let policy = UpdatePolicy(owner: "Kr1xxxx", repository: "OTS")
    private let prepareToQuit: @MainActor (@escaping @MainActor (Bool) -> Void) -> Void
    private let quit: @MainActor () -> Void
    private var busy = false
    private var progressWindow: NSPanel?
    private var progressLabel: NSTextField?

    /// prepareToQuit flushes pending saves and reports whether it is safe to quit.
    init(prepareToQuit: @escaping @MainActor (@escaping @MainActor (Bool) -> Void) -> Void,
         quit: @escaping @MainActor () -> Void) {
        self.prepareToQuit = prepareToQuit
        self.quit = quit
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

    func checkForUpdates(userInitiated: Bool) {
        guard !busy else {
            if userInitiated { progressWindow?.makeKeyAndOrderFront(nil) }
            return
        }
        busy = true
        Task { @MainActor in
            // Stays busy only while a download/install owns the progress window.
            defer { if self.progressWindow == nil { self.busy = false } }
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
                    if userInitiated { info("已是最新版本", "当前版本 V\(current) 就是最新版。") }
                    return
                }
                guard let selected = policy.selectAsset(fromRelease: release, architecture: Self.architecture) else {
                    if userInitiated { info("暂时无法更新", "V\(latest) 没有适用于这台 Mac（\(Self.architecture)）的安装包。") }
                    return
                }
                let notes = (release["body"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard confirmUpdate(current: current, latest: latest, notes: notes) else { return }
                try preflightInstallLocation()
                await install(selected.asset, version: latest)
            } catch {
                if userInitiated { info("检查更新失败", error.localizedDescription) }
            }
        }
    }

    private func confirmUpdate(current: AppVersion, latest: AppVersion, notes: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = "发现新版本 V\(latest)"
        let trimmed = notes.count > 700 ? String(notes.prefix(700)) + "…" : notes
        alert.informativeText = "当前版本 V\(current)。更新会先保存数据，下载完成后自动替换并重新打开软件。"
            + (trimmed.isEmpty ? "" : "\n\n\(trimmed)")
        alert.addButton(withTitle: "更新并重启")
        alert.addButton(withTitle: "稍后")
        return alert.runModal() == .alertFirstButtonReturn
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
        showProgressWindow(text: "正在下载 V\(version)…")
        do {
            let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
            // Same volume as the installed app, so the final swap is a rename.
            let staging = try FileManager.default.url(
                for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: bundle, create: true
            )
            let archive = staging.appendingPathComponent(asset.name)
            let (downloaded, response) = try await URLSession.shared.download(from: asset.downloadURL)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200...299).contains(status) else {
                try? FileManager.default.removeItem(at: downloaded)
                throw UpdateError.message("下载失败（状态 \(status)）。")
            }
            try FileManager.default.moveItem(at: downloaded, to: archive)

            progressLabel?.stringValue = "正在校验安装包…"
            let expected = try await expectedChecksum(for: asset)
            let newApp = try await Task.detached(priority: .userInitiated) {
                try AppUpdater.verifyAndExtract(archive: archive, into: staging, sha256: expected)
            }.value
            try Self.checkBundle(newApp, version: version, bundleIdentifier: Bundle.main.bundleIdentifier)

            progressLabel?.stringValue = "正在保存数据…"
            prepareToQuit { [weak self] safe in
                guard let self else { return }
                guard safe else {
                    self.finishWithError("数据还没确认保存，已取消本次更新。请稍后再试。")
                    return
                }
                do {
                    try AppUpdater.launchInstaller(newApp: newApp, target: bundle, staging: staging)
                    self.quit()
                } catch {
                    self.finishWithError(error.localizedDescription)
                }
            }
        } catch {
            finishWithError(error.localizedDescription)
        }
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
      echo "app did not quit; update aborted"; exit 1
    fi
    BACKUP="$STAGING/previous.app"
    rm -rf "$BACKUP"
    if ! mv "$TARGET" "$BACKUP"; then
      echo "cannot move old app aside"; open "$TARGET"; exit 1
    fi
    if ! mv "$NEW_APP" "$TARGET"; then
      echo "cannot install new app; restoring"; mv "$BACKUP" "$TARGET"; open "$TARGET"; exit 1
    fi
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
    echo "[$(date)] installed; relaunching"
    open "$TARGET"
    sleep 5
    rm -rf "$STAGING"
    """

    private func showProgressWindow(text: String) {
        if let progressWindow {
            progressLabel?.stringValue = text
            progressWindow.makeKeyAndOrderFront(nil)
            return
        }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 96),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        panel.title = "软件更新"
        let spinner = NSProgressIndicator(frame: NSRect(x: 24, y: 38, width: 20, height: 20))
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: 56, y: 38, width: 260, height: 20)
        panel.contentView?.addSubview(spinner)
        panel.contentView?.addSubview(label)
        panel.isReleasedWhenClosed = false
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        progressWindow = panel
        progressLabel = label
    }

    private func finishWithError(_ message: String) {
        progressWindow?.close()
        progressWindow = nil
        progressLabel = nil
        busy = false
        info("更新没有完成", message)
    }

    private func info(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }
}

private enum UpdateError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}
