import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
  fputs("Usage: swift scripts/make-rounded-app-icon.swift <source-image>\n", stderr)
  exit(2)
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = URL(fileURLWithPath: args[1], relativeTo: root).standardizedFileURL
let outPng = root.appendingPathComponent("mac-app/AppIcon-1024.png")
let iconset = root.appendingPathComponent("mac-app/AppIcon.iconset")
let outIcns = root.appendingPathComponent("mac-app/TradeOrderSystem.app/Contents/Resources/AppIcon.icns")

guard let sourceImage = NSImage(contentsOf: source) else {
  fputs("Cannot read source image: \(source.path)\n", stderr)
  exit(1)
}

let iconContentScale: CGFloat = 0.86

func roundedImage(size: Int) -> NSImage {
  let canvas = NSSize(width: size, height: size)
  let image = NSImage(size: canvas)
  image.lockFocus()

  NSColor.clear.setFill()
  NSRect(origin: .zero, size: canvas).fill()

  let rect = NSRect(x: 0, y: 0, width: size, height: size)
  let radius = CGFloat(size) * 0.22
  NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
  let inset = CGFloat(size) * (1 - iconContentScale) / 2
  let drawRect = rect.insetBy(dx: inset, dy: inset)
  sourceImage.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1)

  image.unlockFocus()
  return image
}

func writePng(_ image: NSImage, to url: URL) throws {
  guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let data = bitmap.representation(using: .png, properties: [:])
  else {
    throw NSError(domain: "IconExport", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG export failed"])
  }
  try data.write(to: url)
}

try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let base = roundedImage(size: 1024)
try writePng(base, to: outPng)

let variants: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

for (name, size) in variants {
  try writePng(roundedImage(size: size), to: iconset.appendingPathComponent(name))
}

let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset.path, "-o", outIcns.path]
try process.run()
process.waitUntilExit()

if process.terminationStatus != 0 {
  fputs("iconutil failed\n", stderr)
  exit(process.terminationStatus)
}

print(outIcns.path)
